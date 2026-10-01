package main

// F02 real-provider reconciliation (opt-in): a real coturn 4.6.1, a real
// Redis, the real relayium-coturn-bridge binary as a subprocess, the real
// central ingest over a real SQLite ledger, and a pion TURN client whose
// socket counts every raw byte it sends to and receives from coturn.
//
// It proves, per allocation and in aggregate, raw client bytes (sent +
// received) → coturn's own accounting (independently captured from Redis) →
// bridge cumulative → one owner's ledger, for normal close, lifetime expiry,
// and a drained coturn stop; and it measures (never guesses) the loss of a
// bare SIGTERM and a SIGKILL, plus central outage, bridge SIGKILL, raw
// session-id reuse across coturn epochs and a Redis restart.
//
// Run with scripts/test/coturn-metering-provider.sh. Skipped unless
// RELAYIUM_COTURN_PROVIDER_BIN names a coturn 4.6.1 bin directory.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	turnv4 "github.com/pion/turn/v4"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/coturnbridge"
	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

const provRealm = "relayium.com"

type provEnv struct {
	t        *testing.T
	bin      string // coturn bin dir
	redisBin string
	dir      string // short private working dir
	evid     string // evidence dir

	secret     string
	cliPass    string
	token      string
	redisPort  int
	turnPort   int
	cliPort    int
	centralURL string
	centralLn  string
	relayMin   int

	store   *account.SQLiteStore
	ingest  *account.CoturnMeteringIngest
	central *http.Server
	centMu  sync.Mutex

	billableSince   int64
	recordSnapshots bool
	seenMu          sync.Mutex
	seen            []centralSeen

	redis     *exec.Cmd
	coturn    *exec.Cmd
	bridge    *exec.Cmd
	bridgeBin string
	tokenB    string
	bridgeB   *exec.Cmd
	s10sid    string

	// Production-equivalence knobs (test-only). relayThreads: "1" (default,
	// the pinned fixture), "default" (coturn's own CPU-based count) or a
	// number. tlsPort/tlsCert/tlsKey enable a TLS listener with a per-run
	// private CA (caPool trusts it).
	relayThreads    string
	tlsPort         int
	tlsCert, tlsKey string
	caPool          *x509.CertPool
	caFingerprint   string
	threadsLogged   int // coturn's "Total General servers: N" at the latest start
	coturnStarts    int // such lines seen so far
	peer            *net.UDPConn
	peerN           atomic.Int64

	raw   *rawCapture
	rows  []reconRow
	notes []string
}

func freePort(t *testing.T) int {
	t.Helper()
	for range 50 {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p := l.Addr().(*net.TCPAddr).Port
		l.Close()
		u, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			continue
		}
		u.Close()
		return p
	}
	t.Fatal("no free port")
	return 0
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (p *provEnv) logf(format string, args ...any) {
	line := fmt.Sprintf("%s "+format, append([]any{time.Now().UTC().Format("15:04:05.000")}, args...)...)
	p.t.Log(line)
	p.notes = append(p.notes, line)
}

func (p *provEnv) writeSecret(name, v string) string {
	path := filepath.Join(p.dir, name)
	if err := os.WriteFile(path, []byte(v+"\n"), 0o600); err != nil {
		p.t.Fatal(err)
	}
	return path
}

func (p *provEnv) startRedis() {
	p.t.Helper()
	cmd := exec.Command(p.redisBin, "--port", strconv.Itoa(p.redisPort), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no")
	logf, _ := os.OpenFile(filepath.Join(p.evid, "redis.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		p.t.Fatal(err)
	}
	p.redis = cmd
	p.waitTCP(p.redisPort)
}

func (p *provEnv) stopRedis() {
	if p.redis != nil {
		p.redis.Process.Kill()
		p.redis.Wait()
		p.redis = nil
	}
}

func (p *provEnv) waitTCP(port int) {
	p.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			c.Close()
			return
		}
		if time.Now().After(deadline) {
			p.t.Fatalf("port %d never opened", port)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// turnConf renders the coturn config. With the zero-value knobs (relayThreads
// "" or "1", no TLS) the output is byte-for-byte the config every earlier run
// used.
func (p *provEnv) turnConf() string {
	threads := "relay-threads=1\n"
	switch p.relayThreads {
	case "", "1":
	case "default":
		threads = "" // coturn's own default: one relay thread per CPU (clamped)
	default:
		threads = "relay-threads=" + p.relayThreads + "\n"
	}
	tls := "no-tls\n"
	if p.tlsPort != 0 {
		tls = fmt.Sprintf("tls-listening-port=%d\ncert=%s\npkey=%s\n", p.tlsPort, p.tlsCert, p.tlsKey)
	}
	conf := fmt.Sprintf(`listening-ip=127.0.0.1
relay-ip=127.0.0.1
listening-port=%d
min-port=%d
max-port=%d
realm=%s
use-auth-secret
static-auth-secret=%s
allow-loopback-peers
no-multicast-peers
@@TLS@@no-dtls
no-tcp-relay
fingerprint
@@THREADS@@redis-statsdb="ip=127.0.0.1 dbname=0 port=%d"
cli-ip=127.0.0.1
cli-port=%d
cli-password=%s
pidfile=%s
log-file=%s
simple-log
`, p.turnPort, p.relayMin, p.relayMin+200, provRealm, p.secret, p.redisPort, p.cliPort, p.cliPass,
		filepath.Join(p.dir, "turnserver.pid"), filepath.Join(p.evid, "turn.log"))
	return strings.Replace(strings.Replace(conf, "@@TLS@@", tls, 1), "@@THREADS@@", threads, 1)
}

func (p *provEnv) startCoturn() {
	p.t.Helper()
	conf := filepath.Join(p.dir, "turn.conf")
	if err := os.WriteFile(conf, []byte(p.turnConf()), 0o600); err != nil {
		p.t.Fatal(err)
	}
	os.Remove(filepath.Join(p.dir, "turnserver.pid"))
	cmd := exec.Command(filepath.Join(p.bin, "turnserver"), "-c", conf)
	out, _ := os.OpenFile(filepath.Join(p.evid, "turn.stdout"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		p.t.Fatal(err)
	}
	p.coturn = cmd
	p.waitTCP(p.cliPort)
	// The pidfile must name this very process before the bridge can confirm
	// the new epoch.
	deadline := time.Now().Add(10 * time.Second)
	for {
		b, _ := os.ReadFile(filepath.Join(p.dir, "turnserver.pid"))
		if strings.TrimSpace(string(b)) == strconv.Itoa(cmd.Process.Pid) {
			break
		}
		if time.Now().After(deadline) {
			p.t.Fatalf("coturn pidfile never named pid %d (got %q)", cmd.Process.Pid, b)
		}
		time.Sleep(50 * time.Millisecond)
	}
	p.waitTURNReady()
	p.threadsLogged = p.loggedRelayThreads()
	p.logf("coturn started pid %d (relay threads: mode %q, coturn logged %d, host CPUs %d)", cmd.Process.Pid, p.relayThreads, p.threadsLogged, runtime.NumCPU())
	if n, err := strconv.Atoi(p.relayThreads); err == nil && p.threadsLogged != n {
		p.t.Fatalf("relay-threads=%d configured but coturn logged %d general servers", n, p.threadsLogged)
	}
	if p.threadsLogged < 1 {
		p.t.Fatal("coturn logged no \"Total General servers\" line")
	}
}

var reGeneralServers = regexp.MustCompile(`Total General servers: (\d+)`)

// loggedRelayThreads returns the relay thread count coturn printed at its
// most recent start (the log file is appended across restarts).
func (p *provEnv) loggedRelayThreads() int {
	deadline := time.Now().Add(5 * time.Second)
	for {
		b, _ := os.ReadFile(filepath.Join(p.evid, "turn.log"))
		if m := reGeneralServers.FindAllSubmatch(b, -1); len(m) > p.coturnStarts {
			p.coturnStarts = len(m)
			n, _ := strconv.Atoi(string(m[len(m)-1][1]))
			return n
		}
		if time.Now().After(deadline) {
			return 0
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitTURNReady sends STUN Binding requests from a throwaway socket until
// coturn answers. Without it the first Allocate of a just-started coturn is
// retransmitted while coturn is not yet reading: those bytes leave the client
// but never enter a coturn session, so no provider can account them (the
// first debug run measured exactly 4 unanswered 36-byte Allocates).
func (p *provEnv) waitTURNReady() {
	p.t.Helper()
	c, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		p.t.Fatal(err)
	}
	defer c.Close()
	to := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: p.turnPort}
	req := make([]byte, 20)
	req[1] = 0x01                                  // Binding request
	copy(req[4:8], []byte{0x21, 0x12, 0xa4, 0x42}) // magic cookie
	rand.Read(req[8:20])                           // transaction id
	deadline := time.Now().Add(10 * time.Second)
	buf := make([]byte, 1500)
	for time.Now().Before(deadline) {
		c.WriteTo(req, to)
		c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, _, err := c.ReadFrom(buf)
		if err == nil && n >= 20 && buf[0] == 0x01 && buf[1] == 0x01 && string(buf[8:20]) == string(req[8:20]) {
			return
		}
	}
	p.t.Fatal("coturn never answered a STUN Binding request")
}

func (p *provEnv) signalCoturn(sig syscall.Signal) {
	p.t.Helper()
	pid := p.coturn.Process.Pid
	p.coturn.Process.Signal(sig)
	p.coturn.Wait()
	p.coturn = nil
	p.logf("coturn pid %d stopped with %v", pid, sig)
}

func (p *provEnv) startCentral() {
	p.t.Helper()
	p.centMu.Lock()
	defer p.centMu.Unlock()
	ln, err := net.Listen("tcp", p.centralLn)
	if err != nil {
		p.t.Fatal(err)
	}
	p.central = &http.Server{Handler: http.HandlerFunc(p.serveCentral)}
	go p.central.Serve(ln)
	p.logf("central up at %s", p.centralURL)
}

// serveCentral is central's ingest; with recordSnapshots it first notes,
// test-side, what each received snapshot claimed (the request is otherwise
// passed through unchanged).
func (p *provEnv) serveCentral(w http.ResponseWriter, r *http.Request) {
	if p.recordSnapshots {
		body, err := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		var req wire.Request
		if err == nil && json.Unmarshal(body, &req) == nil {
			at := time.Now().UnixMilli()
			p.seenMu.Lock()
			for _, s := range req.Snapshots {
				h := sha256.Sum256([]byte(s.Username))
				p.seen = append(p.seen, centralSeen{
					AtMilli: at, RelayID: req.RelayID, BootID: s.BootID, PID: s.PID, StartTicks: s.StartTicks,
					SessionID: s.SessionID, UsernameHash: hex.EncodeToString(h[:]), Seq: s.Seq, State: s.State,
					Cumulative: s.Cumulative, FirstObservedUnix: s.FirstObservedUnix,
				})
			}
			p.seenMu.Unlock()
		}
	}
	p.ingest.ServeHTTP(w, r)
}

// centralSeen is one snapshot as central received it (recordSnapshots).
type centralSeen struct {
	AtMilli           int64  `json:"receivedAtUnixMilli"`
	RelayID           string `json:"relayId"`
	BootID            string `json:"bootId"`
	PID               int    `json:"pid"`
	StartTicks        uint64 `json:"startTicks"`
	SessionID         string `json:"sessionId"`
	UsernameHash      string `json:"usernameHash"`
	Seq               uint64 `json:"seq"`
	State             string `json:"state"`
	Cumulative        uint64 `json:"cumulative"`
	FirstObservedUnix int64  `json:"firstObservedUnix"`
}

func (p *provEnv) stopCentral() {
	p.centMu.Lock()
	defer p.centMu.Unlock()
	if p.central != nil {
		p.central.Close()
		p.central = nil
		p.logf("central DOWN")
	}
}

// psdEvery is the bridge's listing interval: 2 listings × 6 s exceed the
// barrier interval + 10 s timeout, as the bridge's ordering guard requires.
const psdEvery = "6s"

func (p *provEnv) bridgeCmd(relayID, spool, token, psd, log string) *exec.Cmd {
	cmd := exec.Command(p.bridgeBin, "run",
		"-relay-id", relayID, "-realm", provRealm,
		"-redis-addr", fmt.Sprintf("127.0.0.1:%d", p.redisPort),
		"-cli-addr", fmt.Sprintf("127.0.0.1:%d", p.cliPort),
		"-cli-password-file", filepath.Join(p.dir, "cli.pass"),
		"-psd-path", filepath.Join(p.dir, "psd", psd),
		"-spool-dir", filepath.Join(p.dir, spool),
		"-central-url", p.centralURL,
		"-token-file", filepath.Join(p.dir, token),
		"-coturn-pidfile", filepath.Join(p.dir, "turnserver.pid"),
		"-psd-interval", psdEvery, "-report-interval", "1s", "-barrier-interval", "250ms")
	out, _ := os.OpenFile(filepath.Join(p.evid, log), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		p.t.Fatal(err)
	}
	return cmd
}

func (p *provEnv) startBridge() {
	p.t.Helper()
	p.bridge = p.bridgeCmd("coturn-local", "spool", "token", "psd.txt", "bridge.log")
	p.logf("bridge started pid %d", p.bridge.Process.Pid)
	p.waitBridgeEpoch()
}

func (p *provEnv) stopBridge(sig syscall.Signal) {
	if p.bridge != nil {
		p.bridge.Process.Signal(sig)
		p.bridge.Wait()
		p.logf("bridge pid %d stopped with %v", p.bridge.Process.Pid, sig)
		p.bridge = nil
	}
}

func (p *provEnv) status() coturnbridge.Status { return p.statusOf("spool") }

func (p *provEnv) statusOf(spool string) coturnbridge.Status {
	var st coturnbridge.Status
	b, err := os.ReadFile(filepath.Join(p.dir, spool, "status.json"))
	if err == nil {
		json.Unmarshal(b, &st)
	}
	return st
}

// waitBridgeEpoch waits until the bridge has confirmed the running coturn's
// epoch with a trusted barrier.
func (p *provEnv) waitBridgeEpoch() {
	p.t.Helper()
	pid := ""
	if p.coturn != nil {
		pid = "/" + strconv.Itoa(p.coturn.Process.Pid) + "/"
	}
	p.eventually("bridge confirms coturn epoch", 20*time.Second, func() bool {
		st := p.status()
		return st.SubscriptionUp && strings.Contains(st.Epoch, pid) && st.LastTrustedBarrier >= time.Now().Unix()-1
	})
}

func (p *provEnv) eventually(what string, d time.Duration, cond func() bool) {
	p.t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			p.t.Fatalf("timed out after %v waiting for %s", d, what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// --- raw evidence: an independent Redis subscriber -----------------------

type rawEvent struct {
	T       float64 `json:"t"`
	Channel string  `json:"ch"`
	Msg     string  `json:"msg"`
}

type rawCapture struct {
	mu     sync.Mutex
	events []rawEvent
	f      *os.File
}

func (p *provEnv) startRawCapture(ctx context.Context) {
	f, err := os.OpenFile(filepath.Join(p.evid, "redis-events.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		p.t.Fatal(err)
	}
	p.raw = &rawCapture{f: f}
	go func() {
		for ctx.Err() == nil {
			c, err := coturnbridge.DialRedis(fmt.Sprintf("127.0.0.1:%d", p.redisPort), "", "", time.Second)
			if err != nil {
				time.Sleep(200 * time.Millisecond)
				continue
			}
			stop := context.AfterFunc(ctx, func() { c.Close() })
			c.Send("PSUBSCRIBE", "turn/*")
			for {
				fr, err := c.Read()
				if err != nil {
					break
				}
				pf, err := coturnbridge.Classify(fr)
				if err != nil || pf.Kind != "pmessage" {
					continue
				}
				ev := rawEvent{T: float64(time.Now().UnixMilli()) / 1000, Channel: pf.Channel, Msg: pf.Payload}
				p.raw.mu.Lock()
				p.raw.events = append(p.raw.events, ev)
				b, _ := json.Marshal(ev)
				p.raw.f.Write(append(b, '\n'))
				p.raw.mu.Unlock()
			}
			stop()
			c.Close()
		}
	}()
}

var reRawCounters = regexp.MustCompile(`rcvb=(\d+), sentp=\d+, sentb=(\d+)`)

// rawFor returns, for one username, the session ids seen, the sum of
// interval deltas and the final total (−1 if none) from the independent
// capture.
func (p *provEnv) rawFor(username string) (sids []string, deltas int64, final int64) {
	sids, deltas, final, _ = p.rawForAt(username)
	return
}

// rawForAt is rawFor plus when the provider's "deleted" status for the
// allocation was received (unix ms; 0 if none).
func (p *provEnv) rawForAt(username string) (sids []string, deltas int64, final int64, deletedAt int64) {
	final = -1
	p.raw.mu.Lock()
	defer p.raw.mu.Unlock()
	seen := map[string]bool{}
	for _, e := range p.raw.events {
		pre := "turn/realm/" + provRealm + "/user/" + username + "/allocation/"
		rest, ok := strings.CutPrefix(e.Channel, pre)
		if !ok {
			continue
		}
		sid, kind, _ := strings.Cut(rest, "/")
		if kind == "status" && e.Msg == "deleted" {
			deletedAt = int64(e.T * 1000)
		}
		if !seen[sid] {
			seen[sid] = true
			sids = append(sids, sid)
		}
		m := reRawCounters.FindStringSubmatch(e.Msg)
		if m == nil {
			continue
		}
		r, _ := strconv.ParseInt(m[1], 10, 64)
		s, _ := strconv.ParseInt(m[2], 10, 64)
		switch kind {
		case "traffic":
			deltas += r + s
		case "total_traffic":
			final = r + s
		}
	}
	return
}

// --- TURN client with a raw-byte-counting socket ---------------------------

type countConn struct {
	net.PacketConn
	sent, recv atomic.Int64
	frozen     atomic.Bool
	mu         sync.Mutex
	tail       []string // STUN control packets: direction, size, type
	channel    map[string]int
	// Allocate requests sent before coturn answered any of them. Exactly one
	// of them is answered; the others are retransmissions coturn never
	// accepted into a session (observed on a just-started darwin coturn), so
	// no provider accounting can include them.
	preAnswerAllocs    int
	preAnswerAllocSize int64
	answered           bool
	// grantLifetime/grantAt: LIFETIME of coturn's Allocate success response
	// and when the client received it (unix ms).
	grantLifetime int64
	grantAt       int64
	maxPacket     int // largest datagram either way
	sentRefresh   int // Refresh requests that actually left the client
	// errCodes: ERROR-CODE of every STUN error response received, in order.
	// watch: transaction ids whose responses are copied to the channel (the
	// harness's own raw requests; pion discards responses it did not ask for).
	errCodes []int
	watch    map[[12]byte]chan []byte
	// stunLog: every STUN control message, in order, with the peer address
	// of CreatePermission/ChannelBind requests (XOR-PEER-ADDRESS).
	stunLog []stunRec
}

type stunRec struct {
	Dir  string
	Type uint16
	Tx   [12]byte
	Peer string // CreatePermission / ChannelBind requests only
	At   time.Time
}

// xorPeerIP decodes an IPv4 XOR-PEER-ADDRESS (0x0012).
func xorPeerIP(b []byte) string {
	v, ok := stunAttrs(b)[0x0012]
	if !ok || len(v) != 8 || v[1] != 0x01 {
		return ""
	}
	return net.IPv4(v[4]^0x21, v[5]^0x12, v[6]^0xa4, v[7]^0x42).String()
}

// stunAttrs returns a STUN message's attributes (type -> value).
func stunAttrs(b []byte) map[int][]byte {
	out := map[int][]byte{}
	for i := 20; i+4 <= len(b); {
		typ, n := int(b[i])<<8|int(b[i+1]), int(b[i+2])<<8|int(b[i+3])
		if i+4+n > len(b) {
			break
		}
		out[typ] = b[i+4 : i+4+n]
		i += 4 + (n+3)/4*4
	}
	return out
}

// stunErrorCode is a STUN error response's ERROR-CODE, or 0.
func stunErrorCode(b []byte) int {
	if v, ok := stunAttrs(b)[0x0009]; ok && len(v) >= 4 {
		return int(v[2]&0x07)*100 + int(v[3])
	}
	return 0
}

// stunLifetime returns the LIFETIME attribute (0x000D) of a STUN message.
func stunLifetime(b []byte) int64 {
	for i := 20; i+4 <= len(b); {
		typ, n := int(b[i])<<8|int(b[i+1]), int(b[i+2])<<8|int(b[i+3])
		if typ == 0x000d && n == 4 && i+8 <= len(b) {
			return int64(b[i+4])<<24 | int64(b[i+5])<<16 | int64(b[i+6])<<8 | int64(b[i+7])
		}
		i += 4 + (n+3)/4*4
	}
	return -1
}

// describe names a packet for the evidence tail: STUN message type
// (method/class) or ChannelData.
func describe(b []byte) string {
	if len(b) >= 4 && b[0]&0xc0 == 0x40 {
		return "channeldata"
	}
	if len(b) >= 20 {
		return fmt.Sprintf("stun-0x%04x", uint16(b[0])<<8|uint16(b[1]))
	}
	return "short"
}

// note keeps every STUN control packet (bounded) and the last ChannelData
// packets, in order.
func (c *countConn) note(dir string, b []byte) {
	d := describe(b)
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case dir == "sent" && d == "stun-0x0003" && !c.answered:
		c.preAnswerAllocs++
		c.preAnswerAllocSize += int64(len(b))
	case dir == "recv" && (d == "stun-0x0113" || d == "stun-0x0103"):
		c.answered = true
	}
	if dir == "recv" && d == "stun-0x0103" && c.grantAt == 0 {
		c.grantLifetime, c.grantAt = stunLifetime(b), time.Now().UnixMilli()
	}
	if dir == "sent" && d == "stun-0x0004" {
		c.sentRefresh++
	}
	if len(b) >= 20 && b[0]&0xc0 == 0 && len(c.stunLog) < 4096 {
		r := stunRec{Dir: dir, Type: uint16(b[0])<<8 | uint16(b[1]), Tx: [12]byte(b[8:20]), At: time.Now()}
		if dir == "sent" && (r.Type == 0x0008 || r.Type == 0x0009) {
			r.Peer = xorPeerIP(b)
		}
		c.stunLog = append(c.stunLog, r)
	}
	if dir == "recv" && len(b) >= 20 && b[0]&0xc0 == 0 {
		if typ := uint16(b[0])<<8 | uint16(b[1]); typ&0x0110 == 0x0110 {
			c.errCodes = append(c.errCodes, stunErrorCode(b))
		}
		if ch, ok := c.watch[[12]byte(b[8:20])]; ok {
			select {
			case ch <- append([]byte(nil), b...):
			default:
			}
		}
	}
	c.maxPacket = max(c.maxPacket, len(b))
	if d == "channeldata" {
		c.channel[dir]++
		return
	}
	if len(c.tail) < 64 {
		c.tail = append(c.tail, fmt.Sprintf("%s %d %s (after %d/%d channeldata sent/recv)", dir, len(b), d, c.channel["sent"], c.channel["recv"]))
	}
}

func (c *countConn) WriteTo(b []byte, a net.Addr) (int, error) {
	if c.frozen.Load() {
		return len(b), nil // the client has vanished: nothing leaves
	}
	n, err := c.PacketConn.WriteTo(b, a)
	if err == nil {
		c.sent.Add(int64(n))
		c.note("sent", b[:n])
	}
	return n, err
}

func (c *countConn) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		n, a, err := c.PacketConn.ReadFrom(b)
		if err != nil {
			return n, a, err
		}
		if c.frozen.Load() {
			continue
		}
		c.recv.Add(int64(n))
		c.note("recv", b[:n])
		return n, a, nil
	}
}

type turnClient struct {
	p        *provEnv
	user     string // account id
	username string
	cc       *countConn
	cl       *turnv4.Client
	relay    net.PacketConn
	got      atomic.Int64
	done     chan struct{}

	// Stream transports (tcp/tls) only: plaintext bytes at the stream (what
	// coturn accounts) and, for TLS, the ciphertext bytes on the socket.
	transport string
	plain     *streamConn
	cipher    *streamConn
	password  string
	server    net.Addr
}

// streamConn counts the bytes read from and written to a stream.
type streamConn struct {
	net.Conn
	read, written atomic.Int64
}

func (c *streamConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	c.read.Add(int64(n))
	return n, err
}

func (c *streamConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	c.written.Add(int64(n))
	return n, err
}

func (p *provEnv) newUser(label string) string {
	p.t.Helper()
	u, err := p.store.UpsertUserByEmail(context.Background(), label+"-"+randHex(4)+"@example.com", "")
	if err != nil {
		p.t.Fatal(err)
	}
	return u.ID
}

func (p *provEnv) allocate(user string) *turnClient {
	p.t.Helper()
	username := fmt.Sprintf("%d:%s.g%s", time.Now().Add(time.Hour).Unix(), user, randHex(16))
	mac := hmac.New(sha1.New, []byte(p.secret))
	mac.Write([]byte(username))
	pass := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	raw, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		p.t.Fatal(err)
	}
	raw.(*net.UDPConn).SetReadBuffer(4 << 20)
	cc := &countConn{PacketConn: raw, channel: map[string]int{}}
	srv := fmt.Sprintf("127.0.0.1:%d", p.turnPort)
	cl, err := turnv4.NewClient(&turnv4.ClientConfig{
		STUNServerAddr: srv, TURNServerAddr: srv, Username: username, Password: pass,
		Realm: provRealm, Conn: cc,
	})
	if err != nil {
		p.t.Fatal(err)
	}
	if err := cl.Listen(); err != nil {
		p.t.Fatal(err)
	}
	relay, err := cl.Allocate()
	if err != nil {
		p.t.Fatalf("allocate: %v", err)
	}
	tc := &turnClient{p: p, user: user, username: username, cc: cc, cl: cl, relay: relay, done: make(chan struct{})}
	go func() {
		defer close(tc.done)
		buf := make([]byte, 2048)
		for {
			n, _, err := relay.ReadFrom(buf)
			if err != nil {
				return
			}
			tc.got.Add(int64(n))
		}
	}()
	return tc
}

// allocateOver allocates over a client transport: "udp" (as allocate),
// "tcp" (coturn's listening port) or "tls" (its TLS port, verified against
// the per-run CA). Over a stream, the existing byte counter wraps pion's
// STUNConn, so it counts whole framed messages (ChannelData padding
// included) — what coturn accounts.
func (p *provEnv) allocateOver(user, transport string) *turnClient {
	p.t.Helper()
	if transport == "udp" {
		tc := p.allocate(user)
		tc.transport = "udp"
		return tc
	}
	username := fmt.Sprintf("%d:%s.g%s", time.Now().Add(time.Hour).Unix(), user, randHex(16))
	mac := hmac.New(sha1.New, []byte(p.secret))
	mac.Write([]byte(username))
	pass := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	port := p.turnPort
	if transport == "tls" {
		port = p.tlsPort
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	raw, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		p.t.Fatal(err)
	}
	tc := &turnClient{p: p, user: user, username: username, transport: transport, done: make(chan struct{})}
	var stream net.Conn = raw
	if transport == "tls" {
		tc.cipher = &streamConn{Conn: raw}
		tlsConn := tls.Client(tc.cipher, &tls.Config{RootCAs: p.caPool, ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12})
		if err := tlsConn.Handshake(); err != nil {
			p.t.Fatalf("tls handshake: %v", err)
		}
		stream = tlsConn
	}
	tc.plain = &streamConn{Conn: stream}
	tc.cc = &countConn{PacketConn: turnv4.NewSTUNConn(tc.plain), channel: map[string]int{}}
	cl, err := turnv4.NewClient(&turnv4.ClientConfig{
		STUNServerAddr: addr, TURNServerAddr: addr, Username: username, Password: pass,
		Realm: provRealm, Conn: tc.cc,
	})
	if err != nil {
		p.t.Fatal(err)
	}
	if err := cl.Listen(); err != nil {
		p.t.Fatal(err)
	}
	relay, err := cl.Allocate()
	if err != nil {
		p.t.Fatalf("allocate over %s: %v", transport, err)
	}
	tc.cl, tc.relay = cl, relay
	go func() {
		defer close(tc.done)
		buf := make([]byte, 2048)
		for {
			n, _, err := relay.ReadFrom(buf)
			if err != nil {
				return
			}
			tc.got.Add(int64(n))
		}
	}()
	return tc
}

// dropStream closes a tcp/tls client's connection without any TURN
// message: coturn ends a stream client's allocation with its connection.
func (tc *turnClient) dropStream() {
	tc.cc.frozen.Store(true)
	tc.plain.Close()
	tc.cl.Close()
}

// makeTLSFixture writes a per-run private CA and a server certificate for
// 127.0.0.1 signed by it (ECDSA P-256, valid one hour). The keys stay in the
// private work dir; only SHA-256 fingerprints reach the evidence.
func (p *provEnv) makeTLSFixture() {
	p.t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	now := time.Now()
	caTmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "relayium coturn harness CA"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		p.t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	srvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	srvTmpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	srvDER, err := x509.CreateCertificate(rand.Reader, srvTmpl, caCert, &srvKey.PublicKey, caKey)
	if err != nil {
		p.t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(srvKey)
	if err != nil {
		p.t.Fatal(err)
	}
	p.tlsCert, p.tlsKey = filepath.Join(p.dir, "tls-cert.pem"), filepath.Join(p.dir, "tls-key.pem")
	os.WriteFile(p.tlsCert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srvDER}), 0o600)
	os.WriteFile(p.tlsKey, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
	p.caPool = x509.NewCertPool()
	p.caPool.AddCert(caCert)
	ca, srv := sha256.Sum256(caDER), sha256.Sum256(srvDER)
	p.caFingerprint = hex.EncodeToString(ca[:])
	p.logf("TLS fixture: CA sha256 %s, server cert sha256 %s (keys not exported)", p.caFingerprint, hex.EncodeToString(srv[:]))
}

// pump sends rounds datagrams of size bytes to the echo peer through the
// relay, paced to keep loopback UDP lossless, and waits for every echo.
func (tc *turnClient) pump(rounds, size int) {
	tc.p.t.Helper()
	peer := tc.p.peer.LocalAddr()
	buf := make([]byte, size)
	want := tc.got.Load() + int64(rounds*size)
	for i := range rounds {
		if _, err := tc.relay.WriteTo(buf, peer); err != nil {
			tc.p.t.Fatalf("relay write: %v", err)
		}
		if i%50 == 49 {
			time.Sleep(20 * time.Millisecond)
		}
	}
	deadline := time.Now().Add(15 * time.Second)
	for tc.got.Load() < want {
		if time.Now().After(deadline) {
			tc.p.t.Fatalf("echo incomplete: got %d of %d payload bytes (loopback loss?)", tc.got.Load(), want)
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond) // let stray replies (permission/channel) land
}

// close releases the allocation the normal way (Refresh lifetime 0) and keeps
// reading long enough to count coturn's reply.
func (tc *turnClient) close() {
	tc.relay.Close()
	time.Sleep(700 * time.Millisecond)
	tc.cl.Close()
	tc.cc.frozen.Store(true)
}

// vanish stops all client I/O without telling coturn.
func (tc *turnClient) vanish() {
	tc.cc.frozen.Store(true)
	tc.relay.Close() // its Refresh(0) is swallowed by the frozen socket
	tc.cl.Close()
}

func (tc *turnClient) raw() int64 { return tc.cc.sent.Load() + tc.cc.recv.Load() }

func (p *provEnv) startPeer() {
	p.t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		p.t.Fatal(err)
	}
	c.SetReadBuffer(4 << 20)
	p.peer = c
	go func() {
		buf := make([]byte, 65536)
		for {
			n, a, err := c.ReadFromUDP(buf)
			if err != nil {
				return
			}
			p.peerN.Add(1)
			c.WriteToUDP(buf[:n], a)
		}
	}()
}

// --- reconciliation ----------------------------------------------------------

type reconRow struct {
	Scenario   string `json:"scenario"`
	SessionIDs string `json:"sessionIds"`
	ClientRaw  int64  `json:"clientRawSentPlusRecv"`
	ClientSent int64  `json:"clientRawSent"`
	ClientRecv int64  `json:"clientRawRecv"`
	RawDeltas  int64  `json:"coturnIntervalDeltaSum"`
	RawFinal   int64  `json:"coturnFinal"` // -1: none published
	BridgeCum  int64  `json:"bridgeAcceptedCumulative"`
	Ledger     int64  `json:"ledgerBillable"`
	Bindings   int    `json:"bindings"`
	Loss       int64  `json:"lossClientMinusLedger"`
	Exactness  string `json:"exactness"`
	// UnansweredRetransmits is the client bytes of Allocate retransmissions
	// coturn never answered (pre-session), excluded from what any provider
	// can account; the rest of ClientRaw must equal coturn's final exactly.
	UnansweredRetransmits int64    `json:"unansweredPreSessionAllocateBytes"`
	ClientTail            []string `json:"clientControlPackets"`
	GrantLifetimeSecs     int64    `json:"grantLifetimeSecs"`
	GrantAtMilli          int64    `json:"grantAtUnixMilli"`
	ProviderDeletedMilli  int64    `json:"providerDeletedAtUnixMilli"`
	RefreshesSent         int      `json:"refreshRequestsSent"`
	MaxClientPacket       int      `json:"maxClientDatagram"`
	// Stream transports: the client's transport, the plaintext stream bytes
	// (read + written) and, for TLS, the ciphertext bytes on the socket.
	Transport        string `json:"transport,omitempty"`
	StreamPlainBytes int64  `json:"streamPlainBytes,omitempty"`
	TLSCipherBytes   int64  `json:"tlsCipherBytes,omitempty"`
	RelayThreadMode  string `json:"relayThreadMode,omitempty"`
	RelayThreads     int    `json:"relayThreadsLogged,omitempty"`
}

func (p *provEnv) binding(username string) (account.CoturnBinding, int) {
	h := sha256.Sum256([]byte(username))
	want := hex.EncodeToString(h[:])
	bs, err := p.store.CoturnBindings(context.Background())
	if err != nil {
		p.t.Fatal(err)
	}
	var out account.CoturnBinding
	n := 0
	for _, b := range bs {
		if b.UsernameHash == want {
			out = b
			n++
		}
	}
	return out, n
}

func (p *provEnv) ledger(user string) int64 {
	n, err := p.store.UserRelayedSince(context.Background(), user, 0)
	if err != nil {
		p.t.Fatal(err)
	}
	return n
}

// settle waits until the allocation's binding is terminal and its ledger
// stops moving, then records a reconciliation row.
func (p *provEnv) settle(scenario string, tc *turnClient, timeout time.Duration) reconRow {
	p.t.Helper()
	p.eventually(scenario+": terminal binding", timeout, func() bool {
		b, n := p.binding(tc.username)
		return n == 1 && b.Terminal && b.Accepted == b.LastCumulative
	})
	b, n := p.binding(tc.username)
	sids, deltas, final, deletedAt := p.rawForAt(tc.username)
	row := reconRow{
		Scenario: scenario, SessionIDs: strings.Join(sids, ","),
		ClientRaw: tc.raw(), ClientSent: tc.cc.sent.Load(), ClientRecv: tc.cc.recv.Load(),
		RawDeltas: deltas, RawFinal: final, BridgeCum: b.Accepted, Ledger: p.ledger(tc.user), Bindings: n,
	}
	tc.cc.mu.Lock()
	row.ClientTail = append([]string(nil), tc.cc.tail...)
	row.GrantLifetimeSecs, row.GrantAtMilli, row.ProviderDeletedMilli = tc.cc.grantLifetime, tc.cc.grantAt, deletedAt
	row.RefreshesSent, row.MaxClientPacket = tc.cc.sentRefresh, tc.cc.maxPacket
	row.Transport, row.RelayThreadMode, row.RelayThreads = tc.transport, p.relayThreads, p.threadsLogged
	if tc.plain != nil {
		row.StreamPlainBytes = tc.plain.read.Load() + tc.plain.written.Load()
	}
	if tc.cipher != nil {
		row.TLSCipherBytes = tc.cipher.read.Load() + tc.cipher.written.Load()
	}
	if tc.cc.preAnswerAllocs > 1 {
		row.UnansweredRetransmits = tc.cc.preAnswerAllocSize / int64(tc.cc.preAnswerAllocs) * int64(tc.cc.preAnswerAllocs-1)
	}
	tc.cc.mu.Unlock()
	row.Loss = row.ClientRaw - row.UnansweredRetransmits - row.Ledger
	p.rows = append(p.rows, row)
	p.logf("%s: %+v", scenario, row)
	return row
}

func (p *provEnv) requireExact(row reconRow) {
	p.t.Helper()
	want := row.ClientRaw - row.UnansweredRetransmits
	if row.RawFinal != want || row.BridgeCum != want || row.Ledger != want || row.Bindings != 1 {
		p.t.Errorf("%s NOT exact: client %d (sent %d recv %d, unanswered pre-session %d) coturn final %d bridge %d ledger %d bindings %d",
			row.Scenario, row.ClientRaw, row.ClientSent, row.ClientRecv, row.UnansweredRetransmits, row.RawFinal, row.BridgeCum, row.Ledger, row.Bindings)
		return
	}
	p.rows[len(p.rows)-1].Exactness = "exact"
}

// setupProvider starts Redis, the raw capture, the echo peer, central,
// coturn and the main bridge; teardown and evidence are registered with
// t.Cleanup. evidSub separates a test's evidence inside the evidence dir.
func setupProvider(t *testing.T, evidSub string) (*provEnv, time.Duration) {
	return setupProviderWith(t, evidSub, false)
}

// setupProviderWith is setupProvider with an optional TLS listener (private
// per-run CA). The relay thread mode comes from
// RELAYIUM_COTURN_PROVIDER_RELAY_THREADS: unset or "1" (the pinned fixture),
// "default" (coturn's CPU-based default) or a positive number.
func setupProviderWith(t *testing.T, evidSub string, withTLS bool) (*provEnv, time.Duration) {
	return setupProviderOpts(t, evidSub, provOpts{tls: withTLS, billableSince: 1})
}

// provOpts: tls adds the TLS listener; billableSince is central's activation
// time (1 for the primary fixtures, so any reliance on the bridge's reserved
// unknown-start value 1 still shows as a non-billable binding there);
// recordSnapshots keeps, test-side, every snapshot central receives.
type provOpts struct {
	tls             bool
	billableSince   int64
	recordSnapshots bool
}

func setupProviderOpts(t *testing.T, evidSub string, o provOpts) (*provEnv, time.Duration) {
	bin := os.Getenv("RELAYIUM_COTURN_PROVIDER_BIN")
	if bin == "" {
		t.Skip("opt-in: set RELAYIUM_COTURN_PROVIDER_BIN to a coturn 4.6.1 bin dir (scripts/test/coturn-metering-provider.sh)")
	}
	redisBin, err := exec.LookPath("redis-server")
	if err != nil {
		t.Fatal("redis-server not on PATH")
	}
	outage := 5 * time.Minute
	if v := os.Getenv("RELAYIUM_COTURN_PROVIDER_OUTAGE"); v != "" {
		if outage, err = time.ParseDuration(v); err != nil {
			t.Fatal(err)
		}
	}
	evid := os.Getenv("RELAYIUM_COTURN_PROVIDER_EVIDENCE")
	if evid == "" {
		evid = t.TempDir()
	}
	if evidSub != "" {
		evid = filepath.Join(evid, evidSub)
	}
	if err := os.MkdirAll(evid, 0o700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "cm-prov-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	for _, d := range []string{"spool", "psd"} {
		os.MkdirAll(filepath.Join(dir, d), 0o700)
	}

	p := &provEnv{t: t, bin: bin, redisBin: redisBin, dir: dir, evid: evid,
		secret: randHex(16), cliPass: randHex(12), token: randHex(24)}
	p.relayThreads = os.Getenv("RELAYIUM_COTURN_PROVIDER_RELAY_THREADS")
	switch p.relayThreads {
	case "", "1":
		p.relayThreads = "1"
	case "default":
	default:
		if n, err := strconv.Atoi(p.relayThreads); err != nil || n < 1 {
			t.Fatalf("RELAYIUM_COTURN_PROVIDER_RELAY_THREADS=%q: want 1, default or a positive number", p.relayThreads)
		}
	}
	p.billableSince, p.recordSnapshots = o.billableSince, o.recordSnapshots
	p.redisPort, p.turnPort, p.cliPort = freePort(t), freePort(t), freePort(t)
	if o.tls {
		p.tlsPort = freePort(t)
		p.makeTLSFixture()
	}
	cp := freePort(t)
	p.centralLn = fmt.Sprintf("127.0.0.1:%d", cp)
	p.centralURL = "http://" + p.centralLn
	p.relayMin = 52000 + int(time.Now().UnixNano()%5000)
	p.writeSecret("cli.pass", p.cliPass)
	p.writeSecret("token", p.token)

	// The evidence script builds and hashes the bridge before the run;
	// without it (development) the harness builds one.
	p.bridgeBin = os.Getenv("RELAYIUM_COTURN_PROVIDER_BRIDGE_BIN")
	if p.bridgeBin == "" {
		p.bridgeBin = filepath.Join(dir, "relayium-coturn-bridge")
		if out, err := exec.Command("go", "build", "-o", p.bridgeBin, "./cmd/relayium-coturn-bridge").CombinedOutput(); err != nil {
			t.Fatalf("build bridge: %v\n%s", err, out)
		}
	}
	p.tokenB = randHex(24)
	p.writeSecret("token-b", p.tokenB)
	os.MkdirAll(filepath.Join(dir, "spool-b"), 0o700)

	p.store, err = account.OpenSQLite(filepath.Join(dir, "central.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.store.Close() })
	p.ingest, err = account.NewCoturnMeteringIngest(p.store, nil, account.CoturnMeteringConfig{
		Relays: map[string][32]byte{"coturn-local": sha256.Sum256([]byte(p.token)), "coturn-local-b": sha256.Sum256([]byte(p.tokenB))},
		Mode:   account.CoturnMeteringBillable, BillableSince: o.billableSince,
		Logf: func(f string, a ...any) { p.logf("central: "+f, a...) },
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	p.startRedis()
	p.startRawCapture(ctx)
	p.startPeer()
	p.startCentral()
	p.startCoturn()
	p.startBridge()
	t.Cleanup(func() {
		if p.bridgeB != nil {
			p.bridgeB.Process.Signal(syscall.SIGTERM)
			p.bridgeB.Wait()
		}
		p.stopBridge(syscall.SIGTERM)
		if p.coturn != nil {
			p.signalCoturn(syscall.SIGKILL)
		}
		p.stopRedis()
		p.stopCentral()
		p.writeEvidence()
	})
	return p, outage
}

// drain runs the bridge's drain command against the running coturn.
func (p *provEnv) drain() ([]byte, error) {
	cmd := exec.Command(p.bridgeBin, "drain",
		"-cli-addr", fmt.Sprintf("127.0.0.1:%d", p.cliPort), "-cli-password-file", filepath.Join(p.dir, "cli.pass"),
		"-psd-path", filepath.Join(p.dir, "psd", "psd.txt"), "-spool-dir", filepath.Join(p.dir, "spool"),
		"-coturn-pidfile", filepath.Join(p.dir, "turnserver.pid"), "-drain-timeout", "60s")
	out, err := cmd.CombinedOutput()
	f, _ := os.OpenFile(filepath.Join(p.evid, "drain.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	f.Write(out)
	f.Close()
	return out, err
}

func TestCoturnMeteringProviderReconciliation(t *testing.T) {
	p, outage := setupProvider(t, "")

	const rounds, size = 3000, 1000

	// S2 natural lifetime expiry, started first: the client vanishes without
	// refreshing. The coturn config, like production, sets no
	// max-allocate-lifetime; pion's Allocate requests no LIFETIME, so coturn
	// grants its 600 s default. The granted LIFETIME (from the Allocate
	// response) and the provider's own deletion time (its "deleted" status,
	// captured independently) are recorded and checked; it is settled after S4.
	// RELAYIUM_COTURN_PROVIDER_DEBUG_NO_EXPIRY=1 skips it for harness debugging
	// only; evidence runs must not set it.
	runExpiry := os.Getenv("RELAYIUM_COTURN_PROVIDER_DEBUG_NO_EXPIRY") == ""
	var c2 *turnClient
	var s2vanished time.Time
	if runExpiry {
		c2 = p.allocate(p.newUser("s2"))
		c2.pump(rounds, size)
		c2.vanish()
		s2vanished = time.Now()
	} else {
		p.logf("DEBUG: lifetime-expiry scenario skipped (not an evidence run)")
	}

	// S1 normal close.
	c := p.allocate(p.newUser("s1"))
	c.pump(rounds, size)
	c.close()
	p.requireExact(p.settle("S1 normal close (Refresh lifetime=0)", c, 30*time.Second))

	// S10 two relay identities metering the same coturn (a duplicated
	// bridge): the provider allocation is one ledger allocation, billed once.
	p.bridgeB = p.bridgeCmd("coturn-local-b", "spool-b", "token-b", "psd-b.txt", "bridge-b.log")
	p.eventually("second bridge confirms the epoch", 20*time.Second, func() bool {
		st := p.statusOf("spool-b")
		return st.SubscriptionUp && st.LastTrustedBarrier >= time.Now().Unix()-1
	})
	c = p.allocate(p.newUser("s10"))
	c.pump(rounds, size)
	c.close()
	p.requireExact(p.settle("S10 two relay identities, one coturn", c, 30*time.Second))
	time.Sleep(3 * time.Second) // both bridges have delivered their finals
	p.bridgeB.Process.Signal(syscall.SIGTERM)
	p.bridgeB.Wait()
	p.bridgeB = nil
	s10sids, _, _ := p.rawFor(c.username)
	conflicts := 0
	for _, n := range p.notes {
		if strings.Contains(n, "another relay identity") {
			conflicts++
		}
	}
	p.logf("S10: raw session %v; central refused %d snapshots from the non-owning relay; second bridge status %+v", s10sids, conflicts, p.statusOf("spool-b"))
	if conflicts == 0 {
		t.Error("S10: no cross-relay conflict observed: was the allocation seen by both bridges?")
	}
	p.s10sid = strings.Join(s10sids, ",")

	// S3 bridge SIGKILL mid-allocation, restarted twice (once while psd
	// listings are being taken every 2s); the final still settles exactly.
	c = p.allocate(p.newUser("s3"))
	c.pump(rounds/2, size)
	time.Sleep(6500 * time.Millisecond) // at least one psd listing spooled
	p.stopBridge(syscall.SIGKILL)
	c.pump(rounds/2, size)
	p.startBridge()
	time.Sleep(5900 * time.Millisecond) // around the restarted bridge's first listing
	p.stopBridge(syscall.SIGKILL)
	p.startBridge()
	c.pump(rounds/2, size)
	c.close()
	p.requireExact(p.settle("S3 bridge SIGKILL x2 and restart", c, 30*time.Second))

	// S4 central down for `outage` while an allocation lives and closes.
	p.stopCentral()
	down := time.Now()
	c = p.allocate(p.newUser("s4"))
	c.pump(rounds, size)
	c.close()
	p.eventually("final spooled while central is down", 30*time.Second, func() bool {
		_, _, final := p.rawFor(c.username)
		return final >= 0 && p.status().ReportFailingSince > 0
	})
	if _, n := p.binding(c.username); n != 0 {
		t.Fatal("binding exists while central is down")
	}
	time.Sleep(time.Until(down.Add(outage)))
	p.logf("central outage lasted %v (bridge status %+v)", time.Since(down).Round(time.Second), p.status())
	p.startCentral()
	p.requireExact(p.settle(fmt.Sprintf("S4 central down %v", outage), c, 2*time.Minute))

	if runExpiry {
		r2 := p.settle("S2 natural lifetime expiry (client vanished, no refresh)", c2, time.Until(s2vanished.Add(13*time.Minute)))
		p.requireExact(r2)
		life := r2.ProviderDeletedMilli - r2.GrantAtMilli
		p.logf("S2: granted LIFETIME %d s at %d; provider deleted at %d (%.3f s after the grant); refreshes sent %d",
			r2.GrantLifetimeSecs, r2.GrantAtMilli, r2.ProviderDeletedMilli, float64(life)/1000, r2.RefreshesSent)
		if r2.GrantLifetimeSecs != 600 || r2.RefreshesSent != 0 || life < 600_000 || life > 603_000 {
			t.Errorf("S2 is not a natural 600 s expiry: lifetime %d, refreshes %d, deleted %d ms after the grant", r2.GrantLifetimeSecs, r2.RefreshesSent, life)
		}
	}

	// S5 drained coturn stop: drain (cs → forced final), then SIGTERM.
	c = p.allocate(p.newUser("s5"))
	c.pump(rounds, size)
	c.cc.frozen.Store(true) // stop client I/O; drain cancels the session
	if out, err := p.drain(); err != nil {
		t.Fatalf("drain: %v\n%s", err, out)
	}
	p.signalCoturn(syscall.SIGTERM)
	sidsE1, _, _ := p.rawFor(c.username)
	p.requireExact(p.settle("S5 drain then coturn SIGTERM", c, 30*time.Second))
	c.cl.Close()

	// S6 bare SIGTERM (no drain): measured loss, reported separately.
	p.startCoturn()
	p.waitBridgeEpoch()
	c = p.allocate(p.newUser("s6"))
	c.pump(rounds, size)
	c.cc.frozen.Store(true)
	time.Sleep(7 * time.Second) // a psd listing after the last delta
	p.signalCoturn(syscall.SIGTERM)
	r6 := p.settle("S6 bare coturn SIGTERM (no drain)", c, 60*time.Second)
	sidsE2, _, _ := p.rawFor(c.username)
	c.cl.Close()

	// S7 coturn SIGKILL.
	p.startCoturn()
	p.waitBridgeEpoch()
	c = p.allocate(p.newUser("s7"))
	c.pump(rounds, size)
	c.cc.frozen.Store(true)
	time.Sleep(7 * time.Second)
	p.signalCoturn(syscall.SIGKILL)
	r7 := p.settle("S7 coturn SIGKILL", c, 60*time.Second)
	sidsE3, _, _ := p.rawFor(c.username)
	c.cl.Close()
	for _, r := range []reconRow{r6, r7} {
		// No final: the ledger is exactly the lower bound the provider
		// published (sum of interval deltas, which psd also reports), never
		// more than the client sent+received, and the loss is what coturn had
		// counted since its last 4096-packet report.
		if r.RawFinal != -1 || r.Ledger != r.RawDeltas || r.Loss < 0 || r.Bindings != 1 {
			t.Errorf("%s: no-final accounting not the published lower bound: %+v", r.Scenario, r)
		}
		// coturn reports when the four packet counters reach a multiple of
		// 4096, counting one event per client read/write; on this UDP
		// transport an event is at most one datagram, so the unreported
		// client bytes are < 4096 × the largest datagram seen. (TCP/TLS
		// count one up-to-64 KiB buffer per event: a far larger bound.)
		if bound := int64(4095) * int64(r.MaxClientPacket); r.Loss < 0 || r.Loss > bound {
			t.Errorf("%s: loss %d outside 4095 × %d", r.Scenario, r.Loss, r.MaxClientPacket)
		}
		p.rows[indexRow(p.rows, r.Scenario)].Exactness = fmt.Sprintf("lower bound; measured loss %d bytes", r.Loss)
	}

	// S8 same raw session id across coturn epochs and users.
	p.startCoturn()
	p.waitBridgeEpoch()
	c = p.allocate(p.newUser("s8"))
	c.pump(rounds/3, size)
	c.close()
	p.requireExact(p.settle("S8 after restarts (raw id reuse check)", c, 30*time.Second))
	sidsE4, _, _ := p.rawFor(c.username)
	p.logf("raw session ids per epoch: E1 %v E2 %v E3 %v E4 %v", sidsE1, sidsE2, sidsE3, sidsE4)
	reused := map[string]int{}
	for _, s := range [][]string{sidsE1, sidsE2, sidsE3, sidsE4} {
		for _, id := range s {
			reused[id]++
		}
	}
	collided := false
	for id, n := range reused {
		if n > 1 {
			collided = true
			p.logf("raw session id %s used by %d different allocations/users across epochs: each billed to its own owner", id, n)
		}
	}
	switch {
	case !collided && p.relayThreads == "1":
		t.Errorf("relay-threads=1 should make coturn reuse raw session ids across restarts; none collided: %v", reused)
	case !collided:
		// Several relay threads: session ids carry a thread prefix, so a
		// collision is chance. The global key and per-owner billing are
		// asserted by the rows above either way.
		p.logf("relay threads %q (coturn logged %d): no raw session id collision this run", p.relayThreads, p.threadsLogged)
	}

	// S9 Redis restart while an allocation is live (hiredis reconnect is a
	// provider assumption the brief lists as unproven): measured, not assumed.
	c = p.allocate(p.newUser("s9"))
	c.pump(rounds/2, size)
	time.Sleep(2500 * time.Millisecond)
	p.stopRedis()
	p.logf("redis DOWN")
	c.pump(rounds, size) // interval reports published into the void
	time.Sleep(2 * time.Second)
	p.startRedis()
	p.logf("redis UP")
	c.pump(rounds/2, size)
	time.Sleep(3 * time.Second)
	c.close()
	r9 := p.settle("S9 redis restart mid-allocation", c, 60*time.Second)
	if r9.Loss < 0 || r9.Bindings != 1 {
		t.Errorf("S9 over-count or split: %+v", r9)
	}
	if r9.Loss == 0 {
		p.rows[len(p.rows)-1].Exactness = "exact (coturn republished after Redis returned)"
	} else {
		p.rows[len(p.rows)-1].Exactness = fmt.Sprintf("lower bound; measured loss %d bytes", r9.Loss)
	}

	// S11 owner hard-purged mid-allocation: after the purge nothing for the
	// allocation is billed or stored against the account; central keeps only
	// a redacted tombstone and the bridge removes its record (no dead letter).
	s11user := p.newUser("s11")
	c = p.allocate(s11user)
	c.pump(rounds/2, size)
	p.eventually("S11 live snapshot billed", 30*time.Second, func() bool { return p.ledger(s11user) > 0 })
	ctx11 := context.Background()
	if err := p.store.SetAccountDeletion(ctx11, s11user, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := p.store.ArchiveAndPurgeUser(ctx11, s11user, 200); err != nil {
		t.Fatal(err)
	}
	c.pump(rounds/2, size)
	c.close()
	_, _, s11final := p.rawFor(c.username)
	p.eventually("S11 bridge record removed after gone", 60*time.Second, func() bool {
		_, _, f := p.rawFor(c.username)
		return f >= 0 && p.status().Unsettled == 0 && p.status().Allocations <= 1
	})
	_, _, s11final = p.rawFor(c.username)
	var tomb account.CoturnBinding
	bs11, _ := p.store.CoturnBindings(ctx11)
	for _, b := range bs11 {
		if b.Purged {
			tomb = b
		}
	}
	p.logf("S11: coturn final %d; ledger for the purged owner %d; tombstone %+v", s11final, p.ledger(s11user), tomb)
	if p.ledger(s11user) != 0 || !tomb.Purged || tomb.UserID != "" || tomb.UsernameHash != "" || tomb.Accepted != 0 || tomb.AllocID != "" {
		t.Errorf("S11: purged owner billed or tombstone not redacted: ledger %d, %+v", p.ledger(s11user), tomb)
	}

	// Aggregate: every billable byte in the ledger belongs to exactly one of
	// these allocations' owners.
	var sumLedger, sumRows int64
	for _, r := range p.rows {
		sumRows += r.Ledger
	}
	bs, _ := p.store.CoturnBindings(context.Background())
	for _, b := range bs {
		if b.Purged {
			continue // S11's redacted tombstone
		}
		if b.Ledger != "billable" {
			t.Errorf("binding %s/%s not billable", b.BootID, b.SessionID)
		}
		sumLedger += b.Accepted
	}
	p.logf("aggregate: %d bindings, ledger accepted %d, per-scenario owners %d", len(bs), sumLedger, sumRows)
	if sumLedger != sumRows {
		t.Errorf("aggregate mismatch: bindings %d vs owners %d", sumLedger, sumRows)
	}
}

func indexRow(rows []reconRow, scenario string) int {
	for i, r := range rows {
		if r.Scenario == scenario {
			return i
		}
	}
	return -1
}

func (p *provEnv) writeEvidence() {
	b, _ := json.MarshalIndent(p.rows, "", "  ")
	os.WriteFile(filepath.Join(p.evid, "reconciliation.json"), b, 0o600)
	os.WriteFile(filepath.Join(p.evid, "harness.log"), []byte(strings.Join(p.notes, "\n")+"\n"), 0o600)
	bs, _ := p.store.CoturnBindings(context.Background())
	sort.Slice(bs, func(i, j int) bool { return bs[i].AllocID < bs[j].AllocID })
	var sb strings.Builder
	w := bufio.NewWriter(&sb)
	for _, x := range bs {
		fmt.Fprintf(w, "%s boot=%s pid=%d start=%d sid=%s ledger=%s seq=%d cum=%d accepted=%d terminal=%v\n",
			x.AllocID, x.BootID, x.PID, x.StartTicks, x.SessionID, x.Ledger, x.LastSeq, x.LastCumulative, x.Accepted, x.Terminal)
	}
	w.Flush()
	os.WriteFile(filepath.Join(p.evid, "ledger-bindings.txt"), []byte(sb.String()), 0o600)
	if psd, err := os.ReadFile(filepath.Join(p.dir, "psd", "psd.txt")); err == nil {
		os.WriteFile(filepath.Join(p.evid, "psd-last.txt"), psd, 0o600)
	}
	// Nothing a real coturn publishes may be quarantined as malformed:
	// STUN-only sessions are counted, not treated as malformed.
	if q, err := os.ReadFile(filepath.Join(p.dir, "spool", "quarantine.jsonl")); err == nil && strings.Contains(string(q), "malformed") {
		p.t.Errorf("real coturn messages quarantined as malformed:\n%s", q)
	}
	// The main bridge may lose ownership of S10's allocation to the second
	// relay (whichever reported first owns it); its dead letters must be
	// exactly those cross-relay refusals.
	if ents, _ := os.ReadDir(filepath.Join(p.dir, "spool", "dead")); len(ents) > 0 {
		for _, e := range ents {
			raw, _ := os.ReadFile(filepath.Join(p.dir, "spool", "dead", e.Name()))
			if !strings.Contains(string(raw), "another relay identity") || p.s10sid == "" || !strings.Contains(string(raw), `"sessionId":"`+p.s10sid+`"`) {
				p.t.Errorf("unexpected dead letter %s: %s", e.Name(), raw)
			}
			os.WriteFile(filepath.Join(p.evid, "dead-main-"+e.Name()), raw, 0o600)
		}
	}
	if ents, _ := os.ReadDir(filepath.Join(p.dir, "spool-b", "dead")); len(ents) > 0 {
		for _, e := range ents {
			raw, _ := os.ReadFile(filepath.Join(p.dir, "spool-b", "dead", e.Name()))
			os.WriteFile(filepath.Join(p.evid, "dead-b-"+e.Name()), raw, 0o600)
		}
	}
	for _, d := range []string{"corrupt"} {
		ents, _ := os.ReadDir(filepath.Join(p.dir, "spool", d))
		if len(ents) > 0 {
			p.t.Errorf("spool %s/ holds %d records", d, len(ents))
		}
	}
	if q, err := os.ReadFile(filepath.Join(p.dir, "spool", "quarantine.jsonl")); err == nil {
		os.WriteFile(filepath.Join(p.evid, "quarantine.jsonl"), q, 0o600)
	}
	if st, err := os.ReadFile(filepath.Join(p.dir, "spool", "status.json")); err == nil {
		os.WriteFile(filepath.Join(p.evid, "bridge-status-final.json"), st, 0o600)
	}
}

// S12 (Fable drain/gone blocker): the owner of a LIVE allocation is
// hard-purged, then coturn is drained and stopped. Drain cancels the session;
// central answers its final with gone; Drain must accept that identity-only
// gone mark (not as a final) and complete, nothing is billed, and no user data
// remains in central or on the bridge's host.
func TestCoturnMeteringProviderPurgedDrain(t *testing.T) {
	p, _ := setupProvider(t, "s12-purged-drain")
	const rounds, size = 3000, 1000
	kept := p.newUser("s12-kept")
	ck := p.allocate(kept) // a second, normal allocation drained alongside
	ck.pump(rounds/3, size)
	purged := p.newUser("s12-purged")
	c := p.allocate(purged)
	c.pump(rounds/2, size)
	p.eventually("S12 live snapshot billed", 30*time.Second, func() bool { return p.ledger(purged) > 0 })
	ctx := context.Background()
	if err := p.store.SetAccountDeletion(ctx, purged, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := p.store.ArchiveAndPurgeUser(ctx, purged, 200); err != nil {
		t.Fatal(err)
	}
	c.pump(rounds/2, size)
	c.cc.frozen.Store(true)
	ck.cc.frozen.Store(true)
	start := time.Now()
	out, err := p.drain()
	if err != nil {
		t.Fatalf("drain with a purged owner's live allocation: %v\n%s", err, out)
	}
	p.logf("S12: drain completed in %v: %s", time.Since(start).Round(time.Millisecond), strings.TrimSpace(string(out)))
	p.signalCoturn(syscall.SIGTERM)
	p.requireExact(p.settle("S12 kept owner drained alongside", ck, 30*time.Second))

	_, _, final := p.rawFor(c.username)
	var tomb account.CoturnBinding
	bs, _ := p.store.CoturnBindings(ctx)
	for _, b := range bs {
		if b.Purged {
			tomb = b
		}
	}
	marks, _ := os.ReadDir(filepath.Join(p.dir, "spool", "gone"))
	var markRaw []byte
	if len(marks) == 1 {
		markRaw, _ = os.ReadFile(filepath.Join(p.dir, "spool", "gone", marks[0].Name()))
	}
	p.logf("S12: coturn final %d for the purged owner; ledger %d; tombstone %+v; bridge gone mark %s", final, p.ledger(purged), tomb, markRaw)
	row := reconRow{Scenario: "S12 purged owner live at drain", RawFinal: final, Ledger: p.ledger(purged), BridgeCum: tomb.Accepted,
		Exactness: "owner purged: nothing billed, drain completed via identity-only gone mark"}
	p.rows = append(p.rows, row)
	if final < 0 || p.ledger(purged) != 0 || !tomb.Purged || tomb.UserID != "" || tomb.UsernameHash != "" || tomb.Accepted != 0 {
		t.Errorf("S12: billed or not redacted: final %d ledger %d tombstone %+v", final, p.ledger(purged), tomb)
	}
	if len(marks) != 1 || strings.Contains(string(markRaw), purged) || strings.Contains(string(markRaw), "username") {
		t.Errorf("S12: bridge gone mark missing or carrying user data: %d marks %s", len(marks), markRaw)
	}
}

// --- production equivalence (test-only) ---------------------------------------

// checkStreamRow adds the stream-transport facts to an exact row: over a
// stream the counter of framed messages must equal the plaintext stream
// bytes, and TLS ciphertext (never accounted) must exceed the plaintext.
func (p *provEnv) checkStreamRow(r reconRow, normalClose bool) {
	p.t.Helper()
	if r.Transport == "udp" {
		return
	}
	if normalClose && r.StreamPlainBytes != r.ClientRaw {
		p.t.Errorf("%s: plaintext stream bytes %d != framed messages counted %d", r.Scenario, r.StreamPlainBytes, r.ClientRaw)
	}
	if r.StreamPlainBytes < r.ClientRaw {
		p.t.Errorf("%s: plaintext stream bytes %d below framed messages %d", r.Scenario, r.StreamPlainBytes, r.ClientRaw)
	}
	if r.Transport == "tls" && r.TLSCipherBytes <= r.StreamPlainBytes {
		p.t.Errorf("%s: TLS ciphertext %d not above plaintext %d", r.Scenario, r.TLSCipherBytes, r.StreamPlainBytes)
	}
}

// TCP and TLS clients (production also listens on 5349 TLS). coturn accounts
// plaintext framed messages, so the client counts the same layer; exactness
// is required wherever coturn publishes a final, and the no-final loss is
// bounded by the largest framed message actually exchanged. No artificial
// allocation lifetime: a stream client's allocation ends with its connection.
func TestCoturnMeteringProviderTransports(t *testing.T) {
	p, _ := setupProviderWith(t, "transports", true)
	const rounds, size = 3000, 1000

	c := p.allocateOver(p.newUser("t1"), "tcp")
	c.pump(rounds, size)
	c.close()
	r := p.settle("T1 TCP normal close (Refresh lifetime=0)", c, 30*time.Second)
	p.requireExact(r)
	p.checkStreamRow(r, true)

	c = p.allocateOver(p.newUser("t2"), "tls")
	c.pump(rounds, size)
	c.close()
	r = p.settle("T2 TLS normal close (Refresh lifetime=0)", c, 30*time.Second)
	p.requireExact(r)
	p.checkStreamRow(r, true)

	c = p.allocateOver(p.newUser("t3"), "tcp")
	c.pump(rounds, size)
	c.dropStream()
	r = p.settle("T3 TCP connection dropped (no TURN message)", c, 60*time.Second)
	p.requireExact(r)
	p.checkStreamRow(r, false)

	c = p.allocateOver(p.newUser("t4"), "tls")
	c.pump(rounds, size)
	c.cc.frozen.Store(true)
	if out, err := p.drain(); err != nil {
		t.Fatalf("drain with a TLS session: %v\n%s", err, out)
	}
	p.signalCoturn(syscall.SIGTERM)
	r = p.settle("T4 TLS drain then coturn SIGTERM", c, 30*time.Second)
	p.requireExact(r)
	p.checkStreamRow(r, false)
	c.plain.Close()

	p.startCoturn()
	p.waitBridgeEpoch()
	c = p.allocateOver(p.newUser("t5"), "tls")
	c.pump(rounds, size)
	c.cc.frozen.Store(true)
	time.Sleep(7 * time.Second) // a psd listing after the last delta
	p.signalCoturn(syscall.SIGKILL)
	r = p.settle("T5 TLS coturn SIGKILL", c, 60*time.Second)
	c.plain.Close()
	p.checkStreamRow(r, false)
	// No final: the ledger is exactly what coturn published; the unreported
	// remainder is < 4096 counted events, each at most one framed message.
	if r.RawFinal != -1 || r.Ledger != r.RawDeltas || r.Loss < 0 || r.Bindings != 1 {
		t.Errorf("%s: no-final accounting not the published lower bound: %+v", r.Scenario, r)
	}
	if bound := int64(4095) * int64(r.MaxClientPacket); r.Loss > bound {
		t.Errorf("%s: loss %d outside 4095 × %d", r.Scenario, r.Loss, r.MaxClientPacket)
	}
	p.rows[indexRow(p.rows, r.Scenario)].Exactness = fmt.Sprintf("lower bound; measured loss %d bytes", r.Loss)
}

// Several relay threads at once (production runs coturn's default, one relay
// thread per CPU): allocations over UDP, TCP and TLS pump concurrently and
// each reconciles exactly. The thread count is coturn's own log line, not
// assumed; with two or more threads, at least two must actually be used.
func TestCoturnMeteringProviderConcurrentThreads(t *testing.T) {
	p, _ := setupProviderWith(t, "concurrent", true)
	const rounds, size = 2000, 1000
	n := p.threadsLogged
	k := max(6, n)
	var clients []*turnClient
	for i := range k {
		clients = append(clients, p.allocateOver(p.newUser(fmt.Sprintf("c%d", i)), "udp"))
	}
	clients = append(clients, p.allocateOver(p.newUser("ctcp"), "tcp"), p.allocateOver(p.newUser("ctls"), "tls"))
	// One echo peer per allocation, and bounded in-flight credit per
	// allocation (pumpWindowed): the load is unchanged — every allocation
	// moves rounds × size and all overlap — but no socket on the path ever
	// queues more than `window` of one allocation's datagrams, so nothing is
	// dropped silently (see CONCURRENT-ECHO-DIAGNOSIS.md). Linux: the
	// network namespace's own UDP drop counters must not move.
	const window, stall = 8, 5 * time.Second
	peers := make([]*net.UDPConn, len(clients))
	for i := range clients {
		peers[i] = p.newEchoPeer()
	}
	before, errBefore := udpDropCounters()
	if errBefore != nil && runtime.GOOS == "linux" {
		t.Fatalf("UDP drop counters unreadable before the run: %v", errBefore)
	}
	// Common start: every goroutine waits until all are ready, so the
	// allocations really overlap; the overlap is then checked from the
	// recorded send intervals.
	errs := make(chan error, len(clients))
	stats := make([]pumpStats, len(clients))
	start := make(chan struct{})
	var ready, wg sync.WaitGroup
	ready.Add(len(clients))
	for i, c := range clients {
		wg.Go(func() {
			ready.Done()
			<-start
			st, err := pumpWindowed(func(b []byte) error { _, err := c.relay.WriteTo(b, peers[i].LocalAddr()); return err },
				c.got.Load, rounds, size, window, stall)
			stats[i] = st
			if err != nil {
				err = fmt.Errorf("%s allocation %d: %w", c.transport, i+1, err)
			}
			errs <- err
		})
	}
	ready.Wait()
	close(start)
	wg.Wait()
	close(errs)
	after, errAfter := udpDropCounters()
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	latestStart, earliestEnd := stats[0].Start, stats[0].End
	for i, st := range stats {
		p.logf("C%d %s: %d datagrams, max in flight %d, sending %s..%s", i+1, clients[i].transport, st.Sent, st.MaxInFlight,
			st.Start.Format("15:04:05.000"), st.End.Format("15:04:05.000"))
		if st.Start.After(latestStart) {
			latestStart = st.Start
		}
		if st.End.Before(earliestEnd) {
			earliestEnd = st.End
		}
	}
	if !latestStart.Before(earliestEnd) {
		t.Fatalf("allocations did not overlap: the last started at %s after the first finished at %s", latestStart, earliestEnd)
	}
	p.logf("all %d allocations overlapped for %v", len(clients), earliestEnd.Sub(latestStart).Round(time.Millisecond))
	switch {
	case runtime.GOOS == "linux":
		if errAfter != nil {
			t.Fatalf("UDP drop counters unreadable after the run: %v", errAfter)
		}
		p.logf("kernel UDP drop counters (network namespace): before %v after %v; net.core.rmem_max %s", before, after, rmemMax())
		for _, k := range []string{"InErrors", "RcvbufErrors"} {
			if after[k] != before[k] {
				t.Fatalf("kernel dropped UDP datagrams during the concurrent run: %s %d -> %d", k, before[k], after[k])
			}
		}
	default:
		p.logf("kernel UDP drop counters: %v (informational run only)", errBefore)
	}
	time.Sleep(300 * time.Millisecond) // let stray replies (permission/channel) land
	for _, c := range clients {
		c.close()
	}
	threads := map[string]int{}
	for i, c := range clients {
		r := p.settle(fmt.Sprintf("C%d concurrent %s", i+1, c.transport), c, 60*time.Second)
		p.requireExact(r)
		p.checkStreamRow(r, true)
		for _, sid := range strings.Split(r.SessionIDs, ",") {
			if len(sid) == 18 {
				threads[sid[:3]]++ // coturn: id = thread × 10^15 + counter
			}
		}
	}
	p.logf("concurrent: mode %q, coturn logged %d relay threads, host CPUs %d; %d allocations used thread prefixes %v",
		p.relayThreads, n, runtime.NumCPU(), len(clients), threads)
	if n >= 2 && len(threads) < 2 {
		t.Errorf("coturn runs %d relay threads but all %d allocations used one: cross-thread interleaving not demonstrated", n, len(clients))
	}
}

// The default config (no knobs) is byte-for-byte the config every earlier
// provider run used; the knobs change only their own lines.
func TestCoturnProviderConfigDefaultUnchanged(t *testing.T) {
	p := &provEnv{turnPort: 3478, relayMin: 52000, secret: "s3cr3t", redisPort: 6379, cliPort: 5766, cliPass: "pw", dir: "/w", evid: "/e"}
	before := fmt.Sprintf(`listening-ip=127.0.0.1
relay-ip=127.0.0.1
listening-port=%d
min-port=%d
max-port=%d
realm=%s
use-auth-secret
static-auth-secret=%s
allow-loopback-peers
no-multicast-peers
no-tls
no-dtls
no-tcp-relay
fingerprint
relay-threads=1
redis-statsdb="ip=127.0.0.1 dbname=0 port=%d"
cli-ip=127.0.0.1
cli-port=%d
cli-password=%s
pidfile=%s
log-file=%s
simple-log
`, 3478, 52000, 52200, provRealm, "s3cr3t", 6379, 5766, "pw", "/w/turnserver.pid", "/e/turn.log")
	for _, mode := range []string{"", "1"} {
		p.relayThreads = mode
		if got := p.turnConf(); got != before {
			t.Fatalf("mode %q changed the config:\n%s", mode, got)
		}
	}
	p.relayThreads = "default"
	if got := p.turnConf(); got != strings.Replace(before, "relay-threads=1\n", "", 1) {
		t.Fatalf("default mode:\n%s", got)
	}
	p.relayThreads = "6"
	if got := p.turnConf(); got != strings.Replace(before, "relay-threads=1\n", "relay-threads=6\n", 1) {
		t.Fatalf("explicit 6:\n%s", got)
	}
	p.relayThreads, p.tlsPort, p.tlsCert, p.tlsKey = "1", 5349, "/w/c.pem", "/w/k.pem"
	if got := p.turnConf(); got != strings.Replace(before, "no-tls\n", "tls-listening-port=5349\ncert=/w/c.pem\npkey=/w/k.pem\n", 1) {
		t.Fatalf("tls:\n%s", got)
	}
}

// Production starts coturn under systemd with an empty --pidfile=, so the
// bridge identifies it by the unit's MainPID (-coturn-unit). These controls
// run that path against a fake systemctl on a scratch PATH and real scratch
// processes (`sleep`): a valid MainPID, 0, empty and garbage answers, a
// process with the wrong name, a restart (new process) and a vanished PID.
func TestCoturnBridgeSystemdMainPIDEpochSource(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("provider epochs are read on linux (darwin for the harness)")
	}
	dir := t.TempDir()
	answer := filepath.Join(dir, "mainpid")
	script := "#!/bin/sh\n[ \"$1 $2 $3 $4\" = \"show --property=MainPID --value cm-test.service\" ] || exit 3\ncat \"" + answer + "\"\n"
	if err := os.WriteFile(filepath.Join(dir, "systemctl"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	start := func() *exec.Cmd {
		c := exec.Command("sleep", "60")
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Process.Kill(); c.Wait() })
		return c
	}
	say := func(v string) { os.WriteFile(answer, []byte(v), 0o600) }
	src := &coturnbridge.ProcessEpochSource{SystemdUnit: "cm-test.service", Comm: "sleep"}

	p1 := start()
	say(fmt.Sprintf("%d\n", p1.Process.Pid))
	e1, err := src.Read()
	if err != nil || !e1.Valid() || e1.PID != p1.Process.Pid {
		t.Fatalf("valid MainPID: %+v %v", e1, err)
	}
	if again, _ := src.Read(); again != e1 || !src.Alive(e1) {
		t.Fatalf("epoch not stable/alive: %+v vs %+v", again, e1)
	}
	for _, bad := range []string{"0\n", "", "\n", "abc\n", "-5\n"} {
		say(bad)
		if e, err := src.Read(); err == nil {
			t.Fatalf("MainPID answer %q accepted: %+v", bad, e)
		}
	}
	say(fmt.Sprintf("%d\n", p1.Process.Pid))
	if _, err := (&coturnbridge.ProcessEpochSource{SystemdUnit: "cm-test.service", Comm: "turnserver"}).Read(); err == nil {
		t.Fatal("a process that is not turnserver accepted")
	}
	// Restart: the unit's MainPID now names a new process.
	p1.Process.Kill()
	p1.Wait()
	if src.Alive(e1) {
		t.Fatal("killed process reported alive")
	}
	if _, err := src.Read(); err == nil {
		t.Fatal("vanished MainPID accepted")
	}
	p2 := start()
	say(fmt.Sprintf("%d\n", p2.Process.Pid))
	e2, err := src.Read()
	if err != nil || e2 == e1 || !src.Alive(e2) {
		t.Fatalf("restart: %+v (old %+v) %v", e2, e1, err)
	}
}

// Opt-in, read-only: identify a real systemd unit's coturn process the way
// the bridge will (`systemctl show`, /proc). Nothing is written or signalled.
// RELAYIUM_COTURN_PROVIDER_SYSTEMD_UNIT names the unit.
func TestCoturnProviderSystemdMainPIDProbe(t *testing.T) {
	unit := os.Getenv("RELAYIUM_COTURN_PROVIDER_SYSTEMD_UNIT")
	if unit == "" {
		t.Skip("opt-in: set RELAYIUM_COTURN_PROVIDER_SYSTEMD_UNIT to a unit running turnserver")
	}
	src := &coturnbridge.ProcessEpochSource{SystemdUnit: unit}
	e1, err := src.Read()
	if err != nil || !e1.Valid() {
		t.Fatalf("read %s: %+v %v", unit, e1, err)
	}
	time.Sleep(2 * time.Second)
	e2, err := src.Read()
	if err != nil || e2 != e1 || !src.Alive(e1) {
		t.Fatalf("epoch not stable over 2 s: %+v then %+v (%v)", e1, e2, err)
	}
	t.Logf("unit %s: coturn epoch %s stable and alive", unit, e1)
}

// newEchoPeer is startPeer for one allocation: its own socket and reader.
func (p *provEnv) newEchoPeer() *net.UDPConn { return p.newEchoPeerAt(net.IPv4(127, 0, 0, 1)) }

// newEchoPeerAt is newEchoPeer on a given loopback address. TURN permissions
// are per peer IP, so only a peer on an IP the allocation has never used
// forces a fresh CreatePermission.
func (p *provEnv) newEchoPeerAt(ip net.IP) *net.UDPConn {
	p.t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip})
	if err != nil {
		p.t.Fatalf("echo peer on %s: %v (Linux routes all of 127/8 to lo; macOS needs `ifconfig lo0 alias %s`)", ip, err, ip)
	}
	c.SetReadBuffer(4 << 20)
	p.t.Cleanup(func() { c.Close() })
	go func() {
		buf := make([]byte, 65536)
		for {
			n, a, err := c.ReadFromUDP(buf)
			if err != nil {
				return
			}
			p.peerN.Add(1)
			c.WriteToUDP(buf[:n], a)
		}
	}()
	return c
}

type pumpStats struct {
	Sent, MaxInFlight int
	Start, End        time.Time // first send, last echo
}

// pumpWindowed sends rounds datagrams of size bytes, never more than window
// of them un-echoed (echoed reports cumulative echoed payload bytes). It
// returns when every datagram has been echoed. If the echo count makes no
// progress for stall, a datagram was lost: it fails at once and says so,
// rather than waiting for echoes that cannot come.
func pumpWindowed(send func([]byte) error, echoed func() int64, rounds, size, window int, stall time.Duration) (pumpStats, error) {
	st := pumpStats{Start: time.Now()}
	buf := make([]byte, size)
	base := echoed()
	last, lastAt := base, time.Now()
	for {
		now := echoed()
		done := int((now - base) / int64(size))
		if done >= rounds {
			st.End = time.Now()
			return st, nil
		}
		if now != last {
			last, lastAt = now, time.Now()
		} else if time.Since(lastAt) > stall {
			return st, fmt.Errorf("echo stalled for %v: sent %d, echoed %d of %d datagrams (window %d): a datagram was lost", stall, st.Sent, done, rounds, window)
		}
		if st.Sent < rounds && st.Sent-done < window {
			if err := send(buf); err != nil {
				return st, fmt.Errorf("relay write: %w", err)
			}
			st.Sent++
			st.MaxInFlight = max(st.MaxInFlight, st.Sent-done)
			continue
		}
		time.Sleep(200 * time.Microsecond)
	}
}

// udpDropCounters reads the Udp InErrors and RcvbufErrors counters of this
// network namespace from /proc/net/snmp. Strict: both counters must be
// present exactly once with plain decimal values; anything else is an
// error, never zeros. Off Linux it reports errUDPCountersUnavailable.
var errUDPCountersUnavailable = errors.New("kernel UDP drop counters are only read on linux")

var reDecimal = regexp.MustCompile(`^[0-9]{1,19}$`)

func udpDropCounters() (map[string]uint64, error) {
	if runtime.GOOS != "linux" {
		return nil, errUDPCountersUnavailable
	}
	b, err := os.ReadFile("/proc/net/snmp")
	if err != nil {
		return nil, err
	}
	return parseUDPDropCounters(b)
}

func parseUDPDropCounters(b []byte) (map[string]uint64, error) {
	var lines [][]string
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "Udp: ") {
			lines = append(lines, strings.Fields(l)[1:])
		}
	}
	if len(lines) != 2 || len(lines[0]) != len(lines[1]) {
		return nil, fmt.Errorf("/proc/net/snmp: want one Udp header and one value line of equal width, got %d lines", len(lines))
	}
	out := map[string]uint64{}
	for i, k := range lines[0] {
		if k != "InErrors" && k != "RcvbufErrors" {
			continue
		}
		if _, dup := out[k]; dup {
			return nil, fmt.Errorf("/proc/net/snmp: %s listed twice", k)
		}
		v := lines[1][i]
		if !reDecimal.MatchString(v) {
			return nil, fmt.Errorf("/proc/net/snmp: %s value %q is not decimal", k, v)
		}
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("/proc/net/snmp: %s: %w", k, err)
		}
		out[k] = n
	}
	if len(out) != 2 {
		return nil, fmt.Errorf("/proc/net/snmp: InErrors/RcvbufErrors missing (found %d)", len(out))
	}
	return out, nil
}

func rmemMax() string {
	b, err := os.ReadFile("/proc/sys/net/core/rmem_max")
	if err != nil {
		return "n/a"
	}
	return strings.TrimSpace(string(b))
}

// The concurrent fixture's pacing, causally: a simulated echo path with a
// fixed-capacity buffer that drops when full (like a UDP socket). With a
// window of 8 every datagram is echoed and never more than 8 are in flight;
// with pacing disabled (window = all) the same path overflows and the pump
// fails, naming the loss; a single injected drop is reported as a stall.
func TestCoturnProviderWindowedPumpBoundsInFlight(t *testing.T) {
	run := func(window, capacity, dropAt int) (pumpStats, error) {
		var echoed atomic.Int64
		q := make(chan struct{}, capacity)
		var n atomic.Int64
		stop := make(chan struct{})
		defer close(stop)
		go func() { // the echo path: drains slowly, one datagram per 50 µs
			for {
				select {
				case <-stop:
					return
				case <-q:
					time.Sleep(50 * time.Microsecond)
					echoed.Add(1000)
				}
			}
		}()
		send := func([]byte) error {
			if n.Add(1) == int64(dropAt) {
				return nil // lost on the way
			}
			select {
			case q <- struct{}{}:
			default: // buffer full: dropped, as a UDP socket would
			}
			return nil
		}
		return pumpWindowed(send, echoed.Load, 2000, 1000, window, 300*time.Millisecond)
	}
	st, err := run(8, 28, 0)
	if err != nil || st.Sent != 2000 || st.MaxInFlight > 8 {
		t.Fatalf("windowed: %+v %v", st, err)
	}
	if _, err := run(2000, 28, 0); err == nil || !strings.Contains(err.Error(), "datagram was lost") {
		t.Fatalf("unpaced burst into a 28-datagram buffer did not fail: %v", err)
	}
	if _, err := run(8, 28, 777); err == nil || !strings.Contains(err.Error(), "datagram was lost") {
		t.Fatalf("injected drop not reported: %v", err)
	}
}

// --- OPS9: provider-native admission gate (opt-in, fixture only) -------------

// tryAllocate opens a new client transport and allocates on it at once,
// returning the Allocate error instead of failing the test.
func (p *provEnv) tryAllocate(user, transport string) (*turnClient, error) {
	p.t.Helper()
	return p.allocateOn(p.openTransport(user, transport))
}

// openTransport opens a client transport to coturn and proves it is live
// WITHOUT allocating: the TLS handshake completes, and a STUN Binding
// request is answered on that very socket or connection. Every byte goes
// through the counting socket, so a later refused Allocate's ERROR-CODE
// is recorded.
func (p *provEnv) openTransport(user, transport string) *turnClient {
	p.t.Helper()
	username := fmt.Sprintf("%d:%s.g%s", time.Now().Add(time.Hour).Unix(), user, randHex(16))
	mac := hmac.New(sha1.New, []byte(p.secret))
	mac.Write([]byte(username))
	pass := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	tc := &turnClient{p: p, user: user, username: username, transport: transport, password: pass, done: make(chan struct{})}
	addr := fmt.Sprintf("127.0.0.1:%d", p.turnPort)
	switch transport {
	case "udp":
		raw, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			p.t.Fatal(err)
		}
		raw.(*net.UDPConn).SetReadBuffer(4 << 20)
		tc.cc = &countConn{PacketConn: raw, channel: map[string]int{}}
		tc.server, _ = net.ResolveUDPAddr("udp4", addr)
	case "tcp", "tls":
		if transport == "tls" {
			addr = fmt.Sprintf("127.0.0.1:%d", p.tlsPort)
		}
		raw, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			p.t.Fatal(err)
		}
		var stream net.Conn = raw
		if transport == "tls" {
			tc.cipher = &streamConn{Conn: raw}
			tlsConn := tls.Client(tc.cipher, &tls.Config{RootCAs: p.caPool, ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12})
			if err := tlsConn.Handshake(); err != nil {
				p.t.Fatalf("tls handshake: %v", err)
			}
			stream = tlsConn
		}
		tc.plain = &streamConn{Conn: stream}
		tc.cc = &countConn{PacketConn: turnv4.NewSTUNConn(tc.plain), channel: map[string]int{}}
		tc.server = raw.RemoteAddr()
	default:
		p.t.Fatalf("transport %q", transport)
	}
	cl, err := turnv4.NewClient(&turnv4.ClientConfig{
		STUNServerAddr: addr, TURNServerAddr: addr, Username: username, Password: pass, Realm: provRealm, Conn: tc.cc,
	})
	if err != nil {
		p.t.Fatal(err)
	}
	if err := cl.Listen(); err != nil {
		p.t.Fatal(err)
	}
	tc.cl = cl
	if _, err := cl.SendBindingRequestTo(tc.server); err != nil {
		p.t.Fatalf("%s transport not live before allocating (Binding): %v", transport, err)
	}
	return tc
}

// allocateOn allocates on an already open transport; on error the client is
// closed and the error returned.
func (p *provEnv) allocateOn(tc *turnClient) (*turnClient, error) {
	relay, err := tc.cl.Allocate()
	if err != nil {
		tc.cl.Close()
		tc.cc.frozen.Store(true)
		tc.cc.Close()
		return tc, err
	}
	tc.relay = relay
	go func() {
		defer close(tc.done)
		buf := make([]byte, 2048)
		for {
			n, _, err := relay.ReadFrom(buf)
			if err != nil {
				return
			}
			tc.got.Add(int64(n))
		}
	}()
	return tc, nil
}

// lastErrorCode is the ERROR-CODE of the last STUN error response the client
// received (0 if none).
func (tc *turnClient) lastErrorCode() int {
	tc.cc.mu.Lock()
	defer tc.cc.mu.Unlock()
	if len(tc.cc.errCodes) == 0 {
		return 0
	}
	return tc.cc.errCodes[len(tc.cc.errCodes)-1]
}

// stunMessage builds a STUN message. With key set it appends
// MESSAGE-INTEGRITY (HMAC-SHA1, long-term key) and FINGERPRINT.
func stunMessage(typ uint16, tx [12]byte, attrs [][2]any, key []byte) []byte {
	b := []byte{byte(typ >> 8), byte(typ), 0, 0, 0x21, 0x12, 0xa4, 0x42}
	b = append(b, tx[:]...)
	put := func(t int, v []byte) {
		b = append(b, byte(t>>8), byte(t), byte(len(v)>>8), byte(len(v)))
		b = append(b, v...)
		for len(b)%4 != 0 {
			b = append(b, 0)
		}
	}
	setLen := func(n int) { b[2], b[3] = byte(n>>8), byte(n) }
	for _, a := range attrs {
		put(a[0].(int), a[1].([]byte))
	}
	if key != nil {
		setLen(len(b) - 20 + 24)
		h := hmac.New(sha1.New, key)
		h.Write(b)
		put(0x0008, h.Sum(nil))
		setLen(len(b) - 20 + 8)
		fp := crc32.ChecksumIEEE(b) ^ 0x5354554e
		put(0x8028, []byte{byte(fp >> 24), byte(fp >> 16), byte(fp >> 8), byte(fp)})
	}
	setLen(len(b) - 20)
	return b
}

// rawRefresh sends a Refresh(lifetime) for the client's existing
// allocation through its counting socket (so both ends count it): first
// unauthenticated to learn the server's REALM/NONCE, then authenticated.
// It returns 0 on a success response, else the ERROR-CODE.
func (tc *turnClient) rawRefresh(lifetime uint32) (int, error) {
	exchange := func(msg []byte, tx [12]byte) ([]byte, error) {
		ch := make(chan []byte, 1)
		tc.cc.mu.Lock()
		if tc.cc.watch == nil {
			tc.cc.watch = map[[12]byte]chan []byte{}
		}
		tc.cc.watch[tx] = ch
		tc.cc.mu.Unlock()
		defer func() { tc.cc.mu.Lock(); delete(tc.cc.watch, tx); tc.cc.mu.Unlock() }()
		if _, err := tc.cc.WriteTo(msg, tc.server); err != nil {
			return nil, err
		}
		select {
		case r := <-ch:
			return r, nil
		case <-time.After(5 * time.Second):
			return nil, errors.New("no response to raw Refresh")
		}
	}
	life := []byte{byte(lifetime >> 24), byte(lifetime >> 16), byte(lifetime >> 8), byte(lifetime)}
	var tx [12]byte
	rand.Read(tx[:])
	r, err := exchange(stunMessage(0x0004, tx, [][2]any{{0x000d, life}}, nil), tx)
	if err != nil {
		return 0, err
	}
	at := stunAttrs(r)
	realm, nonce := at[0x0014], at[0x0015]
	if code := stunErrorCode(r); (code != 401 && code != 438) || realm == nil || nonce == nil {
		return code, fmt.Errorf("unauthenticated Refresh: code %d, realm/nonce present %v/%v", code, realm != nil, nonce != nil)
	}
	k := md5.Sum([]byte(tc.username + ":" + string(realm) + ":" + tc.password))
	rand.Read(tx[:])
	r, err = exchange(stunMessage(0x0004, tx, [][2]any{
		{0x0006, []byte(tc.username)}, {0x0014, realm}, {0x0015, nonce}, {0x000d, life},
	}, k[:]), tx)
	if err != nil {
		return 0, err
	}
	if uint16(r[0])<<8|uint16(r[1]) == 0x0104 {
		return 0, nil
	}
	return stunErrorCode(r), nil
}

// adminCommand runs one coturn CLI command and returns its output IN
// MEMORY ONLY: `pc` prints the whole configuration, including the Redis
// connection string and its password, so callers keep nothing but the
// allowlisted flag lines and never log or persist the raw text.
//
// coturn prints its "> " cursor after most commands but not after `tc`
// (toggle_cli_param returns without type_cli_cursor), so a `tc` reply is
// complete once its flag line has arrived.
func (p *provEnv) adminCommand(cmd string) (string, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p.cliPort), 5*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second))
	until := func(done func([]byte) bool) ([]byte, error) {
		var buf []byte
		tmp := make([]byte, 4096)
		for !done(buf) {
			n, err := c.Read(tmp)
			buf = append(buf, tmp[:n]...)
			if len(buf) > 1<<20 {
				return nil, errors.New("CLI reply too large")
			}
			if err != nil && !done(buf) {
				return nil, err
			}
		}
		return buf, nil
	}
	prompt := func(b []byte) bool { return bytes.HasSuffix(b, []byte("> ")) }
	if _, err := until(func(b []byte) bool { return bytes.Contains(b, []byte("Enter password: ")) }); err != nil {
		return "", err
	}
	c.Write([]byte(p.cliPass + "\r\n"))
	if _, err := until(prompt); err != nil {
		return "", err
	}
	c.Write([]byte(cmd + "\r\n"))
	done := prompt
	if strings.HasPrefix(cmd, "tc ") {
		done = func(b []byte) bool { return reRelayFlag.Match(b) }
	}
	out, err := until(done)
	return string(out), err
}

var reRelayFlag = regexp.MustCompile(`(?m)^\s*(no-udp-relay|no-tcp-relay): (ON|OFF)\b`)

// relayFlags reads coturn's live no-udp-relay/no-tcp-relay from `pc`,
// keeping only those two allowlisted lines; anything ambiguous is an error.
func (p *provEnv) relayFlags() (udpOff, tcpOff bool, err error) {
	out, err := p.adminCommand("pc")
	if err != nil {
		return false, false, err
	}
	seen := map[string]string{}
	for _, m := range reRelayFlag.FindAllStringSubmatch(out, -1) {
		if prev, dup := seen[m[1]]; dup && prev != m[2] {
			return false, false, fmt.Errorf("%s reported twice with different values", m[1])
		}
		seen[m[1]] = m[2]
	}
	if len(seen) != 2 {
		return false, false, fmt.Errorf("pc did not report both relay flags (got %d)", len(seen))
	}
	return seen["no-udp-relay"] == "ON", seen["no-tcp-relay"] == "ON", nil
}

func (p *provEnv) epochNow() (coturnbridge.Epoch, error) {
	return (&coturnbridge.ProcessEpochSource{PIDFile: filepath.Join(p.dir, "turnserver.pid")}).Read()
}

// admissionGate is coturn's own admission switch for new UDP-relay
// allocations (`tc no-udp-relay`), bound to the provider epoch it was closed
// on. restore reopens it only on that same epoch: a different (restarted)
// coturn starts from its config and is never toggled by mistake.
type admissionGate struct {
	p     *provEnv
	epoch coturnbridge.Epoch
}

func (p *provEnv) closeAdmission() *admissionGate {
	p.t.Helper()
	e0, err := p.epochNow()
	if err != nil {
		p.t.Fatalf("refusing to toggle: provider epoch unreadable: %v", err)
	}
	udpOff, tcpOff, err := p.relayFlags()
	if err != nil {
		p.t.Fatalf("refusing to toggle: %v", err)
	}
	if udpOff || !tcpOff {
		p.t.Fatalf("refusing to toggle: unexpected start state no-udp-relay=%v no-tcp-relay=%v", udpOff, tcpOff)
	}
	out, err := p.adminCommand("tc no-udp-relay")
	g := &admissionGate{p: p, epoch: e0}
	p.t.Cleanup(g.restore) // whatever happens next, reopen on this epoch only
	if err != nil {
		p.t.Fatalf("tc no-udp-relay: %v", err)
	}
	if m := reRelayFlag.FindStringSubmatch(out); m == nil || m[1] != "no-udp-relay" || m[2] != "ON" {
		p.t.Fatal("toggle reply did not report no-udp-relay: ON")
	}
	if e1, err := p.epochNow(); err != nil || e1 != e0 {
		p.t.Fatalf("provider epoch changed or unreadable across the toggle (%v): aborting", err)
	}
	if udpOff, _, err := p.relayFlags(); err != nil || !udpOff {
		p.t.Fatalf("no-udp-relay not ON after the toggle (%v)", err)
	}
	p.logf("admission closed: coturn no-udp-relay ON (epoch %s)", e0)
	return g
}

// restore reopens admission on the gate's own epoch; it never toggles a
// different or unreadable provider. Safe to call twice.
func (g *admissionGate) restore() {
	e, err := g.p.epochNow()
	if err != nil || e != g.epoch {
		g.p.logf("admission NOT reopened: provider epoch changed or unreadable (%v); a new coturn starts from its config", err)
		return
	}
	udpOff, _, err := g.p.relayFlags()
	if err != nil {
		g.p.logf("admission NOT reopened: relay flags unreadable (%v)", err)
		return
	}
	if !udpOff {
		return
	}
	out, err := g.p.adminCommand("tc no-udp-relay")
	if m := reRelayFlag.FindStringSubmatch(out); err != nil || m == nil || m[2] != "OFF" {
		g.p.logf("admission reopen did not report no-udp-relay: OFF (%v)", err)
		return
	}
	g.p.logf("admission reopened: coturn no-udp-relay OFF (epoch %s)", g.epoch)
}

func (p *provEnv) refreshedAfter(username string, sinceMilli int64) bool {
	p.raw.mu.Lock()
	defer p.raw.mu.Unlock()
	pre := "turn/realm/" + provRealm + "/user/" + username + "/allocation/"
	for _, e := range p.raw.events {
		if strings.HasPrefix(e.Channel, pre) && strings.HasSuffix(e.Channel, "/status") &&
			strings.HasPrefix(e.Msg, "refreshed lifetime=") && int64(e.T*1000) >= sinceMilli {
			return true
		}
	}
	return false
}

func (p *provEnv) liveSessions() int {
	p.t.Helper()
	cli, err := coturnbridge.DialCLI(fmt.Sprintf("127.0.0.1:%d", p.cliPort), p.cliPass, 10*time.Second)
	if err != nil {
		p.t.Fatal(err)
	}
	defer cli.Close()
	s, err := cli.DumpSessions(filepath.Join(p.dir, "psd", "admission.txt"), 64<<20)
	if err != nil {
		p.t.Fatal(err)
	}
	return len(s)
}

// OPS9 (opt-in, fixture only — never production): coturn's own
// `tc no-udp-relay` closes admission for NEW UDP-relay allocations (442) on
// every client transport, while allocations that already exist keep
// relaying, open new permissions and channels, refresh, close normally and
// drain exactly. An Allocate racing the toggle either gets 442 or becomes
// an allocation that is drained and billed like any other: it cannot
// escape. Admission is reopened only on the same provider epoch.
//
// A refused Allocate gets no allocation (no relay, no "new" status), but
// coturn may still publish the refused session's control-only traffic. The
// bridge reports it with the reserved unknown start, so central keeps it as a
// shadow diagnostic and bills nobody. Central runs here with a real
// activation baseline (setup time − 1 s), as production would, and the end of
// the test reconciles every refused session against coturn's own counters.
func TestCoturnMeteringProviderAdmissionGate(t *testing.T) {
	p, _ := setupProviderOpts(t, "admission", provOpts{tls: true, billableSince: time.Now().Unix() - 1, recordSnapshots: true})
	const rounds, size = 1000, 1000
	var refused []refusedAlloc
	refuse := func(label string, c *turnClient) {
		refused = append(refused, refusedAlloc{label: label, c: c, atMilli: time.Now().UnixMilli()})
	}
	existing := map[string]*turnClient{}
	for _, tr := range []string{"udp", "tcp", "tls"} {
		c := p.allocateOver(p.newUser("adm-"+tr), tr)
		c.password = func() string {
			mac := hmac.New(sha1.New, []byte(p.secret))
			mac.Write([]byte(c.username))
			return base64.StdEncoding.EncodeToString(mac.Sum(nil))
		}()
		if tr == "udp" {
			c.server, _ = net.ResolveUDPAddr("udp4", fmt.Sprintf("127.0.0.1:%d", p.turnPort))
		} else {
			c.server = c.plain.RemoteAddr()
		}
		c.pump(rounds, size)
		existing[tr] = c
	}

	// Transports opened BEFORE the gate closes, not yet allocated: UDP proven
	// live by an answered Binding on the very socket, TCP/TLS by their
	// (completed TLS) connection and an answered Binding on it. They allocate
	// only after the gate is closed, on the same socket/connection.
	preopened := map[string]*turnClient{}
	for _, tr := range []string{"udp", "tcp", "tls"} {
		preopened[tr] = p.openTransport(p.newUser("adm-pre-"+tr), tr)
	}
	p.logf("pre-opened unallocated UDP/TCP/TLS transports (Binding answered%s)", "; TLS handshake complete")

	// An Allocate racing the toggle.
	raceUser := p.newUser("adm-race")
	type raced struct {
		c   *turnClient
		err error
	}
	rc := make(chan raced, 1)
	go func() { c, err := p.tryAllocate(raceUser, "udp"); rc <- raced{c, err} }()
	gate := p.closeAdmission()
	closedAt := time.Now().UnixMilli()
	race := <-rc
	var drainSet []*turnClient
	if race.err != nil {
		if code := race.c.lastErrorCode(); code != 442 {
			t.Fatalf("raced Allocate failed with %d, want 442 or success: %v", code, race.err)
		}
		p.logf("raced Allocate: refused 442 (gate closed first)")
		refuse("raced-udp", race.c)
	} else {
		p.logf("raced Allocate: admitted before the gate closed; it must be drained and billed")
		race.c.pump(rounds/2, size)
		drainSet = append(drainSet, race.c)
	}
	sessions := p.liveSessions()

	// Closed: an authenticated Allocate on each transport opened before the
	// gate closed is refused with 442 and coturn allocates nothing for it (no
	// relay, no "new" status, live sessions unchanged). Whatever coturn later
	// publishes for the refused session is reconciled at the end.
	for _, tr := range []string{"udp", "tcp", "tls"} {
		c, err := p.allocateOn(preopened[tr])
		if err == nil {
			t.Fatalf("Allocate on the pre-opened %s transport admitted while the gate is closed", tr)
		}
		if code := c.lastErrorCode(); code != 442 {
			t.Fatalf("Allocate on the pre-opened %s transport refused with %d, want 442 (%v)", tr, code, err)
		}
		refuse("preopened-"+tr, c)
	}
	// And on transports opened after the gate closed.
	for _, tr := range []string{"udp", "tcp", "tls"} {
		c, err := p.tryAllocate(p.newUser("adm-new-"+tr), tr)
		if err == nil {
			t.Fatalf("new %s Allocate admitted while the gate is closed", tr)
		}
		if code := c.lastErrorCode(); code != 442 {
			t.Fatalf("new %s Allocate refused with %d, want 442 (%v)", tr, code, err)
		}
		refuse("new-"+tr, c)
	}
	if got := p.liveSessions(); got != sessions {
		t.Fatalf("refused Allocates changed coturn's sessions: %d -> %d", sessions, got)
	}
	p.logf("gate closed: Allocates on pre-opened and on new UDP/TCP/TLS transports refused with 442; live sessions unchanged (%d)", sessions)

	// Existing allocations keep working: a peer on 127.0.0.2, an IP none of
	// them has a permission for, so each must send a real CreatePermission
	// and ChannelBind under the closed gate and get success, then relay.
	for _, tr := range []string{"udp", "tcp", "tls"} {
		c := existing[tr]
		peer := p.newEchoPeerAt(net.IPv4(127, 0, 0, 2))
		since := time.Now()
		c.cc.mu.Lock()
		errsBefore := len(c.cc.errCodes)
		c.cc.mu.Unlock()
		if _, err := pumpWindowed(func(b []byte) error { _, err := c.relay.WriteTo(b, peer.LocalAddr()); return err },
			c.got.Load, rounds, size, 8, 5*time.Second); err != nil {
			t.Fatalf("existing %s allocation, new peer while closed: %v", tr, err)
		}
		createOK, bindOK := c.permissionProof("127.0.0.2", since)
		c.cc.mu.Lock()
		newErrs := c.cc.errCodes[errsBefore:]
		c.cc.mu.Unlock()
		if !createOK || !bindOK || len(newErrs) != 0 {
			t.Fatalf("existing %s allocation under the closed gate: CreatePermission success %v, ChannelBind success %v, error responses %v",
				tr, createOK, bindOK, newErrs)
		}
		p.logf("existing %s allocation: CreatePermission + ChannelBind for 127.0.0.2 succeeded under the closed gate; %d datagrams echoed", tr, rounds)
		if code, err := c.rawRefresh(600); err != nil || code != 0 {
			t.Fatalf("existing %s allocation Refresh while closed: code %d %v", tr, code, err)
		}
		p.eventually("refreshed status for the existing "+tr+" allocation", 10*time.Second, func() bool {
			return p.refreshedAfter(c.username, closedAt)
		})
	}
	time.Sleep(300 * time.Millisecond)

	// Normal close while closed (UDP), then drain the rest (TCP, TLS and an
	// admitted racer): every one ends with coturn's final, billed exactly.
	u := existing["udp"]
	u.close()
	p.requireExact(p.settle("A1 existing UDP normal close while admission closed", u, 30*time.Second))
	drainSet = append(drainSet, existing["tcp"], existing["tls"])
	for _, c := range drainSet {
		c.cc.frozen.Store(true)
	}
	if out, err := p.drain(); err != nil {
		t.Fatalf("drain while admission closed: %v\n%s", err, out)
	}
	for i, c := range drainSet {
		r := p.settle(fmt.Sprintf("A%d %s drained while admission closed", i+2, c.transport), c, 30*time.Second)
		p.requireExact(r)
	}
	if got := p.liveSessions(); got != 0 {
		t.Fatalf("%d sessions left after the drain", got)
	}
	c, err := p.tryAllocate(p.newUser("adm-after-drain"), "udp")
	if err == nil || c.lastErrorCode() != 442 {
		t.Fatalf("Allocate after the drain not refused with 442: %v (code %d)", err, c.lastErrorCode())
	}
	refuse("after-drain-udp", c)
	p.logf("quiet: no session left, admission still closed")

	// Reopen on the same epoch; admission works again and is billed exactly.
	gate.restore()
	if udpOff, _, err := p.relayFlags(); err != nil || udpOff {
		t.Fatalf("admission not reopened (%v)", err)
	}
	c, err = p.tryAllocate(p.newUser("adm-reopened"), "udp")
	if err != nil {
		t.Fatalf("Allocate after reopening: %v", err)
	}
	c.pump(rounds/2, size)
	c.close()
	p.requireExact(p.settle("A9 Allocate after admission reopened", c, 30*time.Second))

	admitted := []*turnClient{existing["udp"], existing["tcp"], existing["tls"], c}
	if race.err == nil {
		admitted = append(admitted, race.c)
	}
	p.reconcileRefused(refused, admitted)
}

// refusedAlloc is one Allocate refused with 442 while admission was closed.
type refusedAlloc struct {
	label   string
	c       *turnClient
	atMilli int64
}

// coturnMaxAllocateTimeout is coturn's default max-allocate-timeout (the
// fixture does not set it): a session that never completes an Allocate is
// closed at most this long after it began, which is when coturn publishes
// whatever traffic it counted for it.
const coturnMaxAllocateTimeout = 60 * time.Second

// refusedRow is the admission evidence for one refused Allocate.
type refusedRow struct {
	Label             string        `json:"label"`
	Transport         string        `json:"transport"`
	UserID            string        `json:"userId"`
	UsernameHash      string        `json:"usernameHash"`
	RefusedAtMilli    int64         `json:"refusedAtUnixMilli"`
	ErrorCode         int           `json:"errorCode"`
	ClientSent        int64         `json:"clientRawSent"`
	ClientRecv        int64         `json:"clientRawRecv"`
	StreamPlainBytes  int64         `json:"streamPlainBytes,omitempty"`
	TLSCipherBytes    int64         `json:"tlsCipherBytes,omitempty"`
	ClientTail        []string      `json:"clientControlPackets"`
	RawSessionIDs     string        `json:"coturnSessionIds"`
	RawDeltas         int64         `json:"coturnIntervalDeltaSum"`
	RawFinal          int64         `json:"coturnFinal"` // -1: none published
	RawNew            bool          `json:"coturnNewStatus"`
	Published         bool          `json:"coturnPublishedTraffic"`
	Bindings          int           `json:"bindings"`
	BindingSessionID  string        `json:"bindingSessionId,omitempty"`
	BindingLedger     string        `json:"bindingLedger,omitempty"`
	BindingAccepted   int64         `json:"bindingAcceptedShadowDiagnostic"`
	BindingState      string        `json:"bindingLastState,omitempty"`
	BindingUserMatch  bool          `json:"bindingUserMatchesClient"`
	Received          []centralSeen `json:"centralReceivedSnapshots"`
	FirstObservedNote string        `json:"firstObservedSource"`
	LedgerBillable    int64         `json:"userLedgerBillable"`
	UsageTotal        int64         `json:"userUsageAllPeriods"`
}

// reconcileRefused waits past coturn's max-allocate-timeout (plus the
// bridge's unknown-start hold, its missing-listing end inference and a
// report) from the last refusal, then requires, for every refused Allocate:
// no "new" status; a session coturn published traffic for is reported by the
// bridge as exactly one terminal SHADOW binding of that client's user whose
// cumulative equals coturn's own counters; a session coturn published nothing
// for has no binding; and the refused user's ledger is empty. Every binding
// in central is either an admitted allocation (billable) or a refused one
// (shadow), and the billable bindings sum exactly to the reconciled rows.
func (p *provEnv) reconcileRefused(refused []refusedAlloc, admitted []*turnClient) {
	p.t.Helper()
	last := int64(0)
	for _, r := range refused {
		last = max(last, r.atMilli)
	}
	psd, _ := time.ParseDuration(psdEvery)
	settleAt := time.UnixMilli(last).Add(coturnMaxAllocateTimeout + (2*psd + 5*time.Second) + 2*psd + 5*time.Second)
	p.logf("refused Allocates: %d; waiting until %s (max-allocate-timeout %v after the last refusal, plus the bridge's hold and end inference)",
		len(refused), settleAt.UTC().Format("15:04:05"), coturnMaxAllocateTimeout)
	time.Sleep(time.Until(settleAt))

	hashOf := func(u string) string { h := sha256.Sum256([]byte(u)); return hex.EncodeToString(h[:]) }
	refusedBy := map[string]refusedAlloc{}
	for _, r := range refused {
		refusedBy[hashOf(r.c.username)] = r
	}
	settled := func() bool {
		for _, r := range refused {
			_, deltas, final, _ := p.rawForAt(r.c.username)
			b, n := p.binding(r.c.username)
			want := max(deltas, final)
			if deltas == 0 && final < 0 {
				if n != 0 {
					return false // reported though coturn published nothing: fails below
				}
				continue
			}
			if n != 1 || !b.Terminal || b.LastCumulative != want {
				return false
			}
		}
		return true
	}
	// Bounded, and not fatal on its own: the per-session checks below say
	// exactly what is missing and the evidence is written either way.
	for deadline := time.Now().Add(60 * time.Second); !settled(); time.Sleep(200 * time.Millisecond) {
		if time.Now().After(deadline) {
			p.logf("refused sessions not settled 60s after the wait; reporting what central holds")
			break
		}
	}

	var rows []refusedRow
	var shadowSum, rawSum int64
	for _, r := range refused {
		sids, deltas, final, _ := p.rawForAt(r.c.username)
		b, n := p.binding(r.c.username)
		uh := hashOf(r.c.username)
		row := refusedRow{
			Label: r.label, Transport: r.c.transport, UserID: r.c.user, UsernameHash: uh, RefusedAtMilli: r.atMilli,
			ErrorCode: r.c.lastErrorCode(), ClientSent: r.c.cc.sent.Load(), ClientRecv: r.c.cc.recv.Load(),
			RawSessionIDs: strings.Join(sids, ","), RawDeltas: deltas, RawFinal: final, RawNew: p.rawNew(r.c.username),
			Published: deltas > 0 || final >= 0, Bindings: n,
			LedgerBillable: p.ledger(r.c.user),
		}
		if r.c.plain != nil {
			row.StreamPlainBytes = r.c.plain.read.Load() + r.c.plain.written.Load()
		}
		if r.c.cipher != nil {
			row.TLSCipherBytes = r.c.cipher.read.Load() + r.c.cipher.written.Load()
		}
		r.c.cc.mu.Lock()
		row.ClientTail = append([]string(nil), r.c.cc.tail...)
		r.c.cc.mu.Unlock()
		total, err := p.store.UserUsageTotal(context.Background(), r.c.user)
		if err != nil {
			p.t.Fatal(err)
		}
		row.UsageTotal = total
		if n == 1 {
			row.BindingSessionID, row.BindingLedger, row.BindingAccepted, row.BindingState = b.SessionID, b.Ledger, b.Accepted, b.LastState
			row.BindingUserMatch = b.UserID == r.c.user
		}
		p.seenMu.Lock()
		for _, s := range p.seen {
			if s.UsernameHash == uh {
				row.Received = append(row.Received, s)
			}
		}
		p.seenMu.Unlock()
		switch {
		case len(row.Received) > 0:
			row.FirstObservedNote = "central-received snapshot field"
		case row.Published:
			row.FirstObservedNote = "no snapshot received: not observed"
		default:
			row.FirstObservedNote = "coturn published nothing for this session: no snapshot exists"
		}
		rows = append(rows, row)

		if row.ErrorCode != 442 {
			p.t.Errorf("refused %s: last error %d, want 442", r.label, row.ErrorCode)
		}
		if row.RawNew {
			p.t.Errorf("refused %s: coturn published a \"new\" status for it (%s)", r.label, row.RawSessionIDs)
		}
		if row.LedgerBillable != 0 || row.UsageTotal != 0 {
			p.t.Errorf("refused %s billed: ledger %d, usage %d", r.label, row.LedgerBillable, row.UsageTotal)
		}
		if !row.Published {
			if n != 0 {
				p.t.Errorf("refused %s: %d binding(s) though coturn published nothing for it", r.label, n)
			}
			continue
		}
		want := max(deltas, final)
		if n != 1 || b.Ledger != wire.LedgerShadow || !b.Terminal || b.LastCumulative != want || b.Accepted != want || !row.BindingUserMatch {
			p.t.Errorf("refused %s: want one terminal shadow binding of user %s at coturn's %d, got %d binding(s) %+v",
				r.label, r.c.user, want, n, b)
		}
		for _, s := range row.Received {
			if s.FirstObservedUnix >= p.billableSince {
				p.t.Errorf("refused %s: snapshot seq %d claims first observed %d, at or after activation %d",
					r.label, s.Seq, s.FirstObservedUnix, p.billableSince)
			}
		}
		shadowSum += b.Accepted
		rawSum += want
	}

	// Every binding is accounted for: admitted → billable, refused → shadow.
	admittedBy := map[string]*turnClient{}
	for _, c := range admitted {
		admittedBy[hashOf(c.username)] = c
	}
	bs, err := p.store.CoturnBindings(context.Background())
	if err != nil {
		p.t.Fatal(err)
	}
	var billableSum, rowSum int64
	for _, b := range bs {
		_, isAdmitted := admittedBy[b.UsernameHash]
		_, isRefused := refusedBy[b.UsernameHash]
		switch {
		case isAdmitted && b.Ledger == wire.LedgerBillable:
			billableSum += b.Accepted
		case isRefused && b.Ledger == wire.LedgerShadow:
		default:
			p.t.Errorf("unaccounted binding %s/%s (ledger %s, accepted %d, admitted %v, refused %v)",
				b.BootID, b.SessionID, b.Ledger, b.Accepted, isAdmitted, isRefused)
		}
	}
	for _, r := range p.rows {
		rowSum += r.Ledger
	}
	var ledgerSum int64
	for _, c := range admitted {
		ledgerSum += p.ledger(c.user)
	}
	if billableSum != rowSum || ledgerSum != rowSum {
		p.t.Errorf("admission aggregate: billable bindings %d, admitted users' ledger %d, reconciled rows %d", billableSum, ledgerSum, rowSum)
	}
	if shadowSum != rawSum {
		p.t.Errorf("refused shadow total %d != coturn's refused-session counters %d", shadowSum, rawSum)
	}
	sum := map[string]any{
		"billableSince": p.billableSince, "refused": rows,
		"billableBindingsAccepted": billableSum, "admittedUsersLedger": ledgerSum, "reconciledRowsLedger": rowSum,
		"refusedShadowAccepted": shadowSum, "refusedCoturnCounters": rawSum, "bindings": len(bs),
		"note": "usage_events are not readable from this package; userUsageAllPeriods (every usage_periods byte, billable or not) and userLedgerBillable stand for the ledger",
	}
	out, _ := json.MarshalIndent(sum, "", "  ")
	os.WriteFile(filepath.Join(p.evid, "admission-refused.json"), out, 0o600)
	p.logf("refused Allocates reconciled: %d refused (%d published, shadow %d = coturn %d), billable %d = rows %d = ledger %d, %d bindings",
		len(rows), countPublished(rows), shadowSum, rawSum, billableSum, rowSum, ledgerSum, len(bs))
}

func countPublished(rows []refusedRow) int {
	n := 0
	for _, r := range rows {
		if r.Published {
			n++
		}
	}
	return n
}

// rawNew reports whether coturn published a "new" status for username.
func (p *provEnv) rawNew(username string) bool {
	p.raw.mu.Lock()
	defer p.raw.mu.Unlock()
	pre := "turn/realm/" + provRealm + "/user/" + username + "/allocation/"
	for _, e := range p.raw.events {
		if strings.HasPrefix(e.Channel, pre) && strings.HasSuffix(e.Channel, "/status") && strings.HasPrefix(e.Msg, "new ") {
			return true
		}
	}
	return false
}

func TestCoturnProviderUDPDropCountersStrict(t *testing.T) {
	good := "Ip: Forwarding\nIp: 1\nUdp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors\nUdp: 10 0 3 9 2 0\nUdpLite: InDatagrams\nUdpLite: 0\n"
	m, err := parseUDPDropCounters([]byte(good))
	if err != nil || m["InErrors"] != 3 || m["RcvbufErrors"] != 2 || len(m) != 2 {
		t.Fatalf("good: %v %v", m, err)
	}
	for name, bad := range map[string]string{
		"no Udp lines":         "Ip: Forwarding\nIp: 1\n",
		"header only":          "Udp: InErrors RcvbufErrors\n",
		"width mismatch":       "Udp: InErrors RcvbufErrors\nUdp: 1\n",
		"missing RcvbufErrors": "Udp: InDatagrams InErrors\nUdp: 1 2\n",
		"non-decimal":          "Udp: InErrors RcvbufErrors\nUdp: 1 x\n",
		"negative":             "Udp: InErrors RcvbufErrors\nUdp: -1 0\n",
		"duplicate key":        "Udp: InErrors InErrors RcvbufErrors\nUdp: 1 1 0\n",
		"three Udp lines":      "Udp: InErrors RcvbufErrors\nUdp: 1 0\nUdp: 2 0\n",
	} {
		if m, err := parseUDPDropCounters([]byte(bad)); err == nil {
			t.Errorf("%s accepted: %v", name, m)
		}
	}
}

// permissionProof finds, after since, a CreatePermission and a ChannelBind
// request this client actually sent for peerIP, each answered by a success
// response with the same transaction id.
func (tc *turnClient) permissionProof(peerIP string, since time.Time) (createOK, bindOK bool) {
	tc.cc.mu.Lock()
	defer tc.cc.mu.Unlock()
	answered := map[[12]byte]uint16{}
	for _, r := range tc.cc.stunLog {
		if r.Dir == "recv" {
			answered[r.Tx] = r.Type
		}
	}
	for _, r := range tc.cc.stunLog {
		if r.Dir != "sent" || r.Peer != peerIP || r.At.Before(since) {
			continue
		}
		switch {
		case r.Type == 0x0008 && answered[r.Tx] == 0x0108:
			createOK = true
		case r.Type == 0x0009 && answered[r.Tx] == 0x0109:
			bindOK = true
		}
	}
	return createOK, bindOK
}

func TestCoturnProviderXorPeerAddressAndPermissionProof(t *testing.T) {
	var tx [12]byte
	rand.Read(tx[:])
	ip := net.IPv4(127, 0, 0, 2).To4()
	v := []byte{0, 0x01, 0x12 ^ 0x21, 0x34 ^ 0x12, ip[0] ^ 0x21, ip[1] ^ 0x12, ip[2] ^ 0xa4, ip[3] ^ 0x42}
	req := stunMessage(0x0008, tx, [][2]any{{0x0012, v}}, nil)
	if got := xorPeerIP(req); got != "127.0.0.2" {
		t.Fatalf("xorPeerIP = %q", got)
	}
	since := time.Now()
	cc := &countConn{channel: map[string]int{}}
	tc := &turnClient{cc: cc}
	cc.note("sent", req)
	if c, _ := tc.permissionProof("127.0.0.2", since); c {
		t.Fatal("an unanswered CreatePermission counted as proof")
	}
	cc.note("recv", stunMessage(0x0118, tx, nil, nil)) // error response
	if c, _ := tc.permissionProof("127.0.0.2", since); c {
		t.Fatal("an error response counted as success")
	}
	var tx2 [12]byte
	rand.Read(tx2[:])
	cc.note("sent", stunMessage(0x0008, tx2, [][2]any{{0x0012, v}}, nil))
	cc.note("recv", stunMessage(0x0108, tx2, nil, nil))
	if c, b := tc.permissionProof("127.0.0.2", since); !c || b {
		t.Fatalf("success proof: create %v bind %v", c, b)
	}
	if c, _ := tc.permissionProof("127.0.0.1", since); c {
		t.Fatal("proof matched another peer IP")
	}
	if c, _ := tc.permissionProof("127.0.0.2", time.Now().Add(time.Second)); c {
		t.Fatal("proof matched a request before since")
	}
}
