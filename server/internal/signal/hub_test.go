package signal

import (
	"strconv"
	"sync"
	"testing"
	"time"
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

// count returns how many envelopes a fakeConn has received so far, taking the
// same lock Send/last/countType use. A plain len(f.sent) from a test goroutine
// races with a debounced roster broadcast that a real time.AfterFunc timer
// (armed by hub.go's scheduleRoster) can still be delivering via Send
// concurrently — see TestRelayGoesOnlyToTarget, which uses a real NewHub().
func (f *fakeConn) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

// countType counts how many envelopes of a given type a fakeConn has received.
func countType(f *fakeConn, typ string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, e := range f.sent {
		if e.Type == typ {
			n++
		}
	}
	return n
}

// syncHub runs the roster timer inline so tests that assert on the roster after a
// second same-room mutation see it immediately (debounce is behavior-preserving
// when the trailing timer fires synchronously).
func syncHub() *Hub {
	return newHub(time.Now, func(_ time.Duration, f func()) { f() })
}

func TestRosterBroadcastDebounced(t *testing.T) {
	now := time.Unix(1000, 0)
	var pending []func()
	after := func(_ time.Duration, f func()) { pending = append(pending, f) }
	h := newHub(func() time.Time { return now }, after)

	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinLimited("t:room", "a", "A", a, 0, "") // leading edge → immediate broadcast
	h.JoinLimited("t:room", "b", "B", b, 0, "") // within window → coalesced
	h.JoinLimited("t:room", "c", "C", c, 0, "") // within window → coalesced

	if got := countType(a, TypePeers); got != 1 {
		t.Fatalf("during the window a should have exactly 1 roster broadcast (leading), got %d", got)
	}
	if len(pending) != 1 {
		t.Fatalf("a burst must arm exactly one trailing timer, got %d", len(pending))
	}

	now = now.Add(rosterDebounce) // advance past the window and fire the trailing timer
	pending[0]()

	if got := countType(a, TypePeers); got != 2 {
		t.Fatalf("after the trailing flush a should have 2 roster broadcasts, got %d", got)
	}
	if last := a.last(); last.Type != TypePeers || len(last.Peers) != 3 {
		t.Fatalf("final roster must list all 3 peers, got %+v", last)
	}
}

func TestRosterSingleChangeBroadcastsPromptly(t *testing.T) {
	now := time.Unix(2000, 0)
	armed := 0
	h := newHub(func() time.Time { return now }, func(_ time.Duration, _ func()) { armed++ })
	a := &fakeConn{}
	h.JoinLimited("t:room", "a", "A", a, 0, "")
	if got := countType(a, TypePeers); got != 1 {
		t.Fatalf("a single change must broadcast immediately, got %d", got)
	}
	if armed != 0 {
		t.Fatalf("a single change must not arm a trailing timer, got %d", armed)
	}
}

func TestJoinSendsWelcomeAndRoster(t *testing.T) {
	h := syncHub()
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

func TestJoinLimitedStampsWelcomeWithClientIP(t *testing.T) {
	h := NewHub()
	a := &fakeConn{}
	h.JoinLimited("t:room", "a", "Alice", a, 2, "198.51.100.9")
	if got := a.sent[0]; got.Type != TypeWelcome || got.IP != "198.51.100.9" {
		t.Fatalf("welcome should carry the client IP, got %+v", got)
	}
}

func TestWelcomeIPNotInRoster(t *testing.T) {
	h := syncHub()
	a, b := &fakeConn{}, &fakeConn{}
	h.JoinLimited("t:room", "a", "Alice", a, 0, "198.51.100.9")
	h.JoinLimited("t:room", "b", "Bob", b, 0, "203.0.113.7")
	// The roster must never leak any peer's IP to other peers.
	for _, p := range b.last().Peers {
		if p.ID == "" {
			t.Fatalf("unexpected empty peer id")
		}
	}
	if b.last().IP != "" {
		t.Fatalf("roster envelope must not carry an IP, got %q", b.last().IP)
	}
}

func TestRelayGoesOnlyToTarget(t *testing.T) {
	h := NewHub()
	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.Join("ip1", "a", "A", a)
	h.Join("ip1", "b", "B", b)
	h.Join("ip1", "c", "C", c)
	bBefore := b.count()
	cBefore := c.count()
	h.Relay("ip1", Envelope{Type: TypeSignal, From: "a", To: "b", Data: []byte(`"x"`)})
	if b.count() != bBefore+1 || b.last().From != "a" {
		t.Fatalf("b should receive relayed signal from a")
	}
	if c.count() != cBefore {
		t.Fatalf("c must NOT receive a's signal")
	}
}

func TestLeaveRebroadcastsRoster(t *testing.T) {
	h := syncHub()
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
	h := syncHub()
	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
	if !h.JoinLimited("t:room", "a", "A", a, 2, "") {
		t.Fatalf("first join should be admitted")
	}
	if !h.JoinLimited("t:room", "b", "B", b, 2, "") {
		t.Fatalf("second join should be admitted")
	}
	if h.JoinLimited("t:room", "c", "C", c, 2, "") {
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

func TestJoinLimitedGlobalRoomCap(t *testing.T) {
	h := NewHub()
	for i := 0; i < maxRooms; i++ {
		room := "r" + strconv.Itoa(i)
		if !h.JoinLimited(room, "a", "A", &fakeConn{}, 0, "") {
			t.Fatalf("room %d under the cap must be admitted", i)
		}
	}
	// A brand-new room beyond the cap is rejected...
	if h.JoinLimited("overflow", "x", "X", &fakeConn{}, 0, "") {
		t.Fatal("a new room beyond maxRooms must be rejected")
	}
	// ...but an already-existing room still admits new peers.
	if !h.JoinLimited("r0", "b", "B", &fakeConn{}, 0, "") {
		t.Fatal("an existing room must still admit peers at the cap")
	}
}

func TestJoinUnlimitedAllowsMany(t *testing.T) {
	h := NewHub()
	for _, id := range []string{"a", "b", "c", "d"} {
		if !h.JoinLimited("ip1", id, id, &fakeConn{}, 0, "") {
			t.Fatalf("max=0 must allow %s", id)
		}
	}
}
