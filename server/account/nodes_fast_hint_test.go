package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// hintTestClock is the instant every case below is evaluated at. Nodes are
// seeded with LastSeenAt at this instant so they are online.
const hintTestClock = int64(5000)

// newHintService builds a fleet-token service and mux for the heartbeat hint
// cases, with a fixed clock.
func newHintService(t *testing.T) (*Service, *SQLiteStore, *http.ServeMux) {
	t.Helper()
	st := newTestStore(t)
	s := &Service{store: st, cfg: Config{NodeToken: "fleet-secret", EnableUserNodes: true},
		now: func() time.Time { return time.Unix(hintTestClock, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	return s, st, mux
}

// seedHintNode registers one node directly in the store with a live heartbeat.
func seedHintNode(t *testing.T, st *SQLiteStore, id, ownerType, ownerUserID, version string) {
	t.Helper()
	if _, err := st.UpsertNode(context.Background(), Node{
		ID: id, OwnerType: ownerType, OwnerUserID: ownerUserID, Version: version,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: hintTestClock, ActiveTransfers: 0,
	}); err != nil {
		t.Fatal(err)
	}
}

// heartbeatRaw posts a heartbeat and returns the raw JSON body, so a test can
// assert on the WIRE rather than on a decoded struct — which is the only way to
// tell "false" from "the key is not there".
func heartbeatRaw(t *testing.T, mux *http.ServeMux, token, nodeID string) []byte {
	t.Helper()
	// activeTransfers is REPORTED, as every current node binary does (it is a
	// plain int in heartbeatBody, so it is always on the wire). Omitting it here
	// would not just be unrealistic, it would change the answer: central records
	// an absent count as -1 ("no load signal"), canaryRank sorts such a node
	// after every node it does have a reading for, and the node's own heartbeat
	// would therefore push it out of the first-pick position it is being asked
	// about. An old binary that omits the field consequently ranks last for the
	// canary slot — which is the documented, deliberate bias, and moot for the
	// hint because such a binary has no client-side support for it either.
	idle := 0
	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: nodeID, Status: "ok", ActiveTransfers: &idle})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat %s: got %d: %s", nodeID, w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}

func heartbeatHint(t *testing.T, mux *http.ServeMux, token, nodeID string) bool {
	t.Helper()
	var resp struct {
		UpdateCheckNow bool `json:"updateCheckNow"`
	}
	if err := json.Unmarshal(heartbeatRaw(t, mux, token, nodeID), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.UpdateCheckNow
}

// OLD-CLIENT COMPATIBILITY, at the wire level. The field is additive and
// must be ABSENT whenever there is nothing to ask for, so a node running a
// binary that predates it decodes exactly the same bytes it decoded before.
func TestHeartbeatOmitsTheUpdateHintWhenThereIsNothingToAskFor(t *testing.T) {
	_, st, mux := newHintService(t)
	ctx := context.Background()
	seedHintNode(t, st, "n1", "fleet", "", "v1.0.0")

	// No rollout configured at all.
	if body := heartbeatRaw(t, mux, "fleet-secret", "n1"); bytes.Contains(body, []byte("updateCheckNow")) {
		t.Fatalf("heartbeat body carries the hint key with no rollout configured: %s", body)
	}

	// An ORDINARY staged rollout: the timer is the mechanism there, and nudging
	// nodes would quietly change the cadence of every normal release.
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", StageStartedAt: hintTestClock,
	}); err != nil {
		t.Fatal(err)
	}
	if body := heartbeatRaw(t, mux, "fleet-secret", "n1"); bytes.Contains(body, []byte("updateCheckNow")) {
		t.Fatalf("staged rollout set the hint: %s", body)
	}

	// A finished manual fast rollout: nothing left to accelerate.
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "complete", ManualFast: true,
	}); err != nil {
		t.Fatal(err)
	}
	if body := heartbeatRaw(t, mux, "fleet-secret", "n1"); bytes.Contains(body, []byte("updateCheckNow")) {
		t.Fatalf("a completed track set the hint: %s", body)
	}
}

// During a manual fast rollout the hint goes to the node whose turn it is —
// the one holding the slot (so its result arrives in seconds instead of up to a
// poll interval) and the one the queue would pick next. Nobody else.
func TestHeartbeatHintsOnlyTheNodeWhoseTurnItIs(t *testing.T) {
	_, st, mux := newHintService(t)
	ctx := context.Background()
	seedHintNode(t, st, "n1", "fleet", "", "v1.0.0")
	seedHintNode(t, st, "n2", "fleet", "", "v1.0.0")
	seedHintNode(t, st, "n3", "fleet", "", "v1.0.0")

	// Nothing in flight yet: exactly one node — the one decideFleet would pick —
	// is asked to go and look.
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
		StageStartedAt: hintTestClock,
	}); err != nil {
		t.Fatal(err)
	}
	hinted := 0
	for _, id := range []string{"n1", "n2", "n3"} {
		if heartbeatHint(t, mux, "fleet-secret", id) {
			hinted++
		}
	}
	if hinted != 1 {
		t.Fatalf("%d of 3 nodes were hinted before anything was claimed, want exactly 1", hinted)
	}

	// n1 holds the slot and has not reported yet: it is the one that has to
	// poll, and the others must stay quiet — a hint is not a command, but three
	// nodes all being nudged is three updaters running for one node's turn.
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: hintTestClock,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.CommandNodeUpdate(ctx, "n1", "v1.0.0", hintTestClock); err != nil {
		t.Fatal(err)
	}
	if !heartbeatHint(t, mux, "fleet-secret", "n1") {
		t.Error("the node holding the slot was not asked to run an update check")
	}
	for _, id := range []string{"n2", "n3"} {
		if heartbeatHint(t, mux, "fleet-secret", id) {
			t.Errorf("node %s was hinted while it is not its turn", id)
		}
	}
}

// FLEET ONLY. A user's node must never be nudged by this mechanism, whatever
// the fleet track is doing: the whole feature is scoped to machines we own.
func TestHeartbeatNeverHintsAByoNode(t *testing.T) {
	_, st, mux := newHintService(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "hint@example.test", "H")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateNodeToken(ctx, NodeToken{
		ID: "t-byo-hint", TokenHash: authx.HashToken("byo-plain"), UserID: u.ID, Name: "byo", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	seedHintNode(t, st, "u1", "user", u.ID, "v1.0.0")

	// Both tracks in manual fast mode — which the admin action cannot even
	// produce for byo, but the hint must not depend on that being true.
	for _, track := range []string{"fleet", "byo"} {
		if err := st.PutRolloutTrack(ctx, RolloutTrack{
			Track: track, TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
			StageStartedAt: hintTestClock,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if body := heartbeatRaw(t, mux, "byo-plain", "u1"); bytes.Contains(body, []byte("updateCheckNow")) {
		t.Fatalf("a BYO node was hinted: %s", body)
	}
}

// Once the node holding the slot has reported a PASS-OVER, the manual fast
// rollout is going to halt on it. Nobody must be nudged then — not the node
// itself (its turn is over and its result will not change), and emphatically not
// the next machine, which would be central hurrying a node it is about to refuse.
// The halt is landed by update-check, not here.
func TestHeartbeatDoesNotHintAfterAPassOver(t *testing.T) {
	for _, result := range []string{"skipped", "unreachable", "failed", "rolled_back"} {
		t.Run(result, func(t *testing.T) {
			_, st, mux := newHintService(t)
			ctx := context.Background()
			seedHintNode(t, st, "n1", "fleet", "", "v1.0.0")
			seedHintNode(t, st, "n2", "fleet", "", "v1.0.0")
			if err := st.PutRolloutTrack(ctx, RolloutTrack{
				Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: hintTestClock,
			}); err != nil {
				t.Fatal(err)
			}
			if err := st.CommandNodeUpdate(ctx, "n1", "v1.0.0", hintTestClock); err != nil {
				t.Fatal(err)
			}
			if err := st.SetNodeUpdateResult(ctx, "n1", result); err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"n1", "n2"} {
				if heartbeatHint(t, mux, "fleet-secret", id) {
					t.Errorf("node %s was hinted while the track is about to halt on %q", id, result)
				}
			}
		})
	}
}

// An emergency release has its own path with no queue at all, so there is no
// "your turn" to accelerate. Keeping the hint off there also keeps the two
// modes from bleeding into one another.
func TestHeartbeatDoesNotHintDuringAnEmergencyRelease(t *testing.T) {
	_, st, mux := newHintService(t)
	ctx := context.Background()
	seedHintNode(t, st, "n1", "fleet", "", "v1.0.0")
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
		ManualFast: true, Emergency: true, StageStartedAt: hintTestClock,
	}); err != nil {
		t.Fatal(err)
	}
	if heartbeatHint(t, mux, "fleet-secret", "n1") {
		t.Fatal("an emergency release hinted a node to run an update check")
	}
}

// THE BOUNDARY THAT MATTERS MOST on this path: the heartbeat is read-only with
// respect to rollout state. It may SUGGEST that a node go and ask; it must
// never claim the slot, command an update, halt or complete the track. If it
// could, the shared fleet token would be able to drive a rollout from the
// heartbeat endpoint, where none of update-check's ordering guarantees apply.
func TestHeartbeatHintNeverMutatesRolloutState(t *testing.T) {
	_, st, mux := newHintService(t)
	ctx := context.Background()
	seedHintNode(t, st, "n1", "fleet", "", "v1.0.0")
	seedHintNode(t, st, "n2", "fleet", "", "v1.0.0")

	before := RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
		StageStartedAt: hintTestClock,
	}
	if err := st.PutRolloutTrack(ctx, before); err != nil {
		t.Fatal(err)
	}
	nodesBefore, err := st.NodesByOwnerType(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}

	// Many heartbeats from both nodes, which is exactly what a fast rollout
	// produces: every node, every 30 seconds.
	for i := 0; i < 5; i++ {
		heartbeatRaw(t, mux, "fleet-secret", "n1")
		heartbeatRaw(t, mux, "fleet-secret", "n2")
	}

	after, _, _ := st.GetRolloutTrack(ctx, "fleet")
	if after != before {
		t.Fatalf("heartbeats moved the rollout track:\nbefore %+v\nafter  %+v", before, after)
	}
	nodesAfter, err := st.NodesByOwnerType(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	for i := range nodesAfter {
		if nodesAfter[i].UpdateStartedAt != nodesBefore[i].UpdateStartedAt ||
			nodesAfter[i].UpdateFromVersion != nodesBefore[i].UpdateFromVersion ||
			nodesAfter[i].UpdateResult != nodesBefore[i].UpdateResult {
			t.Fatalf("heartbeat commanded an update on %s: %+v", nodesAfter[i].ID, nodesAfter[i])
		}
	}
}

// The fallback invariant, stated as a test: a node that ignores the hint
// entirely — every node that exists today — still gets its turn through
// ordinary timer-driven update-check polling, and the rollout still progresses
// one node at a time. Nothing about the acceleration path is load-bearing.
func TestTimerPollingStillDrivesAManualFastRolloutWithoutAnyHints(t *testing.T) {
	_, st, mux := newHintService(t)
	ctx := context.Background()
	seedHintNode(t, st, "n1", "fleet", "", "v1.0.0")
	seedHintNode(t, st, "n2", "fleet", "", "v1.0.0")
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
		StageStartedAt: hintTestClock,
	}); err != nil {
		t.Fatal(err)
	}

	// No heartbeats at all in this test: only update-check, exactly as an old
	// node's systemd timer drives it.
	eligible := map[string]bool{}
	for _, id := range []string{"n1", "n2"} {
		eligible[id] = updateCheckEligible(t, mux, "fleet-secret", id, "v1.0.0", "")
	}
	if eligible["n1"] == eligible["n2"] {
		t.Fatalf("timer polling made both nodes %v; exactly one may be eligible", eligible)
	}
}

// updateCheckEligible polls update-check the way a node's root updater does.
func updateCheckEligible(t *testing.T, mux *http.ServeMux, token, nodeID, currentVersion, result string) bool {
	t.Helper()
	body, _ := json.Marshal(updateCheckReq{NodeID: nodeID, CurrentVersion: currentVersion, Result: result})
	r := httptest.NewRequest("POST", "/api/nodes/update-check", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("update-check %s: got %d: %s", nodeID, w.Code, w.Body.String())
	}
	var resp updateCheckResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.Eligible
}
