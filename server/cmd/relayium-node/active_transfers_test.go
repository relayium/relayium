package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// activeAllocs is the load signal the node reports to central, and central uses
// it to choose the rollout canary — the machine with the least to lose if a
// build is bad. It must therefore mean "transfers happening RIGHT NOW", which
// is a different question from the one len(Usage) answers.
//
// len(Usage) was the obvious candidate and is NOT that number:
//   - it EXCLUDES a live allocation whose OnAllocationCreated has not fired yet
//     (sendHeartbeat skips samples with an empty username);
//   - it INCLUDES allocations that already ended, because snapshot deliberately
//     reports a closed entry one final time so its last bytes flush.
//
// So it is closer to "allocations seen since the last heartbeat". Hence a
// dedicated counter rather than reusing a field that means something else.
func TestActiveAllocsCountsOnlyLiveAllocations(t *testing.T) {
	reg := newAllocRegistry(nil)
	relayA := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	relayB := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50001}
	srcA := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 5), Port: 1111}

	if got := reg.activeAllocs(); got != 0 {
		t.Fatalf("idle node: activeAllocs = %d, want 0", got)
	}

	reg.wrap(fakePC{}, relayA)
	reg.created(srcA, relayA, "6000:userA.1")
	// B is live but has NOT been joined to a username yet — it is still a real
	// in-flight transfer, and len(Usage) would not see it.
	reg.wrap(fakePC{}, relayB)
	if got := reg.activeAllocs(); got != 2 {
		t.Fatalf("two live allocations: activeAllocs = %d, want 2", got)
	}

	// A ends. It is no longer active, even though snapshot still owes central
	// one final byte report for it.
	reg.closeAlloc(srcA)
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("after one allocation closed: activeAllocs = %d, want 1", got)
	}
	if n := len(reg.snapshot()); n != 2 {
		t.Fatalf("snapshot = %d samples, want 2 (the closed one still flushes) — "+
			"this is exactly why len(Usage) is not the active count", n)
	}
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("after the final flush: activeAllocs = %d, want 1", got)
	}
}

// sendHeartbeat must actually WIRE the counter into the body it posts. The two
// halves either side of this (activeAllocs counting correctly, central storing
// what it receives) are both tested, and both keep passing if this wiring is
// deleted — the count would just silently read 0 forever, which is exactly the
// failure mode this whole change exists to end.
func TestSendHeartbeatReportsActiveTransfers(t *testing.T) {
	reg := newAllocRegistry(nil)
	relayA := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	relayB := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50001}
	srcA := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 5), Port: 1111}
	reg.wrap(fakePC{}, relayA)
	reg.created(srcA, relayA, "6000:userA.1")
	reg.wrap(fakePC{}, relayB)

	var got heartbeatBody
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode heartbeat body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(heartbeatResp{OK: true})
	}))
	defer central.Close()

	sendHeartbeat(newReporter(central.URL, "tok"), "node-1", reg, "", t.TempDir(), nil, nil)

	if got.ActiveTransfers != 2 {
		t.Fatalf("heartbeat activeTransfers = %d, want 2 (two live allocations)", got.ActiveTransfers)
	}
	// And it is genuinely a different number from len(usage), which sees only
	// the one allocation that has joined a username.
	if len(got.Usage) != 1 {
		t.Fatalf("usage = %d entries, want 1 — the fixture no longer distinguishes the two counts", len(got.Usage))
	}
}

// The heartbeat body must carry the field central reads, under the name central
// reads it by. A new node speaking to an OLD server is unaffected either way:
// encoding/json ignores unknown fields on the server side.
func TestHeartbeatBodyCarriesActiveTransfers(t *testing.T) {
	b, err := json.Marshal(heartbeatBody{NodeID: "n1", ActiveTransfers: 3})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"activeTransfers":3`) {
		t.Fatalf("heartbeat body = %s, want an activeTransfers field (central's nodeHeartbeatReq reads that name)", b)
	}
}
