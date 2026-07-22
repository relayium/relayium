package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// newUpdateCheckServer builds a node-routes-only server whose clock is pinned to
// tNow, so the rollout observation windows (6h canary, 30min step) are exact
// integers rather than wall-clock waits.
func newUpdateCheckServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore) {
	t.Helper()
	st := newTestStore(t)
	s := &Service{
		store: st,
		// EnableUserNodes so a per-user node token resolves to ownerType "user"
		// (the byo track); NodeToken is the shared fleet credential.
		cfg: Config{NodeToken: "fleet-secret", EnableUserNodes: true},
		now: func() time.Time { return time.Unix(tNow, 0) },
	}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, s, st
}

func postUpdateCheck(t *testing.T, ts *httptest.Server, token string, body updateCheckReq) (*http.Response, updateCheckResp) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", ts.URL+"/api/nodes/update-check", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	var out updateCheckResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

// An unauthenticated caller must learn nothing — not even which version the
// fleet is being moved to, which would tell an attacker exactly which release
// to look for known vulnerabilities in.
func TestUpdateCheckRejectsMissingToken(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}

	resp, out := postUpdateCheck(t, ts, "", updateCheckReq{NodeID: "n1", CurrentVersion: "v0.8.0"})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: got %d want 401", resp.StatusCode)
	}
	if out.TargetVersion != "" {
		t.Fatalf("unauthenticated caller learned the target version %q", out.TargetVersion)
	}
	if out.Eligible {
		t.Fatal("unauthenticated caller must never be eligible")
	}
}

// The node the state machine picked is the ONLY one told to move.
func TestUpdateCheckMarksTheChosenNodeEligible(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: tNow}
	if err := st.PutRolloutTrack(ctx, tr); err != nil {
		t.Fatal(err)
	}
	var snaps []NodeSnapshot
	for _, id := range []string{"fleet-a", "fleet-b"} {
		if _, err := st.UpsertNode(ctx, Node{
			ID: id, OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
		snaps = append(snaps, NodeSnapshot{ID: id, Version: "v0.8.0", LastSeenAt: tNow})
	}
	// Ask the state machine itself who is next, rather than hardcoding the
	// hash order: the endpoint's job is to obey decideFleet, not to re-derive it.
	want := decideFleet(tr, snaps, tNow)
	if want.Action != "update" || want.NodeID == "" {
		t.Fatalf("fixture: decideFleet should pick a node, got %+v", want)
	}

	resp, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: want.NodeID, CurrentVersion: "v0.8.0"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200", resp.StatusCode)
	}
	if !out.Eligible {
		t.Fatalf("the node decideFleet picked must be eligible, got %+v", out)
	}
	if out.TargetVersion != "v0.9.0" {
		t.Fatalf("TargetVersion = %q want v0.9.0", out.TargetVersion)
	}

	// Claiming the slot must be PERSISTED before the node is told to move —
	// that is what makes "strictly one at a time" hold across concurrent polls.
	got, ok, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("track: ok=%v err=%v", ok, err)
	}
	if got.CurrentNodeID != want.NodeID {
		t.Fatalf("CurrentNodeID = %q, want the commanded node %q", got.CurrentNodeID, want.NodeID)
	}
	if got.StageStartedAt == 0 {
		t.Fatal("StageStartedAt must be rewritten on the stage transition")
	}
	if got.FirstNodeID != want.NodeID {
		t.Fatalf("FirstNodeID = %q, want the canary %q (else the 6h window collapses to 30min)", got.FirstNodeID, want.NodeID)
	}
	// decideByo's failure accounting is inert without update_from_version, and a
	// stale update_result from the previous rollout would poison this one.
	n, _, err := st.GetNode(ctx, want.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateFromVersion != "v0.8.0" {
		t.Fatalf("update_from_version = %q, want the version the node was commanded from", n.UpdateFromVersion)
	}
	if n.UpdateStartedAt == 0 {
		t.Fatal("update_started_at must be stamped when the node is commanded")
	}
	if n.UpdateResult != "" {
		t.Fatalf("update_result must be cleared on command, got %q", n.UpdateResult)
	}
}

// Strict serial: everyone else waits, and is told so without being told to move.
func TestUpdateCheckMarksOtherNodesIneligible(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "fleet-a", FirstNodeID: "fleet-a", StageStartedAt: tNow - 60,
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"fleet-a", "fleet-b"} {
		if _, err := st.UpsertNode(ctx, Node{
			ID: id, OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
	}

	resp, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "fleet-b", CurrentVersion: "v0.8.0"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200", resp.StatusCode)
	}
	if out.Eligible {
		t.Fatal("a node other than the one in flight must never be told to update")
	}
	if out.Reason == "" {
		t.Fatal("an ineligible node should be told why")
	}
	// The claim must not have moved to the asking node.
	got, _, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.CurrentNodeID != "fleet-a" {
		t.Fatalf("CurrentNodeID = %q, a poll from another node must not steal the slot", got.CurrentNodeID)
	}
}

// A node reporting that it rolled back must stop the queue dead.
func TestUpdateCheckHaltsTheTrackOnRolledBack(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 300,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		UpdateStartedAt: tNow - 300, UpdateFromVersion: "v0.8.0",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n2", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}

	resp, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{
		NodeID: "n1", CurrentVersion: "v0.8.0", Result: "rolled_back",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200", resp.StatusCode)
	}
	if out.Eligible {
		t.Fatal("a node that just rolled back must not be told to update again")
	}
	n, _, err := st.GetNode(ctx, "n1")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateResult != "rolled_back" {
		t.Fatalf("update_result = %q, want rolled_back persisted on the node row", n.UpdateResult)
	}
	got, _, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "halted" {
		t.Fatalf("track status = %q, want halted", got.Status)
	}
	if got.HaltedReason == "" {
		t.Fatal("a halted track must record why")
	}
	// And the queue really is dead: the next node is not commanded.
	_, out2 := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "n2", CurrentVersion: "v0.8.0"})
	if out2.Eligible {
		t.Fatal("a halted track must not command any further node")
	}
}

// A BYO node must be answered from the BYO track, never the fleet one —
// otherwise user machines would follow our fleet's rollout in lockstep.
func TestUpdateCheckRoutesUserNodesToTheByoTrack(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete", StageStartedAt: tNow - 10000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "rolling", StageStartedAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	u, err := st.UpsertUserByEmail(ctx, "byo@example.com", "B")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateNodeToken(ctx, NodeToken{
		ID: "nt1", TokenHash: hashToken("user-token"), UserID: u.ID, Name: "home", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "byo-1", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.7.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}

	resp, out := postUpdateCheck(t, ts, "user-token", updateCheckReq{NodeID: "byo-1", CurrentVersion: "v0.7.0"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200 (body %+v)", resp.StatusCode, out)
	}
	if out.TargetVersion != "v0.8.0" {
		t.Fatalf("TargetVersion = %q, want the BYO track's v0.8.0 (never the fleet's v0.9.0)", out.TargetVersion)
	}
	if !out.Eligible {
		t.Fatalf("the sole BYO node is the whole first batch and should be commanded, got %+v", out)
	}
	// The fleet track must be untouched by a BYO poll.
	fleet, _, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if fleet.Status != "complete" || fleet.CurrentNodeID != "" {
		t.Fatalf("a BYO poll mutated the fleet track: %+v", fleet)
	}
}
