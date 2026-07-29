package account

import (
	"context"
	"net/http"
	"net/http/httptest"
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

// The fleet can legitimately be AHEAD of GitHub's releases/latest: a tag
// published as a pre-release and rolled to the fleet first, or a bad release
// unpublished afterwards. The panel renders nothing in that state, so a page
// left open from before must not be able to post successfully — it would
// repoint the fleet BACKWARDS, and nodes.go sets AllowDowngrade automatically
// for a downgrade, so the nodes install the older build.
//
// This is the case a bare `version != rc.LatestTag` check waves through: the
// posted version DOES equal LatestTag. Only the UI's own predicate catches it.
func TestAdminRolloutRefusesWhenTheFleetIsAheadOfLatest(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.6.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.5.0", now); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("the panel must not offer a rollout backwards")
	}
	resp := postAdminForm(t, ts, cookie, "/admin/release/rollout", url.Values{"version": {"v1.5.0"}})
	resp.Body.Close()

	after, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: %v/%v", ok, err)
	}
	if after.TargetVersion != "v1.6.0" || after.Status != "complete" {
		t.Fatalf("the handler did what the UI declines to offer: %+v", after)
	}
}

// A PAUSED rollout is a rollout in flight. HaltRolloutTrack leaves
// current_node_id set on purpose, and that node is the canary position 恢复发布
// restores. One click here erases it.
func TestAdminRolloutRefusesOnAPausedRollout(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	before := RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "halted",
		HaltedReason: "管理员手动暂停", CurrentNodeID: "n-canary", FirstNodeID: "n-canary",
		StageStartedAt: now - 3600,
	}
	if err := store.PutRolloutTrack(ctx, before); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "v1.3.0") {
		t.Fatal("a paused rollout is not 'nothing new'; the notice must still inform")
	}
	if strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("the button would discard the paused rollout's canary position")
	}
	resp := postAdminForm(t, ts, cookie, "/admin/release/rollout", url.Values{"version": {"v1.3.0"}})
	resp.Body.Close()

	after, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: %v/%v", ok, err)
	}
	if after.TargetVersion != before.TargetVersion || after.Status != before.Status ||
		after.CurrentNodeID != before.CurrentNodeID || after.FirstNodeID != before.FirstNodeID {
		t.Fatalf("a direct POST erased the paused rollout: before=%+v after=%+v", before, after)
	}
}

// RELAYIUM_RELEASE_CHECK=false means NO part of the notice renders — not the
// button, and not the 尚未成功检查过 freshness line, which would otherwise sit
// there forever implying something is broken on a deployment that switched the
// check off deliberately.
//
// This builds its own service rather than using newAdminSettingsServer, which
// sets ReleaseCheck: true on purpose for every other test in this file.
func TestAdminNoticeAbsentWhenTheCheckIsDisabled(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", AdminUser: "boss", AdminPassword: "s3cret",
		MaxFileSize: 50 << 20, DailyQuota: 200 << 20, DefaultTTL: 86400, MaxTTL: 604800,
		ReleaseCheck: false,
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	// Even with a check result sitting in the store, the disabled panel shows none of it.
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("the rollout button rendered on a deployment with the check disabled")
	}
	if strings.Contains(body, "尚未成功检查过") {
		t.Fatal("the freshness line rendered on a deployment that turned the check off on purpose")
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
