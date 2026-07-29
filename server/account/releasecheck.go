package account

import (
	"context"
	"log"
	"time"

	"github.com/relayium/relayium/selfupdate"
)

// This file answers one question for the admin panel: is there a release newer
// than what the fleet is pointed at, and may the operator start it from here?
//
// It only ever makes a POSITIVE claim. It can say a newer version exists; it
// never says the deployment is current. A failed request, a rate limit or a
// GitHub outage therefore degrades to silence rather than to a false statement
// -- the panel prints when the last SUCCESSFUL check was, so silence stays
// legible.

// releaseNoticeView is what the panel renders. Zero value = render nothing.
type releaseNoticeView struct {
	// Enabled gates the whole block, including the freshness line. Without it
	// a deployment that deliberately set RELAYIUM_RELEASE_CHECK=false would be
	// told 尚未成功检查过 forever -- true, useless, and implying something is
	// wrong when the operator switched it off on purpose.
	Enabled     bool
	Show        bool
	OfferButton bool
	// InFlight is true when the fleet track has a rollout in flight: the notice
	// informs but offers no button. See releaseNotice.
	InFlight     bool
	LatestTag    string
	TargetTag    string // "" when the fleet track was never configured
	DismissedTag string // non-empty: render the muted 已忽略 line
	CheckedAt    int64  // 0 = never checked successfully
}

// releaseNotice decides what the panel shows, from the stored check and the
// fleet track. Pure: no clock, no database, no HTTP.
//
// It is also the HANDLER's guard, not only the button's: handleAdminReleaseRollout
// calls this and refuses unless OfferButton. One predicate, so the two cannot
// drift apart -- see that function.
//
// The button is withheld while a rollout is IN FLIGHT, and that is the
// constraint this whole feature is built around. setTargetVersion
// (rollout_gate.go) has no status gate on the fleet path: it rewrites the whole
// row, resetting Status to rolling, restamping StageStartedAt, and clearing
// CurrentNodeID/FirstNodeID. Pressing it during a live rollout silently
// abandons it -- discarding, say, a canary five hours and fifty minutes into a
// six-hour observation window, with nothing shown to say so. That is defensible
// behind a form someone typed a version into. It is not defensible one click
// from a notification.
//
// "In flight" is Status == "rolling" OR CurrentNodeID != "", and the second
// disjunct is the whole point: a PAUSED rollout is a rollout in flight.
// Checking only the status offered the button on one, and one click erased the
// canary position 恢复发布 exists to restore. Which of rollout_store.go's
// statements leave current_node_id set, checked rather than assumed:
//
//   - HaltRolloutTrack writes status='halted' and does NOT touch
//     current_node_id -- deliberately, per its own comment and the rollout
//     panel's: on a halted track the node that was in flight is still the one
//     the operator opened the panel to find.
//   - ResumeRolloutTrack CLEARS it (a fresh canary pick), CompleteRolloutTrack
//     CLEARS it (nothing is in flight once a track is done). So a halted track
//     with an empty current_node_id has genuinely nothing to lose, and gets the
//     button -- see the test.
//   - ClaimRolloutNode is what sets it, and only on status='rolling'.
//
// The panel already refuses to render a control whose only possible outcome is
// a refusal. This is the case that is worse, because it succeeds.
func releaseNotice(rc ReleaseCheck, fleet RolloutTrack, fleetFound bool) releaseNoticeView {
	v := releaseNoticeView{
		Enabled:   true,
		LatestTag: rc.LatestTag, CheckedAt: rc.CheckedAt, DismissedTag: rc.DismissedTag,
	}
	if fleetFound {
		v.TargetTag = fleet.TargetVersion
	}
	// Never checked successfully: there is nothing to claim, in either
	// direction. The panel says 尚未成功检查过 from CheckedAt == 0.
	if rc.CheckedAt == 0 || rc.LatestTag == "" {
		return v
	}
	// A tag we cannot read is not a release we can offer. This guard is here,
	// above every other branch, rather than folded into the comparison below --
	// the comparison only runs when the fleet track HAS a target, so an
	// unreadable tag on a never-configured track would sail past it and produce
	// a button that setTargetVersion is guaranteed to reject. That is a control
	// whose only possible outcome is a refusal, which is exactly what this
	// panel refuses to render, and it would appear on the deployment where the
	// notice matters most.
	if !selfupdate.IsPlainVersion(rc.LatestTag) {
		return v
	}
	// Newer than what the fleet targets? An unconfigured track has nothing to
	// compare against, and offering the rollout is the point.
	if fleetFound && fleet.TargetVersion != "" {
		n, ok := selfupdate.CompareVersions(rc.LatestTag, fleet.TargetVersion)
		// ok == false means one of them does not parse. Saying nothing is the
		// only honest answer: claiming "nothing new" would be an assertion
		// about currency built on a value we could not read.
		if !ok || n <= 0 {
			return v
		}
	}
	// Dismissed this tag or a newer one: stay quiet, but leave the dismissal
	// visible so it can be undone. A tag newer than the dismissed one falls
	// through and prompts again.
	//
	// The `ok &&` is load-bearing and easy to drop as redundant. Without it, a
	// DismissedTag that cannot be parsed -- a hand-edited row, a tag from before
	// a naming change -- compares as 0 and silences EVERY future notice
	// permanently, with nothing on screen to say why.
	if rc.DismissedTag != "" {
		if n, ok := selfupdate.CompareVersions(rc.LatestTag, rc.DismissedTag); ok && n <= 0 {
			return v
		}
	}
	v.Show = true
	v.InFlight = fleetFound && (fleet.Status == "rolling" || fleet.CurrentNodeID != "")
	v.OfferButton = !v.InFlight
	return v
}

// ReleaseCheckStore is the slice of the store this poller needs. Narrow on
// purpose: it writes one thing, and it must be obvious from the type that a
// failed check cannot touch anything else.
type ReleaseCheckStore interface {
	SetReleaseCheckResult(ctx context.Context, tag string, at int64) error
}

// ReleaseChecker polls for the newest release. Latest is injectable for the
// same reason fetchGoogleUser and appleKey are on Service: tests must not reach
// the network.
type ReleaseChecker struct {
	Store  ReleaseCheckStore
	Now    func() time.Time
	Latest func(ctx context.Context) (string, error)
	Log    *log.Logger
	// failing tracks whether the last attempt failed, so an outage costs one
	// log line rather than one per hour. Same shape as the storage prober's
	// reachability logging. Only Run/CheckOnce touch it, from one goroutine.
	failing bool
}

// CheckOnce performs one check. A failure writes NOTHING: leaving the previous
// values in place is what makes the panel degrade to silence rather than to a
// false claim, and overwriting with an empty tag would turn a network blip into
// an amnesiac panel.
func (c *ReleaseChecker) CheckOnce(ctx context.Context) {
	tag, err := c.Latest(ctx)
	if err != nil {
		if !c.failing {
			c.Log.Printf("release-check: %v (keeping the last known release; the panel will not claim to be current)", err)
			c.failing = true
		}
		return
	}
	if c.failing {
		c.Log.Printf("release-check: recovered, latest release is %s", tag)
		c.failing = false
	}
	if err := c.Store.SetReleaseCheckResult(ctx, tag, c.Now().Unix()); err != nil {
		c.Log.Printf("release-check: record %s: %v", tag, err)
	}
}

// Run checks once immediately, then every interval until ctx is cancelled --
// the same shape as StorageProber.Run.
func (c *ReleaseChecker) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	c.CheckOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.CheckOnce(ctx)
		}
	}
}
