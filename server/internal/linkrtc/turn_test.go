package linkrtc

// L2: the TURN v5 client inside Pion ICE against the PATCHED TURN v4 server
// (server/third_party/pion-turn, via the go.mod directory replace). turn/v4 is
// imported by this test only; the transport links the v5 client alone.

import (
	"bytes"
	"net"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	turnv4 "github.com/pion/turn/v4"
	turnv5 "github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"

	"github.com/relayium/relayium/internal/linkwire"
)

const turnRealm = "relayium.test"

// heldRelay delays handing the first relay socket's read error back to the
// server, so an ended allocation's reader unwinds only after its successor
// on the same 5-tuple exists (the W-N38 ordering).
type heldRelay struct {
	net.PacketConn
	once       sync.Once
	readFailed chan struct{}
	hold       chan struct{}
	holdOnce   sync.Once
	readerGID  string
}

func (h *heldRelay) ReadFrom(p []byte) (int, net.Addr, error) {
	n, addr, err := h.PacketConn.ReadFrom(p)
	if err != nil {
		h.once.Do(func() {
			h.readerGID = goroutineID()
			close(h.readFailed)
		})
		<-h.hold
	}
	return n, addr, err
}

func (h *heldRelay) release() { h.holdOnce.Do(func() { close(h.hold) }) }

type relayGen struct {
	inner turnv4.RelayAddressGenerator
	held  bool

	mu    sync.Mutex
	first *heldRelay
}

func (g *relayGen) Validate() error { return g.inner.Validate() }
func (g *relayGen) AllocateConn(network string, port int) (net.Conn, net.Addr, error) {
	return g.inner.AllocateConn(network, port)
}

func (g *relayGen) AllocatePacketConn(network string, port int) (net.PacketConn, net.Addr, error) {
	pc, addr, err := g.inner.AllocatePacketConn(network, port)
	if err != nil || !g.held {
		return pc, addr, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.first == nil {
		g.first = &heldRelay{PacketConn: pc, readFailed: make(chan struct{}), hold: make(chan struct{})}
		return g.first, addr, nil
	}
	return pc, addr, nil
}

func startTURN(t *testing.T, held bool) (*turnv4.Server, *relayGen, string) {
	t.Helper()
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gen := &relayGen{held: held, inner: &turnv4.RelayAddressGeneratorPortRange{
		RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1", MinPort: 49152, MaxPort: 65535,
	}}
	srv, err := turnv4.NewServer(turnv4.ServerConfig{
		Realm: turnRealm,
		AuthHandler: func(u, realm string, _ net.Addr) ([]byte, bool) {
			return turnv4.GenerateAuthKey(u, realm, "pw"), true
		},
		PacketConnConfigs: []turnv4.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: gen}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		gen.mu.Lock()
		if gen.first != nil {
			gen.first.release()
		}
		gen.mu.Unlock()
		_ = srv.Close()
	})
	return srv, gen, udp.LocalAddr().String()
}

func waitAllocs(srv *turnv4.Server, want int, d time.Duration) int {
	deadline := time.Now().Add(d)
	for {
		n := srv.AllocationCount()
		if n == want || time.Now().After(deadline) {
			return n
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func relayConfig(addr string, policy webrtc.ICETransportPolicy) webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers:         []webrtc.ICEServer{{URLs: []string{"turn:" + addr + "?transport=udp"}, Username: "1900000000:tag", Credential: "pw"}},
		ICETransportPolicy: policy,
	}
}

// Relay-only through the patched server: the selected pair is relay on both
// sides (from the agent, not from the configuration), whole-chunk frames move,
// allocations exist while open and are gone after Close.
func TestRelayOnlyThroughPatchedTURN(t *testing.T) {
	srv, _, addr := startTURN(t, false)
	cfg := relayConfig(addr, webrtc.ICETransportPolicyRelay)
	a, b := newPair(t, pairOpts{cfgA: cfg, cfgB: cfg})
	ba, _ := open(t, a, b)
	if ba.MaxFrameBytes != LocalMaxMessageSize {
		t.Fatalf("budget %+v", ba)
	}
	sa, sb := newSink(), newSink()
	sa.attach(t, a.c)
	sb.attach(t, b.c)
	chunk := bytes.Repeat([]byte{0x77}, linkwire.ChunkSize+linkwire.ChunkOverhead)
	for _, f := range [][]byte{make([]byte, 65536), chunk} {
		if err := a.c.Write(LaneFile, f); err != nil {
			t.Fatal(err)
		}
	}
	got := sb.waitN(t, 2, 20*time.Second)
	if len(got[0].data) != 65536 || !bytes.Equal(got[1].data, chunk) {
		t.Fatal("relayed frames corrupted")
	}
	if err := b.c.Write(LaneText, []byte("pong")); err != nil {
		t.Fatal(err)
	}
	sa.waitN(t, 1, 10*time.Second)
	for _, p := range []*peer{a, b} {
		info, err := p.c.SelectedPath()
		if err != nil || info.Path != PathRelay {
			t.Fatalf("%s: selected %+v err=%v, want relay", p.name, info, err)
		}
		if ev := p.waitFor(EventPathChanged, 5*time.Second); ev.Path.Path != PathRelay {
			t.Fatalf("%s PathChanged %+v", p.name, ev.Path)
		}
	}
	live := srv.AllocationCount()
	a.c.Close()
	b.c.Close()
	after := waitAllocs(srv, 0, 10*time.Second)
	t.Logf("allocations open=%d after close=%d", live, after)
	if live < 2 || after != 0 {
		t.Fatalf("allocation lifecycle: open=%d afterClose=%d", live, after)
	}
}

// A link that merely HAD a TURN server (policy all) but selected the host
// pair must report lan, never relay: the path is what was selected.
func TestIssuedRelayIsNotReportedAsRelay(t *testing.T) {
	srv, _, addr := startTURN(t, false)
	cfg := relayConfig(addr, webrtc.ICETransportPolicyAll)
	a, b := newPair(t, pairOpts{cfgA: cfg, cfgB: cfg})
	open(t, a, b)
	deadline := time.Now().Add(10 * time.Second)
	for srv.AllocationCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if srv.AllocationCount() == 0 {
		t.Fatal("no relay candidate was gathered; the test would prove nothing")
	}
	for _, p := range []*peer{a, b} {
		info, err := p.c.SelectedPath()
		if err != nil || info.Path != PathLAN {
			t.Fatalf("%s: %+v err=%v, want lan despite an issued relay", p.name, info, err)
		}
	}
}

// W-N38 client side (A09-DESIGN §3.2): the TURN v5 client ends an allocation
// and re-allocates from the SAME local port; the first allocation's relay
// reader unwinds only after the second exists. Against the patched server the
// second allocation stays live and relays both ways.
func TestSamePortReallocationStaysLive(t *testing.T) {
	srv, gen, addr := startTURN(t, true)
	local, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	localAddr := local.LocalAddr().String()

	newClient := func(conn net.PacketConn) *turnv5.Client {
		c, err := turnv5.NewClient(&turnv5.ClientConfig{
			STUNServerAddr: addr, TURNServerAddr: addr, Conn: conn,
			Username: "1900000000:tag", Password: "pw", Realm: turnRealm,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := c.Listen(); err != nil {
			t.Fatal(err)
		}
		return c
	}

	c1 := newClient(local)
	r1, err := c1.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if n := waitAllocs(srv, 1, 5*time.Second); n != 1 {
		t.Fatalf("first allocation: %d", n)
	}
	_ = r1.Close() // Refresh(LIFETIME=0)
	gen.mu.Lock()
	first := gen.first
	gen.mu.Unlock()
	select {
	case <-first.readFailed: // #1 ended; its reader now holds the error
	case <-time.After(10 * time.Second):
		t.Fatal("first allocation was not ended by the client's close")
	}
	if n := waitAllocs(srv, 0, 5*time.Second); n != 0 {
		t.Fatalf("after close: %d allocations", n)
	}
	c1.Close()
	_ = local.Close()

	local2, err := net.ListenPacket("udp4", localAddr) // same source port
	if err != nil {
		t.Fatalf("re-listen on %s: %v", localAddr, err)
	}
	defer local2.Close()
	c2 := newClient(local2)
	defer c2.Close()
	r2, err := c2.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Close()
	if n := srv.AllocationCount(); n != 1 {
		t.Fatalf("second allocation: %d", n)
	}

	first.release()
	waitGoroutineExited(t, first.readerGID)
	time.Sleep(100 * time.Millisecond)
	if n := srv.AllocationCount(); n != 1 {
		t.Fatalf("the first allocation's late reader ended the second: %d allocations", n)
	}

	peerConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peerConn.Close()
	if _, err := r2.WriteTo([]byte("ping"), peerConn.LocalAddr()); err != nil { // creates the permission
		t.Fatal(err)
	}
	buf := make([]byte, 1500)
	_ = peerConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, from, err := peerConn.ReadFrom(buf)
	if err != nil || string(buf[:n]) != "ping" {
		t.Fatalf("relay out: %q err=%v", buf[:n], err)
	}
	if _, err := peerConn.WriteTo([]byte("pong"), from); err != nil {
		t.Fatal(err)
	}
	_ = r2.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, _, err = r2.ReadFrom(buf)
	if err != nil || string(buf[:n]) != "pong" {
		t.Fatalf("relay in: %q err=%v", buf[:n], err)
	}
}

func goroutineID() string {
	buf := make([]byte, 64)
	buf = buf[:runtime.Stack(buf, false)]
	f := strings.Fields(string(buf))
	if len(f) < 2 || f[0] != "goroutine" {
		return ""
	}
	return f[1]
}

func waitGoroutineExited(t *testing.T, gid string) {
	t.Helper()
	if gid == "" {
		t.Fatal("reader goroutine ID was not captured")
	}
	marker := "goroutine " + gid + " ["
	deadline := time.Now().Add(10 * time.Second)
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n == len(buf) {
			buf = make([]byte, 2*len(buf))
			continue
		}
		if !strings.Contains(string(buf[:n]), marker) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("relay reader goroutine %s did not return", gid)
		}
		time.Sleep(time.Millisecond)
	}
}
