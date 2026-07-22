package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
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
// failure for this target is left alone (and left showing that failure), rather
// than being handed the same doomed command every 30 seconds.
func TestEmergencyReleaseDoesNotRecommandAFailedNode(t *testing.T) {
	ts, _, st := newUpdateCheckServer(t)
	ctx := context.Background()
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
		`action="/admin/rollout/fleet/target"`,
		`action="/admin/rollout/fleet/pause"`,
		`action="/admin/rollout/fleet/resume"`,
		`action="/admin/rollout/fleet/rollback"`,
		`action="/admin/rollout/fleet/emergency"`,
		`action="/admin/rollout/byo/target"`,
		`action="/admin/rollout/byo/pause"`,
		`action="/admin/rollout/byo/resume"`,
		`action="/admin/rollout/byo/rollback"`,
		`action="/admin/rollout/byo/emergency"`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("rollout panels missing %q", want)
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
