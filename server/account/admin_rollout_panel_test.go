package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// adminDashboardHTML logs in and returns the admin dashboard's HTML. The
// rollout panels are part of that page, which is where these assertions look.
func adminDashboardHTML(t *testing.T, ts *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	req, err := http.NewRequest("GET", ts.URL+"/admin", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dashboard: %d", resp.StatusCode)
	}
	return readAll(t, resp)
}

// A canary that installed successfully is being OBSERVED. The old panel called
// it 更新中 for the whole six-hour window, which is what made a healthy rollout
// indistinguishable from a stuck one.
func TestPanelCallsAnInstalledCanaryObserving(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-canary", "fleet", "", "v1.1.0", "v1.0.0", "ok")
	if err := store.TouchNode(ctx, "n-canary", 0, 0, 0, 0, now, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
		CurrentNodeID: "n-canary", FirstNodeID: "n-canary",
		StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "观察中") {
		t.Fatal("panel does not say 观察中 for an installed canary")
	}
	if strings.Contains(body, "更新中") {
		t.Fatal("panel still uses the ambiguous 更新中 label")
	}
	if !strings.Contains(body, "不早于") {
		t.Fatal("panel does not say when the next node can be commanded")
	}
}

// A node commanded but not yet on target is INSTALLING, and the panel shows
// the limit that will actually decide its fate.
func TestPanelCallsANodeStillBehindInstalling(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	// seedRolloutNode leaves LastSeenAt at 1 (1970), which would read as a node
	// that stopped heartbeating. Refresh it so the "still heartbeating" branch
	// is the one under test.
	seedRolloutNode(t, store, "n-installing", "fleet", "", "v1.0.0", "v1.0.0", "")
	if err := store.TouchNode(ctx, "n-installing", 0, 0, 0, 0, now, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
		CurrentNodeID: "n-installing", FirstNodeID: "n-installing",
		StageStartedAt: now - 600,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "安装中") {
		t.Fatal("panel does not say 安装中 for a node still behind the target")
	}
	if strings.Contains(body, "观察中") {
		t.Fatal("a node not yet on target must not read as 观察中")
	}
}
