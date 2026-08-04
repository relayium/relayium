package signal

import (
	"strings"
	"testing"
)

// rosterIDs returns the peer ids of the last roster envelope a fake connection
// received, so a test can talk about what ONE recipient was told rather than
// about the room's internal membership. Per-recipient rosters are the whole
// point of device grouping: two peers in the same room legitimately see
// different lists.
func rosterIDs(f *fakeConn) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.sent) - 1; i >= 0; i-- {
		if f.sent[i].Type == TypePeers {
			out := make([]string, 0, len(f.sent[i].Peers))
			for _, p := range f.sent[i].Peers {
				out = append(out, p.ID)
			}
			return out
		}
	}
	return nil
}

func hasID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

const (
	devA = "0123456789abcdef0123456789abcdef"
	devB = "fedcba9876543210fedcba9876543210"
)

// Two tabs of one browser share one installation id, so an independent device
// must be offered exactly ONE entry for them — this is the reported defect:
// three identically named pages, and picking the wrong one strands the sender.
func TestDeviceGroupAdvertisedOnce(t *testing.T) {
	h := syncHub()
	a1, a2, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a1", "A", a1, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "a2", "A", a2, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	got := rosterIDs(b)
	if len(got) != 1 {
		t.Fatalf("B must see one entry for the two A pages, got %v", got)
	}
	if got[0] != "a1" && got[0] != "a2" {
		t.Fatalf("B's single entry must be one of A's pages, got %v", got)
	}
}

// A client never sees its own installation — including its other tabs, which
// are not send targets and whose presence is what made the chooser ambiguous.
func TestOwnDeviceGroupOmittedFromRoster(t *testing.T) {
	h := syncHub()
	a1, a2, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a1", "A", a1, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "a2", "A", a2, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	for _, ids := range [][]string{rosterIDs(a1), rosterIDs(a2)} {
		if hasID(ids, "a1") || hasID(ids, "a2") {
			t.Fatalf("an A page must not be offered its own device's pages, got %v", ids)
		}
		if !hasID(ids, "b") {
			t.Fatalf("an A page must still see the other device, got %v", ids)
		}
	}
}

// The representative is the page the user is actually looking at: a text/file
// request routed to a background tab is precisely the one-sided wait this fix
// exists to remove.
func TestActivationPicksRepresentative(t *testing.T) {
	h := syncHub()
	a1, a2, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a1", "A", a1, 0, "", devA, true) // joined focused
	h.JoinDeviceLimited("t:room", "a2", "A", a2, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	if got := rosterIDs(b); len(got) != 1 || got[0] != "a1" {
		t.Fatalf("the focused page must represent the device, got %v", got)
	}

	h.Activate("t:room", "a2") // the user switched tabs
	if got := rosterIDs(b); len(got) != 1 || got[0] != "a2" {
		t.Fatalf("activation must hand the device over to a2, got %v", got)
	}
}

// An activation that cannot change what anyone sees must not spend a broadcast:
// focus/visibility fires often, and the roster path is shared by the whole room.
func TestActivationBroadcastsOnlyWhenRepresentativeCanChange(t *testing.T) {
	h := syncHub()
	a1, a2, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a1", "A", a1, 0, "", devA, true)
	h.JoinDeviceLimited("t:room", "a2", "A", a2, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	before := countType(b, TypePeers)
	h.Activate("t:room", "a1") // already the representative
	if got := countType(b, TypePeers); got != before {
		t.Fatalf("re-activating the representative must not rebroadcast, got %d want %d", got, before)
	}
	h.Activate("t:room", "b") // a one-connection device cannot change either
	if got := countType(b, TypePeers); got != before {
		t.Fatalf("activating a lone connection must not rebroadcast, got %d want %d", got, before)
	}
	h.Activate("t:room", "a2")
	if got := countType(b, TypePeers); got <= before {
		t.Fatalf("a representative handover must rebroadcast, got %d want >%d", got, before)
	}
}

// Activation is scoped to the sender's own connection: it can never move
// another device's representative, in its room or in any other.
func TestActivationOnlyAffectsOwnConnection(t *testing.T) {
	h := syncHub()
	a1, a2, b, elsewhere := &fakeConn{}, &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a1", "A", a1, 0, "", devA, true)
	h.JoinDeviceLimited("t:room", "a2", "A", a2, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)
	// Same peer id, same device id, a different room: ids are room-scoped, so
	// this is the frame an attacker would send to move someone else's page.
	h.JoinDeviceLimited("other:room", "a2", "Elsewhere", elsewhere, 0, "", devA, false)

	h.Activate("t:room", "nosuchpeer") // unknown id in a live room
	h.Activate("nosuchroom", "a2")     // known id, no such room
	h.Activate("other:room", "a2")     // its own connection — in the OTHER room

	if got := rosterIDs(b); len(got) != 1 || got[0] != "a1" {
		t.Fatalf("no unknown or cross-room activation may move A's representative, got %v", got)
	}
	if got := rosterIDs(a1); hasID(got, "a1") || hasID(got, "a2") {
		t.Fatalf("A's own pages must stay out of its roster, got %v", got)
	}
}

// When the focused page closes, the device stays reachable through a live
// sibling rather than vanishing or leaving the peer pointed at a dead id.
func TestRepresentativeFallsBackWhenItLeaves(t *testing.T) {
	h := syncHub()
	a1, a2, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a1", "A", a1, 0, "", devA, true)
	h.JoinDeviceLimited("t:room", "a2", "A", a2, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	h.Leave("t:room", "a1")
	if got := rosterIDs(b); len(got) != 1 || got[0] != "a2" {
		t.Fatalf("the surviving page must take over the device, got %v", got)
	}
	h.Leave("t:room", "a2")
	if got := rosterIDs(b); len(got) != 0 {
		t.Fatalf("with every A page gone B must see nothing, got %v", got)
	}
}

// A representative handoff is only a chooser update; the old page can still
// hold a live data channel. A physical close is different and is announced
// explicitly to other devices, while hidden sibling tabs learn nothing about
// one another's peer ids.
func TestPhysicalLeaveIsDistinctFromActivation(t *testing.T) {
	h := syncHub()
	a1, a2, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a1", "A", a1, 0, "", devA, true)
	h.JoinDeviceLimited("t:room", "a2", "A", a2, 0, "", devA, false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	h.Activate("t:room", "a2")
	if got := countType(b, TypeLeft); got != 0 {
		t.Fatalf("focus handoff must not look like a physical leave, got %d events", got)
	}

	h.Leave("t:room", "a1")
	if got := countType(b, TypeLeft); got != 1 {
		t.Fatalf("other devices must receive exactly one physical-leave event, got %d", got)
	}
	if got := countType(a2, TypeLeft); got != 0 {
		t.Fatalf("a sibling tab must not receive a hidden sibling id, got %d events", got)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	found := false
	for _, e := range b.sent {
		if e.Type == TypeLeft {
			found = true
			if e.Peer != "a1" {
				t.Fatalf("leave event names %q, want a1", e.Peer)
			}
		}
	}
	if !found {
		t.Fatal("missing physical-leave event")
	}
}

// Deterministic, not map-order dependent: the same membership must always name
// the same representative, or the roster reshuffles under the user's pointer.
func TestRepresentativeChoiceIsDeterministic(t *testing.T) {
	for i := 0; i < 50; i++ {
		h := syncHub()
		b := &fakeConn{}
		h.JoinDeviceLimited("t:room", "a1", "A", &fakeConn{}, 0, "", devA, false)
		h.JoinDeviceLimited("t:room", "a2", "A", &fakeConn{}, 0, "", devA, false)
		h.JoinDeviceLimited("t:room", "a3", "A", &fakeConn{}, 0, "", devA, false)
		h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)
		got := rosterIDs(b)
		if len(got) != 1 || got[0] != "a3" {
			t.Fatalf("iteration %d: want the last-joined page with nobody focused, got %v", i, got)
		}
	}
}

// A peer that sends no installation id is an older client (or native). It must
// stay a distinct entry and keep receiving the roster shape it was written
// against — which includes itself.
func TestLegacyPeersStayDistinctAndKeepRosterShape(t *testing.T) {
	h := syncHub()
	old1, old2, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	h.JoinLimited("t:room", "o1", "Old", old1, 0, "")
	h.JoinLimited("t:room", "o2", "Old", old2, 0, "")
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	if got := rosterIDs(b); len(got) != 2 || !hasID(got, "o1") || !hasID(got, "o2") {
		t.Fatalf("two legacy peers must remain two entries, got %v", got)
	}
	got := rosterIDs(old1)
	if len(got) != 3 || !hasID(got, "o1") {
		t.Fatalf("a legacy peer must keep the old roster shape including itself, got %v", got)
	}
}

// A hostile or buggy id must not become a grouping key, or one client could
// claim another's group by echoing it back in a shape the server never checked.
func TestInvalidDeviceIDFallsBackToLegacyBehavior(t *testing.T) {
	bad := []string{
		"",                                  // absent
		"short",                             // too short
		strings.Repeat("a", 33),             // too long
		"0123456789ABCDEF0123456789ABCDEF",  // upper case
		"0123456789abcdef0123456789abcde!",  // non-hex
		"0123456789abcdef0123456789abcde\n", // control character
		" 123456789abcdef0123456789abcdef",  // whitespace
	}
	for _, id := range bad {
		if ValidDeviceID(id) {
			t.Fatalf("ValidDeviceID(%q) must be false", id)
		}
	}
	if !ValidDeviceID(devA) {
		t.Fatalf("ValidDeviceID(%q) must be true", devA)
	}

	h := syncHub()
	x, y, b := &fakeConn{}, &fakeConn{}, &fakeConn{}
	// Two connections both presenting the SAME invalid id must not be merged.
	h.JoinDeviceLimited("t:room", "x", "X", x, 0, "", "not-a-device-id", false)
	h.JoinDeviceLimited("t:room", "y", "Y", y, 0, "", "not-a-device-id", false)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)
	if got := rosterIDs(b); len(got) != 2 {
		t.Fatalf("invalid ids must not group two connections, got %v", got)
	}
	// ...and such a connection keeps the legacy roster shape (self included).
	if got := rosterIDs(x); !hasID(got, "x") {
		t.Fatalf("an invalid id must fall back to legacy behavior, got %v", got)
	}
}

// Extra tabs of a device already in the room are not extra devices, so they
// must not eat the room's logical capacity. A different device still cannot.
func TestExtraTabsDoNotConsumeRoomCapacity(t *testing.T) {
	h := syncHub()
	a1, a2, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}, &fakeConn{}
	if !h.JoinDeviceLimited("t:room", "a1", "A", a1, 2, "", devA, true) {
		t.Fatal("first device must be admitted")
	}
	if !h.JoinDeviceLimited("t:room", "b", "B", b, 2, "", devB, false) {
		t.Fatal("second device must be admitted")
	}
	if !h.JoinDeviceLimited("t:room", "a2", "A", a2, 2, "", devA, false) {
		t.Fatal("a second tab of an already-present device must be admitted at capacity")
	}
	if h.JoinDeviceLimited("t:room", "c", "C", c, 2, "", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false) {
		t.Fatal("a third distinct device must still be refused at capacity 2")
	}
	if len(c.sent) != 0 {
		t.Fatalf("a refused peer gets no messages, got %+v", c.sent)
	}
	// The admitted extra tab did not change what B is offered.
	if got := rosterIDs(b); len(got) != 1 || got[0] != "a1" {
		t.Fatalf("B must still see one focused A, got %v", got)
	}
}

// The ordering matters: the old socket-count check passed the test above only
// because the second physical device joined before A's extra tab. In practice a
// user commonly opens several pages first and the other phone arrives later.
func TestExtraTabsBeforeAnotherDeviceDoNotFillLogicalCapacity(t *testing.T) {
	h := syncHub()
	if !h.JoinDeviceLimited("t:room", "a1", "A", &fakeConn{}, 2, "", devA, true) {
		t.Fatal("first page must be admitted")
	}
	if !h.JoinDeviceLimited("t:room", "a2", "A", &fakeConn{}, 2, "", devA, false) {
		t.Fatal("second page of the same device must be admitted")
	}
	b := &fakeConn{}
	if !h.JoinDeviceLimited("t:room", "b", "B", b, 2, "", devB, true) {
		t.Fatal("second logical device must be admitted even after A opened two pages")
	}
	if got := rosterIDs(b); len(got) != 1 || (got[0] != "a1" && got[0] != "a2") {
		t.Fatalf("B must see exactly one A device, got %v", got)
	}
}

// The roster is the one thing every peer in the room reads. The installation id
// is a presence key for the server, not a fact about the user to hand out.
func TestDeviceIDNeverAppearsInRoster(t *testing.T) {
	h := syncHub()
	a, b := &fakeConn{}, &fakeConn{}
	h.JoinDeviceLimited("t:room", "a", "A", a, 0, "", devA, true)
	h.JoinDeviceLimited("t:room", "b", "B", b, 0, "", devB, false)

	b.mu.Lock()
	defer b.mu.Unlock()
	for _, e := range b.sent {
		if e.DeviceID != "" || e.Active {
			t.Fatalf("outbound frames must carry no device presence, got %+v", e)
		}
		for _, p := range e.Peers {
			if strings.Contains(p.ID, devA) || strings.Contains(p.Name, devA) {
				t.Fatalf("roster leaked a device id: %+v", p)
			}
		}
	}
}

// Join/JoinLimited keep working untouched: they are the legacy entry points and
// every existing caller and test depends on their exact behavior.
func TestJoinLimitedStillJoinsWithoutDevice(t *testing.T) {
	h := syncHub()
	a, b := &fakeConn{}, &fakeConn{}
	h.Join("t:room", "a", "A", a)
	if !h.JoinLimited("t:room", "b", "B", b, 2, "1.2.3.4") {
		t.Fatal("JoinLimited must still admit")
	}
	if got := b.sent[0]; got.Type != TypeWelcome || got.IP != "1.2.3.4" {
		t.Fatalf("welcome unchanged, got %+v", got)
	}
	if got := rosterIDs(b); len(got) != 2 {
		t.Fatalf("legacy roster still lists both peers, got %v", got)
	}
}
