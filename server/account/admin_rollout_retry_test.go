package account

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func seedRetryCase(t *testing.T, store *SQLiteStore, nodeResult, trackStatus string) {
	t.Helper()
	ctx := context.Background()
	seedRolloutNode(t, store, "n-x", "fleet", "", "v1.0.0", "v1.0.0", nodeResult)
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: trackStatus,
		HaltedReason: "node n-other failed verification", StageStartedAt: time.Now().Unix() - 3600,
	}); err != nil {
		t.Fatal(err)
	}
}

// Positive path. Without one, a handler that refuses everything passes.
func TestRetryRecommandsAPassedOverNode(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "unreachable", "complete")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	n, ok, err := store.GetNode(context.Background(), "n-x")
	if err != nil || !ok {
		t.Fatalf("GetNode: %v/%v", ok, err)
	}
	if n.UpdateResult != "" {
		t.Fatalf("retry did not clear the node's result: %q", n.UpdateResult)
	}
	tr, _, err := store.GetRolloutTrack(context.Background(), "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "rolling" {
		t.Fatalf("retry left the track at %q", tr.Status)
	}
	if tr.TargetVersion != "v2.0.0" {
		t.Fatalf("retry changed the target version to %q", tr.TargetVersion)
	}
}

// The track guard belongs in the SQL, so assert it there too: RetryRolloutNode
// must report false rather than silently doing nothing, and must leave a halted
// track alone even when called directly.
func TestRetryRolloutNodeRefusesANonCompleteTrack(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedRetryCase(t, store, "unreachable", "halted")

	ok, err := store.RetryRolloutNode(ctx, "fleet", "n-x", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("RetryRolloutNode reported success against a halted track")
	}
	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "halted" || tr.HaltedReason == "" {
		t.Fatalf("the halt did not survive: %+v", tr)
	}
}

// And the node row must not be touched either when the track guard refuses. The
// same defect the resume path had: a refused action that has already written
// half of itself destroys the state the operator was about to act on.
func TestRetryRolloutNodeLeavesTheNodeAloneWhenItRefuses(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedRetryCase(t, store, "unreachable", "halted")

	if _, err := store.RetryRolloutNode(ctx, "fleet", "n-x", 5000); err != nil {
		t.Fatal(err)
	}
	n, ok, err := store.GetNode(ctx, "n-x")
	if err != nil || !ok {
		t.Fatalf("GetNode: %v/%v", ok, err)
	}
	if n.UpdateResult != "unreachable" {
		t.Fatalf("a refused retry cleared the node's result anyway: %q", n.UpdateResult)
	}
}

// The node write is the OTHER half of this compare-and-swap, and dropping its
// RowsAffected check makes the whole operation report a success it did not
// perform: the track flips to rolling, no node is re-admitted, and the handler
// audits a per-node retry that never happened.
//
// The reachable interleaving is the one the CAS exists for. The handler prechecks
// the row, and between that read and this transaction the node reports a real
// FAILURE -- an update it was still carrying out, or another instance's rollout.
// The WHERE clause correctly refuses to erase "failed", so the node write matches
// no row; without checking that, the track is committed to 'rolling' anyway.
func TestRetryRolloutNodeRefusesWhenTheNodeIsNoLongerPassedOver(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedRetryCase(t, store, "failed", "complete")

	ok, err := store.RetryRolloutNode(ctx, "fleet", "n-x", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("RetryRolloutNode reported success while re-admitting nothing")
	}
	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "complete" {
		t.Fatalf("the track was restarted for a node that was never re-admitted: %q", tr.Status)
	}
}

// And this is WHY that half is blocking rather than untidy. A track left
// 'rolling' has no current node -- CompleteRolloutTrack clears current_node_id --
// and "failed" is deliberately NOT in passedOverResult's exclusion set, so
// decideFleet's very next evaluation hands the build straight back to the machine
// that failed to verify it. That is the shortest path around a verification
// failure the row guard exists to close, reached by clicking 重试 on a stale
// panel.
// The node here is seeded ONLINE rather than through seedRetryCase, which stamps
// LastSeenAt: 1. That matters: decideFleet only considers online candidates, so
// an offline fixture makes this assertion vacuous -- it would pass against the
// broken code for the wrong reason.
func TestRefusedRetryDoesNotLetDecideFleetRecommandTheFailedNode(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	if _, err := store.UpsertNode(ctx, Node{
		ID: "n-x", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v1.0.0", CreatedAt: 1, LastSeenAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.CommandNodeUpdate(ctx, "n-x", "v1.0.0", now-600); err != nil {
		t.Fatal(err)
	}
	if err := store.SetNodeUpdateResult(ctx, "n-x", "failed"); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	// Sanity: with the track left rolling, this node IS a candidate. Without
	// this the test could pass because the fixture is inert.
	rolling := RolloutTrack{Track: "fleet", TargetVersion: "v2.0.0", Status: "rolling", StageStartedAt: now}
	nodes, err := store.NodesByOwnerType(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if d := decideFleet(rolling, nodeSnapshots(nodes), now); d.Action != "update" || d.NodeID != "n-x" {
		t.Fatalf("fixture is inert: a rolling track does not re-command this node (%+v)", d)
	}

	if _, err := store.RetryRolloutNode(ctx, "fleet", "n-x", now); err != nil {
		t.Fatal(err)
	}

	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	nodes, err = store.NodesByOwnerType(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	d := decideFleet(tr, nodeSnapshots(nodes), now)
	if d.Action == "update" && d.NodeID == "n-x" {
		t.Fatalf("a refused retry re-commanded the node that failed verification: %+v", d)
	}
}

// A node id that matches nothing must not restart the track either. The id
// arrives in a form field, and "the operator's panel is stale" and "the node was
// deregistered a moment ago" are the same case to this method.
func TestRetryRolloutNodeRefusesAnUnknownNode(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedRetryCase(t, store, "unreachable", "complete")

	ok, err := store.RetryRolloutNode(ctx, "fleet", "n-does-not-exist", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("RetryRolloutNode reported success for a node that does not exist")
	}
	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "complete" {
		t.Fatalf("an unknown node restarted the track: %q", tr.Status)
	}
}

// Owner scoping belongs in the SQL, not only in the handler -- the same
// discipline as the track guard. The two rollouts are independent, and a fleet
// retry that could clear a user node's result would be one track editing the
// other's rollout state.
func TestRetryRolloutNodeRefusesANodeOfAnotherOwnerClass(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "storeretry@example.test", "S")
	if err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "n-user", "user", u.ID, "v1.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete",
		StageStartedAt: time.Now().Unix() - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	ok, err := store.RetryRolloutNode(ctx, "fleet", "n-user", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("the fleet track's retry reported success for a user node")
	}
	n, _, err := store.GetNode(ctx, "n-user")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateResult != "unreachable" {
		t.Errorf("the fleet track's retry cleared a user node's result: %q", n.UpdateResult)
	}
	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "complete" {
		t.Fatalf("retrying a foreign node restarted the fleet track: %q", tr.Status)
	}
}

// A removed node cannot be re-offered anything: NodesByOwnerType filters
// removed_at, so it never reaches decideFleet at all. Restarting a finished
// rollout on its behalf would be a track that rolls, finds nobody, and completes
// again -- reported to the operator as a successful retry.
func TestRetryRolloutNodeRefusesARemovedNode(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedRetryCase(t, store, "unreachable", "complete")
	if err := store.MarkNodeRemoved(ctx, "n-x", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}

	ok, err := store.RetryRolloutNode(ctx, "fleet", "n-x", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("RetryRolloutNode reported success for a removed node")
	}
	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "complete" {
		t.Fatalf("a removed node restarted the track: %q", tr.Status)
	}
}

// The row guard: a node that judged the build is not one click from a re-run.
func TestRetryRefusesAFailedNode(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "failed", "complete")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	n, _, _ := store.GetNode(context.Background(), "n-x")
	if n.UpdateResult != "failed" {
		t.Fatalf("retry cleared a verification failure: %q", n.UpdateResult)
	}
}

// The row guard, and the track it left alone. A refused row must not restart the
// rollout as a side effect -- otherwise the refusal is only half a refusal.
func TestRetryOnAFailedNodeDoesNotRestartTheTrack(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "failed", "complete")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	tr, _, err := store.GetRolloutTrack(context.Background(), "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "complete" {
		t.Fatalf("a refused retry restarted the track: status is now %q", tr.Status)
	}
}

// The track guard -- the sideways route. A passed-over row on a track halted
// for ANOTHER node's failure must not restart the rollout.
func TestRetryRefusesOnAHaltedTrack(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "unreachable", "halted")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	tr, _, err := store.GetRolloutTrack(context.Background(), "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "halted" {
		t.Fatalf("retry cleared a halt sideways: status is now %q", tr.Status)
	}
	if tr.HaltedReason == "" {
		t.Fatal("retry erased the halt reason")
	}
}

// A node of the OTHER track cannot be retried through this track's route. The
// two rollouts are independent, and the node is read back and checked rather
// than trusted from the form.
func TestRetryRefusesANodeOfTheOtherTrack(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "retry@example.test", "R")
	if err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "n-user", "user", u.ID, "v1.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete",
		StageStartedAt: time.Now().Unix() - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-user"}}).Body.Close()

	n, _, _ := store.GetNode(ctx, "n-user")
	if n.UpdateResult != "unreachable" {
		t.Fatalf("the fleet retry route cleared a user node's result: %q", n.UpdateResult)
	}
	tr, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if tr.Status != "complete" {
		t.Fatalf("retrying a foreign node restarted the fleet track: %q", tr.Status)
	}
}

// A retry is an entry point into a rollout, so it is audited in its own right --
// same reasoning as rollout.target versus release.rollout.
func TestRetryIsAudited(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "unreachable", "complete")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	entries, err := store.ListAudit(context.Background(), 10, 0, AuditRolloutRetry)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly one rollout.retry entry, got %d", len(entries))
	}
	if !strings.Contains(entries[0].Target, "fleet") {
		t.Errorf("the audit entry does not name the track: %q", entries[0].Target)
	}
}

// Retry is fleet-only, and not as a scope preference. decideByo's candidate set
// is (online && !onTarget) with no reference to update_result, so byo has no
// pass-over state: it never moves on without a node, it keeps re-offering. A byo
// track can only be 'complete' with an off-target node if that node is OFFLINE,
// so clearing its result re-admits nothing — the track would go rolling, find
// nobody reachable, complete again, and the operator would be told it worked.
func TestRetryRefusesTheByoTrack(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "byoretry@example.test", "B")
	if err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "n-byo", "user", u.ID, "v1.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v2.0.0", Status: "complete",
		StageStartedAt: time.Now().Unix() - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	postAdminForm(t, ts, cookie, "/admin/rollout/byo/retry", url.Values{"node": {"n-byo"}}).Body.Close()

	n, _, _ := store.GetNode(ctx, "n-byo")
	if n.UpdateResult != "unreachable" {
		t.Errorf("a byo retry cleared the node's result: %q", n.UpdateResult)
	}
	tr, _, _ := store.GetRolloutTrack(ctx, "byo")
	if tr.Status != "complete" {
		t.Errorf("a byo retry restarted the byo track: %q", tr.Status)
	}
}

// And the button must not be offered there either — a control whose only
// possible outcome is a refusal is worse than no control, which is the rule the
// other rollout buttons already follow.
func TestRetryButtonIsNotRenderedOnTheByoPanel(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "byobtn@example.test", "B")
	if err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "n-byo", "user", u.ID, "v1.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v2.0.0", Status: "complete",
		StageStartedAt: time.Now().Unix() - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(adminDashboardHTML(t, ts, cookie), "/admin/rollout/byo/retry") {
		t.Fatal("the byo panel offers a retry button that can only be refused")
	}
}

// The button follows the same two rules.
func TestRetryButtonRenderingFollowsBothGuards(t *testing.T) {
	for _, tc := range []struct {
		name, result, status string
		want                 bool
	}{
		{"passed over, complete", "unreachable", "complete", true},
		{"skipped, complete", "skipped", "complete", true},
		{"failed, complete", "failed", "complete", false},
		{"passed over, halted", "unreachable", "halted", false},
		{"passed over, rolling", "unreachable", "rolling", false},
		{"ok, complete", "ok", "complete", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, _, store := newAdminSettingsServer(t)
			cookie := adminLogin(t, ts)
			seedRetryCase(t, store, tc.result, tc.status)
			body := adminDashboardHTML(t, ts, cookie)
			if got := strings.Contains(body, "/admin/rollout/fleet/retry"); got != tc.want {
				t.Fatalf("retry button rendered=%v, want %v", got, tc.want)
			}
		})
	}
}
