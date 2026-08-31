package signal

import "testing"

func fixedPairRegistry(now *int64, code string) *PairRegistry {
	r := NewPairRegistry(300, func() int64 { return *now })
	r.draw = func() string { return code }
	r.drawRoom = func() string { return "generation-one" }
	return r
}

func TestPairActivityMilestonesAreOncePerLiveCode(t *testing.T) {
	now := int64(1000)
	r := fixedPairRegistry(&now, "424242")
	code, _ := r.MintFor("owner")
	room, _ := r.RoomFor(code)
	if _, got, ok := r.ObserveAdmittedRoom(room, 1); !ok || got != (PairActivity{Opened: true}) {
		t.Fatalf("first admission = %+v", got)
	}
	if _, got, ok := r.ObserveAdmittedRoom(room, 1); !ok || got != (PairActivity{}) {
		t.Fatalf("duplicate/reconnect admission = %+v", got)
	}
	if _, got, ok := r.ObserveAdmittedRoom(room, 2); !ok || got != (PairActivity{Paired: true}) {
		t.Fatalf("first pair = %+v", got)
	}
	if _, got, ok := r.ObserveAdmittedRoom(room, 2); !ok || got != (PairActivity{}) {
		t.Fatalf("duplicate pair = %+v", got)
	}
}

func TestPairActivityBackfillsOpenedWhenFirstObservationHasTwoPeers(t *testing.T) {
	now := int64(1000)
	r := fixedPairRegistry(&now, "434343")
	code, _ := r.MintFor("owner")
	room, _ := r.RoomFor(code)
	if _, got, ok := r.ObserveAdmittedRoom(room, 2); !ok || got != (PairActivity{Opened: true, Paired: true}) {
		t.Fatalf("two-peer first observation = %+v, want opened+paired", got)
	}
}

func TestPairActivityRejectsUnknownExpiredAndNonAdmissions(t *testing.T) {
	now := int64(1000)
	r := fixedPairRegistry(&now, "444444")
	code, _ := r.MintFor("owner")
	room, _ := r.RoomFor(code)
	if _, got, ok := r.ObserveAdmittedRoom(room, 0); ok || got != (PairActivity{}) {
		t.Fatalf("zero peers = %+v", got)
	}
	if _, got, ok := r.ObserveAdmittedRoom(pairRoomForGeneration("999999", "other"), 2); ok || got != (PairActivity{}) {
		t.Fatalf("unknown code = %+v", got)
	}
	now = 1300
	if _, got, ok := r.ObserveAdmittedRoom(room, 2); ok || got != (PairActivity{}) {
		t.Fatalf("expired code = %+v", got)
	}
}

func TestReissuedDigitsUseIsolatedRoomGeneration(t *testing.T) {
	now := int64(1000)
	r := fixedPairRegistry(&now, "454545")
	generation := "old-generation"
	r.drawRoom = func() string { return generation }
	code, _ := r.MintFor("owner-old")
	oldRoom, _ := r.RoomFor(code)

	hub := syncHub()
	oldA, oldB := &fakeConn{}, &fakeConn{}
	if admitted, peers := hub.JoinDeviceLimitedObserved(oldRoom, "old-a", "old", oldA, 2, "", "", false); !admitted || peers != 1 {
		t.Fatalf("old first join = (%v,%d)", admitted, peers)
	}

	now = 1300 // expiry is exclusive
	generation = "new-generation"
	newCode, _ := r.MintFor("owner-new")
	if newCode != code {
		t.Fatalf("forced reissue = %q, want %q", newCode, code)
	}
	newRoom, _ := r.RoomFor(newCode)
	if newRoom == oldRoom {
		t.Fatal("same digits reused the old signaling room")
	}

	// The old socket can still admit its old peer, but that room is no longer
	// current and therefore cannot trigger lifecycle or aggregate milestones.
	if admitted, peers := hub.JoinDeviceLimitedObserved(oldRoom, "old-b", "old", oldB, 2, "", "", false); !admitted || peers != 2 {
		t.Fatalf("old second join = (%v,%d)", admitted, peers)
	}
	if staleCode, staleActivity, current := r.ObserveAdmittedRoom(oldRoom, 2); current || staleCode != "" || staleActivity != (PairActivity{}) {
		t.Fatalf("stale room observed as current: code=%q activity=%+v current=%v", staleCode, staleActivity, current)
	}

	newA, newB := &fakeConn{}, &fakeConn{}
	_, newPeers := hub.JoinDeviceLimitedObserved(newRoom, "new-a", "new", newA, 2, "", "", false)
	if newPeers != 1 {
		t.Fatalf("old room consumed new room capacity: new peers=%d", newPeers)
	}
	_, activity, current := r.ObserveAdmittedRoom(newRoom, newPeers)
	if !current || activity != (PairActivity{Opened: true}) {
		t.Fatalf("new first activity = %+v current=%v", activity, current)
	}
	_, newPeers = hub.JoinDeviceLimitedObserved(newRoom, "new-b", "new", newB, 2, "", "", false)
	_, activity, current = r.ObserveAdmittedRoom(newRoom, newPeers)
	if !current || activity != (PairActivity{Paired: true}) {
		t.Fatalf("new pair activity = %+v current=%v", activity, current)
	}
}
