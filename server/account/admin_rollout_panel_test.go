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

// A track written before FirstNodeID existed carries "" while a node is in
// flight. rollout_fleet.go:247 treats that node as the canary -- every defence
// there fails LONG, because guessing "not the canary" cuts a live six-hour
// observation to thirty minutes. The panel has to guess the same way, or it
// reports the short window and marks a healthy canary overdue.
func TestPanelTreatsAnUnsetCanaryAsTheCanary(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-legacy", "fleet", "", "v1.1.0", "v1.0.0", "ok")
	if err := store.TouchNode(ctx, "n-legacy", 0, 0, 0, 0, now, 0); err != nil {
		t.Fatal(err)
	}
	// Stage started longer ago than the SHORT window but well inside the long
	// one, so the two guesses give visibly different answers.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
		CurrentNodeID: "n-legacy", FirstNodeID: "",
		StageStartedAt: now - fleetStepWindow - 60,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "不早于") {
		t.Fatal("an unset FirstNodeID must still get the canary's long window, not an expired short one")
	}
	if strings.Contains(body, "等待下一次轮询") {
		t.Fatal("the panel used the 30-minute window for a node the state machine treats as the canary")
	}
}

// The bug that prompted this work: pressing 继续 on a rolling track returns
// "该轨道当前不是已中止状态". The refusal is correct; offering the button is
// not. This panel's own view model already names the principle -- a button
// whose only possible outcome is a refusal is worse than no button -- and
// already applies it to 回滚到上一版本.
func TestPanelHidesControlsThatCanOnlyBeRefused(t *testing.T) {
	const (
		pauseAction  = "/admin/rollout/fleet/pause"
		resumeAction = "/admin/rollout/fleet/resume"
	)
	cases := []struct {
		name       string
		status     string // "" means the track row exists but was never started
		configured bool
		wantShown  []string
		wantHidden []string
	}{
		{"rolling", "rolling", true, []string{pauseAction}, []string{resumeAction}},
		{"halted", "halted", true, []string{resumeAction}, []string{pauseAction}},
		{"complete", "complete", true, nil, []string{pauseAction, resumeAction}},
		{"never configured", "", false, nil, []string{pauseAction, resumeAction}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts, _, store := newAdminSettingsServer(t)
			cookie := adminLogin(t, ts)
			now := time.Now().Unix()
			seedRolloutNode(t, store, "n-1", "fleet", "", "v1.0.0", "", "")
			if tc.configured {
				if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
					Track: "fleet", TargetVersion: "v1.1.0", Status: tc.status,
					StageStartedAt: now - 60,
				}); err != nil {
					t.Fatal(err)
				}
			}
			body := adminDashboardHTML(t, ts, cookie)
			for _, want := range tc.wantShown {
				if !strings.Contains(body, want) {
					t.Fatalf("status %q: %s should be offered here but is missing", tc.status, want)
				}
			}
			for _, unwanted := range tc.wantHidden {
				if strings.Contains(body, unwanted) {
					t.Fatalf("status %q: %s is rendered, but pressing it can only be refused",
						tc.status, unwanted)
				}
			}
		})
	}
}

// The timing rules belong on the page, not in an operator's memory.
func TestPanelPrintsTheTimingRules(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	now := time.Now().Unix()
	seedRolloutNode(t, store, "n-1", "fleet", "", "v1.0.0", "", "")
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", StageStartedAt: now - 60,
	}); err != nil {
		t.Fatal(err)
	}
	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, humanDuration(fleetFirstWindow)) {
		t.Fatal("panel does not state the canary observation window")
	}
	if !strings.Contains(body, humanDuration(fleetStepWindow)) {
		t.Fatal("panel does not state the per-node window")
	}
	// Deliberately NOT asserted here: humanDuration(byoBatchWindow). Both it and
	// fleetFirstWindow are six hours, so that string is already on the page from
	// the fleet panel and the assertion would pass with the BYO rules line
	// deleted. The BYO half is covered by TestPanelPrintsTheByoBatchStep below,
	// which asserts a BYO-specific sentence.
}

// The BYO half of this change had no coverage until this test: every other test
// here seeds only a fleet track, and asserting a duration string does not work
// because both windows are six hours. Assert the BYO sentence itself.
func TestPanelPrintsTheByoBatchStep(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	now := time.Now().Unix()
	seedRolloutNode(t, store, "byo-1", "user", "u1", "v1.0.0", "", "")
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: now - 60,
	}); err != nil {
		t.Fatal(err)
	}
	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "下一批：") {
		t.Fatal("the BYO panel does not show when its next batch can open")
	}
	if !strings.Contains(body, "不早于") {
		t.Fatal("the BYO next step is not phrased as an earliest time")
	}
	if !strings.Contains(body, byoRulesText()) {
		t.Fatal("the BYO panel does not print its own rules line")
	}
}

// An emergency release skips the batch ladder entirely: nodes.go:470
// short-circuits both state machines before the per-track dispatch. There is no
// next batch to time, and the panel already says 已跳过分批 two lines above, so
// timing one would describe a ladder that is not running.
func TestPanelPrintsNoNextBatchDuringAnEmergency(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	now := time.Now().Unix()
	seedRolloutNode(t, store, "byo-1", "user", "u1", "v1.0.0", "", "")
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: now - 60, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}
	body := adminDashboardHTML(t, ts, cookie)
	if strings.Contains(body, "下一批：") {
		t.Fatal("an emergency release has no batch ladder, so there is no next batch to time")
	}
}

// Pausing a rolling canary must not leave a timer running on the panel.
// HaltRolloutTrack keeps current_node_id and RESTAMPS stage_started_at, so a
// panel that times the node regardless of the track's status prints an
// observation window that the PAUSE created — and, later, that the node is
// about to be aborted "在下一次轮询时", which no poll can do to a track that has
// already stopped. The row itself stays (and stays at the top): on a halted
// track the node that was in flight is exactly the one an operator is looking
// for. What goes is the clock.
func TestPanelStopsTimingWhenTheTrackIsNotRolling(t *testing.T) {
	for _, status := range []string{"halted", "complete"} {
		t.Run(status, func(t *testing.T) {
			ts, _, store := newAdminSettingsServer(t)
			cookie := adminLogin(t, ts)
			ctx := context.Background()
			now := time.Now().Unix()

			seedRolloutNode(t, store, "n-canary", "fleet", "", "v1.1.0", "v1.0.0", "ok")
			if err := store.TouchNode(ctx, "n-canary", 0, 0, 0, 0, now, 0); err != nil {
				t.Fatal(err)
			}
			// StageStartedAt is `now` because that is what HaltRolloutTrack
			// writes: the pause itself restamps the stage.
			if err := store.PutRolloutTrack(ctx, RolloutTrack{
				Track: "fleet", TargetVersion: "v1.1.0", Status: status,
				CurrentNodeID: "n-canary", FirstNodeID: "n-canary",
				StageStartedAt: now, HaltedReason: "管理员手动暂停",
			}); err != nil {
				t.Fatal(err)
			}

			body := adminDashboardHTML(t, ts, cookie)
			if !strings.Contains(body, "n-canary") {
				t.Fatal("the node that was in flight must still be listed")
			}
			for _, unwanted := range []string{"观察中", "安装中", "等待节点开始", "不早于", "更新中"} {
				if strings.Contains(body, unwanted) {
					t.Fatalf("track is %q, nothing is being timed, but the panel says %q", status, unwanted)
				}
			}
		})
	}
}

// A node that reported a failure is why the track stops. decideFleet:228 halts
// on it above every clock it runs, so the panel must not answer "you have 55
// minutes of headroom" about it.
func TestPanelSaysAFailedNodeIsWhyTheTrackStops(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-broken", "fleet", "", "v1.0.0", "v1.0.0", "failed")
	if err := store.TouchNode(ctx, "n-broken", 0, 0, 0, 0, now, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
		CurrentNodeID: "n-broken", FirstNodeID: "n-broken",
		StageStartedAt: now - 300,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if strings.Contains(body, "安装中") {
		t.Fatal("a node that already reported failed is not installing, and it has no headroom left")
	}
	// "· 上限 1 小时" is how elapsedText offers the install limit as remaining
	// room. A node whose track halts on the next poll has no such room. (The
	// bare word 上限 appears all over this page for quotas, hence the full
	// phrase, built from the constant rather than written out.)
	if headroom := "· 上限 " + humanDuration(fleetInstallLimit); strings.Contains(body, headroom) {
		t.Fatalf("the panel still offers %q to a node whose track halts on the next poll", headroom)
	}
	if !strings.Contains(body, "中止") {
		t.Fatal("the panel does not say this node is why the track stops")
	}
}

// At the widest batch there is no wider one, so the time the panel prints is not
// the time of a "next batch". decideByo's ladder is exhausted: what the window's
// close brings is completion or a re-sweep of the nodes still behind.
func TestPanelDoesNotNameANextBatchAtTheWidestBatch(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	now := time.Now().Unix()
	seedRolloutNode(t, store, "byo-1", "user", "u1", "v1.0.0", "", "")
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", Status: "rolling",
		ByoBatch: byoBatches[len(byoBatches)-1], StageStartedAt: now - 60,
	}); err != nil {
		t.Fatal(err)
	}
	body := adminDashboardHTML(t, ts, cookie)
	if strings.Contains(body, "下一批：") {
		t.Fatal("the widest batch is already open; there is no next batch to name")
	}
	if !strings.Contains(body, "不早于") {
		t.Fatal("the window still runs at the widest batch, so its close must still be shown")
	}
}
