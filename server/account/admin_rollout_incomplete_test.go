package account

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A completed track that left nodes behind must not read as a clean success.
//
// This is the safety net for the case Task 2 opened: a release published without
// checksums.txt.sig 404s on every node, every one of them classifies it as a
// fetch failure, the queue advances past the whole fleet installing nothing, and
// the track reaches the end. Between the node reporting "unreachable" and this
// panel copy, that outcome is SILENT — a green 已完成 over a rollout that updated
// no machine at all.
func TestPanelShowsCompletedWithNodesLeftBehind(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-done", "fleet", "", "v2.0.0", "v1.0.0", "ok")
	seedRolloutNode(t, store, "n-stuck", "fleet", "", "v1.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "未更新") {
		t.Fatal("a completion that left a node behind must say so")
	}
	if !strings.Contains(body, "拿不到产物") {
		t.Fatal("the row must say why the node was passed over")
	}
}

// A clean completion must NOT acquire the new copy. A suite of "says so" tests
// passes against a panel that says so unconditionally.
func TestPanelCleanCompletionSaysNothingExtra(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-done", "fleet", "", "v2.0.0", "v1.0.0", "ok")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(adminDashboardHTML(t, ts, cookie), "未更新") {
		t.Fatal("a clean completion must not claim nodes were left behind")
	}
}

// The count is over the WHOLE track, and it counts only nodes that are BOTH
// passed over and not on target. A node that was passed over earlier in the
// rollout and then reached the target on a later attempt is not left behind, and
// counting it would inflate the number the operator acts on.
func TestPassedOverCountExcludesNodesThatReachedTheTarget(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	// Carries "unreachable" from an earlier pass but is running the target.
	seedRolloutNode(t, store, "n-caught-up", "fleet", "", "v2.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(adminDashboardHTML(t, ts, cookie), "未更新") {
		t.Fatal("a node running the target version is not left behind")
	}
}

// "skipped" and "unreachable" are both passed over, and they send the operator
// to DIFFERENT places: a broken mirror is fixed and retried, a node that
// declined locally will decline again. So the row names which one it was.
func TestPanelNamesWhyANodeWasPassedOver(t *testing.T) {
	for _, tc := range []struct{ result, want string }{
		{"unreachable", "拿不到产物"},
		{"skipped", "本地前置条件"},
	} {
		t.Run(tc.result, func(t *testing.T) {
			ts, _, store := newAdminSettingsServer(t)
			cookie := adminLogin(t, ts)
			ctx := context.Background()
			now := time.Now().Unix()

			seedRolloutNode(t, store, "n-x", "fleet", "", "v1.0.0", "v1.0.0", tc.result)
			if err := store.PutRolloutTrack(ctx, RolloutTrack{
				Track: "fleet", TargetVersion: "v2.0.0", Status: "complete", StageStartedAt: now - 3600,
			}); err != nil {
				t.Fatal(err)
			}

			if !strings.Contains(adminDashboardHTML(t, ts, cookie), tc.want) {
				t.Fatalf("the row does not say why %q was passed over", tc.result)
			}
		})
	}
}

// "unreachable" must stop rendering as "—", which is what a node that was never
// commanded renders as. Reading the two as the same thing is how a fleet-wide
// fetch failure looks like a rollout that simply has not got there yet.
func TestUnreachableDoesNotRenderAsNeverCommanded(t *testing.T) {
	if got := rolloutResultText("unreachable"); got == rolloutResultText("") {
		t.Fatalf("unreachable renders as %q, identical to never-commanded", got)
	}
}

// A track still ROLLING has not left anyone behind yet -- the queue may still
// reach them. The terminal copy is for a track that finished.
func TestPanelRollingTrackDoesNotClaimNodesLeftBehind(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-stuck", "fleet", "", "v1.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "rolling", StageStartedAt: now - 60,
	}); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(adminDashboardHTML(t, ts, cookie), "未更新") {
		t.Fatal("a rolling track must not report a terminal outcome")
	}
}
