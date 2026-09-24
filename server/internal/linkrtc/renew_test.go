package linkrtc

// A11: the renewal transport surface against real Pion peers and the patched
// TURN server. These pin the Pion facts the CLI's renewal design rests on:
// a restart offer retires the live path at once (break-before-make); the
// renewed credential is what allocates afterwards; the old allocation is
// released; and the generation labels come from the agent's CURRENT state.

import (
	"bytes"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	turnv4 "github.com/pion/turn/v4"
	"github.com/pion/webrtc/v4"
)

type renewTURN struct {
	srv  *turnv4.Server
	addr string
	mu   sync.Mutex
	used map[string]int
}

func startRenewTURN(t *testing.T) *renewTURN {
	t.Helper()
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	rt := &renewTURN{addr: udp.LocalAddr().String(), used: map[string]int{}}
	srv, err := turnv4.NewServer(turnv4.ServerConfig{
		Realm: turnRealm,
		AuthHandler: func(u, realm string, _ net.Addr) ([]byte, bool) {
			rt.mu.Lock()
			rt.used[u]++
			rt.mu.Unlock()
			return turnv4.GenerateAuthKey(u, realm, "pw"), true
		},
		PacketConnConfigs: []turnv4.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: &turnv4.RelayAddressGeneratorPortRange{
			RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1", MinPort: 49152, MaxPort: 65535,
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	rt.srv = srv
	t.Cleanup(func() { _ = srv.Close() })
	return rt
}

func (rt *renewTURN) cfg(user string) webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers:         []webrtc.ICEServer{{URLs: []string{"turn:" + rt.addr + "?transport=udp"}, Username: user, Credential: "pw"}},
		ICETransportPolicy: webrtc.ICETransportPolicyRelay,
	}
}

func (rt *renewTURN) uses(user string) int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.used[user]
}

// heldCandidates takes the candidates p emitted since its last call.
func heldCandidates(p *peer) []webrtc.ICECandidateInit {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []webrtc.ICECandidateInit
	for _, e := range p.holdBuf {
		if e.Kind == EventLocalCandidate {
			out = append(out, *e.Candidate)
		}
	}
	p.holdBuf = nil
	return out
}

func TestRenewerMigratesBreakBeforeMakeThroughTURN(t *testing.T) {
	rt := startRenewTURN(t)
	a, b := newPair(t, pairOpts{cfgA: rt.cfg("1900000000:old"), cfgB: rt.cfg("1900000000:old")})
	open(t, a, b)
	sa, sb := newSink(), newSink()
	sa.attach(t, a.c)
	sb.attach(t, b.c)
	if err := a.c.Write(LaneText, []byte("before")); err != nil {
		t.Fatal(err)
	}
	sb.waitN(t, 1, 10*time.Second)
	if n := waitAllocs(rt.srv, 2, 5*time.Second); n != 2 {
		t.Fatalf("allocations %d before renewal", n)
	}

	ra, rb := NewRenewer(a.c), NewRenewer(b.c)
	baseA, okA := ra.BaselineSDP()
	baseB, okB := rb.BaselineSDP()
	if !okA || !okB || !strings.Contains(baseA, "a=setup:") || !strings.Contains(baseB, "a=setup:actpass") {
		t.Fatalf("baselines not pinned from the applied remote descriptions")
	}
	gen0A, gen0B := ra.LocalUfrag(), rb.LocalUfrag()
	if l, r := ra.SelectedGeneration(); l != gen0A || r != rb.LocalUfrag() {
		t.Fatalf("epoch-0 selected generation %q/%q, want %q/%q", l, r, gen0A, gen0B)
	}
	// An epoch-0 candidate string, to prove it is not labelled after restart.
	var oldCand string
	for _, e := range a.events(EventLocalCandidate) {
		oldCand = e.Candidate.Candidate
	}
	if ra.LocalGeneration(oldCand) != gen0A {
		t.Fatalf("an epoch-0 candidate is not labelled with epoch 0")
	}

	// Candidates are routed by hand from here on, through the renewal path.
	for _, p := range []*peer{a, b} {
		p.mu.Lock()
		p.hold = true
		p.holdBuf = nil
		p.mu.Unlock()
	}
	// The policy the link was built with survives a configuration that says
	// otherwise.
	loose := rt.cfg("1900000000:new")
	loose.ICETransportPolicy = webrtc.ICETransportPolicyAll
	if err := ra.SetConfiguration(loose); err != nil {
		t.Fatal(err)
	}
	if err := rb.SetConfiguration(rt.cfg("1900000000:new")); err != nil {
		t.Fatal(err)
	}
	if p := a.c.pc.GetConfiguration().ICETransportPolicy; p != webrtc.ICETransportPolicyRelay {
		t.Fatalf("renewal changed the transport policy to %s", p)
	}
	if err := ra.SetConfiguration("not a configuration"); err != ErrRenewConfig {
		t.Fatalf("SetConfiguration(string) = %v", err)
	}

	offer, err := ra.RestartOffer()
	if err != nil {
		t.Fatal(err)
	}
	// Break-before-make: the offer alone retired the initiator's path.
	if l, _ := ra.SelectedGeneration(); l != "" {
		t.Fatalf("a selected pair survived the restart offer: %q", l)
	}
	if ra.LocalUfrag() == gen0A || ra.LocalUfrag() == "" {
		t.Fatalf("the restart offer kept ufrag %q", ra.LocalUfrag())
	}
	if ra.LocalGeneration(oldCand) != "" {
		t.Fatal("an epoch-0 candidate was labelled with the new generation")
	}
	applied, err := rb.ApplyRemote("offer", offer)
	if err != nil || rb.RemoteUfrag() != ra.LocalUfrag() || !strings.Contains(applied, "a=ice-ufrag:"+ra.LocalUfrag()) {
		t.Fatalf("responder apply: %v remote=%q", err, rb.RemoteUfrag())
	}
	answer, err := rb.Answer()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ra.ApplyRemote("answer", answer); err != nil {
		t.Fatal(err)
	}
	if ra.RemoteUfrag() != rb.LocalUfrag() || rb.LocalUfrag() == gen0B {
		t.Fatalf("ufrags: a remote %q, b local %q (was %q)", ra.RemoteUfrag(), rb.LocalUfrag(), gen0B)
	}
	if _, err := ra.ApplyRemote("pranswer", answer); err != ErrSDPType {
		t.Fatalf("pranswer accepted: %v", err)
	}

	// Route the new generation's candidates, labelled from the agent.
	deadline := time.Now().Add(20 * time.Second)
	routed := 0
	for {
		for _, pr := range []struct {
			from, to *peer
			rf, rt   *Renewer
		}{{a, b, ra, rb}, {b, a, rb, ra}} {
			for _, c := range heldCandidates(pr.from) {
				label := pr.rf.LocalGeneration(c.Candidate)
				if label == "" {
					continue // cannot tell: never sent
				}
				if label != pr.rf.LocalUfrag() {
					t.Fatalf("candidate labelled %q, agent ufrag %q", label, pr.rf.LocalUfrag())
				}
				var idx *uint32
				if c.SDPMLineIndex != nil {
					v := uint32(*c.SDPMLineIndex)
					idx = &v
				}
				if err := pr.rt.AddCandidate(c.Candidate, c.SDPMid, idx, label); err != nil {
					t.Fatalf("add candidate: %v", err)
				}
				routed++
			}
		}
		la, rA := ra.SelectedGeneration()
		lb, rB := rb.SelectedGeneration()
		if la == ra.LocalUfrag() && rA == ra.RemoteUfrag() && lb == rb.LocalUfrag() && rB == rb.RemoteUfrag() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no new-generation pair: a %q/%q b %q/%q routed %d", la, rA, lb, rB, routed)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// The same SCTP association carries both lanes on the new allocation.
	if err := a.c.Write(LaneFile, bytes.Repeat([]byte{1}, 70_000)); err != nil {
		t.Fatal(err)
	}
	if err := b.c.Write(LaneText, []byte("after")); err != nil {
		t.Fatal(err)
	}
	if got := sb.waitN(t, 2, 10*time.Second); len(got[1].data) != 70_000 {
		t.Fatal("file frame after migration corrupted")
	}
	if got := sa.waitN(t, 1, 10*time.Second); string(got[0].data) != "after" {
		t.Fatal("text after migration")
	}
	if rt.uses("1900000000:new") == 0 {
		t.Fatal("the renewed credential never authenticated")
	}
	// The old allocations exit: two live, both on the renewed credential.
	if n := waitAllocs(rt.srv, 2, 10*time.Second); n != 2 {
		t.Fatalf("allocations %d after migration, want the two renewed ones only", n)
	}
	info, err := a.c.SelectedPath()
	if err != nil || info.Path != PathRelay {
		t.Fatalf("path after migration %+v %v", info, err)
	}
}

func TestDeadlineLatchRenewOnlyLater(t *testing.T) {
	base := time.Unix(1_900_000_000, 0)
	d := func(off time.Duration) RelayDeadline {
		return RelayDeadline{ExpiresAt: base.Add(off), DeadlineAt: base.Add(off - time.Minute), WarnAt: base.Add(off - 6*time.Minute)}
	}
	var l DeadlineLatch
	if l.Renew(d(time.Hour)) {
		t.Fatal("renewed a latch that bounded nothing")
	}
	l.Tighten(d(time.Hour))
	for _, off := range []time.Duration{time.Hour, 30 * time.Minute, 0} {
		if l.Renew(d(off)) {
			t.Fatalf("renew to +%s accepted over +1h", off)
		}
	}
	if !l.Renew(d(2 * time.Hour)) {
		t.Fatal("a later bound was refused")
	}
	if b, _ := l.Bound(); !b.DeadlineAt.Equal(d(2 * time.Hour).DeadlineAt) {
		t.Fatalf("bound %v", b.DeadlineAt)
	}
	// Tighten keeps its only-earlier rule after a renewal.
	l.Tighten(d(3 * time.Hour))
	if b, _ := l.Bound(); !b.DeadlineAt.Equal(d(2 * time.Hour).DeadlineAt) {
		t.Fatal("Tighten extended a renewed bound")
	}
}
