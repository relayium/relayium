package account

import (
	"fmt"
	"time"
)

// This file DESCRIBES rollout state for the admin panel. It never decides
// anything: decideFleet and decideByo remain the only authority, and nothing
// here may reimplement their branches. If the two could disagree, the operator
// would eventually believe the wrong one.
//
// Every threshold below is read from the state machine's own constants
// (rollout_fleet.go, rollout_byo.go). A panel carrying its own copies starts
// lying the day someone tunes a constant, and a panel that lies is worse than
// one that says nothing, because decisions get made from it.

// rolloutNodeStatus is what the panel prints for the node holding the fleet
// rollout slot.
type rolloutNodeStatus struct {
	Band   string // "" | "installing" | "not-started" | "observing" | "failed" | "skipped"
	Label  string // 安装中 / 等待节点开始 / 观察中 / 更新失败 / 已回滚 / 已跳过（不是失败）
	Detail string // the applicable clock, in words
	// Overdue is true once the limit that applies to this band has passed. It
	// is NOT "the track has halted": both state machines are evaluated only
	// when some node polls, so the consequence lands on the next poll rather
	// than at the instant the limit is crossed.
	Overdue bool
	// Alarm is whether this state calls for a human, and it -- not Overdue --
	// is what the template escalates on. They differ in exactly one band, and
	// it is the one that matters: in the observing band a crossed limit is the
	// window's SUCCESSFUL end, so a healthy canary that finished its six hours
	// and is waiting out the poll interval must not render in the same red as
	// a node about to be aborted. Colour that an operator learns to ignore is
	// worse than no colour.
	Alarm bool
}

// fleetNodeInput is everything the classification needs, in primitives, so
// this stays testable without a database, an HTTP request or a clock.
type fleetNodeInput struct {
	// TrackStatus and Emergency belong to the TRACK, not to the node, and they
	// are the precondition for every band below: see fleetNodeStatus.
	TrackStatus string
	Emergency   bool
	OnTarget    bool
	IsCanary    bool
	// UpdateResult is nodes.update_result for this node, i.e. what it last
	// reported back. Two of its values are decisions in decideFleet, not
	// clocks, and they sit ABOVE every clock it runs (rollout_fleet.go:228,
	// :248), so the panel cannot classify without it.
	UpdateResult    string
	UpdateStartedAt int64
	LastSeenAt      int64
	StageStartedAt  int64
}

// newFleetNodeInput builds that input from the same two things decideFleet
// reads: the track row and the node's snapshot. It exists so that the panel and
// the test that pins the panel to decideFleet cannot assemble it two different
// ways -- every defect found on this work so far was a predicate that had been
// hand-copied from the state machine and then drifted, and a second copy of the
// input mapping would be one more place for that to happen.
//
// onTarget is passed in rather than recomputed because the caller already has
// it (and computes it with the same selfupdate.SameVersion decideFleet uses).
func newFleetNodeInput(tr RolloutTrack, n NodeSnapshot, onTarget bool) fleetNodeInput {
	return fleetNodeInput{
		TrackStatus: tr.Status,
		Emergency:   tr.Emergency,
		OnTarget:    onTarget,
		// Same rule as rollout_fleet.go:247, including the empty case:
		// FirstNodeID == "" while a node IS in flight is a track written before
		// that field existed, and the state machine assumes the node in flight
		// IS the canary, because guessing "not the canary" silently cuts a live
		// 6h observation to 30 minutes. Every defence there fails LONG; a panel
		// that guessed the other way would report the shorter window and mark a
		// healthy canary overdue.
		IsCanary:        n.ID == tr.FirstNodeID || tr.FirstNodeID == "",
		UpdateResult:    n.UpdateResult,
		UpdateStartedAt: n.UpdateStartedAt,
		LastSeenAt:      n.LastSeenAt,
		StageStartedAt:  tr.StageStartedAt,
	}
}

// fleetNodeStatus says what decideFleet is doing with the node holding the
// rollout slot. Its branches are in decideFleet's own order, because mirroring
// the order of the thing you describe is what stops the two drifting apart when
// either is restructured -- and drift here is not cosmetic, it is the panel
// telling an operator to wait when the track is about to stop, or to go and
// look at a machine that is fine.
func fleetNodeStatus(in fleetNodeInput, now int64) rolloutNodeStatus {
	// decideFleet's step 1 (rollout_fleet.go:166): a track that is not
	// 'rolling' is INERT. It returns wait for every node at every clock,
	// forever, so NOTHING is being timed and there is no band to print.
	//
	// This is the first check because it is the precondition for all of them,
	// and getting it wrong is not a cosmetic slip: HaltRolloutTrack
	// (rollout_store.go:122-127) does not clear current_node_id and DOES
	// restamp stage_started_at, so pausing a rolling canary would otherwise
	// print "观察中 · 不早于 <six hours after the pause>" -- a window the pause
	// itself created -- and a paused node still behind the target would
	// eventually claim "将在下一次轮询时中止", which no poll can ever do to an
	// already-halted track. An empty band is truthful there: the track-level
	// line already says 已中止 and prints the halt reason.
	//
	// !Emergency is here for symmetry with the BYO path (admin_rollout.go) and
	// for whoever adds the next emergency path, NOT for a live bug: an
	// emergency short-circuits both state machines in nodes.go before the
	// per-track dispatch, so decideFleet is not reached at all while it is
	// armed.
	if in.TrackStatus != "rolling" || in.Emergency {
		return rolloutNodeStatus{}
	}
	// decideFleet:228 -- a node reporting failed or rolled_back HALTS the whole
	// track on the next poll. This sits above every clock below because that is
	// where decideFleet has it: without it a heartbeating node commanded five
	// minutes ago that already reported "failed" reads 安装中 · 已 5 分钟 ·
	// 上限 1 小时, i.e. the panel answering "you have 55 minutes of headroom"
	// about the node that is stopping the release.
	//
	// There is no staleness test here because decideFleet has none, and adding
	// one would be inventing a branch it does not have: the result is read off
	// the node holding the slot, and CommandNodeUpdate clears
	// nodes.update_result when it commands that node (rollout_store.go:315-326),
	// so a result present on it belongs to THIS rollout. (The BYO track needs
	// byoResultIsFailure for exactly the reason the fleet track does not: it has
	// no CurrentNodeID to key on.)
	if in.UpdateResult == "failed" || in.UpdateResult == "rolled_back" {
		label := "更新失败"
		if in.UpdateResult == "rolled_back" {
			label = "已回滚"
		}
		return rolloutNodeStatus{
			Band: "failed", Label: label,
			Detail: "该节点报告" + label + "，这就是本轨道停下的原因：下一次轮询时中止。",
			// No deadline has passed because no deadline is left to pass, so
			// Overdue stays false and Alarm carries the escalation.
			Alarm: true,
		}
	}
	// decideFleet:248 -- "skipped" is NOT a failure: the node declined this
	// update (already newer, pinned, whatever) and will never reach the target.
	// Its stage is over and the queue ADVANCES without it on the next poll, so
	// nothing is being timed here either. Alarm is set even though nothing
	// failed, because this is the one band where the node is permanently left
	// behind the fleet and only a human closes it out.
	if in.UpdateResult == "skipped" {
		return rolloutNodeStatus{
			Band: "skipped", Label: "已跳过（不是失败）",
			Detail: "该节点跳过了本次更新，不会装到目标版本；队列将在下一次轮询时越过它继续，这台机器留给人处理。",
			Alarm:  true,
		}
	}
	if in.UpdateStartedAt == 0 && in.StageStartedAt == 0 {
		return rolloutNodeStatus{} // not in flight at all
	}
	// The band's own clock, then the silence clock ON TOP of it. They run in
	// PARALLEL -- decideFleet reads the same stamps whether or not the node is
	// heartbeating -- so silence must not be allowed to hide a band deadline
	// that has already expired.
	st := fleetBand(in, now)
	// Silence is tested by decideFleet ABOVE the on-target branch
	// (rollout_fleet.go:252 sits above :255): a node that installed
	// successfully and then went dark during its six-hour window halts the
	// whole track, so reporting it as calmly 观察中 would be the panel lying in
	// the band it presents as the safe one.
	//
	// The ENTRY threshold here (nodeOnlineWindow, 90s -- the same window the
	// rest of the panel calls a node 离线) is deliberately EARLIER than the halt
	// it describes (updateSilenceLimit, 15min at :252). That is not a mismatch
	// to be "fixed" in either direction: the DEADLINE printed below is always
	// the halt's own, so nothing here claims a limit that does not exist; the
	// earlier entry only decides when the panel starts showing the silence clock
	// instead of the band's, and an operator wants to be told a machine has gone
	// quiet before the halt is 14 minutes away.
	if in.UpdateStartedAt != 0 && now-in.LastSeenAt > int64(nodeOnlineWindow/time.Second) {
		// The label keeps the band it came from, so the operator can still see
		// what the node was doing when it went dark.
		st.Label += "（已停止心跳）"
		deadline := in.LastSeenAt + updateSilenceLimit
		switch {
		case now > deadline:
			// The silence halt has fired: it is the whole story now.
			st.Detail = elapsedText(in.LastSeenAt, deadline, now)
			st.Overdue, st.Alarm = true, true
		case !st.Overdue:
			// Two clocks running, neither expired. Show the silence one: a
			// heartbeating node resets it every 30 seconds, so it is the clock
			// the operator cannot see coming, and printing both is noise.
			st.Detail = elapsedText(in.LastSeenAt, deadline, now)
		default:
			// The band's OWN limit already ran out while the node was dark, and
			// that is what decideFleet acts on first -- halt for an install past
			// fleetInstallLimit, advance for an observation window that closed.
			// Keep the band's detail and add the silence as a fact; showing only
			// the silence clock here would present a stage that has ENDED as one
			// with 14 minutes left.
			st.Detail += fmt.Sprintf(" · 已停止心跳 %s", humanDuration(now-in.LastSeenAt))
		}
	}
	return st
}

// fleetBand places a node in flight in one of the three bands decideFleet times
// it in, ignoring silence -- fleetNodeStatus overlays that above, because it is
// a second clock running alongside these, not a fourth band.
//
// The three are mutually exclusive, they have different deadlines and they call
// for opposite responses: an observing node needs waiting for, the other two
// need looking at.
func fleetBand(in fleetNodeInput, now int64) rolloutNodeStatus {
	if in.OnTarget {
		// The observation window only starts once the node actually runs the
		// target. The six hours are spent watching a node that already
		// installed -- which is the whole point of the window.
		window := int64(fleetStepWindow)
		if in.IsCanary {
			window = fleetFirstWindow
		}
		// The LATER of the two stamps. rollout_fleet.go:285-288 records why:
		// they are written by different code paths, and a stale or zero
		// StageStartedAt would collapse a six-hour observation into seconds.
		start := in.StageStartedAt
		if in.UpdateStartedAt > start {
			start = in.UpdateStartedAt
		}
		deadline := start + window
		return rolloutNodeStatus{
			Band: "observing", Label: "观察中",
			Detail: notBeforeText(deadline, now), Overdue: now >= deadline,
			// Alarm is deliberately never set in this band: crossing this limit
			// is the window SUCCEEDING, not a node in trouble.
		}
	}
	if in.UpdateStartedAt == 0 {
		// Commanded, but the node never recorded a start: central's two writes
		// split. The stage's clock is the backstop (rollout_fleet.go:263).
		deadline := in.StageStartedAt + updateSilenceLimit
		over := now > deadline
		return rolloutNodeStatus{
			Band: "not-started", Label: "等待节点开始",
			Detail: elapsedText(in.StageStartedAt, deadline, now), Overdue: over, Alarm: over,
		}
	}
	// Installing. The install limit is the one that will decide this node's fate
	// while it keeps heartbeating (rollout_fleet.go:275).
	deadline := in.UpdateStartedAt + fleetInstallLimit
	over := now > deadline
	return rolloutNodeStatus{
		Band: "installing", Label: "安装中",
		Detail: elapsedText(in.UpdateStartedAt, deadline, now), Overdue: over, Alarm: over,
	}
}

// byoNextStepText is the BYO track's equivalent of the fleet bands. It has no
// per-node states -- it commands a whole batch -- so all it needs is when the
// current batch's window closes.
//
// batch is tr.ByoBatch, and it is load-bearing: decideByo gates the window on
// `tr.ByoBatch != 0` (rollout_byo.go:229-231), because a FRESH track opens its
// first batch immediately. Reporting a six-hour wait there would be the panel
// inventing a delay the state machine does not have.
func byoNextStepText(batch int, stageStartedAt, now int64) string {
	if batch == 0 {
		return "首批将在下一次轮询时下发"
	}
	return notBeforeText(stageStartedAt+byoBatchWindow, now)
}

// byoNextStepLabel names WHAT byoNextStepText is the time of. At the widest
// batch there is no wider one to open: decideByo's ladder is exhausted
// (rollout_byo.go:251-256) and what the window's close brings is either
// completion or a re-sweep of whoever is still behind. The time is right there;
// the noun "下一批" is not, because it names a batch that does not exist.
//
// The widest batch is read off byoBatches rather than written as 100, for the
// same reason no threshold on this page is a literal.
func byoNextStepLabel(batch int) string {
	if batch == byoBatches[len(byoBatches)-1] {
		return "全量批次已开，仍落后的节点重发"
	}
	return "下一批"
}

// notBeforeText phrases a deadline as the earliest it can matter, never as a
// prediction. Both state machines are evaluated only when some node polls, and
// nodes poll roughly every 10 minutes, so a bare timestamp would read as a
// promise and slip on every rollout. A panel whose predictions visibly miss
// teaches the operator to ignore it.
func notBeforeText(deadline, now int64) string {
	if now >= deadline {
		return "已到时间，等待下一次轮询"
	}
	return fmt.Sprintf("不早于 %s UTC（还有 %s）",
		time.Unix(deadline, 0).UTC().Format("2006-01-02 15:04"), humanDuration(deadline-now))
}

// elapsedText states a fact and a limit rather than a prediction: how long this
// has been going and how long it may go. A slow link taking forty minutes to
// fetch a binary is normal, so this reads plainly at every point below the
// limit.
func elapsedText(since, deadline, now int64) string {
	if now > deadline {
		return fmt.Sprintf("已 %s · 超过 %s 的上限，将在下一次轮询时中止",
			humanDuration(now-since), humanDuration(deadline-since))
	}
	return fmt.Sprintf("已 %s · 上限 %s", humanDuration(now-since), humanDuration(deadline-since))
}

// fleetRulesText and byoRulesText put the timing rules on the page instead of
// in an operator's memory. Both are generated from the constants so that
// tuning one moves the state machine and the sentence together.
func fleetRulesText() string {
	return fmt.Sprintf("canary 观察 %s，之后每台 %s；节点每 ~10 分钟来问一次，所以下发会落在窗口关闭之后的十分钟内。",
		humanDuration(fleetFirstWindow), humanDuration(fleetStepWindow))
}

func byoRulesText() string {
	return fmt.Sprintf("每批观察 %s，之后自动放宽到下一档；节点每 ~10 分钟来问一次。",
		humanDuration(byoBatchWindow))
}

// humanDuration renders a span of seconds the way the panel says it. Sub-minute
// spans read as 0 分钟 rather than in seconds: nothing here is precise to the
// second, and a countdown ticking in seconds invites watching it.
func humanDuration(sec int64) string {
	if sec < 0 {
		sec = 0
	}
	h, m := sec/3600, (sec%3600)/60
	switch {
	case h > 0 && m > 0:
		return fmt.Sprintf("%d 小时 %d 分钟", h, m)
	case h > 0:
		return fmt.Sprintf("%d 小时", h)
	default:
		return fmt.Sprintf("%d 分钟", m)
	}
}
