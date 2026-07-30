package account

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// seedRolloutNode inserts one node of the given ownership class with a version
// and (optionally) a live command record + reported result, which is what the
// per-node rollout rows render from.
func seedRolloutNode(t *testing.T, store *SQLiteStore, id, ownerType, ownerUserID, version, fromVersion, result string) {
	t.Helper()
	ctx := context.Background()
	if _, err := store.UpsertNode(ctx, Node{
		ID: id, OwnerType: ownerType, OwnerUserID: ownerUserID, Version: version,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if fromVersion != "" {
		// CommandNodeUpdate CLEARS update_result, so it has to come first.
		if err := store.CommandNodeUpdate(ctx, id, fromVersion, 1000); err != nil {
			t.Fatal(err)
		}
	}
	if result != "" {
		if err := store.SetNodeUpdateResult(ctx, id, result); err != nil {
			t.Fatal(err)
		}
	}
}

// Emergency mode is what makes 紧急发布 mean anything: every node behind the
// target moves NOW, with no queue and no batch. Without it the button would set
// a target and then the staged ladder would quietly ignore the emergency.
func TestEmergencyReleaseSkipsTheStagedLadder(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	// fleet-a holds the rollout slot and its 6h canary window has just started,
	// so on the STAGED path fleet-b is told "another node is next".
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "fleet-a", FirstNodeID: "fleet-a", StageStartedAt: tNow, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"fleet-a", "fleet-b"} {
		if _, err := st.UpsertNode(ctx, Node{
			ID: id, OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
	}
	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "fleet-b", CurrentVersion: "v0.8.0"})
	if !out.Eligible {
		t.Fatalf("emergency release must let a queued-behind node move now: %+v", out)
	}
	// It was really commanded (update_from_version is what makes its later
	// result attributable), not just told "yes".
	n, _, err := st.GetNode(ctx, "fleet-b")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateFromVersion != "v0.8.0" || n.UpdateStartedAt != tNow {
		t.Fatalf("emergency release did not record the command: %+v", n)
	}
}

// ...but it must not turn into a reinstall loop: a node that already reported a
// failure for THIS release is left alone (and left showing that failure), rather
// than being handed the same doomed command every 30 seconds.
//
// The timestamps matter and are not arbitrary: the release was armed at
// tNow-200 and the node was commanded at tNow-100, i.e. BY this release. That
// is what makes its failure this release's failure — see emergencyRefusesNode,
// and TestEmergencyReleaseIgnoresAStaleFailure for the other side of the line.
func TestEmergencyReleaseDoesNotRecommandAFailedNode(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		StageStartedAt: tNow - 200, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "fleet-a", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.CommandNodeUpdate(ctx, "fleet-a", "v0.8.0", tNow-100); err != nil {
		t.Fatal(err)
	}
	_, out := postUpdateCheck(t, ts, "fleet-secret",
		updateCheckReq{NodeID: "fleet-a", CurrentVersion: "v0.8.0", Result: "failed"})
	if out.Eligible {
		t.Fatalf("a node that just reported a failure was re-commanded: %+v", out)
	}
	n, _, err := st.GetNode(ctx, "fleet-a")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateResult != "failed" || n.UpdateStartedAt != tNow-100 {
		t.Fatalf("the failure record was overwritten by a re-command: %+v", n)
	}
}

// 1) The dashboard renders TWO independent panels, each with its own target
// version, status, halt reason and progress, and each with its own controls.
func TestAdminDashboardShowsBothRolloutPanels(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.3", Status: "rolling",
		CurrentNodeID: "fleet-b", FirstNodeID: "fleet-b", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "halted", ByoBatch: 50,
		HaltedReason: "byo rollout: 3/5 nodes in the 50% batch failed", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "fleet-a", "fleet", "", "v1.2.3", "", "")
	seedRolloutNode(t, store, "fleet-b", "fleet", "", "v1.1.0", "v1.1.0", "failed")
	seedRolloutNode(t, store, "byo-a", "user", "u1", "v1.0.0", "", "")
	seedRolloutNode(t, store, "byo-b", "user", "u2", "v0.9.0", "v0.9.0", "rolled_back")

	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	html := readAll(t, resp)

	for _, want := range []string{
		// Both panels, named.
		"机队轨（fleet）",
		"自带节点轨（byo）",
		// Each panel's own target version and status.
		"v1.2.3", "发布中",
		"v1.0.0", "已中止",
		// The byo halt reason must be legible on the page.
		"byo rollout: 3/5 nodes in the 50% batch failed",
		// Per-track progress: 1 of 2 on target on each track.
		"1/2 台已在目标版本",
		// Fleet progress names the node in flight; byo names the open batch.
		"正在更新：fleet-b",
		"当前批次：50%",
		// Per-node diagnosis rows.
		"fleet-a", "fleet-b", "byo-a", "byo-b",
		"更新失败", "已回滚",
		// Each panel has its OWN set of controls (independent form actions).
		// pause/resume are asserted below instead of here: which one of the
		// pair renders follows this panel's own status (see
		// TestPanelHidesControlsThatCanOnlyBeRefused), and fleet here is
		// "rolling" while byo is "halted", so the two tracks show opposite
		// halves of the pair.
		`action="/admin/rollout/fleet/target"`,
		`action="/admin/rollout/fleet/rollback"`,
		`action="/admin/rollout/fleet/emergency"`,
		`action="/admin/rollout/byo/target"`,
		`action="/admin/rollout/byo/rollback"`,
		`action="/admin/rollout/byo/emergency"`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("rollout panels missing %q", want)
		}
	}
	// fleet is "rolling": only pause can succeed. byo is "halted": only resume
	// can succeed. A button whose only possible outcome is a refusal must not
	// be rendered (the same principle already applied to 回滚到上一版本).
	for _, want := range []string{
		`action="/admin/rollout/fleet/pause"`,
		`action="/admin/rollout/byo/resume"`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("rollout panels missing %q", want)
		}
	}
	for _, unwanted := range []string{
		`action="/admin/rollout/fleet/resume"`,
		`action="/admin/rollout/byo/pause"`,
	} {
		if strings.Contains(html, unwanted) {
			t.Fatalf("rollout panels render %q, but pressing it can only be refused", unwanted)
		}
	}
	// "1/2 台已在目标版本" must appear once per panel — one shared progress
	// number would mean the panels are reading each other's state.
	if got := strings.Count(html, "台已在目标版本"); got != 2 {
		t.Fatalf("want exactly 2 progress readouts (one per panel), got %d", got)
	}
}

// 2) THE property this design exists for: a halted (or otherwise wedged) BYO
// track must never stop the fleet track from accepting a new target and
// rolling. Driven through the REAL route, so it also pins that setting a fleet
// target is not gated behind anything the byo track can influence.
func TestAdminHaltedByoTrackDoesNotBlockFleetTarget(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "complete", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	byoBefore := RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "halted", ByoBatch: 50,
		HaltedReason: "byo rollout: 4/5 nodes in the 50% batch failed", StageStartedAt: 1000,
	}
	if err := store.PutRolloutTrack(ctx, byoBefore); err != nil {
		t.Fatal(err)
	}

	resp := postAdminForm(t, ts, cookie, "/admin/rollout/fleet/target",
		url.Values{"version": {"v1.1.0"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("setting a fleet target while byo is halted: want 302, got %d\n%s",
			resp.StatusCode, readAll(t, resp))
	}

	fleet, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack(fleet) = %v/%v", ok, err)
	}
	if fleet.TargetVersion != "v1.1.0" || fleet.Status != "rolling" {
		t.Fatalf("fleet track did not start rolling to v1.1.0: %+v", fleet)
	}

	// And the byo track must be byte-for-byte where it was: the fleet control
	// must not "fix" or otherwise touch the other track.
	byoAfter, ok, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack(byo) = %v/%v", ok, err)
	}
	if byoAfter.TargetVersion != byoBefore.TargetVersion || byoAfter.Status != byoBefore.Status ||
		byoAfter.ByoBatch != byoBefore.ByoBatch || byoAfter.HaltedReason != byoBefore.HaltedReason {
		t.Fatalf("fleet action mutated the byo track: before=%+v after=%+v", byoBefore, byoAfter)
	}
}

// 3) SetTargetVersion's rejections (unknown track, non-semver version, and the
// one-way byo-behind-fleet gate) must reach the admin as a readable error —
// not a 500, not a silent success — and must leave the track untouched.
func TestRolloutTargetErrorsAreLegibleAndDoNotMutate(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	// Fleet has only ever completed v1.0.0.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "complete", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	byoBefore := RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "rolling", ByoBatch: 10, StageStartedAt: 1000,
	}
	if err := store.PutRolloutTrack(ctx, byoBefore); err != nil {
		t.Fatal(err)
	}

	// byo pointed at a version the fleet has never completed.
	resp := postAdminForm(t, ts, cookie, "/admin/rollout/byo/target", url.Values{"version": {"v2.0.0"}})
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("byo ahead of fleet: want 400, got %d\n%s", resp.StatusCode, body)
	}
	for _, want := range []string{"目标版本设置失败", ErrByoAheadOfFleet.Error()} {
		if !strings.Contains(body, want) {
			t.Fatalf("error page missing %q, got:\n%s", want, body)
		}
	}
	byoAfter, _, _ := store.GetRolloutTrack(ctx, "byo")
	if byoAfter != byoBefore {
		t.Fatalf("rejected target still mutated the byo track: before=%+v after=%+v", byoBefore, byoAfter)
	}

	// A version that is not a plain release tag.
	resp = postAdminForm(t, ts, cookie, "/admin/rollout/fleet/target", url.Values{"version": {"nightly"}})
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("non-semver version: want 400, got %d\n%s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "目标版本设置失败") || !strings.Contains(body, "nightly") {
		t.Fatalf("non-semver error not legible, got:\n%s", body)
	}
	fleetAfter, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if fleetAfter.TargetVersion != "v1.0.0" || fleetAfter.Status != "complete" {
		t.Fatalf("rejected version still mutated the fleet track: %+v", fleetAfter)
	}

	// An unknown track name.
	resp = postAdminForm(t, ts, cookie, "/admin/rollout/nonsense/target", url.Values{"version": {"v1.1.0"}})
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown track: want 400, got %d\n%s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "目标版本设置失败") {
		t.Fatalf("unknown-track error not legible, got:\n%s", body)
	}
}

// 4) Emergency release is its OWN action: it is gated behind the step-up
// confirmation page, it writes an audit entry, and it is not something the
// ordinary set-target control can do.
func TestEmergencyReleaseIsSeparateActionAndAudited(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	// A plain POST must NOT apply — it renders the confirmation page.
	resp := postAdminForm(t, ts, cookie, "/admin/rollout/fleet/emergency", url.Values{"version": {"v2.0.0"}})
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `name="confirm_token"`) {
		t.Fatalf("emergency release must render a confirmation page, got %d:\n%s", resp.StatusCode, body)
	}
	if _, ok, _ := store.GetRolloutTrack(ctx, "fleet"); ok {
		t.Fatal("emergency release applied before the operator confirmed it")
	}

	// Confirmed: it applies, and it flips the track into emergency mode.
	resp = confirmAction(t, ts, cookie, "/admin/rollout/fleet/emergency", url.Values{"version": {"v2.0.0"}})
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed emergency release: want 302, got %d\n%s", resp.StatusCode, body)
	}
	tr, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack(fleet) = %v/%v", ok, err)
	}
	if tr.TargetVersion != "v2.0.0" || tr.Status != "rolling" || !tr.Emergency {
		t.Fatalf("emergency release did not release the whole track: %+v", tr)
	}

	// It is audited, under its own action name and naming the track.
	entries, err := store.ListAudit(ctx, 10, 0, AuditRolloutEmergency)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly 1 %s audit entry, got %d", AuditRolloutEmergency, len(entries))
	}
	if entries[0].Target != "rollout:fleet" {
		t.Fatalf("audit target: want %q, got %q", "rollout:fleet", entries[0].Target)
	}
	if entries[0].StepUp == StepUpNone {
		t.Fatalf("emergency release audited without a step-up factor: %+v", entries[0])
	}

	// The ordinary set-target control is a DIFFERENT action and can never turn
	// emergency mode on: setting a target normally puts the track back on the
	// staged ladder.
	resp = postAdminForm(t, ts, cookie, "/admin/rollout/fleet/target", url.Values{"version": {"v2.1.0"}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("normal set-target: want 302, got %d", resp.StatusCode)
	}
	tr, _, _ = store.GetRolloutTrack(ctx, "fleet")
	if tr.TargetVersion != "v2.1.0" || tr.Emergency {
		t.Fatalf("normal set-target must clear emergency mode: %+v", tr)
	}
	if entries, _ := store.ListAudit(ctx, 10, 0, AuditRolloutEmergency); len(entries) != 1 {
		t.Fatalf("a normal set-target was logged as an emergency release: %d entries", len(entries))
	}
}

// A leftover failure from a PREVIOUS rollout must NOT exclude a node from an
// emergency release. Nothing clears a FAILURE result except CommandNodeUpdate —
// not re-register, not heartbeat, and not SetTargetVersion, whose
// ClearPassedOverResults erases only "skipped"/"unreachable" — so before the
// guard was time-scoped a
// single stale "failed" made a machine sit out every future emergency release,
// silently and forever. The STAGED ladder would have re-commanded that same node
// (decideFleet/decideByo use failures for the halt rate, never to exclude
// candidates), so the emergency path was STRICTER than staging in exactly the
// place it is meant to be looser.
func TestEmergencyReleaseIgnoresAStaleFailure(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	// The release now in flight was armed at tNow.
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		StageStartedAt: tNow, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "fleet-a", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	// ...but this node's failure is from the v0.7.0 -> v0.8.0 attempt, long
	// before this release existed. It reached v0.8.0 in the end; the row is
	// just never cleaned up.
	if err := st.CommandNodeUpdate(ctx, "fleet-a", "v0.7.0", tNow-10000); err != nil {
		t.Fatal(err)
	}
	if err := st.SetNodeUpdateResult(ctx, "fleet-a", "failed"); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "fleet-a", CurrentVersion: "v0.8.0"})
	if !out.Eligible {
		t.Fatalf("a stale failure from an older rollout excluded this node from the emergency release: %+v", out)
	}
	n, _, err := st.GetNode(ctx, "fleet-a")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateFromVersion != "v0.8.0" || n.UpdateStartedAt != tNow || n.UpdateResult != "" {
		t.Fatalf("the emergency release did not actually command the node: %+v", n)
	}
}

// The other half of the same fix: a node the emergency path REFUSES to command
// must not count as "still in progress", or it pins the track in
// rolling+emergency forever — and a track stuck like that keeps blanket-
// commanding every node that comes back online or registers afterwards.
func TestEmergencyReleaseCompletesDespiteARefusedNode(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		StageStartedAt: tNow - 200, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}
	// fleet-a is done; fleet-b is online, behind, and has already failed THIS
	// release, so it will never be commanded again.
	for id, ver := range map[string]string{"fleet-a": "v0.9.0", "fleet-b": "v0.8.0"} {
		if _, err := st.UpsertNode(ctx, Node{
			ID: id, OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: ver, CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.CommandNodeUpdate(ctx, "fleet-b", "v0.8.0", tNow-100); err != nil {
		t.Fatal(err)
	}
	if err := st.SetNodeUpdateResult(ctx, "fleet-b", "failed"); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{NodeID: "fleet-a", CurrentVersion: "v0.9.0"})
	if out.Eligible {
		t.Fatalf("a node already on target was told to update: %+v", out)
	}
	tr, ok, err := st.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack(fleet) = %v/%v", ok, err)
	}
	if tr.Status != "complete" {
		t.Fatalf("one permanently-refused node held the emergency release open forever: %+v (%s)", tr, out.Reason)
	}
	// MINOR 4: a finished track is not 紧急发布中 — the badge must not survive
	// completion.
	if tr.Emergency {
		t.Fatalf("emergency flag survived completion: %+v", tr)
	}
	// And fleet-b's failure is still on its row for the panel to show.
	n, _, err := st.GetNode(ctx, "fleet-b")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateResult != "failed" {
		t.Fatalf("the refused node's failure record was lost: %+v", n)
	}
}

// The confirmation page is the ONLY working 二次确认 for an emergency release
// (the panel's inline onsubmit="confirm(...)" is dead — CSP blocks inline
// handlers), and the single most consequential fact about the action is WHICH
// TRACK it hits: "fleet" is our own machines, "byo" is every user's machine.
// The page used to name the action and the version and nothing else, because
// the track lives in the path wildcard and was patched in for the AUDIT only.
func TestEmergencyConfirmationPageNamesTheTrack(t *testing.T) {
	ts, _, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)

	resp := postAdminForm(t, ts, cookie, "/admin/rollout/byo/emergency", url.Values{"version": {"v2.0.0"}})
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `name="confirm_token"`) {
		t.Fatalf("want the confirmation page, got %d:\n%s", resp.StatusCode, body)
	}
	for _, want := range []string{
		"轨道：byo",                 // the track, spelled out, not buried in a form action
		rolloutTrackLabel("byo"), // ...and whose machines that means
		"rollout:byo",            // the page's target matches the audit target
		"v2.0.0",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("emergency confirmation page never states %q:\n%s", want, body)
		}
	}
	// The fleet track must be named as itself, not as whatever was rendered
	// last — i.e. the value really comes from the path.
	resp = postAdminForm(t, ts, cookie, "/admin/rollout/fleet/emergency", url.Values{"version": {"v2.0.0"}})
	body = readAll(t, resp)
	resp.Body.Close()
	if !strings.Contains(body, "轨道：fleet") || strings.Contains(body, "轨道：byo") {
		t.Fatalf("fleet confirmation page does not name the fleet track:\n%s", body)
	}
}

// armFailStore makes the old two-step emergency release fail at its SECOND
// step (the emergency CAS), which is the interleaving that used to leave the
// track repointed and rolling to the confirmed version with emergency mode
// never armed — while the operator was told 紧急发布失败 and, because
// HandleAdminConfirm skips the audit on any >=400, with nothing in the log.
type armFailStore struct{ *SQLiteStore }

func (armFailStore) SetRolloutEmergency(context.Context, string, string, int64) (bool, error) {
	return false, nil
}

// An emergency release must be all-or-nothing to the operator: it must never
// leave a track repointed but unarmed, and anything it DID write must be
// audited.
func TestEmergencyReleaseIsNeverHalfApplied(t *testing.T) {
	base := newTestStore(t)
	svc := NewService(armFailStore{base}, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: "admin", AdminPassword: "secret123",
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	resp := confirmAction(t, ts, cookie, "/admin/rollout/fleet/emergency", url.Values{"version": {"v2.0.0"}})
	body := readAll(t, resp)
	resp.Body.Close()

	tr, ok, err := base.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := base.ListAudit(ctx, 10, 0, AuditRolloutEmergency)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		// Nothing was written at all — acceptable, but only if the operator was
		// actually told it failed.
		if resp.StatusCode == http.StatusFound {
			t.Fatalf("reported success but wrote nothing:\n%s", body)
		}
		return
	}
	if tr.TargetVersion == "v2.0.0" && !tr.Emergency {
		t.Fatalf("track repointed to the confirmed version but emergency mode was never armed "+
			"— a STAGED rollout is now underway that nobody asked for: %+v (HTTP %d)", tr, resp.StatusCode)
	}
	if len(entries) != 1 {
		t.Fatalf("an emergency release that wrote to the track left %d audit entries, want 1: %+v", len(entries), tr)
	}
}

// newRolloutFullServer registers BOTH the admin controls and the node
// update-check endpoint against one store and one pinned clock, so a test can
// drive an operator action and a node poll against the same state.
func newRolloutFullServer(t *testing.T) (*httptest.Server, *SQLiteStore) {
	t.Helper()
	st := newTestStore(t)
	svc := NewService(st, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: "admin", AdminPassword: "secret123",
		NodeToken: "fleet-secret", EnableUserNodes: true,
	})
	svc.now = func() time.Time { return time.Unix(tNow, 0) }
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	svc.RegisterNodeRoutes(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, st
}

// 暂停 halts a track where it stands, and 继续 restarts it from the beginning of
// the ladder. Resume's field resets are not cosmetic: leaving byo_batch (or the
// fleet's current/first node) where the halt found them re-evaluates the same
// batch against the same failing nodes and re-halts immediately, forever.
func TestRolloutPauseAndResume(t *testing.T) {
	ts, store := newRolloutFullServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "rolling", ByoBatch: 50,
		CurrentNodeID: "byo-a", FirstNodeID: "byo-a", StageStartedAt: 1000, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}

	resp := postAdminForm(t, ts, cookie, "/admin/rollout/byo/pause", url.Values{})
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("pause: want 302, got %d\n%s", resp.StatusCode, body)
	}
	tr, _, _ := store.GetRolloutTrack(ctx, "byo")
	if tr.Status != "halted" || tr.HaltedReason != "管理员手动暂停" {
		t.Fatalf("pause did not halt the track: %+v", tr)
	}
	if tr.TargetVersion != "v1.0.0" {
		t.Fatalf("pause moved the target version: %+v", tr)
	}

	// Pausing a track that is not rolling is refused, legibly, and changes
	// nothing — it must not resurrect or re-stamp a halt.
	resp = postAdminForm(t, ts, cookie, "/admin/rollout/byo/pause", url.Values{})
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, "该轨道当前不在发布中") {
		t.Fatalf("second pause: want a legible 400, got %d\n%s", resp.StatusCode, body)
	}

	resp = postAdminForm(t, ts, cookie, "/admin/rollout/byo/resume", url.Values{})
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("resume: want 302, got %d\n%s", resp.StatusCode, body)
	}
	tr, _, _ = store.GetRolloutTrack(ctx, "byo")
	if tr.Status != "rolling" || tr.HaltedReason != "" {
		t.Fatalf("resume did not restart the track: %+v", tr)
	}
	if tr.TargetVersion != "v1.0.0" {
		t.Fatalf("resume changed the target version: %+v", tr)
	}
	// The resets that stop an immediate re-halt, plus emergency staying OFF:
	// 继续 is the staged, careful path, never a silent re-arm of a blanket
	// release.
	if tr.ByoBatch != 0 || tr.CurrentNodeID != "" || tr.FirstNodeID != "" || tr.Emergency {
		t.Fatalf("resume did not reset the staging fields: %+v", tr)
	}

	// Resuming something that is not halted is refused the same way.
	resp = postAdminForm(t, ts, cookie, "/admin/rollout/byo/resume", url.Values{})
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, "该轨道当前不是已中止状态") {
		t.Fatalf("second resume: want a legible 400, got %d\n%s", resp.StatusCode, body)
	}

	// Both controls are audited.
	for _, action := range []string{AuditRolloutPause, AuditRolloutResume} {
		entries, err := store.ListAudit(ctx, 10, 0, action)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Target != "rollout:byo" {
			t.Fatalf("%s audit: got %d entries %+v", action, len(entries), entries)
		}
	}
}

// 暂停 is documented as THE kill switch for an emergency release that is going
// wrong. That claim is only true if a paused track really stops commanding
// nodes — every decision path treats a track that is not 'rolling' as inert,
// and the emergency short-circuit must be no exception.
func TestPauseStopsAnEmergencyReleaseFromCommandingNodes(t *testing.T) {
	ts, store := newRolloutFullServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		StageStartedAt: tNow, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"fleet-a", "fleet-b"} {
		if _, err := store.UpsertNode(ctx, Node{
			ID: id, OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
			Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Before the pause, the emergency release commands whoever asks.
	if _, out := postUpdateCheck(t, ts, "fleet-secret",
		updateCheckReq{NodeID: "fleet-a", CurrentVersion: "v0.8.0"}); !out.Eligible {
		t.Fatalf("emergency release did not command fleet-a: %+v", out)
	}

	resp := postAdminForm(t, ts, cookie, "/admin/rollout/fleet/pause", url.Values{})
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("pause: want 302, got %d", resp.StatusCode)
	}

	// After it, nobody is: not the node that already moved, and not one that
	// never got the command.
	_, out := postUpdateCheck(t, ts, "fleet-secret",
		updateCheckReq{NodeID: "fleet-b", CurrentVersion: "v0.8.0"})
	if out.Eligible {
		t.Fatalf("a paused emergency release still commanded a node: %+v", out)
	}
	n, _, err := store.GetNode(ctx, "fleet-b")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateFromVersion != "" || n.UpdateStartedAt != 0 {
		t.Fatalf("a paused emergency release recorded a command against fleet-b: %+v", n)
	}
}

// FINDING 1: the top-of-page halt banner must survive the SHARED node listing
// failing. GetRolloutTrack succeeded and the halt is genuinely known — losing
// the one thing the banner exists to never miss because an unrelated query
// (ListNodes) failed would be exactly backwards. The panel itself still
// reports Err (its node table and controls are rightly hidden — the node
// listing really did fail), but haltedRolloutTracks must not be fooled by
// that into treating the halt as unknown.
func TestHaltBannerSurvivesANodeListingFailure(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "halted",
		HaltedReason: "byo rollout: 4/5 nodes failed", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}

	// nodesErr=true simulates the dashboard's shared ListNodes call failing;
	// allNodes is empty/nil exactly as it would be in that case.
	panel := svc.rolloutPanel(ctx, "byo", "自带节点轨", svc.now(), nil, true)
	if !panel.Err {
		t.Fatalf("panel should still report Err when the node listing failed: %+v", panel)
	}
	if !panel.Configured || panel.Status != "halted" {
		t.Fatalf("the track's halted status was lost to the node-listing failure: %+v", panel)
	}

	halts := haltedRolloutTracks(panel)
	if len(halts) != 1 || halts[0].Track != "byo" {
		t.Fatalf("halt banner missing despite a known halt: %+v", halts)
	}

	// Contrast: a track whose OWN read genuinely failed must still be excluded
	// — Configured stays false in that case, never reaching "halted" here.
	unread := rolloutPanelView{Track: "fleet", Title: "机队轨", Err: true}
	if got := haltedRolloutTracks(unread); len(got) != 0 {
		t.Fatalf("a track whose own read failed must not appear in the banner: %+v", got)
	}
}

// The BYO track is one row per USER machine, so an uncapped panel is an
// unbounded page. Truncating an unordered list would hide exactly the failures
// the panel exists to surface, so the ordering is part of the cap.
func TestRolloutPanelRowsAreCappedFailuresFirst(t *testing.T) {
	var rows []rolloutNodeView
	for i := 0; i < rolloutPanelMaxRows+5; i++ {
		rows = append(rows, rolloutNodeView{ID: fmt.Sprintf("n%03d", i), OnTarget: true})
	}
	// The one node that matters is last in the caller's order.
	rows = append(rows, rolloutNodeView{ID: "broken", Result: "failed"})

	shown, hidden := rolloutNodeRows(rows)
	if len(shown) != rolloutPanelMaxRows {
		t.Fatalf("rendered %d rows, want the cap %d", len(shown), rolloutPanelMaxRows)
	}
	if hidden != len(rows)-rolloutPanelMaxRows {
		t.Fatalf("hidden=%d, want %d", hidden, len(rows)-rolloutPanelMaxRows)
	}
	if shown[0].ID != "broken" {
		t.Fatalf("the failed node was not surfaced first: %+v", shown[0])
	}
	// Under the cap nothing is dropped and nothing is claimed hidden.
	shown, hidden = rolloutNodeRows(rows[:3])
	if len(shown) != 3 || hidden != 0 {
		t.Fatalf("short list: shown=%d hidden=%d", len(shown), hidden)
	}
}
