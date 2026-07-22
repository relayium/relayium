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

// SetTargetVersion is the only way a track's target changes. track must be
// exactly "fleet" or "byo", and version must be a plain release tag (see
// selfupdate.IsPlainVersion) — both are validated up front and rejected with
// an error rather than silently accepted, since this is reachable from an
// admin-facing form. For "byo" it additionally enforces the one-way gate
// against the fleet track's completed version; for "fleet" it consults
// nothing but the track itself.
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
//   - Emergency: back to off. Setting a target the ordinary way is the STAGED
//     path by definition; an emergency release is a separately confirmed
//     action (see SetEmergencyTargetVersion) and must never be inherited by
//     the next target somebody types into the normal box.
func (s *Service) SetTargetVersion(ctx context.Context, track, version string) error {
	return s.setTargetVersion(ctx, track, version, false)
}

// SetEmergencyTargetVersion points a track at version AND arms emergency mode
// in the SAME write, so the operation is atomic from the operator's point of
// view: either the track is repointed and released whole, or nothing happened
// at all.
//
// That atomicity is the whole reason this exists rather than "SetTargetVersion
// then flip a flag". The two-step form had a state in between where the track
// was already repointed to {target: v, status: rolling} but NOT armed: if the
// second step then failed, the operator was told 紧急发布失败 while a STAGED
// rollout to that very version was already underway — and, because
// handleAdminConfirm skips the audit on any >=400, with no record of it
// anywhere. There is no such intermediate state now: PutRolloutTrack is a
// single INSERT ... ON CONFLICT statement.
//
// It routes through the same setTargetVersion chokepoint as the staged path,
// so it cannot skip the track-name check, the version check, or the one-way
// byo-behind-fleet gate. Emergency means "skip the staged ladder on machines
// this track owns", never "skip the gate that stops users' machines getting a
// build our own fleet never ran".
func (s *Service) SetEmergencyTargetVersion(ctx context.Context, track, version string) error {
	return s.setTargetVersion(ctx, track, version, true)
}

// setTargetVersion is the single implementation behind both exported entry
// points, and therefore still the ONLY place a track's target_version changes.
// emergency only decides which value the emergency column is written with in
// that same row write; everything else is identical on both paths.
func (s *Service) setTargetVersion(ctx context.Context, track, version string, emergency bool) error {
	// Reject anything but the exact two track names. Callers (an admin form
	// handler, in particular) are expected to pass raw user input straight
	// through; without this check an unknown or differently-cased track
	// (e.g. "BYO", "nonsense") would key a brand-new row in node_rollout that
	// the fleet-vs-byo gate below never sees, silently bypassing it while
	// reporting success.
	if track != "fleet" && track != "byo" {
		return fmt.Errorf("unknown rollout track %q: must be \"fleet\" or \"byo\"", track)
	}
	// Reject anything IsPlainVersion doesn't accept, including "". This is
	// the single chokepoint for that check: an unparseable version left to
	// reach the store either burns a canary node before the node updater's
	// own IsPlainVersion check halts the track (loud, but late), or — for ""
	// specifically — is accepted and then wedges the track in "wait" FOREVER
	// because decideFleet/decideByo's empty-target guards never halt. Doing
	// it here turns both into an immediate error for the admin instead.
	if !selfupdate.IsPlainVersion(version) {
		return fmt.Errorf("invalid target version %q: must be a plain vMAJOR.MINOR.PATCH release tag", version)
	}
	if track == "byo" {
		// Isolation: the fleet path below (track == "fleet") must never read
		// this row or anything derived from it — a broken/halted BYO track
		// must never block the fleet. This read only happens on the byo
		// branch.
		fleet, ok, err := s.store.GetRolloutTrack(ctx, "fleet")
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("%w: the fleet track has never been started", ErrByoAheadOfFleet)
		}
		if fleet.Status != "complete" || !selfupdate.SameVersion(fleet.TargetVersion, version) {
			return fmt.Errorf("%w: fleet is on %q/%q", ErrByoAheadOfFleet, fleet.TargetVersion, fleet.Status)
		}
		// Non-transactional read-then-write is safe here even though this
		// deployment is multi-instance. The property this gate certifies is
		// "the fleet track has ALREADY COMPLETED this version" — a fact
		// about the past. Once we've observed complete@X above, admitting
		// byo->X is justified no matter what the fleet row becomes between
		// this read and the PutRolloutTrack below (it could move on to
		// complete@Y, or start rolling again; neither retroactively un-ships
		// X). The only other interleaving — this read sees "rolling" while
		// the fleet concurrently completes — fails CLOSED (we return
		// ErrByoAheadOfFleet above) and the admin simply retries. There is
		// no interleaving that admits a byo target the fleet never
		// completed, so no transaction is needed.
	}
	return s.store.PutRolloutTrack(ctx, RolloutTrack{
		Track:          track,
		TargetVersion:  version,
		Status:         "rolling",
		StageStartedAt: s.now().Unix(),
		Emergency:      emergency,
	})
}
