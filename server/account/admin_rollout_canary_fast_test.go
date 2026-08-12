package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The safe fast push (canary-then-fast) is the entry point for a version the
// fleet has never run: it keeps the canary's whole six-hour observation window
// and drops only the soak between the machines after it.
//
// These tests hold the properties that make it a SEPARATE action rather than a
// flag on the existing one — its own route, its own audit identity, its own
// confirmation copy — plus the guards it shares with the immediate fast push,
// which must refuse identically because they are the same code.

const canaryFastPath = "/admin/rollout/fleet/fast-canary"

// Its own audit action, applied only after step-up, with the factor recorded.
// Folding it into rollout.fast would tell an incident review that the canary
// window had been skipped on a release that kept it.
func TestCanaryFastRolloutIsStepUpConfirmedAndAuditedUnderItsOwnAction(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	// A plain POST must NOT apply — it renders the confirmation page.
	resp := postAdminForm(t, ts, cookie, canaryFastPath, fastForm("v2.0.0", "", ""))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `name="confirm_token"`) {
		t.Fatalf("safe fast push must render a confirmation page, got %d:\n%s", resp.StatusCode, body)
	}
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("safe fast push applied before the operator confirmed it")
	}

	resp = confirmAction(t, ts, cookie, canaryFastPath, fastForm("v2.0.0", "", ""))
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed safe fast push: want 302, got %d\n%s", resp.StatusCode, body)
	}
	tr, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack(fleet) = %v/%v", ok, err)
	}
	if tr.TargetVersion != "v2.0.0" || tr.Status != "rolling" || !tr.FastAfterCanary {
		t.Fatalf("track = %+v, want rolling v2.0.0 in canary-then-fast mode", tr)
	}
	// The two critical negatives: neither of the other two modes.
	if tr.ManualFast {
		t.Fatal("the safe fast push armed the immediate manual-fast mode; the canary window would be skipped")
	}
	if tr.Emergency {
		t.Fatal("the safe fast push armed emergency mode; it must never release the whole track at once")
	}

	entries, err := store.ListAudit(ctx, 10, 0, AuditRolloutFastCanary)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly 1 %s audit entry, got %d", AuditRolloutFastCanary, len(entries))
	}
	if entries[0].Target != "rollout:fleet" {
		t.Fatalf("audit target: want %q, got %q", "rollout:fleet", entries[0].Target)
	}
	if entries[0].StepUp == StepUpNone {
		t.Fatalf("safe fast push audited without a step-up factor: %+v", entries[0])
	}
	// The audit's change record must say WHICH mode, and it must say the window
	// was kept — that is the fact the action name alone cannot carry to someone
	// reading the diff.
	if !strings.Contains(entries[0].Changes, "canary") {
		t.Errorf("audit changes do not describe the mode: %q", entries[0].Changes)
	}
	if !strings.Contains(entries[0].Changes, "v2.0.0") {
		t.Errorf("audit changes do not name the target version: %q", entries[0].Changes)
	}
	// And it must not have been logged as any of the other rollout actions.
	for _, other := range []string{AuditRolloutFast, AuditRolloutEmergency, AuditRolloutTarget} {
		if got, _ := store.ListAudit(ctx, 10, 0, other); len(got) != 0 {
			t.Fatalf("safe fast push wrote %d %s entries", len(got), other)
		}
	}
}

// The confirmation page is the only working 二次确认 (the panel's inline onsubmit
// is dead under CSP). Its whole job here is to distinguish this action from the
// two it sits beside: it keeps the canary window, and it is not an emergency.
func TestCanaryFastConfirmationPageStatesTheCanaryWindowIsKept(t *testing.T) {
	ts, _, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)

	resp := postAdminForm(t, ts, cookie, canaryFastPath, fastForm("v2.0.0", "", ""))
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
	// THE distinguishing fact: the first node keeps its full observation window.
	for _, want := range []string{"第一台", "观察窗", "6 小时", "回报成功"} {
		if !strings.Contains(body, want) {
			t.Errorf("confirmation page does not state %q:\n%s", want, body)
		}
	}
	// What is shared with the other fast push: still one at a time, still halts.
	if !strings.Contains(body, "一台") || !strings.Contains(body, "中止") {
		t.Errorf("confirmation page does not state the one-at-a-time / halt guarantees:\n%s", body)
	}
	// It must be neither of the other two pages.
	if strings.Contains(body, "整条轨道一次性放行") {
		t.Errorf("confirmation page reuses the emergency copy:\n%s", body)
	}
	if strings.Contains(body, "⚠ 手动快速发布：跳过 canary 观察窗") {
		t.Errorf("confirmation page reuses the immediate manual-fast banner, which claims the window is skipped:\n%s", body)
	}
	if !strings.Contains(body, "v2.0.0") {
		t.Errorf("confirmation page does not name the version:\n%s", body)
	}
}

// The state guards are shared with the immediate fast push, so this action must
// refuse the same states — and, on every refusal, write nothing and audit
// nothing. The four cases are the ones that reach different branches.
func TestCanaryFastRolloutRefusesEveryUnstartableStateWithoutWriting(t *testing.T) {
	cases := []struct {
		name          string
		row           *RolloutTrack
		form          url.Values
		wantInBody    string
		wantNotInBody string
	}{
		{
			// A rollout in flight: starting here would abandon it, discarding up
			// to six hours of canary observation on one click.
			name: "rolling",
			row: &RolloutTrack{Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: 500},
			form: fastForm("v2.0.0", "rolling", "v1.0.0"), wantInBody: "发布中",
		},
		{
			// A paused rollout is somebody's explicit decision to stop; restarting
			// it is 继续's job, which returns the track to the staged ladder.
			name: "halted",
			row: &RolloutTrack{Track: "fleet", TargetVersion: "v1.0.0", Status: "halted",
				HaltedReason: "node n1 rolled back", CurrentNodeID: "n1"},
			form: fastForm("v2.0.0", "halted", "v1.0.0"), wantInBody: "已中止",
		},
		{
			// A stale page: the fleet finished a DIFFERENT version since it was
			// rendered. It must refuse rather than ship from a description of a
			// world that no longer exists.
			name:       "stale confirmation",
			row:        &RolloutTrack{Track: "fleet", TargetVersion: "v1.1.0", Status: "complete"},
			form:       fastForm("v2.0.0", "complete", "v1.0.0"),
			wantInBody: staleCanaryFastRolloutMessage,
			// And it must be THIS action's message, not the other one's.
			wantNotInBody: staleFastRolloutMessage,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ts, _, store, _ := newAdminAuditServer(t)
			cookie := adminLoginCookie(t, ts)
			ctx := context.Background()
			if err := store.PutRolloutTrack(ctx, *c.row); err != nil {
				t.Fatal(err)
			}
			before, _, _ := store.GetRolloutTrack(ctx, "fleet")

			resp := confirmAction(t, ts, cookie, canaryFastPath, c.form)
			body := readAll(t, resp)
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("want 400, got %d\n%s", resp.StatusCode, body)
			}
			if !strings.Contains(body, c.wantInBody) {
				t.Errorf("refusal does not explain itself (%q):\n%s", c.wantInBody, body)
			}
			if c.wantNotInBody != "" && strings.Contains(body, c.wantNotInBody) {
				t.Errorf("refusal used the other action's message:\n%s", body)
			}
			if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got != before {
				t.Fatalf("a refused safe fast push mutated the track:\ngot  %+v\nwant %+v", got, before)
			}
			// HandleAdminConfirm skips the audit on >=400: a refusal must leave no
			// trace of an action that did not happen.
			for _, action := range []string{AuditRolloutFastCanary, AuditRolloutFast} {
				if entries, _ := store.ListAudit(ctx, 10, 0, action); len(entries) != 0 {
					t.Fatalf("a refused safe fast push wrote %d %s entries", len(entries), action)
				}
			}
		})
	}
}

// A row that exists but was never started (status at its schema default) has to
// be refused by NAMING THE STATE, not by blaming a stale page: there is nothing
// stale, and refreshing would change nothing. Same defect the immediate fast
// push already fixed, re-pinned here because this handler shares that guard.
func TestCanaryFastRolloutRefusesAnUnstartableStateLegibly(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if _, err := store.db.ExecContext(ctx, `INSERT INTO node_rollout (track) VALUES ('fleet')`); err != nil {
		t.Fatal(err)
	}
	resp := confirmAction(t, ts, cookie, canaryFastPath, fastForm("v2.0.0", "", ""))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for an unstartable state, got %d\n%s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "未启动") {
		t.Errorf("refusal does not name the track's actual state:\n%s", body)
	}
	if strings.Contains(body, staleCanaryFastRolloutMessage) {
		t.Errorf("an unstartable state was reported as a stale confirmation:\n%s", body)
	}
	if tr, _, _ := store.GetRolloutTrack(ctx, "fleet"); tr.FastAfterCanary || tr.Status != "" {
		t.Fatalf("the refused start mutated the track: %+v", tr)
	}
}

// The version is operator input on a form, exactly like the staged target box,
// and a version the state machine cannot parse wedges a track in "wait" forever
// rather than erroring.
func TestCanaryFastRolloutRejectsAnUnparseableVersion(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	for _, bad := range []string{"", "latest", "nightly", "v1.2"} {
		resp := confirmAction(t, ts, cookie, canaryFastPath, fastForm(bad, "", ""))
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

// FLEET ONLY, at the routing layer. The BYO track is every user's machine; the
// safest way to say "we will never mass-push hardware we do not own" is for
// there to be no route that could — and a safer fast mode is not a reason to
// open one.
func TestCanaryFastPushHasNoByoRoute(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	for _, track := range []string{"byo", "user", "nonsense"} {
		resp := postAdminForm(t, ts, cookie, "/admin/rollout/"+track+"/fast-canary", fastForm("v2.0.0", "", ""))
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("POST /admin/rollout/%s/fast-canary: want 404, got %d", track, resp.StatusCode)
		}
		if tr, ok, _ := store.GetRolloutTrack(ctx, "byo"); ok && tr.FastAfterCanary {
			t.Fatalf("the byo track was put into canary-then-fast mode: %+v", tr)
		}
	}
}

// Same authentication and CSRF conventions as every other admin write. The
// guards are on the route, so it is worth pinning that this route carries them:
// an unauthenticated or cross-origin POST must not start a fleet rollout.
func TestCanaryFastPushRequiresAdminAndOrigin(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	ctx := context.Background()

	resp, err := ts.Client().PostForm(ts.URL+canaryFastPath, fastForm("v2.0.0", "", ""))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("an unauthenticated safe fast push wrote a rollout track")
	}

	cookie := adminLoginCookie(t, ts)
	req, err := http.NewRequest(http.MethodPost, ts.URL+canaryFastPath,
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
		t.Fatalf("cross-origin safe fast push: want a 4xx, got %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("a cross-origin safe fast push wrote a rollout track")
	}
}

// Posting the action's form directly to /admin/confirm without a valid pending
// token — i.e. skipping the step-up round trip entirely — must apply nothing.
func TestCanaryFastPushCannotBypassStepUp(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	form := fastForm("v2.0.0", "", "")
	form.Set("confirm_token", "not-a-real-token")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm", form)
	resp.Body.Close()
	if resp.StatusCode < 400 {
		t.Fatalf("a forged confirmation was accepted: %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("a forged confirmation started a fleet rollout")
	}
	if entries, _ := store.ListAudit(ctx, 10, 0, AuditRolloutFastCanary); len(entries) != 0 {
		t.Fatalf("a forged confirmation wrote %d audit entries", len(entries))
	}
}

// The panel must name this mode as its own thing. Three modes, three badges: the
// badge answers "what is protecting this release right now", and reading the
// manual-fast one on a track that kept its canary window would be the panel
// understating the safety in force — while reading it the other way round would
// be far worse.
func TestRolloutPanelShowsCanaryFastDistinctly(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()
	now := time.Unix(2_000_000, 0)

	seedRolloutNode(t, store, "n1", "fleet", "", "v1.0.0", "", "")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", FastAfterCanary: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: now.Unix() - 60,
	}); err != nil {
		t.Fatal(err)
	}
	nodes, err := store.ListNodes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	p := svc.rolloutPanel(ctx, "fleet", "机队轨", now, nodes, false)
	if !p.FastAfterCanary {
		t.Fatal("panel does not report the track as being in canary-then-fast mode")
	}
	if p.ManualFast || p.Emergency {
		t.Fatalf("panel reports the wrong mode: manualFast=%v emergency=%v", p.ManualFast, p.Emergency)
	}
	// Unlike the immediate fast mode, the rules line MUST still promise the
	// canary window — that is the whole difference, and an operator plans the
	// rollout around that duration.
	if !strings.Contains(p.RulesText, humanDuration(fleetFirstWindow)) {
		t.Errorf("rules text does not state the %s canary window this mode keeps: %q",
			humanDuration(fleetFirstWindow), p.RulesText)
	}
	if !strings.Contains(p.RulesText, "一台") || !strings.Contains(p.RulesText, "中止") {
		t.Errorf("rules text does not state the one-at-a-time / halt guarantees: %q", p.RulesText)
	}
}

// The canary's own row: it has reported success and is being observed. The panel
// must print the WINDOW there, not the immediate mode's "waiting for the next
// poll to command the next node" — an operator reading that on a rollout that is
// deliberately holding for another five hours would conclude it is stuck.
func TestFleetNodeStatusCanaryFastShowsTheWindowAfterOK(t *testing.T) {
	const now = 1_000_000
	in := fleetNodeInput{
		TrackStatus: "rolling", FastAfterCanary: true, OnTarget: true, IsCanary: true,
		UpdateResult: "ok", UpdateStartedAt: now - 60, LastSeenAt: now, StageStartedAt: now - 60,
	}
	st := fleetNodeStatus(in, now)
	if st.Band != "observing" {
		t.Fatalf("band = %q, want observing: the canary is inside its window", st.Band)
	}
	if st.Overdue || st.Alarm {
		t.Errorf("an observing canary is marked overdue/alarming: %+v", st)
	}
	if !strings.Contains(st.Detail, "观察窗") && !strings.Contains(st.Detail, "不早于") {
		t.Errorf("detail does not describe the observation window: %q", st.Detail)
	}

	// A node AFTER the canary in the same mode gets the fast answer instead: no
	// window is being run on it at all.
	later := in
	later.IsCanary = false
	if st := fleetNodeStatus(later, now); st.Band != "observing" || !st.Overdue {
		t.Fatalf("a non-canary node = %+v, want the immediate 'nothing is being timed' answer", st)
	}

	// And once the canary's window has closed, it reads as passed rather than
	// still waiting. The node has gone on heartbeating across those six hours;
	// leaving LastSeenAt behind would trip the silence overlay, which is a
	// different (and correct) alarm than the one under test here.
	observed := in
	observed.LastSeenAt = now + fleetFirstWindow
	done := fleetNodeStatus(observed, now+fleetFirstWindow)
	if !done.Overdue || done.Alarm {
		t.Fatalf("a canary past its window = %+v, want Overdue and no alarm", done)
	}
}

// The rendered page has to carry the badge and the control: a view field is only
// useful if the template prints it.
func TestAdminPageRendersTheCanaryFastBadgeAndControl(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", FastAfterCanary: true,
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)
	if !strings.Contains(body, "安全快速发布中") {
		t.Errorf("admin page does not show the safe fast badge:\n%s", excerptAround(body, "机队轨"))
	}
	for _, wrong := range []string{"手动快速发布中", "紧急发布中（已跳过分批）"} {
		if strings.Contains(body, wrong) {
			t.Errorf("admin page shows %q for a canary-then-fast rollout", wrong)
		}
	}

	// On a finished track BOTH controls are offered, and each carries the state
	// the handler compares against. A control that posted no from_status /
	// from_version would make every submission look fresh and defeat the
	// staleness guard entirely.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	body = getAdminHome(t, ts, cookie)
	for _, action := range []string{
		`action="/admin/rollout/fleet/fast-canary"`,
		`action="/admin/rollout/fleet/fast"`,
	} {
		if !strings.Contains(body, action) {
			t.Errorf("control %s is not on the page:\n%s", action, excerptAround(body, "机队轨"))
		}
	}
	if strings.Count(body, `name="from_status" value="complete"`) < 2 ||
		strings.Count(body, `name="from_version" value="v1.0.0"`) < 2 {
		t.Errorf("a fast control does not carry the observed state:\n%s",
			excerptAround(body, "/admin/rollout/fleet/fast-canary"))
	}
}

// FLEET ONLY on the page as well as in the router.
func TestAdminPageDoesNotOfferCanaryFastOnTheByoPanel(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)
	if strings.Contains(body, `action="/admin/rollout/byo/fast-canary"`) {
		t.Fatal("the BYO panel offers a safe fast push")
	}
}
