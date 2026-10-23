//go:build relayiumdiag

// Command local-turn-fixture is a loopback-only TURN relay for the opt-in
// realtime relay diagnostics (scripts/realtime-relay-diagnostics.sh). It is a
// test fixture, not a production relay and not production-equivalent: it is
// the repository's own pinned pion/turn (server/third_party/pion-turn via the
// server module's replace), listening on 127.0.0.1 only.
//
// It is NOT part of any shipped binary. The `relayiumdiag` build tag keeps it
// out of every ordinary `go build`/`go vet ./...`, and it lives outside the
// server module. It is compiled against server/go.mod through `go build
// -overlay`, so the exact pinned dependency set is used without a copy of the
// module and without writing into server/.
//
//	RELAYIUM_DIAG_TURN_SECRET=<secret> local-turn-fixture -status FILE [-max-seconds N] [-exit-on-stdin-eof] [-self-check]
//
// Credentials are the TURN REST construction the central server issues
// (username "<expiry>:<token>", password base64(HMAC-SHA1(secret, username))).
// The shared secret is read from the environment only, never argv, and is
// never written anywhere.
//
// Observable output, and nothing else:
//
//   - one stdout line `RELAYIUM_TURN_FIXTURE_READY {"port":N}` once both the UDP
//     and the TCP listener are bound on 127.0.0.1:N;
//   - a counters file (-status), rewritten atomically while running and once
//     more with "final":true on exit. Counters only: no address, port, username,
//     realm, credential or payload is ever recorded.
//
// It exits on SIGTERM/SIGINT, at -max-seconds, or — with -exit-on-stdin-eof, for
// an owner that holds a pipe to it — on stdin EOF, whichever is first.
//
// -self-check drives a real pion client through this very server and exits:
// a UDP-transport and a TCP-transport allocation must each relay a payload to a
// loopback peer byte-exactly and be counted under their own transport, and a
// wrong password and an expired username must each be refused. It is how
// scripts/test/local-turn-fixture-test.sh proves the counters mean something.
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pion/turn/v4"
)

const (
	statusVersion = 1
	realm         = "relayium-diagnostics.invalid"
	loopback      = "127.0.0.1"
)

// counters is the whole observable state. Every field is a count.
type counters struct {
	authAccepted    atomic.Int64
	authRejected    atomic.Int64
	allocUDP        atomic.Int64
	allocTCP        atomic.Int64
	allocOther      atomic.Int64
	relayClosed     atomic.Int64
	permissions     atomic.Int64
	channels        atomic.Int64
	allocErrors     atomic.Int64
	toPeerUDP       atomic.Int64
	toPeerTCP       atomic.Int64
	toPeerUnknown   atomic.Int64
	fromPeerUDP     atomic.Int64
	fromPeerTCP     atomic.Int64
	fromPeerUnknown atomic.Int64
}

type byProto struct {
	UDP     int64 `json:"udp"`
	TCP     int64 `json:"tcp"`
	Unknown int64 `json:"unknown"`
}

type status struct {
	Version            int     `json:"version"`
	Final              bool    `json:"final"`
	ExitReason         string  `json:"exitReason,omitempty"`
	AuthAccepted       int64   `json:"authAccepted"`
	AuthRejected       int64   `json:"authRejected"`
	Allocations        byProto `json:"allocations"`
	RelaySocketsClosed int64   `json:"relaySocketsClosed"`
	Permissions        int64   `json:"permissions"`
	Channels           int64   `json:"channels"`
	AllocationErrors   int64   `json:"allocationErrors"`
	RelayBytesToPeer   byProto `json:"relayBytesToPeer"`
	RelayBytesFromPeer byProto `json:"relayBytesFromPeer"`
}

func (c *counters) snapshot() status {
	return status{
		Version:            statusVersion,
		AuthAccepted:       c.authAccepted.Load(),
		AuthRejected:       c.authRejected.Load(),
		Allocations:        byProto{UDP: c.allocUDP.Load(), TCP: c.allocTCP.Load(), Unknown: c.allocOther.Load()},
		RelaySocketsClosed: c.relayClosed.Load(),
		Permissions:        c.permissions.Load(),
		Channels:           c.channels.Load(),
		AllocationErrors:   c.allocErrors.Load(),
		RelayBytesToPeer:   byProto{UDP: c.toPeerUDP.Load(), TCP: c.toPeerTCP.Load(), Unknown: c.toPeerUnknown.Load()},
		RelayBytesFromPeer: byProto{UDP: c.fromPeerUDP.Load(), TCP: c.fromPeerTCP.Load(), Unknown: c.fromPeerUnknown.Load()},
	}
}

// relayConn counts payload bytes crossing one allocation's relay socket. Its
// client transport (udp/tcp) is the transport of the listener whose generator
// created it: pion's own five-tuple and OnAllocationCreated report "UDP" for
// every allocation, including one requested over TCP, so they cannot say.
type relayConn struct {
	net.PacketConn
	c     *counters
	proto string // "udp" | "tcp"
	once  sync.Once
}

func (r *relayConn) kind() string { return r.proto }

func (r *relayConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	n, err := r.PacketConn.WriteTo(p, addr)
	if n > 0 {
		switch r.kind() {
		case "udp":
			r.c.toPeerUDP.Add(int64(n))
		case "tcp":
			r.c.toPeerTCP.Add(int64(n))
		default:
			r.c.toPeerUnknown.Add(int64(n))
		}
	}
	return n, err
}

func (r *relayConn) ReadFrom(p []byte) (int, net.Addr, error) {
	n, addr, err := r.PacketConn.ReadFrom(p)
	if n > 0 {
		switch r.kind() {
		case "udp":
			r.c.fromPeerUDP.Add(int64(n))
		case "tcp":
			r.c.fromPeerTCP.Add(int64(n))
		default:
			r.c.fromPeerUnknown.Add(int64(n))
		}
	}
	return n, addr, err
}

func (r *relayConn) Close() error {
	r.once.Do(func() { r.c.relayClosed.Add(1) })
	return r.PacketConn.Close()
}

// generator hands pion loopback-only relay sockets for ONE client transport
// and remembers them by relay address until OnAllocationCreated counts them.
type generator struct {
	inner *turn.RelayAddressGeneratorStatic
	c     *counters
	proto string
	mu    sync.Mutex
	live  map[string]*relayConn
}

func (g *generator) Validate() error { return g.inner.Validate() }

func (g *generator) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.inner.AllocatePacketConn(network, requestedPort)
	if err != nil {
		return nil, nil, err
	}
	rc := &relayConn{PacketConn: conn, c: g.c, proto: g.proto}
	g.mu.Lock()
	g.live[addr.String()] = rc
	g.mu.Unlock()
	return rc, addr, nil
}

func (g *generator) AllocateConn(network string, requestedPort int) (net.Conn, net.Addr, error) {
	return g.inner.AllocateConn(network, requestedPort)
}

// claim reports whether this generator created the allocation at relayAddr.
func (g *generator) claim(relayAddr net.Addr) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if relayAddr == nil || g.live[relayAddr.String()] == nil {
		return false
	}
	delete(g.live, relayAddr.String())
	return true
}

func restPassword(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func expired(username string, now int64) bool {
	i := strings.IndexByte(username, ':')
	if i <= 0 {
		return true
	}
	exp, err := strconv.ParseInt(username[:i], 10, 64)
	return err != nil || exp < now
}

func writeStatus(path string, s status) error {
	body, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(body, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// listen binds UDP and TCP on the SAME loopback port: the central server's
// withTCPTransport offers `turn:H:P` and `turn:H:P?transport=tcp` together.
func listen() (net.PacketConn, net.Listener, int, error) {
	var last error
	for attempt := 0; attempt < 20; attempt++ {
		udp, err := net.ListenPacket("udp4", loopback+":0")
		if err != nil {
			return nil, nil, 0, err
		}
		port := udp.LocalAddr().(*net.UDPAddr).Port
		tcp, err := net.Listen("tcp4", net.JoinHostPort(loopback, strconv.Itoa(port)))
		if err == nil {
			return udp, tcp, port, nil
		}
		last = err
		_ = udp.Close()
	}
	return nil, nil, 0, fmt.Errorf("no loopback port free for both UDP and TCP: %w", last)
}

func main() {
	statusPath := flag.String("status", "", "counters file (required; directory must be private)")
	maxSeconds := flag.Int("max-seconds", 900, "hard lifetime bound in seconds (1..3600)")
	check := flag.Bool("self-check", false, "run the built-in client checks against this server, then exit")
	stdinEOF := flag.Bool("exit-on-stdin-eof", false, "also exit when stdin reaches EOF (the owner's pipe closed)")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "local-turn-fixture: unexpected arguments")
		os.Exit(2)
	}
	var stdin io.Reader
	if *stdinEOF {
		stdin = os.Stdin
	}
	if err := run(*statusPath, *maxSeconds, *check, stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "local-turn-fixture:", err)
		os.Exit(1)
	}
}

func run(statusPath string, maxSeconds int, check bool, stdin io.Reader, stdout io.Writer) error {
	secret := os.Getenv("RELAYIUM_DIAG_TURN_SECRET")
	if len(secret) < 16 {
		return errors.New("RELAYIUM_DIAG_TURN_SECRET must be set (>= 16 bytes) in the environment")
	}
	if statusPath == "" || !filepath.IsAbs(statusPath) {
		return errors.New("-status must be an absolute path")
	}
	if maxSeconds < 1 || maxSeconds > 3600 {
		return errors.New("-max-seconds must be within 1..3600")
	}
	if info, err := os.Stat(filepath.Dir(statusPath)); err != nil || info.Mode().Perm()&0o077 != 0 {
		return errors.New("-status directory must exist and be private (mode 0700)")
	}

	c := &counters{}
	udp, tcp, port, err := listen()
	if err != nil {
		return err
	}
	gen := func(proto string) *generator {
		return &generator{c: c, proto: proto, live: map[string]*relayConn{},
			inner: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP(loopback), Address: loopback}}
	}
	udpGen, tcpGen := gen("udp"), gen("tcp")
	count := func(relayAddr net.Addr) {
		switch {
		case udpGen.claim(relayAddr):
			c.allocUDP.Add(1)
		case tcpGen.claim(relayAddr):
			c.allocTCP.Add(1)
		default:
			c.allocOther.Add(1)
		}
	}
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(username, _ string, _ net.Addr) ([]byte, bool) {
			if expired(username, time.Now().Unix()) {
				return nil, false
			}
			return turn.GenerateAuthKey(username, realm, restPassword(secret, username)), true
		},
		EventHandler: turn.EventHandler{
			OnAuth: func(_, _ net.Addr, _, _, _ string, _ string, verdict bool) {
				if verdict {
					c.authAccepted.Add(1)
				} else {
					c.authRejected.Add(1)
				}
			},
			OnAllocationCreated: func(_, _ net.Addr, _, _, _ string, relayAddr net.Addr, _ int) {
				count(relayAddr)
			},
			OnAllocationError: func(_, _ net.Addr, _, _ string) { c.allocErrors.Add(1) },
			OnPermissionCreated: func(_, _ net.Addr, _, _, _ string, _ net.Addr, _ net.IP) {
				c.permissions.Add(1)
			},
			OnChannelCreated: func(_, _ net.Addr, _, _, _ string, _, _ net.Addr, _ uint16) {
				c.channels.Add(1)
			},
		},
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: udpGen}},
		ListenerConfigs:   []turn.ListenerConfig{{Listener: tcp, RelayAddressGenerator: tcpGen}},
	})
	if err != nil {
		_ = udp.Close()
		_ = tcp.Close()
		return err
	}
	if err := writeStatus(statusPath, c.snapshot()); err != nil {
		_ = server.Close()
		return err
	}
	fmt.Fprintf(stdout, "RELAYIUM_TURN_FIXTURE_READY {\"port\":%d}\n", port)

	done := make(chan string, 4)
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() { s := <-sigs; done <- "signal:" + s.String() }()
	checked := make(chan error, 1)
	if check {
		// A self-check owns its own lifetime; stdin is not its parent signal.
		go func() { checked <- selfCheck(port, secret, c) }()
	} else if stdin != nil {
		go func() { _, _ = io.Copy(io.Discard, stdin); done <- "stdin-closed" }()
	}
	deadline := time.NewTimer(time.Duration(maxSeconds) * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()

	reason := ""
	var last status
	for reason == "" {
		select {
		case reason = <-done:
		case err := <-checked:
			if err != nil {
				fmt.Fprintln(stdout, "RELAYIUM_TURN_FIXTURE_SELFCHECK FAIL:", err)
				reason = "self-check-failed"
			} else {
				fmt.Fprintln(stdout, "RELAYIUM_TURN_FIXTURE_SELFCHECK PASS")
				reason = "self-check-passed"
			}
		case <-deadline.C:
			reason = "max-seconds"
		case <-tick.C:
			if s := c.snapshot(); s != last {
				if err := writeStatus(statusPath, s); err != nil {
					reason = "status-write-failed"
				}
				last = s
			}
		}
	}
	closeErr := server.Close()
	final := c.snapshot()
	final.Final = true
	final.ExitReason = reason
	if err := writeStatus(statusPath, final); err != nil {
		return err
	}
	if closeErr != nil {
		return fmt.Errorf("close: %w", closeErr)
	}
	if reason == "max-seconds" || reason == "status-write-failed" || reason == "self-check-failed" {
		return errors.New("stopped by " + reason)
	}
	return nil
}

// selfCheck exercises the server it runs beside through pion's own client.
func selfCheck(port int, secret string, c *counters) error {
	server := net.JoinHostPort(loopback, strconv.Itoa(port))
	future := strconv.FormatInt(time.Now().Add(10*time.Minute).Unix(), 10) + ":selfcheck.diag"
	past := strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10) + ":selfcheck.diag"
	payload := make([]byte, 1200)
	for i := range payload {
		payload[i] = byte(i*31 + 7)
	}

	relayOnce := func(transport, username, password string) error {
		var conn net.PacketConn
		switch transport {
		case "udp":
			pc, err := net.ListenPacket("udp4", loopback+":0")
			if err != nil {
				return err
			}
			conn = pc
		case "tcp":
			tc, err := net.DialTimeout("tcp4", server, 3*time.Second)
			if err != nil {
				return err
			}
			conn = turn.NewSTUNConn(tc)
		}
		defer conn.Close()
		client, err := turn.NewClient(&turn.ClientConfig{TURNServerAddr: server, STUNServerAddr: server,
			Username: username, Password: password, Realm: realm, Conn: conn, RTO: 200 * time.Millisecond})
		if err != nil {
			return err
		}
		defer client.Close()
		if err := client.Listen(); err != nil {
			return err
		}
		relay, err := client.Allocate()
		if err != nil {
			return err
		}
		defer relay.Close()
		peer, err := net.ListenPacket("udp4", loopback+":0")
		if err != nil {
			return err
		}
		defer peer.Close()
		buf := make([]byte, 4096)
		for attempt := 0; attempt < 10; attempt++ {
			if _, err := relay.WriteTo(payload, peer.LocalAddr()); err != nil {
				return err
			}
			_ = peer.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
			n, _, err := peer.ReadFrom(buf)
			if err == nil {
				if n != len(payload) || string(buf[:n]) != string(payload) {
					return errors.New("relayed payload differs")
				}
				return nil
			}
		}
		return errors.New("payload never reached the loopback peer through the relay")
	}

	before := c.snapshot()
	if err := relayOnce("udp", future, restPassword(secret, future)); err != nil {
		return fmt.Errorf("udp allocation: %w", err)
	}
	if err := relayOnce("tcp", future, restPassword(secret, future)); err != nil {
		return fmt.Errorf("tcp allocation: %w", err)
	}
	if err := relayOnce("udp", future, restPassword(secret+"-wrong", future)); err == nil {
		return errors.New("a wrong password was accepted")
	}
	if err := relayOnce("udp", past, restPassword(secret, past)); err == nil {
		return errors.New("an expired username was accepted")
	}
	after := c.snapshot()
	switch {
	case after.Allocations.UDP-before.Allocations.UDP != 1:
		return fmt.Errorf("udp allocations counted %d, want 1", after.Allocations.UDP-before.Allocations.UDP)
	case after.Allocations.TCP-before.Allocations.TCP != 1:
		return fmt.Errorf("tcp allocations counted %d, want 1", after.Allocations.TCP-before.Allocations.TCP)
	case after.RelayBytesToPeer.UDP-before.RelayBytesToPeer.UDP < int64(len(payload)):
		return errors.New("udp relay bytes were not counted")
	case after.RelayBytesToPeer.TCP-before.RelayBytesToPeer.TCP < int64(len(payload)):
		return errors.New("tcp relay bytes were not counted")
	case after.RelayBytesToPeer.Unknown != before.RelayBytesToPeer.Unknown:
		return errors.New("relay bytes were counted under an unknown transport")
	case after.AuthRejected-before.AuthRejected < 1:
		return errors.New("no authentication rejection was counted")
	}
	return nil
}
