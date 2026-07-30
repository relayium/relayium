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
