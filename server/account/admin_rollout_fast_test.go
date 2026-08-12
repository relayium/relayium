package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// fastForm builds the manual-fast control's POST body: the version to ship,
// plus the state the panel was showing when the operator clicked. The last two
// are what make a stale page refuse rather than act.
func fastForm(version, fromStatus, fromVersion string) url.Values {
	return url.Values{
		"version":      {version},
		"from_status":  {fromStatus},
		"from_version": {fromVersion},
	}
}

// The action is step-up confirmed, applies only after that confirmation, and is
// audited under its OWN identity — never folded into rollout.target or, worse,
// rollout.emergency, which is a materially different promise (everyone at once,
// no failure gating).
func TestManualFastFleetRolloutIsStepUpConfirmedAndAudited(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	// A plain POST must NOT apply — it renders the confirmation page.
	resp := postAdminForm(t, ts, cookie, "/admin/rollout/fleet/fast", fastForm("v2.0.0", "", ""))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `name="confirm_token"`) {
		t.Fatalf("manual fast push must render a confirmation page, got %d:\n%s", resp.StatusCode, body)
	}
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("manual fast push applied before the operator confirmed it")
	}

	resp = confirmAction(t, ts, cookie, "/admin/rollout/fleet/fast", fastForm("v2.0.0", "", ""))
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed manual fast push: want 302, got %d\n%s", resp.StatusCode, body)
	}
	tr, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack(fleet) = %v/%v", ok, err)
	}
	if tr.TargetVersion != "v2.0.0" || tr.Status != "rolling" || !tr.ManualFast {
		t.Fatalf("track = %+v, want rolling v2.0.0 in manual fast mode", tr)
	}
	// The critical negative: this is NOT an emergency release.
	if tr.Emergency {
		t.Fatal("the manual fast push armed emergency mode; it must never release the whole track at once")
	}

	entries, err := store.ListAudit(ctx, 10, 0, AuditRolloutFast)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly 1 %s audit entry, got %d", AuditRolloutFast, len(entries))
	}
	if entries[0].Target != "rollout:fleet" {
		t.Fatalf("audit target: want %q, got %q", "rollout:fleet", entries[0].Target)
	}
	if entries[0].StepUp == StepUpNone {
		t.Fatalf("manual fast push audited without a step-up factor: %+v", entries[0])
	}
	// It must not have been logged as anything else.
	if other, _ := store.ListAudit(ctx, 10, 0, AuditRolloutEmergency); len(other) != 0 {
		t.Fatalf("manual fast push wrote %d rollout.emergency entries", len(other))
	}
	if other, _ := store.ListAudit(ctx, 10, 0, AuditRolloutTarget); len(other) != 0 {
		t.Fatalf("manual fast push wrote %d rollout.target entries", len(other))
	}
}

// The confirmation page is the only working 二次确认 (the panel's inline
// onsubmit is dead under CSP), so it has to tell the truth about what is being
// skipped AND what is not. An operator who reads "跳过" and nothing else cannot
// tell this apart from 紧急发布.
func TestManualFastConfirmationPageStatesWhatIsAndIsNotSkipped(t *testing.T) {
	ts, _, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)

	resp := postAdminForm(t, ts, cookie, "/admin/rollout/fleet/fast", fastForm("v2.0.0", "", ""))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want the confirmation page, got %d:\n%s", resp.StatusCode, body)
	}
	// Whose machines.
	if !strings.Contains(body, "机队轨") {
		t.Errorf("confirmation page does not name the fleet track:\n%s", body)
	}
	if strings.Contains(body, "自带节点轨") {
		t.Errorf("confirmation page mentions the BYO track for a fleet-only action:\n%s", body)
	}
	// What survives: one at a time, and a halt on failure. Without these the
	// page reads exactly like the emergency one.
	if !strings.Contains(body, "一台") {
		t.Errorf("confirmation page does not say the rollout stays one node at a time:\n%s", body)
	}
	if !strings.Contains(body, "中止") {
		t.Errorf("confirmation page does not say a failure halts the rollout:\n%s", body)
	}
	// ONLY SUCCESS COUNTS. The page must not leave an operator thinking this
	// behaves like the staged ladder, which steps over a node that could not
	// fetch the artifact and carries on. Here that halts, and the page has to say
	// so before they confirm.
	if !strings.Contains(body, "拿不到产物") {
		t.Errorf("confirmation page does not say an unobtainable artifact halts the rollout:\n%s", body)
	}
	if !strings.Contains(body, "回报成功") {
		t.Errorf("confirmation page does not say the queue waits for a reported success:\n%s", body)
	}
	// And it must not claim to be the emergency release.
	if strings.Contains(body, "整条轨道一次性放行") {
		t.Errorf("confirmation page reuses the emergency copy:\n%s", body)
	}
	if !strings.Contains(body, "v2.0.0") {
		t.Errorf("confirmation page does not name the version:\n%s", body)
	}
}

// The invariant this action exists under: it may not silently replace a
// rollout that is in flight. A staged rollout mid-canary is exactly the state
// where a one-click "ship it fast" would abandon six hours of observation.
func TestManualFastFleetRolloutRefusesAnInFlightRollout(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	before := RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: 500,
	}
	if err := store.PutRolloutTrack(ctx, before); err != nil {
		t.Fatal(err)
	}

	resp := confirmAction(t, ts, cookie, "/admin/rollout/fleet/fast",
		fastForm("v2.0.0", "rolling", "v1.0.0"))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 against a rolling track, got %d\n%s", resp.StatusCode, body)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if got != before {
		t.Fatalf("a refused manual fast push mutated the track:\ngot  %+v\nwant %+v", got, before)
	}
	// HandleAdminConfirm skips the audit on >=400, so a refusal must leave no
	// trace of an action that did not happen.
	if entries, _ := store.ListAudit(ctx, 10, 0, AuditRolloutFast); len(entries) != 0 {
		t.Fatalf("a refused manual fast push wrote %d audit entries", len(entries))
	}
}

// A paused rollout is somebody's (or some failure check's) explicit decision to
// stop. Restarting it is 继续's job, and 继续 deliberately puts the track back on
// the STAGED ladder.
func TestManualFastFleetRolloutRefusesAHaltedRollout(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	before := RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "halted",
		HaltedReason: "node n1 rolled back", CurrentNodeID: "n1",
	}
	if err := store.PutRolloutTrack(ctx, before); err != nil {
		t.Fatal(err)
	}
	resp := confirmAction(t, ts, cookie, "/admin/rollout/fleet/fast",
		fastForm("v2.0.0", "halted", "v1.0.0"))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 against a halted track, got %d\n%s", resp.StatusCode, body)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got != before {
		t.Fatalf("a refused manual fast push mutated the halted track: %+v", got)
	}
}

// The handler's startable-state guard must match the store's accepted set
// EXACTLY. A row whose status is neither complete, rolling nor halted (the
// schema default, on a row written by something that did not set it) used to
// pass a "rolling or halted" guard, be refused by the store's compare-and-swap,
// and be reported as a stale page — a control that refuses forever while telling
// the operator to refresh, with nothing they could refresh to fix it.
func TestManualFastFleetRolloutRefusesAnUnstartableStateLegibly(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	// A row that exists but was never started.
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO node_rollout (track) VALUES ('fleet')`); err != nil {
		t.Fatal(err)
	}
	resp := confirmAction(t, ts, cookie, "/admin/rollout/fleet/fast", fastForm("v2.0.0", "", ""))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for an unstartable state, got %d\n%s", resp.StatusCode, body)
	}
	// It must name the STATE, not blame a stale page — there is nothing stale
	// here and refreshing would change nothing.
	if !strings.Contains(body, "未启动") {
		t.Errorf("refusal does not name the track's actual state:\n%s", body)
	}
	if strings.Contains(body, staleFastRolloutMessage) {
		t.Errorf("an unstartable state was reported as a stale confirmation:\n%s", body)
	}
	if tr, _, _ := store.GetRolloutTrack(ctx, "fleet"); tr.ManualFast || tr.Status != "" {
		t.Fatalf("the refused start mutated the track: %+v", tr)
	}
}

// The confirmation page can be minutes old. If the world moved on since it was
// rendered, the action must refuse rather than ship from a description of a
// state that no longer exists.
func TestManualFastFleetRolloutRefusesAStaleConfirmation(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	// The operator's page showed complete@v1.0.0; the fleet has since finished
	// v1.1.0.
	before := RolloutTrack{Track: "fleet", TargetVersion: "v1.1.0", Status: "complete"}
	if err := store.PutRolloutTrack(ctx, before); err != nil {
		t.Fatal(err)
	}
	resp := confirmAction(t, ts, cookie, "/admin/rollout/fleet/fast",
		fastForm("v2.0.0", "complete", "v1.0.0"))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for a stale confirmation, got %d\n%s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "刷新") {
		t.Errorf("stale refusal does not tell the operator to refresh:\n%s", body)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got != before {
		t.Fatalf("a stale manual fast push mutated the track: %+v", got)
	}
}

// A fresh page on a finished track is the normal path, and it must work.
func TestManualFastFleetRolloutStartsFromAFinishedTrack(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "complete", FirstNodeID: "n3",
	}); err != nil {
		t.Fatal(err)
	}
	resp := confirmAction(t, ts, cookie, "/admin/rollout/fleet/fast",
		fastForm("v2.0.0", "complete", "v1.0.0"))
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("want 302, got %d", resp.StatusCode)
	}
	tr, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if !tr.ManualFast || tr.Status != "rolling" || tr.TargetVersion != "v2.0.0" {
		t.Fatalf("track = %+v, want a rolling manual-fast v2.0.0", tr)
	}
	if tr.FirstNodeID != "" || tr.CurrentNodeID != "" {
		t.Fatalf("track kept the previous rollout's positional state: %+v", tr)
	}
}

// FLEET ONLY, at the routing layer. The BYO track is every user's machine; no
// operator hurry makes mass-pushing hardware we do not own the right call, and
// the safest place to say so is "there is no such route".
func TestManualFastPushHasNoByoRoute(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	for _, track := range []string{"byo", "user", "nonsense"} {
		resp := postAdminForm(t, ts, cookie, "/admin/rollout/"+track+"/fast", fastForm("v2.0.0", "", ""))
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("POST /admin/rollout/%s/fast: want 404, got %d", track, resp.StatusCode)
		}
		if tr, ok, _ := store.GetRolloutTrack(ctx, "byo"); ok && tr.ManualFast {
			t.Fatalf("the byo track was put into manual fast mode: %+v", tr)
		}
	}
}

// Same CSRF and authentication conventions as every other admin write: the
// guard is on the route, not inside the handler, so it is worth pinning that
// the route actually carries it.
func TestManualFastPushRequiresAdminAndOrigin(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	ctx := context.Background()

	// No session at all.
	resp, err := ts.Client().PostForm(ts.URL+"/admin/rollout/fleet/fast", fastForm("v2.0.0", "", ""))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusFound && strings.Contains(resp.Header.Get("Location"), "fast") {
		t.Fatal("an unauthenticated manual fast push was accepted")
	}
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("an unauthenticated manual fast push wrote a rollout track")
	}

	// A logged-in session, but a cross-site Origin.
	cookie := adminLoginCookie(t, ts)
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/admin/rollout/fleet/fast",
		strings.NewReader(fastForm("v2.0.0", "", "").Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://evil.test")
	req.AddCookie(cookie)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode < 400 {
		t.Fatalf("cross-origin manual fast push: want a 4xx, got %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("a cross-origin manual fast push wrote a rollout track")
	}
}

// The version is operator input on a form, exactly like the staged target box,
// and a version the state machine cannot parse wedges a track in "wait"
// forever rather than erroring.
func TestManualFastPushRejectsAnUnparseableVersion(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	for _, bad := range []string{"", "latest", "nightly", "v1.2"} {
		resp := confirmAction(t, ts, cookie, "/admin/rollout/fleet/fast", fastForm(bad, "", ""))
		body := readAll(t, resp)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("version %q: want 400, got %d\n%s", bad, resp.StatusCode, body)
		}
		if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
			t.Fatalf("version %q was accepted onto the fleet track", bad)
		}
	}
}
