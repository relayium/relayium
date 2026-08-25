package account

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/relayium/relayium/selfupdate"
)

// rolloutPanelView is ONE track's panel: its own target version, status, halt
// reason, progress and node rows, plus the track name its own control forms
// post to.
//
// There are two of these on the dashboard and they are built by two separate,
// independent calls to rolloutPanel — never one shared read, never one shared
// form with a track selector. That is not a style preference: the whole point
// of two tracks is that a halted, wedged or unreadable BYO rollout cannot stop
// the fleet from shipping, and a UI that couples them (one form, one error
// path, one state object) hands that property straight back. If a panel cannot
// be built, Err is set on THAT panel only and the other one renders as usual.
type rolloutPanelView struct {
	// Lang is repeated here rather than read from the page data because
	// {{template "rolloutPanel" .RolloutFleet}} rebinds $ to the ARGUMENT: inside
	// the define, $.Lang means this struct's field, not the page's. Leaving it
	// off makes every render of the panel fail mid-way and truncate the page.
	Lang  string
	Track string // "fleet" | "byo" — goes straight into this panel's form actions
	Title string
	// Err marks a panel whose state could not be read. Its controls are hidden
	// (acting on state we could not read is how an operator makes things
	// worse), which must never affect the other panel.
	Err bool
	// Configured is false when no rollout has ever been started on this track.
	Configured    bool
	TargetVersion string
	Status        string // raw "rolling" | "halted" | "complete"
	StatusText    string // Chinese label for the above
	HaltedReason  string
	Emergency     bool
	// ManualFast is the fleet track running its ladder without the waiting (see
	// RolloutTrack.ManualFast). It is a SEPARATE field from Emergency and
	// renders a separate badge, because the two are opposite claims about what
	// is protecting this release: an emergency has no queue and no failure
	// gating left, a manual fast push has both. One badge with two meanings
	// would tell an operator the wrong thing at the exact moment they are
	// deciding whether to intervene.
	ManualFast bool
	// FastAfterCanary is the fleet track running the SAFE fast mode: the canary
	// keeps its whole six-hour observation window, only the nodes after it skip
	// the soak (see RolloutTrack.FastAfterCanary). A third separate field and a
	// third separate badge, for the same reason ManualFast is not folded into
	// Emergency: the badge answers "what is protecting this release right now",
	// and these three answer it differently. An operator deciding whether to
	// intervene must not have to remember which of two modes a shared badge meant.
	FastAfterCanary bool
	StageStartedAt  int64
	// CurrentNodeID (fleet) is the node in flight; ByoBatch (byo) is the batch
	// percentage currently open. Each is meaningless on the other track, and
	// the template only renders the one that belongs to this panel.
	CurrentNodeID string
	ByoBatch      int
	// FirstNodeID is the canary of this rollout. It is positional and cannot be
	// re-derived from fleet version state later (see RolloutTrack.FirstNodeID),
	// and it is what decides whether the node in flight gets the long
	// observation window or the short one.
	FirstNodeID string
	// PreviousVersion is set on the BYO panel only, and only when a predecessor
	// is actually recorded: it is both the label and the availability of the
	// 回滚到上一版本 control. Empty means the control is not rendered at all —
	// a button whose only possible outcome is a refusal is worse than no button.
	PreviousVersion string
	// RulesText states this track's timing rules on the page, generated from
	// the state machine's constants (see rollout_status.go) so it cannot drift
	// away from them.
	RulesText string
	// NextStepText is set on the BYO panel only: the fleet track's next step is
	// a property of the node in flight and is rendered on that node's row
	// instead. Empty means there is nothing pending to time. NextStepLabel
	// names what that time is the time OF — at the widest batch it is not
	// "下一批", because there is no wider batch. See byoNextStepLabel.
	NextStepText  string
	NextStepLabel string
	OnTarget      int // nodes already running TargetVersion
	Total         int
	// PassedOverCount is how many nodes the rollout moved on without AND that
	// are still not on the target — the machines a finished track left behind.
	//
	// Derived here on every render, never stored on the track row. A stored list
	// would go stale the instant one of those nodes updated, and this way the
	// count heals itself; it also keeps status at three values, which a dozen
	// call sites read as a predicate.
	//
	// Both halves of the condition are load-bearing. Without "not on target" a
	// node passed over earlier that caught up later would still be counted, and
	// the operator would go looking for a machine that is fine. It is counted
	// over the whole track, like OnTarget/Total and unlike Nodes, which is cut
	// to rolloutPanelMaxRows.
	PassedOverCount int
	// Nodes is at most rolloutPanelMaxRows rows, most relevant first; Hidden
	// counts the rest. OnTarget/Total are always over the WHOLE track, never
	// over the rendered slice.
	Nodes  []rolloutNodeView
	Hidden int
}

// rolloutHaltView is one halted track in the dashboard's top-of-page alert:
// which track, what it was shipping, why it stopped, and the anchor of the
// panel that can restart it. It carries no controls of its own — acting on a
// halt is still done in that track's own panel, which is the only place that
// knows the rest of its state.
type rolloutHaltView struct {
	Track   string // "fleet" | "byo"
	Title   string // the panel's Chinese title, so the banner names the same thing
	Version string // the target it halted on
	Reason  string // HaltedReason, shown verbatim — it is the diagnosis
	Anchor  string // fragment of the panel below, e.g. "rollout-byo"
}

// haltedRolloutTracks collects the halted tracks from the panels the dashboard
// has already built, in fleet-then-byo order.
//
// It takes the built panels rather than re-reading the store: the panels are
// the two independent reads, so this cannot introduce a coupling between the
// tracks (nor a third query). It deliberately does NOT skip on p.Err: rolloutPanel
// fills in Configured/Status/TargetVersion/HaltedReason from the track read
// BEFORE it can fail later on the shared node listing, so those fields are
// trustworthy even when Err ends up true for that reason. Gating this on Err
// too would make the top-of-page halt banner — which exists precisely so a
// halt is never missed — disappear because of an unrelated query, which is
// exactly backwards. The case that still needs excluding (the track read
// itself failed) is already handled by !p.Configured: rolloutPanel returns
// with Configured left at its zero value (false) whenever GetRolloutTrack
// itself errored, so a track whose status genuinely was never read never
// reaches "halted" here.
func haltedRolloutTracks(panels ...rolloutPanelView) []rolloutHaltView {
	var out []rolloutHaltView
	for _, p := range panels {
		if !p.Configured || p.Status != "halted" {
			continue
		}
		out = append(out, rolloutHaltView{
			Track: p.Track, Title: p.Title, Version: p.TargetVersion,
			Reason: p.HaltedReason, Anchor: "rollout-" + p.Track,
		})
	}
	return out
}

// rolloutPanelMaxRows caps how many node rows one panel renders. The fleet is
// ~16 machines, but the BYO track is one row per user machine and grows without
// limit — an uncapped table turns the admin home page into an unbounded
// document. The cap is on RENDERING only: every count on the panel, and every
// rollout decision, is still computed over the full population.
const rolloutPanelMaxRows = 50

// rolloutNodeView is one machine's row inside a panel: enough to diagnose a
// halt without opening the database — what it runs, what it was told to
// install, and what it reported back.
type rolloutNodeView struct {
	ID                string
	Label             string
	Version           string
	Online            bool
	OnTarget          bool
	UpdateFromVersion string
	UpdateStartedAt   int64
	Result            string // raw update_result
	ResultText        string // Chinese label
	Current           bool   // fleet: this node holds the rollout slot
	InBatch           bool   // byo: this node is in the batch currently open
	// Status describes what this node is doing, for the node holding the fleet
	// rollout slot. Zero for every other row. See rollout_status.go: it
	// DESCRIBES decideFleet's state and never re-decides it.
	Status rolloutNodeStatus
	// PassedOver is true when the queue moved on without this node — it could
	// not obtain the artifact, or it declined locally. Distinct from a failure:
	// a passed-over node made no judgement about the build, so this must never
	// be rendered in the failure styling.
	//
	// Unlike Status it is set on EVERY row, not just the node holding the slot,
	// and on tracks that are no longer rolling. That is the point: the case this
	// exists for is a finished track, where nothing holds the slot any more and
	// fleetNodeStatus is silent by design.
	PassedOver bool
	// PassedOverReason is the Chinese label for WHY, because the operator's next
	// move differs: 拿不到产物 means fix the source and retry, 本地前置条件
	// usually means the node had its own reason and will decline again.
	PassedOverReason string
}

// rolloutStatusText maps the stored status onto the panel's label. An empty
// status (a row that exists but was never started) reads as 未启动 rather than
// rendering blank.
func rolloutStatusText(status string, configured bool) string {
	if !configured {
		return "未启动"
	}
	switch status {
	case "rolling":
		return "发布中"
	case "halted":
		return "已中止"
	case "complete":
		return "已完成"
	default:
		return "未启动"
	}
}

// rolloutResultText maps nodes.update_result onto its label. "" is the normal
// state for a node that was never commanded, so it must not read as an error.
//
// "unreachable" needs its own label rather than falling through to "—": that is
// what a node the rollout has not reached yet renders as, and reading the two as
// the same thing is precisely how a fleet-wide fetch failure passes for a
// rollout that simply has not got there.
func rolloutResultText(result string) string {
	switch result {
	case "ok":
		return "成功"
	case "failed":
		return "更新失败"
	case "rolled_back":
		return "已回滚"
	case "skipped":
		return "已跳过"
	case "unreachable":
		return "拿不到产物"
	default:
		return "—"
	}
}

// passedOverReason explains a pass-over in terms of what the operator does next,
// which is the only reason the panel distinguishes the two values at all: a node
// that could not fetch is waiting on something we can fix, and a node that
// declined locally will decline again until someone opens it up. Empty for every
// result that is not a pass-over, so it doubles as the render condition.
func passedOverReason(result string) string {
	switch result {
	case "unreachable":
		return "拿不到产物：没能取到这个版本的文件，修好来源后可以重试"
	case "skipped":
		return "本地前置条件未满足：该节点自己拒绝了这次更新，重试前需要先处理这台机器"
	}
	return ""
}

// validRolloutTrack mirrors SetTargetVersion's own track check for the paths
// that never reach it (pause/resume act on the store directly). Without it an
// unknown track name would silently no-op an UPDATE and report success.
func validRolloutTrack(track string) bool { return track == "fleet" || track == "byo" }

// rolloutAuditTarget renders a track name as the audit/confirmation-page
// target. "-" (the package's "no scoped target" marker) only for the
// impossible empty case, so the emergency confirmation page always has a
// target to show.
func rolloutAuditTarget(track string) string {
	if track == "" {
		return "-"
	}
	return "rollout:" + track
}

// rolloutTrackLabel spells out, in the operator's language, WHOSE machines a
// track owns. The bare track name is too easy to skim past on a confirmation
// page whose whole job is to stop a misclick, and the difference between the
// two tracks is the difference between our own machines and every user's.
func rolloutTrackLabel(track string) string {
	switch track {
	case "fleet":
		return "机队轨：我们自己运营的全部节点"
	case "byo":
		return "自带节点轨：所有用户自己运行的节点，全部一次性放行"
	}
	return track
}

// confirmBlastFor resolves the confirmation page's blast banner for an action:
// which track it hits, and which of the two banners to render ("emergency" or
// "fast"). The prose itself lives in adminConfirmTmpl — see
// confirmPageData.TrackNotice for why.
//
// Both values come from ONE function so they cannot diverge. Resolved
// separately, an action added to one switch and forgotten in the other would
// render a page with a track and the WRONG banner — telling an operator they
// were about to release the whole track at once, or the opposite. A missing
// banner is a visible gap; a wrong one is a lie, and this is the page whose
// entire job is not lying.
//
// Emergency reads its track from the path wildcard (registered on {id}, aimable
// at either track); both fast pushes are fleet-only by route, so their track is
// a constant rather than anything read from the request. ("", "") means no
// banner: correct for every action whose blast radius is a form field.
//
// The two fast modes get two notices, not one parameterised notice, for the same
// reason emergency and fast do: they differ in whether the canary's six hours
// are kept, which is the ONLY thing an operator on this page has to decide
// between them, so a shared sentence would be one edit away from describing the
// window while performing the mode that skips it.
func confirmBlastFor(action, pathID string) (track, notice string) {
	switch action {
	case AuditRolloutEmergency:
		return pathID, "emergency"
	case AuditRolloutFast:
		return "fleet", "fast"
	case AuditRolloutFastCanary:
		return "fleet", "fast-canary"
	}
	return "", ""
}

// rolloutOwnerClass maps a track to the nodes.owner_type it governs. The owner
// type IS the track (see handleUpdateCheck): our machines roll on "fleet",
// users' machines on "byo", and neither is ever read across.
func rolloutOwnerClass(track string) string {
	if track == "byo" {
		return "user"
	}
	return "fleet"
}

// rolloutPanel builds one track's panel. It reads THAT track's row and nothing
// else — in particular it never touches the other track's row, so a halted,
// wedged or unreadable BYO track cannot affect the fleet panel or its controls.
// A track read failure degrades to Err on this panel alone.
//
// allNodes is the node listing the dashboard has ALREADY loaded (ListNodes),
// filtered here to this track's ownership class. It is passed in rather than
// re-queried per panel: the panels used to issue two extra full-table scans on
// every admin home render for rows the caller was holding all along. Filtering
// in Go is exact — rolloutOwnerClass is the same owner_type the endpoint keys
// on — and the batch ordering is unaffected because byoOrder re-sorts its input
// deterministically by (fleetHash, ID). nodesErr means that shared listing
// failed; both panels then hide their controls, which is a whole-database
// failure, not one track leaking into the other. Note that the track-derived
// fields (Configured, Status, TargetVersion, HaltedReason, ...) are set BEFORE
// the nodesErr check below, not after: haltedRolloutTracks reads them off this
// panel regardless of Err, so a halt must already be recorded by the time
// nodesErr can bail out.
func (s *Service) rolloutPanel(ctx context.Context, track, title string, now time.Time, allNodes []Node, nodesErr bool) rolloutPanelView {
	p := rolloutPanelView{Track: track, Title: title}
	tr, found, err := s.Store().GetRolloutTrack(ctx, track)
	if err != nil {
		log.Printf("admin: GetRolloutTrack(%s) failed: %v", track, err)
		p.Err = true
		return p
	}
	// Filled in from the track read BEFORE the node-listing bail-out below, so
	// that a real halt is still visible — and still surfaces the top-of-page
	// banner via haltedRolloutTracks — even when the shared ListNodes call is
	// what failed. The track read succeeded; losing the one thing the banner
	// exists to never miss because an unrelated query failed would be exactly
	// backwards.
	p.Configured = found
	p.TargetVersion, p.Status = tr.TargetVersion, tr.Status
	p.StatusText = rolloutStatusText(tr.Status, found)
	if track == "fleet" {
		p.RulesText = fleetRulesText(tr)
	} else {
		p.RulesText = byoRulesText()
		// !tr.Emergency is part of the precondition, not a nicety: nodes.go:470
		// short-circuits BOTH state machines on an emergency, before the
		// per-track dispatch, so during one there is no batch ladder running at
		// all. Timing "the next batch" there would describe a ladder that is not
		// there — and the panel two lines above already says 已跳过分批.
		if found && tr.Status == "rolling" && !tr.Emergency {
			// tr.ByoBatch decides whether there is a window at all — a fresh
			// track opens its first batch immediately. See byoNextStepText.
			p.NextStepText = byoNextStepText(tr.ByoBatch, tr.StageStartedAt, now.Unix())
			p.NextStepLabel = byoNextStepLabel(tr.ByoBatch)
		}
	}
	p.HaltedReason, p.Emergency, p.ManualFast = tr.HaltedReason, tr.Emergency, tr.ManualFast
	p.FastAfterCanary = tr.FastAfterCanary
	p.StageStartedAt, p.CurrentNodeID, p.ByoBatch = tr.StageStartedAt, tr.CurrentNodeID, tr.ByoBatch
	p.FirstNodeID = tr.FirstNodeID
	if track == "byo" {
		p.PreviousVersion = tr.PreviousVersion
	}
	if nodesErr {
		p.Err = true
		return p
	}
	ownerClass := rolloutOwnerClass(track)
	var nodes []Node
	for _, n := range allNodes {
		if n.OwnerType == ownerClass {
			nodes = append(nodes, n)
		}
	}

	snaps := nodeSnapshots(nodes)
	// Batch membership is derived, not stored per node; byoOpenBatchMembers is
	// the same ordering/prefix decideByo uses, so the panel cannot disagree
	// with what the endpoint will actually allow.
	inBatch := map[string]bool{}
	if track == "byo" && found {
		inBatch = byoOpenBatchMembers(tr, snaps)
	}
	cutoff := now.Add(-nodeOnlineWindow).Unix()
	p.Total = len(nodes)
	rows := make([]rolloutNodeView, 0, len(nodes))
	for i, n := range nodes {
		onTarget := tr.TargetVersion != "" && selfupdate.SameVersion(n.Version, tr.TargetVersion)
		if onTarget {
			p.OnTarget++
		}
		// Current stays derived from CurrentNodeID alone, and deliberately so:
		// it ranks this row to the top of the table (see rolloutNodeRows), and
		// on a HALTED track the node that was in flight is still the one an
		// operator opens this panel to find. What must not survive a halt is the
		// timing — and that is fleetNodeStatus's own first check, not this one.
		current := track == "fleet" && n.ID == tr.CurrentNodeID && tr.CurrentNodeID != ""
		var status rolloutNodeStatus
		if current {
			// snaps is nodeSnapshots(nodes), which is 1:1 and in order, so
			// snaps[i] is this row's node as the state machine sees it. Built
			// through newFleetNodeInput so the panel and the test that pins it
			// to decideFleet cannot assemble the input two different ways.
			status = fleetNodeStatus(newFleetNodeInput(tr, snaps[i], onTarget), now.Unix())
		}
		// passedOverResult is decideFleet's own predicate (rollout_fleet.go), so
		// the row is marked passed over exactly when the queue would skip it —
		// the panel cannot claim a pass-over the state machine does not make, or
		// miss one it does.
		passedOver := passedOverResult(n.UpdateResult)
		if passedOver && !onTarget {
			p.PassedOverCount++
		}
		rows = append(rows, rolloutNodeView{
			ID: n.ID, Label: n.Label, Version: n.Version,
			Online: n.LastSeenAt >= cutoff, OnTarget: onTarget,
			UpdateFromVersion: n.UpdateFromVersion, UpdateStartedAt: n.UpdateStartedAt,
			Result: n.UpdateResult, ResultText: rolloutResultText(n.UpdateResult),
			Current:          current,
			Status:           status,
			InBatch:          inBatch[n.ID],
			PassedOver:       passedOver,
			PassedOverReason: passedOverReason(n.UpdateResult),
		})
	}
	// The terminal state Task 2 made reachable and nothing else reports: the
	// queue ran to the end having installed nothing on some machines. status
	// deliberately gains no fourth value for it — 已完成 is true, it is just not
	// the whole truth, so the count is rendered INTO the same line rather than
	// stored beside it.
	//
	// Only on a finished track. A rolling one may still reach those nodes, and
	// saying "left behind" while the queue is still moving would be false.
	if p.Status == "complete" && p.PassedOverCount > 0 {
		p.StatusText = fmt.Sprintf("完成，但 %d 台未更新", p.PassedOverCount)
	}
	p.Nodes, p.Hidden = rolloutNodeRows(rows)
	return p
}

// rolloutNodeRows orders a panel's rows most-relevant-first and cuts them to
// rolloutPanelMaxRows, returning the visible slice and how many were dropped.
//
// "Relevant" is what an operator opens this panel to find, in order: nodes that
// reported a FAILURE (the reason a track halts), then the node in flight or in
// the open batch, then everything still behind the target, then the machines
// already done. Truncating an unordered list would hide exactly the failures
// the panel exists to surface, so the ordering is part of the cap, not a
// nicety. Ties keep the caller's order (sort.SliceStable) so the list does not
// reshuffle between refreshes.
func rolloutNodeRows(rows []rolloutNodeView) ([]rolloutNodeView, int) {
	rank := func(v rolloutNodeView) int {
		switch {
		case v.Result == "failed" || v.Result == "rolled_back":
			return 0
		case v.Current || v.InBatch:
			return 1
		case !v.OnTarget:
			return 2
		default:
			return 3
		}
	}
	out := append([]rolloutNodeView(nil), rows...)
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	if len(out) > rolloutPanelMaxRows {
		return out[:rolloutPanelMaxRows], len(out) - rolloutPanelMaxRows
	}
	return out, 0
}

// renderAdminRolloutError re-renders the dashboard with msg in a banner and the
// given status, so a rejected control (a bad version, the byo-behind-fleet
// gate, pausing a track that is not rolling) reaches the operator as readable
// text on the page they were just looking at — instead of a bare 500 or, worse,
// a redirect that looks exactly like success.
func (s *Service) renderAdminRolloutError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	data, err := s.buildAdminHomeData(r, adminSectionFleet)
	if err != nil {
		// The dashboard itself is unbuildable; the operator still has to be
		// told why their action was refused.
		http.Error(w, msg, status)
		return
	}
	data.RolloutError = msg
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := adminUsersTmpl.Execute(w, data); err != nil {
		log.Printf("admin: rendering rollout error page failed: %v", err)
	}
}

// handleAdminRolloutTarget points a track at a new version, starting a staged
// rollout. handleAdminRolloutRollback is the same operation aimed backwards; it
// is a separate route/action purely so the audit trail (and the UI) can tell
// "shipping v1.3.0" from "getting off v1.3.0", which is the fact an incident
// review actually needs.
func (s *Service) handleAdminRolloutTarget(w http.ResponseWriter, r *http.Request) {
	s.rolloutSetVersion(w, r, AuditRolloutTarget)
}

func (s *Service) handleAdminRolloutRollback(w http.ResponseWriter, r *http.Request) {
	s.rolloutSetVersion(w, r, AuditRolloutRollback)
}

// rolloutSetVersion routes both through SetTargetVersion, which is the ONLY
// way a target changes: it owns the track-name and version validation and the
// one-way byo-behind-fleet gate. This handler never re-implements or bypasses
// any of that — it only turns the error into something an admin can read.
//
// Note what is NOT here: any read of the OTHER track. For track == "fleet"
// SetTargetVersion consults nothing but the fleet row, so a byo track that is
// halted, wedged, or pointed at a broken build cannot make this fail.
func (s *Service) rolloutSetVersion(w http.ResponseWriter, r *http.Request, action string) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	version := strings.TrimSpace(r.FormValue("version"))
	// Best-effort before-image for the audit diff; an unknown track simply has
	// none, and SetTargetVersion rejects it a line later anyway.
	before, _, _ := s.Store().GetRolloutTrack(r.Context(), track)
	if err := s.SetTargetVersion(r.Context(), track, version); err != nil {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "目标版本设置失败："+err.Error())
		return
	}
	s.WriteAudit(r, action, "rollout:"+track, []ChangeField{
		{Field: "target_version", Old: before.TargetVersion, New: version},
		{Field: "status", Old: before.Status, New: "rolling"},
	}, StepUpNone)
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// handleAdminReleaseRollout points the fleet track at the release the
// notice named, going through SetTargetVersion — the same call the typed
// fleet-target form uses — so there is exactly one way a target is ever set.
//
// It has TWO guards, and both exist for the same reason: a stale page, or a
// direct POST, must not be able to do what the UI declines to offer.
//
//  1. WHETHER. Re-read the fleet track and the check row, and refuse unless
//     releaseNotice(...).OfferButton — the EXACT predicate the template renders
//     the button on. It is expressed as a call, not as a restatement, and that
//     shape is the fix rather than an incidental tidy: every previous version of
//     this guard restated one axis of the UI's rule in its own words and drifted
//     from the rest. A hand-written `status != "rolling"` waved through a paused
//     rollout (halted, but with the canary still in current_node_id, which
//     HaltRolloutTrack leaves set on purpose). A hand-written
//     `version == LatestTag` waved through a fleet target that was AHEAD of
//     the newest release the check found — routine while a tag is a pre-release
//     rolled to the fleet first (release discovery skips pre-releases), or
//     after a bad release is unpublished — where the panel
//     correctly renders nothing and a stale page posted successfully anyway.
//     Delegating collapses button and handler onto one predicate, so a future
//     condition added to releaseNotice reaches this handler for free and the two
//     cannot fall out of step again.
//
//     What that predicate is protecting: SetTargetVersion rewrites the WHOLE
//     fleet row — resetting Status to rolling, restamping StageStartedAt,
//     clearing CurrentNodeID/FirstNodeID — so pressing the button on a rollout
//     in flight, live or paused, silently abandons it.
//
//  2. WHICH. Re-read GetReleaseCheck and refuse unless the posted version equals
//     the stored LatestTag. OfferButton says whether ANY release may be shipped
//     from here; it says nothing about the string this request carried. Without
//     this the handler trusts a client-supplied version: an admin leaves /admin
//     open showing v1.3.0, the fleet completes a rollout to v1.5.0, and the
//     stale button posts v1.3.0 — which passes guard 1 (a newer release does
//     exist and nothing is in flight) and repoints the fleet BACKWARDS. That is
//     not inert: nodes.go:445 sets AllowDowngrade automatically for a
//     downgrade, so nodes actually install the older build.
//
// Audited as its own action, AuditReleaseRollout, rather than reused
// AuditRolloutTarget. That is deliberate, not an oversight: the house rule
// here is the OPPOSITE of "identical writes share an action" —
// handleAdminRolloutTarget and handleAdminRolloutRollback (above) funnel
// into this exact same SetTargetVersion write and are deliberately given
// DIFFERENT actions, precisely so the audit trail (and the UI) can tell
// "shipping v1.3.0" from "getting off v1.3.0" — the fact an incident review
// actually needs. Entry point is exactly what an incident review wants to
// know here too: "the operator typed a version in" and "the operator clicked
// the button the release notice offered" are different facts about how a
// rollout started, even though the row ends up in the same shape.
func (s *Service) handleAdminReleaseRollout(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	version := strings.TrimSpace(r.FormValue("version"))
	before, found, err := s.Store().GetRolloutTrack(r.Context(), "fleet")
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "发布失败："+err.Error())
		return
	}
	rc, rcErr := s.Store().GetReleaseCheck(r.Context())
	if rcErr != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "发布失败："+rcErr.Error())
		return
	}
	if v := releaseNotice(rc, before, found); !v.OfferButton {
		// The button the page posted from is not one this server would render
		// right now. One message covers every reason, because the point of
		// asking releaseNotice is that this handler does not maintain its own
		// list of them.
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			"发布失败：当前没有可一键发布的新版本，请刷新页面后重试。"+
				"若机队轨上有未结束的发布（正在发布或已暂停），请到下方机队面板手动处理。")
		return
	}
	if rc.LatestTag == "" || version != rc.LatestTag {
		// A stale page (or a direct POST) naming a version other than what
		// the server currently reports as newest. Refusing here is what
		// keeps the button's only possible effect "set the target to the
		// version this page is actually offering" — never an arbitrary
		// client-supplied string.
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			"发布失败：提交的版本与服务器当前检测到的最新版本不一致，请刷新页面后重试")
		return
	}
	if err := s.SetTargetVersion(r.Context(), "fleet", version); err != nil {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "目标版本设置失败："+err.Error())
		return
	}
	s.WriteAudit(r, AuditReleaseRollout, "rollout:fleet", []ChangeField{
		{Field: "target_version", Old: before.TargetVersion, New: version},
		{Field: "status", Old: before.Status, New: "rolling"},
	}, StepUpNone)
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// handleAdminReleaseDismiss records (or, with an empty version, clears) the
// release the operator does not want to be prompted about again. It never
// touches a rollout track — dismissing changes nothing about what is
// running, only what the notice says.
func (s *Service) handleAdminReleaseDismiss(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	version := strings.TrimSpace(r.FormValue("version"))
	before, err := s.Store().GetReleaseCheck(r.Context())
	if err != nil {
		log.Printf("admin: GetReleaseCheck (release dismiss before-image) failed: %v", err)
	}
	if err := s.Store().SetReleaseCheckDismissed(r.Context(), version, s.Now().Unix()); err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "忽略发布通知失败："+err.Error())
		return
	}
	s.WriteAudit(r, AuditReleaseDismiss, "release:notice", []ChangeField{
		{Field: "dismissed_tag", Old: before.DismissedTag, New: version},
	}, StepUpNone)
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// handleAdminRolloutByoRollbackPrevious rolls the BYO track back onto the
// version it held immediately before the current one. It is registered on a
// path with "byo" spelled out, not on the {id} wildcard, because it is
// BYO-only: it is the escape hatch from the byo-behind-fleet gate and the fleet
// track is not behind that gate in the first place.
//
// It reads no version from the request — the destination comes from the stored
// previous_version and nothing else, so this cannot be turned into a general
// "set any target, skip the gate" control. See
// Service.RollbackByoToPreviousVersion for why the bypass is sound.
//
// The audit's before-image comes from the SAME read the mutation itself used
// (RollbackByoToPreviousVersion's return value), not a separate GetRolloutTrack
// call made from this handler: a second, separately-timed read can race a
// concurrent retarget or simply fail, leaving the audit entry for the one
// action that bypasses the gate — exactly what an incident review most needs
// to trust — wrong or empty. And a genuine store failure is distinguished from
// a refusal: only the two documented refusal sentinels render as 400 with
// their message; anything else is a store problem, not the operator's
// mistake, so it is a 500 with a generic message and the real error only in
// the log.
func (s *Service) handleAdminRolloutByoRollbackPrevious(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	before, version, err := s.RollbackByoToPreviousVersion(r.Context())
	if err != nil {
		switch {
		case errors.Is(err, ErrNoPreviousByoVersion):
			s.renderAdminRolloutError(w, r, http.StatusBadRequest,
				"回滚到上一版本失败：自带节点轨没有记录上一个目标版本（当前目标是它的第一个版本）")
		case errors.Is(err, ErrCorruptPreviousByoVersion):
			s.renderAdminRolloutError(w, r, http.StatusBadRequest, "回滚到上一版本失败："+err.Error())
		default:
			log.Printf("admin: RollbackByoToPreviousVersion failed: %v", err)
			s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "回滚到上一版本失败：内部错误，请稍后重试")
		}
		return
	}
	// Audited as a rollback, the same action the version-box rollback writes:
	// what an incident review needs is "byo was taken off X onto Y", and the
	// diff below says exactly that.
	s.WriteAudit(r, AuditRolloutRollback, "rollout:byo", []ChangeField{
		{Field: "target_version", Old: before.TargetVersion, New: version},
		{Field: "status", Old: before.Status, New: "rolling"},
	}, StepUpNone)
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// handleAdminRolloutPause stops a track where it is. It is the kill switch for
// a release that is going wrong — including an emergency one — because every
// decision path in the package treats a track that is not 'rolling' as inert.
func (s *Service) handleAdminRolloutPause(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	if !validRolloutTrack(track) {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "暂停失败：未知轨道 "+track)
		return
	}
	// HaltRolloutTrack is conditional on the track still being 'rolling', so a
	// track another instance just completed is not resurrected as halted.
	ok, err := s.Store().HaltRolloutTrack(r.Context(), track, "管理员手动暂停", s.Now().Unix())
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "暂停失败："+err.Error())
		return
	}
	if !ok {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "暂停失败：该轨道当前不在发布中")
		return
	}
	// Same greppable marker the state machines' halts use (see haltRollout), so
	// a monitor watching for stopped rollouts sees every way a track can stop,
	// not just the automatic ones. The target version is not read back here --
	// this path holds no track row -- and is not worth a second query.
	log.Printf("%s track=%s target=? reason=%q", rolloutHaltLogPrefix, track, "管理员手动暂停")
	s.WriteAudit(r, AuditRolloutPause, "rollout:"+track,
		[]ChangeField{{Field: "status", Old: "rolling", New: "halted"}}, StepUpNone)
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// handleAdminRolloutResume restarts a halted track on the version it already
// targets. It goes through ResumeRolloutTrack rather than SetTargetVersion
// precisely so it cannot be blocked by the other track: see that method's doc
// comment for why resuming byo through the gate would make an unrelated fleet
// release silently un-resumable.
//
// 继续 restarts the ladder FROM THE BEGINNING — that is what the control says and
// what ResumeRolloutTrack's field resets implement — so it must also clear the
// results that mark a node as already passed over. The case is concrete: the
// fleet rolls to v2, n1 reports "unreachable" off a broken mirror, n2 reports
// "failed", the track halts. The operator fixes the mirror and presses 继续.
// Without the clear, n1 stays excluded for the whole resumed rollout and the
// track completes with n1 still on v1 — and 继续 cannot fix it, because the only
// other thing that clears those results is retyping the target. That is a
// rollout silently finishing over a machine it never updated.
//
// The asymmetry with "failed"/"rolled_back" is the point, not an omission: the
// clear erases only "skipped" and "unreachable". A failure is the judgement that
// STOPPED the track, and resuming is a decision to carry on past it, never a
// licence to forget it — decideByo's failure rate and emergencyRefusesNode both
// still read those rows.
//
// The clear is NOT a separate call here. It happens inside ResumeRolloutTrack's
// transaction, conditional on the status compare-and-swap having matched, and it
// has to: a 继续 this handler goes on to REFUSE with 400 must leave the track
// exactly as it found it. The reachable case is a track that has completed —
// every node passed over is now an ordinary outcome — with a stale panel still
// offering the control. Clearing there would erase the markers the panel's
// finished-but-incomplete count and the per-node retry guard are both derived
// from, destroying the report and the repair affordance for precisely the nodes
// that need them, while telling the operator nothing happened.
func (s *Service) handleAdminRolloutResume(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	if !validRolloutTrack(track) {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "继续失败：未知轨道 "+track)
		return
	}
	ok, err := s.Store().ResumeRolloutTrack(r.Context(), track, s.Now().Unix())
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "继续失败："+err.Error())
		return
	}
	if !ok {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "继续失败：该轨道当前不是已中止状态")
		return
	}
	s.WriteAudit(r, AuditRolloutResume, "rollout:"+track,
		[]ChangeField{{Field: "status", Old: "halted", New: "rolling"}}, StepUpNone)
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// handleAdminRolloutRetry re-offers a finished rollout's target to ONE machine
// the queue moved on without. It is the affordance that makes 完成，但 N 台未更新
// actionable without an SSH session: clearing that node's result makes it a
// candidate again, and the track goes back to rolling on the same target.
//
// Two guards, and they are independent — neither is expressible as the other.
//
// The ROW guard: only "skipped" or "unreachable". A node that reported failed or
// rolled_back JUDGED the build, and a one-click re-run of it is a shortest path
// around a verification failure. That decision stays with the whole-track 继续,
// which shows the halt reason and asks for confirmation.
//
// The TRACK guard: only a complete track. On a halted one, retrying an innocent
// passed-over row would restart a rollout that stopped for a reason nobody has
// addressed — reaching the same place sideways, and the row it was aimed at is
// not even the row that stopped it.
//
// The button's absence is not the guard. Both conditions are re-read here, and
// the track condition is additionally a compare-and-swap inside
// RetryRolloutNode, because the panel the operator clicked may be seconds stale
// and a halt must never be lost to a retry racing it.
func (s *Service) handleAdminRolloutRetry(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	if !validRolloutTrack(track) {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "重试失败：未知轨道 "+track)
		return
	}
	// FLEET ONLY, and this is a correctness guard rather than a scope decision.
	// "Passed over" is a concept only decideFleet has: decideByo's candidate set
	// is (online && !onTarget) with no reference to update_result at all, so it
	// never moves on without a node — it keeps re-offering, one sweep per batch
	// window. A byo track can therefore only reach 'complete' with an off-target
	// node if that node is OFFLINE, and clearing its result would re-admit
	// nothing: the track would go rolling, find nobody reachable, and complete
	// again, while the operator was told the retry succeeded.
	//
	// The route stays on the {id} wildcard so a stale or bookmarked byo POST gets
	// this explanation instead of a bare 404, and so the refusal is testable.
	if track != "fleet" {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			"重试失败：单台重试只适用于机队轨。自带节点轨是按批次放行的，"+
				"没有「被越过」这个状态——落后的节点会在下一轮自动重新收到更新。")
		return
	}
	nodeID := r.FormValue("node")
	if nodeID == "" {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "重试失败：未指定节点")
		return
	}
	n, found, err := s.Store().GetNode(r.Context(), nodeID)
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "重试失败："+err.Error())
		return
	}
	if !found {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "重试失败：找不到节点 "+nodeID)
		return
	}
	// The node's ownership class must match the track whose route this is. The
	// node id arrives in a form field, and the two rollouts are independent: a
	// fleet retry that could clear a user node's result would be one track
	// editing the other's rollout state.
	if n.OwnerType != rolloutOwnerClass(track) {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			"重试失败：节点 "+nodeID+" 不属于该轨道")
		return
	}
	if !passedOverResult(n.UpdateResult) {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			"重试失败：只有被越过的节点（拿不到产物 / 已跳过）可以单台重试。"+
				"该节点当前的结果是「"+rolloutResultText(n.UpdateResult)+"」——"+
				"报告了失败或回滚的节点是对这个版本的判断，请用整条轨道的「继续」处理。")
		return
	}
	tr, foundTrack, err := s.Store().GetRolloutTrack(r.Context(), track)
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "重试失败："+err.Error())
		return
	}
	if !foundTrack || tr.Status != "complete" {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			"重试失败：只有已完成的轨道可以单台重试，该轨道当前是「"+
				rolloutStatusText(tr.Status, foundTrack)+"」。")
		return
	}
	ok, err := s.Store().RetryRolloutNode(r.Context(), track, nodeID, s.Now().Unix())
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "重试失败："+err.Error())
		return
	}
	if !ok {
		// The compare-and-swap refused. Either half can be the reason — the track
		// left 'complete', or this node stopped being passed over (it reported a
		// result, or was removed) — between the reads above and the write. Both
		// mean the same thing to the operator: what they were looking at is no
		// longer true, and nothing was written.
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			"重试失败：该轨道或该节点的状态刚刚发生了变化，本次操作没有改动任何东西，请刷新后重新确认")
		return
	}
	s.WriteAudit(r, AuditRolloutRetry, "rollout:"+track,
		[]ChangeField{
			{Field: "node", Old: nodeID + " " + n.UpdateResult, New: nodeID + " 重试"},
			{Field: "status", Old: "complete", New: "rolling"},
		}, StepUpNone)
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// handleAdminRolloutFast starts a MANUAL FAST fleet rollout: the ordinary
// staged ladder, minus its waiting. One node at a time, every node's own
// install/restart/health check/rollback intact, a halt on the first bad result
// — and no 6h canary observation, no 30min soak between machines. It is the
// answer to "this fix has to be on the fleet today", without being the answer
// to "release it to everyone at once", which is what 紧急发布 already is and
// what this must never quietly become.
//
// Registered on a path with "fleet" spelled out rather than on the {id}
// wildcard. That is invariant 1 expressed structurally: the BYO track is every
// user's machine, and the safest way to say "never mass-push hardware we do not
// own" is for there to be no route that could. A byo POST 404s, and
// Service.StartManualFastFleetRollout takes no track parameter either.
//
// It sits behind RequireStepUp, so by the time this runs the operator has seen a
// confirmation page naming the fleet track, the version, and — the part that
// distinguishes this page from the emergency one — what is still guaranteed.
// HandleAdminConfirm writes the audit entry (rollout.fast) once this returns a
// non-error status, so this handler must NOT write its own: that would double-log
// it, and log it without the step-up factor.
//
// THREE GUARDS, and none of them is "the button was not rendered":
//
//  1. WHICH version — validated as a plain release tag by the service call, the
//     same chokepoint the staged target box uses.
//  2. WHAT STATE — the fleet track must be neither rolling (starting here would
//     abandon a rollout in flight, discarding up to six hours of canary
//     observation on one click) nor halted (restarting a paused rollout is
//     继续's job, which returns it to the STAGED ladder on purpose).
//  3. WHAT THE OPERATOR SAW — from_status/from_version carry the panel's state
//     at render time. Without them a page showing "已完成 v1.0.0" could, minutes
//     later, ship over a rollout that had since started and passed its canary.
//
// Guards 2 and 3 are re-read here AND expressed in the store's compare-and-swap.
// That is not belt-and-braces: the read below and the write are separate
// statements against a multi-instance deployment, so only the SQL can stop a
// rollout that starts in between; these branches exist to turn the refusal into
// a message that says which condition failed.
//
// The body is rolloutStartFast below, shared with the safe fast push
// (handleAdminRolloutFastCanary) so the two cannot come to accept different
// states. Everything documented above is implemented there.
func (s *Service) handleAdminRolloutFast(w http.ResponseWriter, r *http.Request) {
	s.rolloutStartFast(w, r, fastPushManual, s.StartManualFastFleetRollout)
}

// handleAdminRolloutFastCanary starts the SAFE fast fleet rollout: the same
// action as above in every respect except the one that matters most — the canary
// keeps its ENTIRE six-hour observation window and must report success while
// actually running the target, and only the machines after it skip the 30-minute
// soak (see RolloutTrack.FastAfterCanary).
//
// It exists because the manual fast push cannot legitimately be a version's
// FIRST fleet exposure: that mode hands the slot on as soon as the node in
// flight reports success, so a build that only fails after hours of real traffic
// reaches the whole fleet before anything notices. Its own runbook says so, and
// before this control the only way to obey that rule with no separate staging
// fleet was to not use the fast path at all — or to take a production node
// offline to manufacture a "previously validated" target, which is a workaround,
// not a safety property.
//
// Everything else is handleAdminRolloutFast's, literally: the three guards, the
// startable-state set, the stale-confirmation comparison and the store's
// compare-and-swap all come from the shared rolloutStartFast below, so the two
// controls cannot drift into accepting different states. Only the operator-facing
// wording and which service call is made differ.
func (s *Service) handleAdminRolloutFastCanary(w http.ResponseWriter, r *http.Request) {
	s.rolloutStartFast(w, r, fastPushCanary, s.StartCanaryFastFleetRollout)
}

// fastPushLabels is the per-mode operator-facing wording for the shared handler:
// what to call this action in a refusal, and the staleness message that belongs
// to it. Two message constants rather than one built by concatenation, because
// each is a complete sentence an operator reads under time pressure and both are
// pinned by tests as whole strings.
type fastPushLabels struct {
	name  string // 手动快速发布 / 安全快速发布
	stale string
}

var (
	fastPushManual = fastPushLabels{name: "手动快速发布", stale: staleFastRolloutMessage}
	fastPushCanary = fastPushLabels{name: "安全快速发布", stale: staleCanaryFastRolloutMessage}
)

// rolloutStartFast is the shared implementation of both fast pushes. See
// handleAdminRolloutFast above for what each guard is protecting; start is the
// service call that arms the mode, and it is the ONLY thing that differs between
// the two beyond wording.
//
// Sharing it is not a tidy-up. The three guards here are the difference between
// "start a fresh rollout" and "silently abandon one in flight", and a second
// hand-written copy of them for the safe mode would be a second place for that
// distinction to rot — this package's own history is a series of predicates that
// were copied and then drifted.
func (s *Service) rolloutStartFast(w http.ResponseWriter, r *http.Request, lbl fastPushLabels,
	start func(ctx context.Context, expectStatus, expectTargetVersion, version string) error) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	version := strings.TrimSpace(r.FormValue("version"))
	fromStatus := strings.TrimSpace(r.FormValue("from_status"))
	fromVersion := strings.TrimSpace(r.FormValue("from_version"))

	before, found, err := s.Store().GetRolloutTrack(r.Context(), "fleet")
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, lbl.name+"失败："+err.Error())
		return
	}
	// Guard 2, as a message. The store refuses anything but these two states too
	// (that is the race-safe half); this branch exists so the operator is told
	// WHICH state stopped them rather than getting the staleness message.
	//
	// The condition is "not complete" rather than "rolling or halted", so it
	// matches StartManualFastRollout's accepted set exactly. Enumerating the two
	// bad statuses instead would let any third value (a row whose status column
	// is still at its schema default) pass this guard, fail the store's, and be
	// reported as a stale page — a control that refuses forever while telling the
	// operator to refresh.
	if found && before.Status != "complete" {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest,
			lbl.name+"失败：机队轨当前是「"+rolloutStatusText(before.Status, found)+"」。"+
				lbl.name+"只能在机队轨已经结束（「已完成」）或从未启动过时开始——"+
				"请先在下方机队面板里处理这一轮：正在发布中就等它跑完或先「暂停」，"+
				"已暂停就用「继续」（会回到常规分批节奏）。")
		return
	}
	// Guard 3, as a message. The same comparison is the store's compare-and-swap
	// a moment later; this one only turns "the page you clicked from is stale"
	// into words while the values are still to hand.
	curStatus, curVersion := "", ""
	if found {
		curStatus, curVersion = before.Status, before.TargetVersion
	}
	if fromStatus != curStatus || fromVersion != curVersion {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, lbl.stale)
		return
	}

	if err := start(r.Context(), curStatus, curVersion, version); err != nil {
		if errors.Is(err, ErrFastRolloutStateChanged) {
			// The compare-and-swap refused: the track moved between the read
			// above and the write. Nothing was written.
			s.renderAdminRolloutError(w, r, http.StatusBadRequest, lbl.stale)
			return
		}
		// Everything else reaching here is the version check, which is the
		// operator's input and legible as-is.
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, lbl.name+"失败："+err.Error())
		return
	}
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}

// staleFastRolloutMessage is shared by the handler's own staleness check and by
// the store compare-and-swap's refusal, because the two describe the SAME thing
// to the operator — what you were looking at is no longer true, and nothing was
// written — and only differ in how narrowly they raced. One string so they
// cannot drift into contradicting each other.
const staleFastRolloutMessage = "手动快速发布失败：机队轨的状态在你确认之后发生了变化，" +
	"本次操作没有改动任何东西。请刷新 /admin 重新确认当前目标版本与状态后再试。"

// staleCanaryFastRolloutMessage is the same sentence for the safe fast push. It
// is a second constant rather than the first one with the action name
// substituted in, so that each message is greppable as the whole string an
// operator will see and can be pinned by its own test — and so that a future
// edit to one mode's wording cannot silently reword the other's refusal.
const staleCanaryFastRolloutMessage = "安全快速发布失败：机队轨的状态在你确认之后发生了变化，" +
	"本次操作没有改动任何东西。请刷新 /admin 重新确认当前目标版本与状态后再试。"

// handleAdminRolloutEmergency releases the whole track at once: a single write
// points the track at the target AND arms emergency mode, which makes the
// update check bypass the staged ladder for every node of this track (see
// RolloutTrack.Emergency and updateCheckEmergency).
//
// It is registered behind RequireStepUp, so by the time this runs the operator
// has seen a confirmation page naming the version and the fact that staging is
// skipped, and has re-presented a second factor; HandleAdminConfirm writes the
// audit entry (rollout.emergency, target rollout:<track>, with the factor that
// satisfied the step-up) once this returns a non-error status. This handler
// must therefore NOT write its own audit entry — that would double-log it, and
// log it without the factor.
//
// The one thing an emergency does NOT skip is the byo-behind-fleet gate: it
// still goes through setTargetVersion. Skipping the ladder is a decision about
// speed on OUR machines; pushing users' machines a build our own fleet has
// never run is a different promise, and an emergency is not a reason to break
// it. Emergency-release the fleet first, then byo.
func (s *Service) handleAdminRolloutEmergency(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	version := strings.TrimSpace(r.FormValue("version"))
	// ONE write, not two. Repointing the track and arming emergency mode used
	// to be separate statements, which left a window where a failure of the
	// second reported 紧急发布失败 to the operator while the track was already
	// repointed and rolling to that version by the STAGED path — a release
	// nobody asked for, and (because HandleAdminConfirm skips the audit on any
	// >=400) with no record that anything had been written at all. There is no
	// half-applied outcome to report or audit now: this either lands whole or
	// leaves the row exactly as it was.
	if err := s.SetEmergencyTargetVersion(r.Context(), track, version); err != nil {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "紧急发布失败："+err.Error())
		return
	}
	http.Redirect(w, r, "/admin/fleet", http.StatusFound)
}
