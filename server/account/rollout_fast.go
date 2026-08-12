package account

import (
	"context"
	"errors"
	"fmt"

	"github.com/relayium/relayium/selfupdate"
)

// ErrFastRolloutStateChanged is the manual fast push refusing because the fleet
// track is not in the state the operator was shown. It covers both halves of
// that: a rollout is in flight or paused (so starting one here would silently
// abandon or resurrect it), and the confirmation page is simply stale (the
// fleet finished a different version since it was rendered).
//
// It is a REFUSAL, not a failure: the handler must render it as a 400 telling
// the operator to refresh, never as a 500. The two are told apart with
// errors.Is, never by treating err != nil as one bucket — the same discipline
// the byo rollback path documents.
var ErrFastRolloutStateChanged = errors.New("the fleet rollout track changed since this action was confirmed")

// StartManualFastFleetRollout starts a manual fast rollout of version on the
// FLEET track: the ladder runs immediately and without its waiting periods,
// keeping every other property (see RolloutTrack.ManualFast for the exact list
// of what is and is not skipped).
//
// It deliberately does NOT route through setTargetVersion, and the reason is
// the compare-and-swap rather than any of that function's checks. A whole-row
// upsert cannot express "only if the track is still finished and still on the
// version the operator was looking at", and without that condition this action
// would be able to do the one thing it must never do: replace a rollout that is
// in flight. Everything setTargetVersion WOULD have contributed is reproduced
// here or is inapplicable:
//
//   - the version check is below, and it is the same selfupdate.IsPlainVersion
//     chokepoint. It matters for the same reason: an unparseable target wedges
//     decideFleet in "wait" forever, because its empty/invalid-target guards
//     answer wait rather than halting;
//   - the track-name check is structural — this function takes no track and the
//     route spells "fleet" out — which is stronger than a runtime check;
//   - the byo-behind-fleet gate constrains what BYO may target and is never
//     consulted for the fleet track, so there is nothing to skip;
//   - the passed-over clear happens inside StartManualFastRollout's transaction,
//     which is where it has to be for a refusal to write nothing at all.
//
// FLEET ONLY, and not by policy but by construction: there is no parameter to
// pass another track through. The BYO ladder exists to keep our own machines
// ahead of every user's, and "faster" is not a reason to mass-push hardware we
// do not own — invariant 1 of this whole feature.
//
// expectStatus/expectTargetVersion are the state the confirmation page showed;
// see StartManualFastRollout for how they are matched.
func (s *Service) StartManualFastFleetRollout(ctx context.Context, expectStatus, expectTargetVersion, version string) error {
	if !selfupdate.IsPlainVersion(version) {
		return fmt.Errorf("invalid target version %q: must be a plain vMAJOR.MINOR.PATCH release tag", version)
	}
	ok, err := s.store.StartManualFastRollout(ctx, "fleet", expectStatus, expectTargetVersion, version, s.now().Unix())
	if err != nil {
		return err
	}
	if !ok {
		return ErrFastRolloutStateChanged
	}
	return nil
}
