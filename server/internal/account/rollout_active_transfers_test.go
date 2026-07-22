package account

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// postHeartbeat sends a raw heartbeat body, so these tests exercise the WIRE
// format a real node speaks rather than a Go struct literal.
func postHeartbeat(t *testing.T, ts *httptest.Server, token, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest("POST", ts.URL+"/api/nodes/heartbeat", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// The canary is supposed to be the node with the FEWEST in-flight transfers —
// least to lose if the build is bad. decideFleet has always sorted on
// NodeSnapshot.ActiveTransfers, but nothing produced the number: it was 0 for
// every node in production and the pick silently degraded to the deterministic
// hash order.
//
// This is the end-to-end proof that the producer exists: node heartbeats carry
// the count, central persists it, nodeSnapshot feeds it back in, and the pick
// follows load. The busy node is chosen as whichever one the HASH order would
// have picked first, so the test can only pass if load genuinely dominates —
// deleting the producer (nodeSnapshot's ActiveTransfers assignment, or the
// heartbeat field) makes both nodes read 0 and the hash order pick the busy
// one, failing the assertion.
func TestHeartbeatFeedsCanaryPick(t *testing.T) {
	ts, s, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"node-a", "node-b"} {
		if _, err := st.UpsertNode(ctx, Node{
			ID: id, OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Whoever the hash would pick FIRST is the one we make busy, so a passing
	// test cannot be explained by the hash tie-break.
	busy, idle := "node-a", "node-b"
	if fleetHash("node-b", "v0.9.0") < fleetHash("node-a", "v0.9.0") {
		busy, idle = "node-b", "node-a"
	}
	postHeartbeat(t, ts, "fleet-secret", `{"nodeID":"`+busy+`","status":"ok","activeTransfers":7}`)
	postHeartbeat(t, ts, "fleet-secret", `{"nodeID":"`+idle+`","status":"ok","activeTransfers":0}`)

	// Persisted, not just parsed.
	n, _, err := s.store.GetNode(ctx, busy)
	if err != nil {
		t.Fatal(err)
	}
	if n.ActiveTransfers != 7 {
		t.Fatalf("%s active_transfers = %d, want 7 (heartbeat must persist it)", busy, n.ActiveTransfers)
	}

	// The busy node polls first; it must be told to wait, and the idle node
	// must be the one that gets the canary slot.
	if _, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{
		NodeID: busy, CurrentVersion: "v0.8.0"}); out.Eligible {
		t.Fatalf("the BUSIEST node was picked as canary (%s) — the pick is still hash-ordered", busy)
	}
	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{
		NodeID: idle, CurrentVersion: "v0.8.0"})
	if !out.Eligible {
		t.Fatalf("the idle node %s was not picked as canary (reason %q)", idle, out.Reason)
	}
	tr, _, err := s.store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.FirstNodeID != idle {
		t.Fatalf("canary recorded as %q, want %q", tr.FirstNodeID, idle)
	}
}

// WIRE COMPATIBILITY, old node -> new server: a node running the CURRENT
// released binary sends no activeTransfers field at all. It must keep working
// (the heartbeat is how it stays online, reports usage and learns its caps),
// reading as 0 — "we have no load signal for this machine" — rather than
// failing the request or corrupting the row.
func TestHeartbeatWithoutActiveTransfersStillWorks(t *testing.T) {
	ts, s, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if _, err := st.UpsertNode(ctx, Node{
		ID: "old", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	// Byte-for-byte the shape the released node sends today.
	resp := postHeartbeat(t, ts, "fleet-secret",
		`{"nodeID":"old","status":"ok","usage":[],"relayedTotal":10,"storedBytes":0,"storageTotal":0,"storageFree":0}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("legacy heartbeat: got %d want 200", resp.StatusCode)
	}
	n, _, err := s.store.GetNode(ctx, "old")
	if err != nil {
		t.Fatal(err)
	}
	if n.ActiveTransfers != 0 {
		t.Fatalf("active_transfers = %d, want 0 for a node that reports none", n.ActiveTransfers)
	}
	if n.LastSeenAt != tNow {
		t.Fatalf("last_seen_at = %d, want %d: the legacy heartbeat must still land", n.LastSeenAt, tNow)
	}
}

// A node reporting a negative count (corrupt, or hostile) must not sort itself
// to the front of the canary queue.
func TestHeartbeatClampsNegativeActiveTransfers(t *testing.T) {
	ts, s, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if _, err := st.UpsertNode(ctx, Node{
		ID: "liar", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	postHeartbeat(t, ts, "fleet-secret", `{"nodeID":"liar","status":"ok","activeTransfers":-5}`)
	n, _, err := s.store.GetNode(ctx, "liar")
	if err != nil {
		t.Fatal(err)
	}
	if n.ActiveTransfers != 0 {
		t.Fatalf("active_transfers = %d, want 0 (negative counts are clamped)", n.ActiveTransfers)
	}
}
