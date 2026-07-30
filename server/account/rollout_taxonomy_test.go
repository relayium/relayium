package account

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func fleetTrackAt(target, status, current, first string) RolloutTrack {
	return RolloutTrack{Track: "fleet", TargetVersion: target, Status: status,
		CurrentNodeID: current, FirstNodeID: first, StageStartedAt: 1000}
}

// The change: a node that could not fetch does not stop the fleet, and the
// queue moves ON. Asserting only "not halt" would pass against the old code,
// which returned "wait" while the node sat inside its canary window -- the
// distinction this task exists to create is wait-versus-advance, so the
// assertion has to be the positive one.
func TestDecideFleetAdvancesPastUnreachable(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 2000},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "update" {
		t.Fatalf("want the queue to move on to the next node, got %+v", got)
	}
	if got.NodeID != "n2" {
		t.Fatalf("want n2 commanded next, got %+v", got)
	}
}

// The test that would have caught two failed attempts at this task: drive the
// state machine the way the real caller does and assert it CONVERGES.
//
// Both attempts scoped the exclusion on a clock, and both looked right in a
// single-evaluation fixture while cycling forever in the sequence. A test that
// evaluates once cannot see a loop; this one replays the caller's writes.
func TestDecideFleetConvergesWhenEveryNodeFailsToFetch(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "", "")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 9000},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 9000},
		{ID: "n3", Version: "v1.0.0", LastSeenAt: 9000},
	}
	byID := func(id string) *NodeSnapshot {
		for i := range nodes {
			if nodes[i].ID == id {
				return &nodes[i]
			}
		}
		return nil
	}
	commanded := map[string]int{}
	now := int64(1000)
	for step := 0; step < 20; step++ {
		d := decideFleet(tr, nodes, now)
		switch d.Action {
		case "update":
			// Mirror the real caller: ClaimRolloutNode moves the track's
			// pointers and restamps the stage; CommandNodeUpdate stamps the
			// node and CLEARS its previous result.
			tr.CurrentNodeID = d.NodeID
			if d.IsFirst {
				tr.FirstNodeID = d.NodeID
			}
			tr.StageStartedAt = now
			n := byID(d.NodeID)
			n.UpdateStartedAt, n.UpdateResult = now, ""
			commanded[d.NodeID]++
			if commanded[d.NodeID] > 1 {
				t.Fatalf("step %d: %s commanded twice — the queue is cycling, not converging", step, d.NodeID)
			}
			// The node cannot fetch, and says so.
			n.UpdateResult = "unreachable"
		case "complete":
			if len(commanded) != 3 {
				t.Fatalf("completed after commanding %d of 3 nodes", len(commanded))
			}
			return
		case "halt":
			t.Fatalf("step %d: a fleet-wide fetch failure must not halt: %+v", step, d)
		}
		now += 10
	}
	t.Fatal("decideFleet never reached a terminal decision in 20 evaluations")
}

// The exclusion is by RESULT, not by "is the current node". With a single
// skipped-id the queue re-commands a passed-over node as soon as some other
// node takes the slot, which is an endless loop rather than a rollout: n1
// passes over, n2 is picked, n2 passes over, n1 is no longer excluded, n1 is
// picked again. Here n1 already passed over and is NOT current.
func TestDecideFleetDoesNotRecommandAPassedOverNode(t *testing.T) {
	for _, result := range []string{"unreachable", "skipped"} {
		t.Run(result, func(t *testing.T) {
			tr := fleetTrackAt("v2.0.0", "rolling", "", "")
			nodes := []NodeSnapshot{
				{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: result},
				{ID: "n2", Version: "v2.0.0", LastSeenAt: 2000, UpdateResult: "ok"},
			}
			got := decideFleet(tr, nodes, 2000)
			if got.Action == "update" && got.NodeID == "n1" {
				t.Fatalf("re-commanded a node that already passed over: %+v", got)
			}
			if got.Action != "complete" {
				t.Fatalf("everyone left is on target or passed over; want complete, got %+v", got)
			}
		})
	}
}

// Regression guard: "failed" must NEVER join passedOverResult's exclusion set.
//
// An earlier round deleted this test on the reasoning that no reachable state
// needs it -- "a halt always takes the track out of rolling first, so a
// non-current node's failed can never matter". That reasoning is wrong, and the
// state it dismissed is one button press away: ResumeRolloutTrack puts the track
// back to "rolling" and clears current_node_id while leaving the failed node's
// "failed" exactly where it is. The fixture below IS that state. Add "failed" to
// passedOverResult and this track answers "complete" -- finishing over the one
// machine that could not verify the build, silently -- instead of offering it
// the build again, which is what 继续 means.
func TestDecideFleetDoesNotExcludeAFailedNode(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "", "")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "failed"},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "update" || got.NodeID != "n1" {
		t.Fatalf("a resumed track finished over the node whose failure halted it: %+v", got)
	}
}

// The half that must not loosen.
func TestDecideFleetStillHaltsOnVerificationFailure(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "failed"},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 2000},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "halt" {
		t.Fatalf("a verification failure must still halt: %+v", got)
	}
	if !strings.Contains(got.Reason, "n1") {
		t.Fatalf("the halt reason must name the node: %q", got.Reason)
	}
}

// Regression guard: splitting a signal most easily damages the value that was
// already correct.
func TestDecideFleetOkIsUnchanged(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v2.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "ok"},
	}
	if got := decideFleet(tr, nodes, 2000); got.Action == "halt" {
		t.Fatalf("a successful node halted the track: %+v", got)
	}
}

// The no-op rollout. Every node fails to fetch, the queue reaches the end, and
// the track must not look like a clean success. This only appears when ALL
// nodes fail and no ordinary test reaches it.
func TestDecideFleetEveryNodeUnreachable(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "complete" {
		t.Fatalf("a fleet-wide fetch failure must finish the queue, got %+v", got)
	}
	// And it finished having updated nobody, which is what Task 4 renders.
	for _, n := range nodes {
		if n.Version == tr.TargetVersion {
			t.Fatal("test setup wrong: no node should be on target here")
		}
	}
}

// The other half of the fix, and the half decideFleet cannot test: what keeps
// the exclusion above from being PERMANENT is a write, not a read.
// nodes.update_result outlives the rollout that produced it, and an excluded
// node is by construction never re-commanded, so nothing but this clear could
// ever hand it back its candidacy. Two attempts tried to scope the exclusion at
// the read instead and both shipped an infinite re-command loop -- see
// passedOverResult -- so this test exists to keep the surviving mechanism
// honest.
//
// It also pins the owner scoping: retargeting the fleet must not touch a user
// node, or one track would be silently editing the other's rollout state.
func TestSetTargetVersionClearsPassedOverResults(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "clear@example.test", "C")
	if err != nil {
		t.Fatal(err)
	}
	seed := []Node{
		{ID: "fleet-passed-over", OwnerType: "fleet", Version: "v0.8.0"},
		{ID: "fleet-failed", OwnerType: "fleet", Version: "v0.8.0"},
		{ID: "user-passed-over", OwnerType: "user", OwnerUserID: u.ID, Version: "v0.8.0"},
	}
	for _, n := range seed {
		n.URLs, n.TURNSecret, n.CreatedAt, n.LastSeenAt = []string{"turn:x:3478"}, "s", 1, 1
		if _, err := store.UpsertNode(ctx, n); err != nil {
			t.Fatal(err)
		}
	}
	for id, result := range map[string]string{
		"fleet-passed-over": "unreachable",
		"fleet-failed":      "failed",
		"user-passed-over":  "skipped",
	} {
		if err := store.SetNodeUpdateResult(ctx, id, result); err != nil {
			t.Fatal(err)
		}
	}

	if err := svc.SetTargetVersion(ctx, "fleet", "v0.9.0"); err != nil {
		t.Fatal(err)
	}

	got := map[string]string{}
	for _, ownerType := range []string{"fleet", "user"} {
		nodes, err := store.NodesByOwnerType(ctx, ownerType)
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range nodes {
			got[n.ID] = n.UpdateResult
		}
	}
	if got["fleet-passed-over"] != "" {
		t.Errorf("a fleet node passed over by the PREVIOUS rollout still carries %q, so the new "+
			"rollout will never offer it the build", got["fleet-passed-over"])
	}
	// "failed" is a halt, not a pass-over: it is the record of a build that broke
	// a machine, and clearing it would erase the evidence rather than free a node
	// that nothing else can free.
	if got["fleet-failed"] != "failed" {
		t.Errorf(`a "failed" result was cleared along with the passed-over ones: %q`, got["fleet-failed"])
	}
	if got["user-passed-over"] != "skipped" {
		t.Errorf("retargeting the fleet cleared a USER node's result (%q): the two tracks must not "+
			"reach into each other's rows", got["user-passed-over"])
	}
}

// 继续 restarts the ladder from the beginning, so it must hand back the build to
// the nodes this rollout passed over -- otherwise the operator's only way to
// reach them is retyping the target version, and the resumed rollout finishes
// over a machine it never updated.
//
// The scenario, end to end: the fleet is rolling to v2.0.0; n1 cannot fetch it
// (a broken mirror) and reports "unreachable"; n2 gets the bytes and fails to
// verify them, which halts the track. The operator fixes the mirror and presses
// 继续. n1 must be a candidate again -- and n2's "failed" must SURVIVE, because
// that is the judgement that stopped the track and resuming is not a licence to
// forget it (decideByo's failure rate and emergencyRefusesNode both read it).
func TestResumeClearsPassedOverResultsButNotFailures(t *testing.T) {
	ts, store := newRolloutFullServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "halted",
		HaltedReason: "node n2 failed to verify or install the update", StageStartedAt: tNow - 100,
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"n1", "n2"} {
		if _, err := store.UpsertNode(ctx, Node{
			ID: id, OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: "v1.0.0", CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.SetNodeUpdateResult(ctx, "n1", "unreachable"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetNodeUpdateResult(ctx, "n2", "failed"); err != nil {
		t.Fatal(err)
	}

	resp := postAdminForm(t, ts, cookie, "/admin/rollout/fleet/resume", url.Values{})
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("resume: want 302, got %d\n%s", resp.StatusCode, body)
	}

	nodes, err := store.NodesByOwnerType(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, n := range nodes {
		got[n.ID] = n.UpdateResult
	}
	if got["n1"] != "" {
		t.Errorf("继续 left the passed-over node carrying %q, so the resumed rollout cannot reach it",
			got["n1"])
	}
	if got["n2"] != "failed" {
		t.Errorf(`继续 erased the failure that halted the track: n2 = %q`, got["n2"])
	}

	// And the consequence the column is only a proxy for. The snapshot is
	// narrowed to n1 on purpose: that is the moment the bug actually bites, when
	// n1 is the last node the resumed rollout has left. Excluded, it answers
	// "complete" -- a finished rollout over a machine still on v1.0.0.
	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	var justN1 []Node
	for _, n := range nodes {
		if n.ID == "n1" {
			justN1 = append(justN1, n)
		}
	}
	d := decideFleet(tr, nodeSnapshots(justN1), tNow)
	if d.Action != "update" || d.NodeID != "n1" {
		t.Fatalf("the resumed rollout finished without ever re-offering the build to n1: %+v", d)
	}
}

type clearFailStore struct {
	*SQLiteStore
}

func (s *clearFailStore) ClearPassedOverResults(context.Context, string) error {
	return errors.New("boom: database is locked")
}

// Order of the two writes, pinned. If the clear fails and the row is written
// anyway, the track points at a NEW target while stale results still exclude
// nodes from it -- precisely the bug the clear exists to prevent, and now
// unreachable by any retry because the target no longer changes. Failing the
// whole call instead leaves the operator with an error they can act on and a
// track that never moved.
func TestSetTargetVersionDoesNotRetargetIfTheClearFails(t *testing.T) {
	_, store := newRolloutService(t)
	ctx := context.Background()
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.8.0", Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}

	svc := NewService(&clearFailStore{SQLiteStore: store}, nil, Config{})
	if err := svc.SetTargetVersion(ctx, "fleet", "v0.9.0"); err == nil {
		t.Fatal("a failed clear must fail the retarget, not be swallowed")
	}

	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.TargetVersion != "v0.8.0" {
		t.Fatalf("the track was retargeted to %q despite the clear failing", tr.TargetVersion)
	}
}
