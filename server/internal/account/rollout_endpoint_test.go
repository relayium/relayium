package account

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/authx"
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
	// StageStartedAt is seeded to a value that is NOT the injected clock, so
	// "the stage transition restamped it" is actually observable: seeding tNow
	// makes the assertion below pass even if the endpoint never writes it.
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: tNow - 9999}
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
	if got.StageStartedAt != tNow {
		t.Fatalf("StageStartedAt = %d, want the clock at the transition (%d): the observation window is measured from it",
			got.StageStartedAt, tNow)
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
		ID: "nt1", TokenHash: authx.HashToken("user-token"), UserID: u.ID, Name: "home", CreatedAt: 1,
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

// The `d.NodeID != node.ID` guard is THE branch that keeps the fleet track
// strictly serial when the queue is about to advance: the state machine has
// decided to command somebody, and everybody else asking must be turned away
// without stealing the slot. TestUpdateCheckMarksOtherNodesIneligible does not
// reach it (its fixture makes decideFleet answer "wait", exercising the resume
// rejection instead), so this test sets up the "update" decision explicitly and
// polls as the node that was NOT picked.
func TestUpdateCheckTurnsAwayTheNodeThatWasNotPicked(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: tNow - 9999}
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
	// Ask the state machine who it picks, then poll as the OTHER node.
	d := decideFleet(tr, snaps, tNow)
	if d.Action != "update" || d.NodeID == "" {
		t.Fatalf("fixture: decideFleet must want to command someone, got %+v", d)
	}
	other := "fleet-a"
	if d.NodeID == other {
		other = "fleet-b"
	}

	resp, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: other, CurrentVersion: "v0.8.0"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200", resp.StatusCode)
	}
	if out.Eligible {
		t.Fatalf("%s was not the node decideFleet picked (%s) and must never be told to update", other, d.NodeID)
	}
	// And it must not have taken the slot: a claim by the wrong node would let
	// the real pick be commanded too, i.e. two fleet nodes on the new build.
	got, _, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.CurrentNodeID != "" {
		t.Fatalf("CurrentNodeID = %q: a node that was not picked claimed the slot", got.CurrentNodeID)
	}
	n, _, err := st.GetNode(ctx, other)
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateStartedAt != 0 || n.UpdateFromVersion != "" {
		t.Fatalf("a node that was not picked was commanded: %+v", n)
	}
}

// The fleet RESUME path: an updater that restarted mid-update still holds the
// claim and must be told to carry on, or the track sits there until the silence
// check halts a node that is perfectly alive.
func TestUpdateCheckResumesTheNodeHoldingTheClaim(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		UpdateStartedAt: tNow - 60, UpdateFromVersion: "v0.8.0",
	}); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "n1", CurrentVersion: "v0.8.0"})
	if !out.Eligible {
		t.Fatalf("the node holding the claim must be told to carry on, got %+v", out)
	}
	n, _, err := st.GetNode(ctx, "n1")
	if err != nil {
		t.Fatal(err)
	}
	// Never re-stamped: that would reset the timeout clock on every poll and
	// make a wedged node undetectable.
	if n.UpdateStartedAt != tNow-60 {
		t.Fatalf("update_started_at = %d, resume must not re-stamp it (was %d)", n.UpdateStartedAt, tNow-60)
	}
}

// Resume repairs a split write: the claim was persisted but the node's own
// update_started_at was not (a crash between the two), so the silence check has
// nothing to run against. The endpoint re-commands rather than waiting forever.
func TestUpdateCheckResumeRepairsAMissingUpdateStamp(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "n1", CurrentVersion: "v0.8.0"})
	if !out.Eligible {
		t.Fatalf("the node holding the claim must be told to carry on, got %+v", out)
	}
	n, _, err := st.GetNode(ctx, "n1")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateStartedAt != tNow {
		t.Fatalf("update_started_at = %d, want the repair stamp %d", n.UpdateStartedAt, tNow)
	}
	if n.UpdateFromVersion != "v0.8.0" {
		t.Fatalf("update_from_version = %q, want the version it is being commanded from", n.UpdateFromVersion)
	}
}

// The resume path is bounded by ELAPSED WALL CLOCK TIME since the update was
// commanded, not by how many times the node has polled (see updateSilenceLimit's
// doc comment for why a poll-count budget is the wrong bound: the poll interval
// is entirely client-side). A node that never installs, never reports and keeps
// heartbeating is not SILENT, so decideFleet's own brick check can never fire
// against it; without SOME bound it would be handed the same build to
// re-download forever, with the whole track wedged behind it.
func TestUpdateCheckHaltsAfterTooManyResumes(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		// The command was issued more than updateSilenceLimit ago -- exactly
		// what a node stuck resuming forever looks like on the wire, no matter
		// how many (or how few) times it has polled since. LastSeenAt stays at
		// tNow (still heartbeating), so decideFleet's OWN silence check (which
		// runs on LastSeenAt, not UpdateStartedAt) does not fire here -- this
		// test is isolating the update-check resume path's own bound.
		UpdateStartedAt: tNow - updateSilenceLimit - 1, UpdateFromVersion: "v0.8.0",
	}); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "n1", CurrentVersion: "v0.8.0"})
	if out.Eligible {
		t.Fatal("a node whose update has been in flight past the silence limit must not be told to reinstall again")
	}
	got, _, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "halted" || got.HaltedReason == "" {
		t.Fatalf("an update stuck past the silence limit must halt the track with a reason, got %+v", got)
	}
}

// The flip side of the same fix: a poll-COUNT budget would have halted this
// after a fixed number of calls no matter how little wall-clock time had
// passed -- burnable in seconds by a crash-restart loop, or by anyone replaying
// the in-flight node's ID against the shared fleet token. With the clock
// FROZEN and the update commanded recently, even many resumes in a row must
// leave the track rolling.
func TestUpdateCheckManyResumesWithFrozenClockDoNotHalt(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		UpdateStartedAt: tNow - 60, UpdateFromVersion: "v0.8.0",
	}); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 40; i++ {
		_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "n1", CurrentVersion: "v0.8.0"})
		if !out.Eligible {
			t.Fatalf("poll %d: resume was refused before the elapsed silence limit passed, got %+v", i, out)
		}
	}
	got, _, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "rolling" {
		t.Fatalf("track status = %q after 40 resumes with a frozen clock, want still rolling", got.Status)
	}
}

// A rolling track with no target version is malformed, and decideFleet answers
// "wait" precisely so nobody is told to install the empty version. The resume
// path must not route around that guard.
func TestUpdateCheckResumeNeverCommandsAnEmptyTarget(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		UpdateStartedAt: tNow - 60, UpdateFromVersion: "v0.8.0",
	}); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "n1", CurrentVersion: "v0.8.0"})
	if out.Eligible {
		t.Fatalf("resume must not authorise a swap to the empty version, got %+v", out)
	}
}

// newByoFleet seeds a user, a node token, and n BYO nodes all on `version`,
// returning the node IDs and their snapshots.
func newByoFleet(t *testing.T, st *SQLiteStore, n int, version string) []NodeSnapshot {
	t.Helper()
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "byo@example.com", "B")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateNodeToken(ctx, NodeToken{
		ID: "nt1", TokenHash: authx.HashToken("user-token"), UserID: u.ID, Name: "home", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	var snaps []NodeSnapshot
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("b%d", i)
		if _, err := st.UpsertNode(ctx, Node{
			ID: id, OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: version, CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
		snaps = append(snaps, NodeSnapshot{ID: id, Version: version, LastSeenAt: tNow})
	}
	return snaps
}

// THE BYO BATCH LADDER. A node that is NOT in the currently-open batch must be
// told to wait, even when it still carries a command record from a PREVIOUS
// rollout. Starting a new rollout resets the track's ByoBatch but never clears
// nodes.update_from_version / update_result, and update_result == "" is the
// normal state (nothing reports results yet) — so answering from those columns
// alone told every such node "your turn" on its very first poll, moving 100% of
// BYO machines in one poll cycle and defeating the 10/50/100 ladder outright.
func TestUpdateCheckKeepsNodesOutsideTheOpenBatchIneligible(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow,
	}
	if err := st.PutRolloutTrack(ctx, tr); err != nil {
		t.Fatal(err)
	}
	snaps := newByoFleet(t, st, 10, "v0.8.0")
	// The batch that is open holds 10% of 10 nodes = 1. Find a node OUTSIDE it.
	open := byoOpenBatchMembers(tr, snaps)
	if len(open) != 1 {
		t.Fatalf("fixture: the 10%% batch of 10 nodes should hold 1 node, got %d", len(open))
	}
	var outsider string
	for _, s := range snaps {
		if !open[s.ID] {
			outsider = s.ID
			break
		}
	}
	// The state machine must be waiting out the batch window, so the endpoint
	// takes its "wait" branch — the one that used to answer from update_*.
	if action, eligible, _ := decideByo(tr, snaps, tNow); action != "wait" || len(eligible) != 0 {
		t.Fatalf("fixture: decideByo should be waiting, got %q %v", action, eligible)
	}
	// A leftover command record from the PREVIOUS rollout (which targeted
	// v0.8.0, from v0.7.0), with no result — exactly what every node that has
	// ever been commanded looks like today, since nothing reports results yet.
	if err := st.CommandNodeUpdate(ctx, outsider, "v0.7.0", tNow-100000); err != nil {
		t.Fatal(err)
	}
	n, _, err := st.GetNode(ctx, outsider)
	if err != nil {
		t.Fatal(err)
	}
	if !byoWasCommandedForTarget(nodeSnapshot(n), tr.TargetVersion) {
		t.Fatal("fixture: the stale record must look 'commanded' or this test proves nothing")
	}

	resp, out := postUpdateCheck(t, ts, "user-token", updateCheckReq{NodeID: outsider, CurrentVersion: "v0.8.0"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200", resp.StatusCode)
	}
	if out.Eligible {
		t.Fatalf("%s is outside the open 10%% batch and must not be told to update (%+v)", outsider, out)
	}
}

// The other side of the same gate: a node that IS in the open batch and was
// commanded for THIS rollout keeps being told to carry on, because a batch opens
// once per window while nodes poll every 30s.
func TestUpdateCheckResumesNodesInsideTheOpenBatch(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow,
	}
	if err := st.PutRolloutTrack(ctx, tr); err != nil {
		t.Fatal(err)
	}
	snaps := newByoFleet(t, st, 10, "v0.8.0")
	open := byoOpenBatchMembers(tr, snaps)
	var member string
	for _, s := range snaps {
		if open[s.ID] {
			member = s.ID
			break
		}
	}
	if err := st.CommandNodeUpdate(ctx, member, "v0.8.0", tNow-10); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "user-token", updateCheckReq{NodeID: member, CurrentVersion: "v0.8.0"})
	if !out.Eligible {
		t.Fatalf("%s is in the open batch and was commanded for this rollout, got %+v", member, out)
	}
}

// The shared fleet token stands in for any FLEET node by design, but never for
// a user's node: otherwise its holder could post a stranger's nodeID with
// Result:"failed" and poison the BYO track's failure accounting — a track it has
// no business touching.
func TestUpdateCheckRejectsAFleetTokenNamingAUserNode(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	newByoFleet(t, st, 1, "v0.8.0")

	resp, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{
		NodeID: "b0", CurrentVersion: "v0.8.0", Result: "failed",
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("got %d want 403 (body %+v)", resp.StatusCode, out)
	}
	n, _, err := st.GetNode(ctx, "b0")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateResult != "" {
		t.Fatalf("a fleet token wrote update_result=%q onto a user's node", n.UpdateResult)
	}
}

// AllowDowngrade must be decided from the version central has RECORDED, not the
// one the caller types into the request body: nodeID is unauthenticated on the
// fleet path, so a self-reported "v9.9.9" would otherwise authorise a downgrade
// to anything the track happens to point at.
func TestUpdateCheckIgnoresASelfReportedVersionForDowngrade(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete", StageStartedAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "n1", CurrentVersion: "v9.9.9"})
	if out.AllowDowngrade {
		t.Fatal("a node claiming v9.9.9 must not be handed AllowDowngrade; the stored version is v0.8.0")
	}
}

// The BYO halt reason must not disclose the global BYO population or failure
// counts to the polling node: any authenticated BYO node reaches this path
// (unlike the fleet path, fleet-token-only and naming fleet node IDs an
// operator already controls). The detailed reason must still reach the admin
// via HaltedReason.
func TestUpdateCheckByoHaltReasonIsGenericToTheNode(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 100, StageStartedAt: tNow - 100000,
	}); err != nil {
		t.Fatal(err)
	}
	snaps := newByoFleet(t, st, 5, "v0.8.0")
	// Command every node for this rollout, then report two of them failed --
	// 2/5 = 40%, clearing both the rate (20%) and count (2) thresholds.
	for _, n := range snaps {
		if err := st.CommandNodeUpdate(ctx, n.ID, "v0.8.0", tNow-100000); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SetNodeUpdateResult(ctx, snaps[0].ID, "failed"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetNodeUpdateResult(ctx, snaps[1].ID, "failed"); err != nil {
		t.Fatal(err)
	}

	resp, out := postUpdateCheck(t, ts, "user-token", updateCheckReq{NodeID: snaps[2].ID, CurrentVersion: "v0.8.0"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200 (body %+v)", resp.StatusCode, out)
	}
	if out.Eligible {
		t.Fatal("a halted track must not command anyone")
	}
	if out.Reason == "" {
		t.Fatal("the node should still be told the track is paused")
	}
	if strings.ContainsAny(out.Reason, "%/") {
		t.Fatalf("the node-facing reason leaks population/failure detail: %q", out.Reason)
	}
	got, _, err := st.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "halted" {
		t.Fatalf("track status = %q, want halted", got.Status)
	}
	if !strings.ContainsAny(got.HaltedReason, "%/") {
		t.Fatalf("the detailed reason must still be recorded for the admin, got %q", got.HaltedReason)
	}
}
