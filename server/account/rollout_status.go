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
	Band   string // "" | "installing" | "not-started" | "observing"
	Label  string // 安装中 / 等待节点开始 / 观察中
	Detail string // the applicable clock, in words
	// Overdue is true once the limit that applies to this band has passed. It
	// is NOT "the track has halted": both state machines are evaluated only
	// when some node polls, so the consequence lands on the next poll rather
	// than at the instant the limit is crossed.
	Overdue bool
}

// fleetNodeInput is everything the classification needs, in primitives, so
// this stays testable without a database, an HTTP request or a clock.
type fleetNodeInput struct {
	OnTarget        bool
	IsCanary        bool
	UpdateStartedAt int64
	LastSeenAt      int64
	StageStartedAt  int64
}

// fleetNodeStatus places the node in one of three mutually exclusive states.
// They have different deadlines and they call for opposite responses: an
// observing node needs waiting for, the other two need looking at.
func fleetNodeStatus(in fleetNodeInput, now int64) rolloutNodeStatus {
	if in.UpdateStartedAt == 0 && in.StageStartedAt == 0 {
		return rolloutNodeStatus{} // not in flight at all
	}
	// Silence is tested FIRST, above the on-target branch, because that is
	// where decideFleet tests it (rollout_fleet.go:252 sits above the
	// !onTarget branch at :255). A node that installed successfully and then
	// went dark during its six-hour window halts the whole track, so reporting
	// it as calmly 观察中 would be the panel lying in the band it presents as
	// the safe one. Mirroring the order of the thing you describe is what stops
	// the two drifting apart when either is restructured.
	if in.UpdateStartedAt != 0 && now-in.LastSeenAt > int64(nodeOnlineWindow/time.Second) {
		band, label := "installing", "安装中（已停止心跳）"
		if in.OnTarget {
			band, label = "observing", "观察中（已停止心跳）"
		}
		deadline := in.LastSeenAt + updateSilenceLimit
		return rolloutNodeStatus{
			Band: band, Label: label,
			Detail: elapsedText(in.LastSeenAt, deadline, now), Overdue: now > deadline,
		}
	}
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
		}
	}
	if in.UpdateStartedAt == 0 {
		// Commanded, but the node never recorded a start: central's two writes
		// split. The stage's clock is the backstop (rollout_fleet.go:263).
		deadline := in.StageStartedAt + updateSilenceLimit
		return rolloutNodeStatus{
			Band: "not-started", Label: "等待节点开始",
			Detail: elapsedText(in.StageStartedAt, deadline, now), Overdue: now > deadline,
		}
	}
	// Installing, and still heartbeating -- the silence branch above already
	// took every node that has gone quiet. So the install limit is the one
	// that will decide this node's fate, and it is the only one worth showing.
	deadline := in.UpdateStartedAt + fleetInstallLimit
	return rolloutNodeStatus{
		Band: "installing", Label: "安装中",
		Detail: elapsedText(in.UpdateStartedAt, deadline, now), Overdue: now > deadline,
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
