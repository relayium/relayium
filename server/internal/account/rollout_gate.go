package account

import (
	"context"
	"errors"
	"fmt"

	"github.com/relayium/relayium/internal/selfupdate"
)

// ErrByoAheadOfFleet rejects pointing user nodes at a version our own fleet has
// not finished running. Our fleet is the canary for user machines; that
// ordering is the entire justification for auto-updating machines we don't
// own. This gate is one-way ONLY: it constrains what the byo track may target,
// and it must NEVER be consulted when setting the fleet track's target — a
// halted, stuck, or broken BYO track must never stop the fleet from shipping.
var ErrByoAheadOfFleet = errors.New("BYO track cannot target a version the fleet has not completed")

// SetTargetVersion is the only way a track's target changes. For "byo" it
// enforces the one-way gate against the fleet track's completed version; for
// "fleet" (or any other track) it consults nothing but the track itself.
//
// A new target always replaces the WHOLE row (PutRolloutTrack is a whole-row
// upsert) rather than patching TargetVersion in place, which deliberately
// resets CurrentNodeID, FirstNodeID, ByoBatch and HaltedReason to zero along
// with Status going to "rolling":
//   - HaltedReason/Status: a new target clears any prior halt — fix-forward
//     means jumping straight to the new version, not being stuck replaying
//     the one that failed.
//   - ByoBatch: decideByo's doc comment records that restarting a halted BYO
//     rollout on the SAME target version re-halts immediately (and forever)
//     unless ByoBatch is reset to 0 first — the failing update_result rows
//     that caused the halt are still on those nodes, and a nonzero ByoBatch
//     would re-evaluate the same batch against the same failures. Since this
//     resets on every call (not just same-version restarts), it is always
//     safe: a genuinely new version has no history to preserve either.
//   - CurrentNodeID/FirstNodeID: fleet-track positional state (which node is
//     current, which was the first/canary) belongs to the rollout that is
//     being replaced; a new target starts a fresh canary pick.
func (s *Service) SetTargetVersion(ctx context.Context, track, version string) error {
	if track == "byo" {
		fleet, ok, err := s.store.GetRolloutTrack(ctx, "fleet")
		if err != nil {
			return err
		}
		if !ok || fleet.Status != "complete" || !selfupdate.SameVersion(fleet.TargetVersion, version) {
			return fmt.Errorf("%w: fleet is on %q/%q", ErrByoAheadOfFleet, fleet.TargetVersion, fleet.Status)
		}
	}
	return s.store.PutRolloutTrack(ctx, RolloutTrack{
		Track:          track,
		TargetVersion:  version,
		Status:         "rolling",
		StageStartedAt: s.now().Unix(),
	})
}
