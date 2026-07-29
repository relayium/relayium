package account

import (
	"context"
	"errors"
	"io"
	"log"
	"testing"
	"time"
)

func TestReleaseNoticeOffersTheButtonWhenTheFleetIsIdle(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if !got.Show || !got.OfferButton {
		t.Fatalf("want a notice with a button, got %+v", got)
	}
	if got.LatestTag != "v1.3.0" || got.TargetTag != "v1.2.0" {
		t.Fatalf("versions wrong: %+v", got)
	}
}

// The constraint the whole design hangs off. setTargetVersion has no status
// gate: it rewrites the fleet row, resetting Status, restamping StageStartedAt
// and clearing CurrentNodeID/FirstNodeID. One click from a notice must not be
// able to discard a canary most of the way through its six-hour window.
func TestReleaseNoticeWithholdsTheButtonWhileRolling(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "rolling"}, true)
	if !got.Show {
		t.Fatal("the notice should still inform while a rollout is running")
	}
	if got.OfferButton {
		t.Fatal("pressing the button here would silently abandon the rollout in flight")
	}
	if !got.InFlight {
		t.Fatal("the notice must be able to say what is currently rolling")
	}
}

// A PAUSED rollout is a rollout in flight. HaltRolloutTrack sets
// status='halted' and deliberately leaves current_node_id alone
// (rollout_store.go), so the canary is still recorded as the node in flight.
// Offering the button here loses that position: setTargetVersion clears
// CurrentNodeID/FirstNodeID and rewrites the target, after which 恢复发布 can no
// longer put the operator back where they pressed pause.
func TestReleaseNoticeWithholdsTheButtonOnAPausedRollout(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "halted", CurrentNodeID: "n-canary"}, true)
	if !got.Show {
		t.Fatal("a paused rollout is not 'nothing new'; the notice must still inform")
	}
	if got.OfferButton {
		t.Fatal("pressing the button here discards the paused rollout's canary position")
	}
	if !got.InFlight {
		t.Fatal("the notice must be able to say a rollout is still in flight")
	}
}

// The other side of it: a halted track with NO node in flight (resumed and
// re-halted, or halted before any pick) has nothing to lose, and the button is
// exactly what the operator wants. ResumeRolloutTrack and CompleteRolloutTrack
// both clear current_node_id, so this state is reachable and ordinary.
func TestReleaseNoticeOffersTheButtonOnAHaltedTrackWithNoNodeInFlight(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "halted"}, true)
	if !got.Show || !got.OfferButton {
		t.Fatalf("nothing is in flight here; the button is the point: %+v", got)
	}
}

func TestReleaseNoticeHiddenWhenDismissed(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000, DismissedTag: "v1.3.0", DismissedAt: 1100},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if got.Show {
		t.Fatal("a dismissed version must not keep prompting")
	}
	if got.DismissedTag != "v1.3.0" {
		t.Fatal("the dismissal must stay visible so it can be undone")
	}
}

// Dismissal is per-version, so a newer release brings the notice back without
// the operator having to remember to re-enable anything.
func TestReleaseNoticeReturnsForANewerRelease(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.4.0", CheckedAt: 1000, DismissedTag: "v1.3.0", DismissedAt: 1100},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if !got.Show || !got.OfferButton {
		t.Fatalf("a newer release than the dismissed one must prompt again: %+v", got)
	}
}

func TestReleaseNoticeSilentWhenNothingIsNewer(t *testing.T) {
	for _, latest := range []string{"v1.2.0", "v1.1.9"} {
		got := releaseNotice(
			ReleaseCheck{LatestTag: latest, CheckedAt: 1000},
			RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
		if got.Show {
			t.Fatalf("latest=%s is not newer than the target; got %+v", latest, got)
		}
	}
}

// The whole point of the "positive claims only" rule: a deployment that has
// never checked successfully says nothing about being current.
// A deployment that switched the check off must not be told 尚未成功检查过
// forever: true, useless, and it implies something is broken when the operator
// turned it off deliberately. admin.go leaves the zero value in that case.
func TestReleaseNoticeZeroValueIsNotEnabled(t *testing.T) {
	var v releaseNoticeView
	if v.Enabled || v.Show || v.OfferButton {
		t.Fatalf("the zero view must render nothing at all: %+v", v)
	}
	if got := releaseNotice(ReleaseCheck{}, RolloutTrack{}, false); !got.Enabled {
		t.Fatal("releaseNotice is only called when the feature is on, so its result is Enabled")
	}
}

func TestReleaseNoticeSaysNothingWhenNeverChecked(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if got.Show {
		t.Fatalf("nothing has been checked; there is nothing to claim: %+v", got)
	}
	if got.CheckedAt != 0 {
		t.Fatal("CheckedAt must stay 0 so the panel can say 尚未成功检查过")
	}
}

// A track that was never configured still gets the notice — there is nothing
// to compare against, and offering the rollout is exactly what is wanted.
func TestReleaseNoticeWithNoTargetConfigured(t *testing.T) {
	got := releaseNotice(ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000}, RolloutTrack{}, false)
	if !got.Show || !got.OfferButton {
		t.Fatalf("want a notice with a button: %+v", got)
	}
	if got.TargetTag != "" {
		t.Fatalf("TargetTag should be empty so the panel can say so: %+v", got)
	}
}

// An unparseable stored tag must not read as "nothing new". Both cases matter,
// and the second is the one an earlier draft got wrong: the comparison against
// the fleet target only runs when there IS a target, so on a never-configured
// track an unreadable tag sailed past it and produced a button that
// setTargetVersion is guaranteed to reject.
func TestReleaseNoticeIgnoresAnUnparseableTag(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "not-a-version", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if got.Show {
		t.Fatalf("an unparseable tag must not produce a prompt: %+v", got)
	}
	noTarget := releaseNotice(
		ReleaseCheck{LatestTag: "not-a-version", CheckedAt: 1000}, RolloutTrack{}, false)
	if noTarget.Show || noTarget.OfferButton {
		t.Fatalf("an unparseable tag on a never-configured track must stay silent: %+v", noTarget)
	}
}

// A DismissedTag that cannot be parsed must not silence everything forever.
// This is the guard on the `ok &&` in the dismissal comparison, which reads as
// redundant and is not: without it the unparseable tag compares as 0 and
// suppresses every future notice, with nothing on screen to say why.
func TestReleaseNoticeIgnoresAnUnparseableDismissal(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000, DismissedTag: "not-a-version", DismissedAt: 1100},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if !got.Show || !got.OfferButton {
		t.Fatalf("an unreadable dismissal must not suppress a real release: %+v", got)
	}
}

// The property, in the shape the rollout panel's sweep established: per-case
// assertions are written from the same understanding as the code and drift with
// it. Offering the button must imply NOTHING IS IN FLIGHT on the fleet track,
// in EVERY state, not just the cases above — and "in flight" is status
// 'rolling' OR a node still recorded in current_node_id, which is what a paused
// rollout looks like.
func TestReleaseNoticeButtonImpliesNothingInFlight(t *testing.T) {
	statuses := []string{"", "rolling", "halted", "complete"}
	tags := []string{"", "v1.1.0", "v1.2.0", "v1.3.0", "not-a-version"}
	times := []int64{0, 1000}
	nodes := []string{"", "n-canary"}
	for _, status := range statuses {
		for _, latest := range tags {
			for _, target := range tags {
				for _, dismissed := range tags {
					for _, at := range times {
						for _, node := range nodes {
							for _, found := range []bool{true, false} {
								rc := ReleaseCheck{LatestTag: latest, CheckedAt: at, DismissedTag: dismissed}
								tr := RolloutTrack{Track: "fleet", TargetVersion: target, Status: status, CurrentNodeID: node}
								got := releaseNotice(rc, tr, found)
								if got.OfferButton && found && (tr.Status == "rolling" || tr.CurrentNodeID != "") {
									t.Fatalf("button offered with a rollout in flight: rc=%+v tr=%+v -> %+v", rc, tr, got)
								}
								if got.OfferButton && !got.Show {
									t.Fatalf("button offered without a notice: rc=%+v tr=%+v -> %+v", rc, tr, got)
								}
							}
						}
					}
				}
			}
		}
	}
}

type fakeReleaseStore struct {
	tag string
	at  int64
	n   int
}

func (f *fakeReleaseStore) SetReleaseCheckResult(_ context.Context, tag string, at int64) error {
	f.tag, f.at, f.n = tag, at, f.n+1
	return nil
}

// A failed check must not write. Overwriting with "" would erase the last good
// answer and turn a network blip into an amnesiac panel.
func TestReleaseCheckerFailureDoesNotWrite(t *testing.T) {
	store := &fakeReleaseStore{}
	c := &ReleaseChecker{
		Store: store,
		Now:   func() time.Time { return time.Unix(2000, 0) },
		Latest: func(context.Context) (string, error) {
			return "", errors.New("network is unreachable")
		},
		Log: log.New(io.Discard, "", 0),
	}
	c.CheckOnce(context.Background())
	if store.n != 0 {
		t.Fatalf("a failed check wrote to the store %d time(s)", store.n)
	}
}

func TestReleaseCheckerSuccessWrites(t *testing.T) {
	store := &fakeReleaseStore{}
	c := &ReleaseChecker{
		Store:  store,
		Now:    func() time.Time { return time.Unix(2000, 0) },
		Latest: func(context.Context) (string, error) { return "v1.3.0", nil },
		Log:    log.New(io.Discard, "", 0),
	}
	c.CheckOnce(context.Background())
	if store.n != 1 || store.tag != "v1.3.0" || store.at != 2000 {
		t.Fatalf("store got tag=%q at=%d n=%d", store.tag, store.at, store.n)
	}
}
