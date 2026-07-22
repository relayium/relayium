package account

import (
	"context"
	"database/sql"
)

// rolloutCols is the column list shared by GetRolloutTrack's SELECT and
// PutRolloutTrack's upsert, so the two can never drift out of order.
const rolloutCols = `track, target_version, current_node_id, first_node_id, byo_batch, stage_started_at, status, halted_reason`

// GetRolloutTrack returns the persisted state of the given track ("fleet" |
// "byo"). ok=false means no row has been written for that track yet (a fresh
// DB, or a track whose rollout has never been started) — not an error.
func (s *SQLiteStore) GetRolloutTrack(ctx context.Context, track string) (RolloutTrack, bool, error) {
	var t RolloutTrack
	err := s.reader().QueryRowContext(ctx,
		`SELECT `+rolloutCols+` FROM node_rollout WHERE track = ?`, track).
		Scan(&t.Track, &t.TargetVersion, &t.CurrentNodeID, &t.FirstNodeID, &t.ByoBatch, &t.StageStartedAt, &t.Status, &t.HaltedReason)
	if err == sql.ErrNoRows {
		return RolloutTrack{}, false, nil
	}
	if err != nil {
		return RolloutTrack{}, false, err
	}
	return t, true, nil
}

// PutRolloutTrack upserts a track's full state in one row keyed by Track.
// Every field is overwritten on conflict — this is whole-row state, not
// incremental counters — so the caller must always pass the complete desired
// state, not a partial patch.
func (s *SQLiteStore) PutRolloutTrack(ctx context.Context, t RolloutTrack) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO node_rollout (`+rolloutCols+`) VALUES (?,?,?,?,?,?,?,?)
		 ON CONFLICT(track) DO UPDATE SET
		   target_version=excluded.target_version, current_node_id=excluded.current_node_id,
		   first_node_id=excluded.first_node_id,
		   byo_batch=excluded.byo_batch, stage_started_at=excluded.stage_started_at,
		   status=excluded.status, halted_reason=excluded.halted_reason`,
		t.Track, t.TargetVersion, t.CurrentNodeID, t.FirstNodeID, t.ByoBatch, t.StageStartedAt, t.Status, t.HaltedReason)
	return err
}

// ClaimRolloutNode hands the fleet track's single slot to nodeID, but ONLY if
// the row still looks the way the caller read it. It is a compare-and-swap, not
// a blind write, and it is the sole thing that makes "one fleet node at a time"
// hold across multiple app instances:
//
//   - WHERE current_node_id = expectCurrentNodeID: two instances that both read
//     the pre-claim row race, and exactly one UPDATE matches; the loser gets
//     ok=false and must answer "not eligible". Without it the later write simply
//     overwrites the earlier claim (PutRolloutTrack is a whole-row upsert with
//     no WHERE) and BOTH nodes are told to install, with the track recording
//     only one of them — so the other's failure is never attributed to the
//     rollout. Determinism of decideFleet is NOT sufficient on its own: two
//     instances reading a moment apart see different candidate sets (online() is
//     last_seen_at >= now-90s and update-check does not refresh last_seen_at), so
//     they can legitimately pick different nodes.
//   - The expected value is what was READ, not the empty string, because a claim
//     is also taken over a non-empty current_node_id: when the node in flight
//     reports "skipped", decideFleet falls through and picks the next one while
//     the skipped node's ID is still in the row.
//   - AND status='rolling': a track another instance has just halted must not be
//     resurrected by a claim computed from the pre-halt state.
//
// firstNodeID is written unconditionally, so the caller passes the value it
// wants persisted (the unchanged one when the pick is not the canary).
func (s *SQLiteStore) ClaimRolloutNode(ctx context.Context, track, expectCurrentNodeID, nodeID, firstNodeID string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET current_node_id = ?, first_node_id = ?, stage_started_at = ?
		   WHERE track = ? AND current_node_id = ? AND status = 'rolling'`,
		nodeID, firstNodeID, at, track, expectCurrentNodeID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// HaltRolloutTrack stops a track, conditional on it still being 'rolling'.
//
// The condition is what stops a halt from being LOST: PutRolloutTrack rewrites
// the whole row, so an instance that read the track as rolling and then wrote
// anything (a claim, a batch advance) would silently overwrite a 'halted' status
// another instance wrote in between — resurrecting a rollout that had already
// decided to stop, which is precisely the failure the halt exists to prevent.
// ok=false means the track was no longer rolling (already halted, or completed);
// the caller should still answer its node "not eligible".
func (s *SQLiteStore) HaltRolloutTrack(ctx context.Context, track, reason string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET status = 'halted', halted_reason = ?, stage_started_at = ?
		   WHERE track = ? AND status = 'rolling'`,
		reason, at, track)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// CompleteRolloutTrack marks a track finished, conditional on it still being
// 'rolling'. Used by both the fleet and byo "complete" decisions.
//
// Same clobber risk as HaltRolloutTrack, just with the roles reversed: a
// whole-row PutRolloutTrack writing {Status:complete, HaltedReason:""}
// unconditionally over a row a concurrent instance just halted would erase
// the halt and its reason, and would report to operators that a release the
// failure check had already stopped shipped successfully. On the fleet track
// it also clears current_node_id (there is no node in flight once a track is
// complete); on byo the column is already always empty, so clearing it there
// is a no-op, not a behaviour change.
// ok=false means the track was no longer rolling when this landed (already
// halted, already completed, or advanced past the state this decision was
// computed from) — the caller must not treat the transition as having
// happened.
func (s *SQLiteStore) CompleteRolloutTrack(ctx context.Context, track string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET status = 'complete', current_node_id = '', stage_started_at = ?
		   WHERE track = ? AND status = 'rolling'`,
		at, track)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// AdvanceByoBatch opens the next, wider byo batch, but ONLY if the row is
// still 'rolling' AND still at fromBatch — the percentage this decision was
// computed from.
//
// Both conditions are load-bearing, and dropping either reproduces the worst
// finding in this package: an instance that read ByoBatch=10 while rolling,
// then (after a concurrent instance halted the track for too many failures)
// blindly wrote {Status:rolling, ByoBatch:50, HaltedReason:""} via
// PutRolloutTrack, would silently undo the halt AND move the ladder from a
// 10% canary straight to a 50% batch — shipping a release the failure check
// had explicitly decided to stop to five times as many nodes, with no record
// that it was ever halted. WHERE status='rolling' stops that. WHERE
// byo_batch=fromBatch additionally stops two instances that both read
// ByoBatch=10 concurrently from each independently advancing it (10->50, then
// 50->100 from the second instance's stale read), which would let the 50%
// batch's observation window be skipped entirely.
// ok=false means the row already moved (halted, completed, or advanced by
// another instance) since this decision was computed — the caller must not
// command the batch it computed as if it were now open, and should answer
// "not eligible" for this poll instead.
func (s *SQLiteStore) AdvanceByoBatch(ctx context.Context, track string, fromBatch, toBatch int, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET byo_batch = ?, stage_started_at = ?
		   WHERE track = ? AND status = 'rolling' AND byo_batch = ?`,
		toBatch, at, track, fromBatch)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// NodesByOwnerType returns EVERY node of one ownership class ("fleet" | "user"),
// INCLUDING offline ones — deliberately unfiltered by last_seen_at.
//
// This exists because the rollout state machines require it: decideFleet does
// its own online filtering and relies on seeing the offline row of the node it
// is currently updating, since a node bricked mid-update simply stops
// heartbeating. Feeding it a pre-filtered listing (OnlineNodes) would make that
// node vanish from the snapshot instead of halting the track, and decideByo's
// batch ordering is computed over the whole population so membership does not
// shift as nodes flap. Do not "optimise" this into a last_seen_at filter.
func (s *SQLiteStore) NodesByOwnerType(ctx context.Context, ownerType string) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type = ? ORDER BY id`, ownerType)
}

// CommandNodeUpdate records that central has just told a node to self-update.
// All three writes are load-bearing and must happen together:
//   - update_started_at is the clock the silence/brick check runs against;
//   - update_from_version is what makes a later result attributable to THIS
//     rollout — without it decideByo's failure accounting is entirely inert
//     (both numerator and denominator are empty) and the BYO track can never
//     halt however bad the build is;
//   - update_result is CLEARED, because it deliberately survives re-register
//     and heartbeat and nothing else ever resets it: a stale "failed" from the
//     node's previous command would otherwise be read as a failure of the
//     command being issued right now.
//   - update_attempts is reset to 0 for hygiene. Nothing reads it as a bound
//     anymore (the fleet resume path now bounds itself by elapsed time since
//     update_started_at, not by this counter — see Node.UpdateAttempts), but
//     resetting it here costs nothing and avoids a stale nonzero value
//     lingering from a version of this code that did.
func (s *SQLiteStore) CommandNodeUpdate(ctx context.Context, nodeID, fromVersion string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET update_started_at = ?, update_from_version = ?, update_result = '', update_attempts = 0 WHERE id = ?`,
		at, fromVersion, nodeID)
	return err
}

// BumpNodeUpdateAttempts counts one more "carry on with the update you already
// hold" answer for this node. No longer called by the fleet resume path (see
// Node.UpdateAttempts) — kept, unused, per the package's schema-migration
// policy of not dropping columns/methods that a live deployment might still
// reference.
func (s *SQLiteStore) BumpNodeUpdateAttempts(ctx context.Context, nodeID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET update_attempts = update_attempts + 1 WHERE id = ?`, nodeID)
	return err
}

// SetNodeUpdateResult records the outcome a node reported for the update it was
// last commanded ("ok" | "failed" | "rolled_back" | "skipped"). It is written
// before any rollout decision is taken, so a report is never lost to a
// subsequent decision error.
func (s *SQLiteStore) SetNodeUpdateResult(ctx context.Context, nodeID, result string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET update_result = ? WHERE id = ?`, result, nodeID)
	return err
}
