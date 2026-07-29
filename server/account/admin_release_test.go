package account

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAdminNoticeOffersRolloutWhenIdle(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "v1.3.0") {
		t.Fatal("the notice does not name the new release")
	}
	if !strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("the rollout button is missing on an idle fleet track")
	}
}

// The constraint, at the level a user feels it.
func TestAdminNoticeHasNoButtonWhileRolling(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "rolling", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "v1.3.0") {
		t.Fatal("the notice should still inform while a rollout is running")
	}
	if strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("pressing that button would silently abandon the rollout in flight")
	}
}

// Never checked successfully: the panel says so, and never implies currency.
func TestAdminNoticeSaysItHasNotCheckedYet(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "尚未成功检查过") {
		t.Fatal("a deployment that has never checked must say so, not stay silent")
	}
	if strings.Contains(body, "已是最新") {
		t.Fatal("the panel must never claim to be up to date")
	}
}

func TestAdminDismissHidesTheNoticeAndCanBeUndone(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	postAdminForm(t, ts, cookie, "/admin/release/dismiss", url.Values{"version": {"v1.3.0"}}).Body.Close()
	body := adminDashboardHTML(t, ts, cookie)
	if strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("a dismissed release must stop prompting")
	}
	if !strings.Contains(body, "已忽略") {
		t.Fatal("the dismissal must stay visible so it can be undone")
	}

	postAdminForm(t, ts, cookie, "/admin/release/dismiss", url.Values{"version": {""}}).Body.Close()
	body = adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("undoing the dismissal must bring the notice back")
	}
}

// A page left open showing an old release must not be able to repoint the fleet
// backwards. nodes.go:445 sets AllowDowngrade automatically for a downgrade, so
// this is not inert -- the nodes would install the older build.
func TestAdminRolloutRefusesAStaleVersion(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.5.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.5.0", now); err != nil {
		t.Fatal(err)
	}

	// The stale page still holds v1.3.0.
	resp := postAdminForm(t, ts, cookie, "/admin/release/rollout", url.Values{"version": {"v1.3.0"}})
	resp.Body.Close()

	after, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: %v/%v", ok, err)
	}
	if after.TargetVersion != "v1.5.0" || after.Status != "complete" {
		t.Fatalf("a stale version repointed the fleet: %+v", after)
	}
}

// The rolling guard, at the handler rather than at the button.
func TestAdminRolloutRefusesWhileRolling(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	before := RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "rolling",
		CurrentNodeID: "n-canary", FirstNodeID: "n-canary", StageStartedAt: now - 3600,
	}
	if err := store.PutRolloutTrack(ctx, before); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	resp := postAdminForm(t, ts, cookie, "/admin/release/rollout", url.Values{"version": {"v1.3.0"}})
	resp.Body.Close()

	after, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: %v/%v", ok, err)
	}
	if after.TargetVersion != before.TargetVersion || after.Status != before.Status ||
		after.CurrentNodeID != before.CurrentNodeID || after.StageStartedAt != before.StageStartedAt {
		t.Fatalf("a direct POST abandoned the rollout in flight: before=%+v after=%+v", before, after)
	}
}
