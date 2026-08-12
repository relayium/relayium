package account

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The panel is what an operator reads while a rollout is running, and the two
// ladder-skipping modes must never be confused there: 紧急发布 means every node
// moved at once with nothing left to catch a bad build, 手动快速发布 means the
// queue is intact and only the waiting is gone. A badge that said the wrong one
// would be the panel lying about the safety properties in force.
func TestRolloutPanelShowsManualFastDistinctlyFromEmergency(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()
	now := time.Unix(2_000_000, 0)

	seedRolloutNode(t, store, "n1", "fleet", "", "v1.0.0", "", "")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: now.Unix() - 60,
	}); err != nil {
		t.Fatal(err)
	}
	nodes, err := store.ListNodes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	p := svc.rolloutPanel(ctx, "fleet", "机队轨", now, nodes, false)
	if !p.ManualFast {
		t.Fatal("panel does not report the track as being in manual fast mode")
	}
	if p.Emergency {
		t.Fatal("panel reports a manual fast rollout as an emergency release")
	}
	// The timing sentence is generated from the state machine's own constants,
	// so it must stop promising the canary window that this mode does not run —
	// checked by its DURATION, which is the part an operator plans around, not
	// by the word "canary" (the fast sentence legitimately says there is none).
	if strings.Contains(p.RulesText, humanDuration(fleetFirstWindow)) {
		t.Errorf("rules text still promises the %s canary window in fast mode: %q",
			humanDuration(fleetFirstWindow), p.RulesText)
	}
	if !strings.Contains(p.RulesText, "一台") {
		t.Errorf("rules text does not say the rollout is still one node at a time: %q", p.RulesText)
	}
	if !strings.Contains(p.RulesText, "中止") {
		t.Errorf("rules text does not say a failure halts the rollout: %q", p.RulesText)
	}
}

// A pass-over HALTS a manual fast rollout, so the row for the node that
// reported it must not keep saying the queue will step over it and carry on.
// That sentence is true on the staged ladder and false here, and it is the
// difference between "wait, it will sort itself out" and "this release has
// stopped and needs you".
func TestFleetNodeStatusPassOverTextDependsOnTheMode(t *testing.T) {
	const now = 1_000_000
	for _, result := range []string{"skipped", "unreachable"} {
		t.Run(result, func(t *testing.T) {
			in := fleetNodeInput{
				TrackStatus: "rolling", OnTarget: false, IsCanary: true,
				UpdateResult: result, UpdateStartedAt: now - 60,
				StageStartedAt: now - 60, LastSeenAt: now,
			}
			staged := fleetNodeStatus(in, now)
			if !strings.Contains(staged.Detail, "越过") {
				t.Errorf("staged %s detail lost the pass-over wording: %q", result, staged.Detail)
			}
			if strings.Contains(staged.Detail, "中止") {
				t.Errorf("staged %s detail claims the track halts, which it does not: %q", result, staged.Detail)
			}

			in.ManualFast = true
			fast := fleetNodeStatus(in, now)
			if strings.Contains(fast.Detail, "越过") {
				t.Errorf("fast %s detail still says the queue steps over and continues: %q", result, fast.Detail)
			}
			if !strings.Contains(fast.Detail, "中止") {
				t.Errorf("fast %s detail does not say the rollout halts: %q", result, fast.Detail)
			}
			if !fast.Alarm {
				t.Errorf("fast %s must call for a human", result)
			}
		})
	}
}

// ...and the ordinary staged panel must keep saying exactly what it said
// before, or this change would have quietly rewritten every normal rollout's
// description.
func TestRolloutPanelStagedRulesTextIsUnchanged(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()
	now := time.Unix(2_000_000, 0)

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
	}); err != nil {
		t.Fatal(err)
	}
	p := svc.rolloutPanel(ctx, "fleet", "机队轨", now, nil, false)
	if p.ManualFast {
		t.Fatal("a staged track is reported as manual fast")
	}
	if !strings.Contains(p.RulesText, "canary 观察") {
		t.Errorf("staged rules text lost its canary sentence: %q", p.RulesText)
	}
}

// The rendered page has to carry the badge too — the view field is only useful
// if the template prints it, and the emergency badge proved that the string an
// operator actually sees is the thing worth pinning.
func TestAdminPageRendersTheManualFastBadge(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", ManualFast: true,
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)
	if !strings.Contains(body, "手动快速发布中") {
		t.Errorf("admin page does not show the manual fast badge:\n%s", excerptAround(body, "机队轨"))
	}
	if strings.Contains(body, "紧急发布中（已跳过分批）") {
		t.Errorf("admin page shows the emergency badge for a manual fast rollout")
	}
}

// The control itself has to be on the page, and it has to carry the state the
// handler compares against — a button that posts no from_status/from_version
// would make every submission look fresh and defeat the staleness guard
// entirely.
func TestAdminPageManualFastFormCarriesTheObservedState(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)
	if !strings.Contains(body, `action="/admin/rollout/fleet/fast"`) {
		t.Fatalf("the manual fast control is not on the page:\n%s", excerptAround(body, "机队轨"))
	}
	if !strings.Contains(body, `name="from_status" value="complete"`) {
		t.Errorf("the manual fast form does not carry the observed status:\n%s",
			excerptAround(body, "/admin/rollout/fleet/fast"))
	}
	if !strings.Contains(body, `name="from_version" value="v1.0.0"`) {
		t.Errorf("the manual fast form does not carry the observed target version:\n%s",
			excerptAround(body, "/admin/rollout/fleet/fast"))
	}
}

// FLEET ONLY, on the page as well as in the router: a button on the BYO panel
// could only ever 404, and offering it at all misrepresents what this feature
// is willing to do to users' machines.
func TestAdminPageDoesNotOfferManualFastOnTheByoPanel(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)
	if strings.Contains(body, `action="/admin/rollout/byo/fast"`) {
		t.Fatal("the BYO panel offers a manual fast push")
	}
}

// excerptAround returns a readable slice of the page around a marker, so a
// failure message is diagnosable without dumping the whole dashboard.
func excerptAround(body, marker string) string {
	i := strings.Index(body, marker)
	if i < 0 {
		return "(marker " + marker + " not found in page)"
	}
	start, end := i-400, i+1200
	if start < 0 {
		start = 0
	}
	if end > len(body) {
		end = len(body)
	}
	return body[start:end]
}
