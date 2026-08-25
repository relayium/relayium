package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// getAdminHome fetches the admin dashboard as a logged-in admin and returns the
// rendered HTML.
func getAdminHome(t *testing.T, ts *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+"/admin/fleet", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return readAll(t, resp)
}

// A halted track sits at the bottom of a long dashboard, under the users and
// nodes sections. The fleet ladder runs ~14h and a byo batch window is 6h, so
// an unseen halt can cost a day. It has to be at the top.
func TestHaltedTrackBannerAtTopOfAdminHome(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "halted", ByoBatch: 50,
		HaltedReason: "byo rollout: 3/5 nodes in the 50% batch failed", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)

	bannerIdx := strings.Index(body, "发布已中止")
	if bannerIdx < 0 {
		t.Fatalf("no halt banner rendered:\n%s", body)
	}
	// Above the users/nodes sections, not merely somewhere on the page.
	nodesIdx := strings.Index(body, `<section class="nodes">`)
	if nodesIdx < 0 || bannerIdx > nodesIdx {
		t.Fatalf("halt banner at %d is not above the nodes section at %d", bannerIdx, nodesIdx)
	}
	banner := body[bannerIdx:nodesIdx]
	for _, want := range []string{
		"自带节点轨", "v1.0.0",
		"byo rollout: 3/5 nodes in the 50% batch failed",
		`href="#rollout-byo"`,
	} {
		if !strings.Contains(banner, want) {
			t.Fatalf("halt banner missing %q:\n%s", want, banner)
		}
	}
	// And the anchor it links to actually exists.
	if !strings.Contains(body, `id="rollout-byo"`) {
		t.Fatal("halt banner links to #rollout-byo but no such anchor exists")
	}
}

// Nothing halted -> no empty box.
func TestNoHaltBannerWhenNothingIsHalted(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "complete", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if body := getAdminHome(t, ts, cookie); strings.Contains(body, "发布已中止") {
		t.Fatal("halt banner rendered with no halted track")
	}
}

// Both halted -> both listed; one halt must not hide the other.
func TestBothHaltedTracksAppearInBanner(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "halted",
		HaltedReason: "fleet rollout: node fleet-a went silent", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "halted",
		HaltedReason: "byo rollout: 3/5 nodes in the 50% batch failed", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)
	nodes := strings.Index(body, `<section class="nodes">`)
	if nodes < 0 {
		t.Fatal("dashboard did not render")
	}
	banner := body[:nodes]
	for _, want := range []string{
		"机队轨", "v1.2.0", "fleet rollout: node fleet-a went silent", `href="#rollout-fleet"`,
		"自带节点轨", "v1.0.0", "byo rollout: 3/5 nodes in the 50% batch failed", `href="#rollout-byo"`,
	} {
		if !strings.Contains(banner, want) {
			t.Fatalf("halt banner missing %q:\n%s", want, banner)
		}
	}
}
