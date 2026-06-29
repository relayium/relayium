package signal

import (
	"sync"
	"testing"
)

type fakeConn struct {
	mu   sync.Mutex
	sent []Envelope
}

func (f *fakeConn) Send(e Envelope) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, e)
}

func (f *fakeConn) last() Envelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent[len(f.sent)-1]
}

func TestJoinSendsWelcomeAndRoster(t *testing.T) {
	h := NewHub()
	a := &fakeConn{}
	h.Join("ip1", "a", "Alice", a)
	if a.sent[0].Type != TypeWelcome || a.sent[0].Name != "a" {
		t.Fatalf("expected welcome with self id, got %+v", a.sent[0])
	}
	b := &fakeConn{}
	h.Join("ip1", "b", "Bob", b)
	// Both a and b should now have received a peers roster naming both.
	if got := a.last(); got.Type != TypePeers || len(got.Peers) != 2 {
		t.Fatalf("a roster wrong: %+v", got)
	}
}

func TestRelayGoesOnlyToTarget(t *testing.T) {
	h := NewHub()
	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.Join("ip1", "a", "A", a)
	h.Join("ip1", "b", "B", b)
	h.Join("ip1", "c", "C", c)
	bBefore := len(b.sent)
	cBefore := len(c.sent)
	h.Relay("ip1", Envelope{Type: TypeSignal, From: "a", To: "b", Data: []byte(`"x"`)})
	if len(b.sent) != bBefore+1 || b.last().From != "a" {
		t.Fatalf("b should receive relayed signal from a")
	}
	if len(c.sent) != cBefore {
		t.Fatalf("c must NOT receive a's signal")
	}
}

func TestLeaveRebroadcastsRoster(t *testing.T) {
	h := NewHub()
	a, b := &fakeConn{}, &fakeConn{}
	h.Join("ip1", "a", "A", a)
	h.Join("ip1", "b", "B", b)
	h.Leave("ip1", "b")
	if got := a.last(); got.Type != TypePeers || len(got.Peers) != 1 {
		t.Fatalf("a should see roster of 1 after b leaves: %+v", got)
	}
}

func TestRoomsAreIsolated(t *testing.T) {
	h := NewHub()
	a, b := &fakeConn{}, &fakeConn{}
	h.Join("ip1", "a", "A", a)
	h.Join("ip2", "b", "B", b)
	if got := a.last(); len(got.Peers) != 1 {
		t.Fatalf("a in ip1 must not see b in ip2: %+v", got)
	}
}

func TestJoinLimitedEnforcesCapacity(t *testing.T) {
	h := NewHub()
	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
	if !h.JoinLimited("t:room", "a", "A", a, 2) {
		t.Fatalf("first join should be admitted")
	}
	if !h.JoinLimited("t:room", "b", "B", b, 2) {
		t.Fatalf("second join should be admitted")
	}
	if h.JoinLimited("t:room", "c", "C", c, 2) {
		t.Fatalf("third join must be rejected at capacity 2")
	}
	// The rejected peer received no welcome.
	if len(c.sent) != 0 {
		t.Fatalf("rejected peer must get no messages, got %+v", c.sent)
	}
	// The room still has exactly the two admitted peers in its roster.
	if got := b.last(); got.Type != TypePeers || len(got.Peers) != 2 {
		t.Fatalf("roster should be 2 after rejection: %+v", got)
	}
}

func TestJoinUnlimitedAllowsMany(t *testing.T) {
	h := NewHub()
	for _, id := range []string{"a", "b", "c", "d"} {
		if !h.JoinLimited("ip1", id, id, &fakeConn{}, 0) {
			t.Fatalf("max=0 must allow %s", id)
		}
	}
}
