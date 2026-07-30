package account

import (
	"context"
	"database/sql"
)

// rolloutCols is the column list shared by GetRolloutTrack's SELECT and
// PutRolloutTrack's upsert, so the two can never drift out of order.
const rolloutCols = `track, target_version, previous_version, current_node_id, first_node_id, byo_batch, stage_started_at, status, halted_reason, emergency`

// GetRolloutTrack returns the persisted state of the given track ("fleet" |
// "byo"). ok=false means no row has been written for that track yet (a fresh
// DB, or a track whose rollout has never been started) — not an error.
func (s *SQLiteStore) GetRolloutTrack(ctx context.Context, track string) (RolloutTrack, bool, error) {
	var t RolloutTrack
	var emergency int
	err := s.reader().QueryRowContext(ctx,
		`SELECT `+rolloutCols+` FROM node_rollout WHERE track = ?`, track).
		Scan(&t.Track, &t.TargetVersion, &t.PreviousVersion, &t.CurrentNodeID, &t.FirstNodeID, &t.ByoBatch, &t.StageStartedAt, &t.Status, &t.HaltedReason, &emergency)
	t.Emergency = emergency != 0
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
//
// previous_version is the one deliberate exception: an incoming empty value is
// a no-op (CASE below), not a wipe. It is the only thing that makes the BYO
// self-rollback button possible at all (see RollbackByoToPreviousVersion), and
// a future caller of this whole-row upsert that simply forgets to carry
// PreviousVersion forward would otherwise silently erase that history on its
// very next write. Both current writers of an intentionally-empty
// PreviousVersion are safe under this: setTargetVersion's non-byo branch
// (byoPreviousVersion returns "" for the fleet track, which never has — and
// never reads — rollback history) and RollbackByoToPreviousVersion's
// self-reference guard (it writes "" only when the destination equals the
// track's own current target, i.e. there is genuinely nothing to preserve).
// Neither ever needs an empty write to actually CLEAR a previously-recorded
// version.
func (s *SQLiteStore) PutRolloutTrack(ctx context.Context, t RolloutTrack) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO node_rollout (`+rolloutCols+`) VALUES (?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(track) DO UPDATE SET
		   target_version=excluded.target_version,
		   previous_version=CASE WHEN excluded.previous_version = '' THEN previous_version ELSE excluded.previous_version END,
		   current_node_id=excluded.current_node_id,
		   first_node_id=excluded.first_node_id,
		   byo_batch=excluded.byo_batch, stage_started_at=excluded.stage_started_at,
		   status=excluded.status, halted_reason=excluded.halted_reason,
		   emergency=excluded.emergency`,
		t.Track, t.TargetVersion, t.PreviousVersion, t.CurrentNodeID, t.FirstNodeID, t.ByoBatch, t.StageStartedAt, t.Status, t.HaltedReason, b2i(t.Emergency))
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
//   - AND target_version = expectTargetVersion: an admin RETARGET (the only way
//     target_version ever changes) leaves status='rolling' and clears
//     current_node_id, so without this term a decision computed from the OLD
//     target still satisfies every other condition. The observed consequence is
//     not merely a wasted poll: the node is handed the STALE target in its
//     response and installs the old version, while the row records it as the NEW
//     rollout's current node. decideFleet then sees a node that is alive, has
//     update_started_at set, reported "ok", and is not on target — which is the
//     plain "wait" branch, with no halt and no timeout. The fleet track wedges,
//     showing 发布中 forever.
//
// firstNodeID is written unconditionally, so the caller passes the value it
// wants persisted (the unchanged one when the pick is not the canary).
func (s *SQLiteStore) ClaimRolloutNode(ctx context.Context, track, expectTargetVersion, expectCurrentNodeID, nodeID, firstNodeID string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET current_node_id = ?, first_node_id = ?, stage_started_at = ?
		   WHERE track = ? AND current_node_id = ? AND status = 'rolling' AND target_version = ?`,
		nodeID, firstNodeID, at, track, expectCurrentNodeID, expectTargetVersion)
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

// ResumeRolloutTrack restarts a HALTED track on the version it already
// targets, conditional on it still being 'halted' so a concurrent instance's
// complete (or a fresh target) is never clobbered.
//
// It touches ONE track's row and reads nothing else — in particular it does
// NOT go through SetTargetVersion. That is deliberate: SetTargetVersion's byo
// branch consults the fleet track, so resuming a halted byo rollout through it
// would fail the moment the fleet had moved on to a NEWER version (fleet is
// then 'rolling', not 'complete' at the byo target), i.e. an unrelated fleet
// release would silently make the byo track unresumable. The gate exists to
// stop byo from being pointed at a version the fleet never completed; resuming
// a target the fleet already certified is not that.
//
// The reset of the positional/staging fields is not optional:
//   - byo_batch back to 0, because decideByo's doc records that resuming a
//     halted rollout on the SAME target with a non-zero batch re-evaluates the
//     same batch against the same failing nodes and re-halts immediately, with
//     a byte-identical reason, forever.
//   - current_node_id/first_node_id cleared, for the same reason on the fleet
//     side: the node that failed is still recorded as in flight with its
//     failure still on its row, so decideFleet would halt again on its very
//     next evaluation. Clearing them starts a fresh canary pick.
//   - emergency back to 0: resuming is the staged, careful path. An emergency
//     release that was halted must be re-armed explicitly (and re-confirmed),
//     never silently by pressing 继续.
func (s *SQLiteStore) ResumeRolloutTrack(ctx context.Context, track string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET status = 'rolling', halted_reason = '', current_node_id = '',
		   first_node_id = '', byo_batch = 0, emergency = 0, stage_started_at = ?
		   WHERE track = ? AND status = 'halted'`,
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

// SetRolloutEmergency arms emergency mode on a track that is rolling to
// expectVersion, as a compare-and-swap against what the operator saw.
//
// NO LONGER ON THE ADMIN PATH, and it must not be put back there. Arming used
// to be this second statement after SetTargetVersion had already repointed the
// track, and the gap between the two was a real bug: when this returned
// ok=false (or an error) the operator was told 紧急发布失败 while the track was
// already rolling to that version on the STAGED ladder, unaudited. Repointing
// and arming are now one row write — see Service.SetEmergencyTargetVersion.
// Kept (unused) per this package's policy of not dropping store methods a live
// deployment might still be calling mid-rollout.
func (s *SQLiteStore) SetRolloutEmergency(ctx context.Context, track, expectVersion string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET emergency = 1, stage_started_at = ?
		   WHERE track = ? AND status = 'rolling' AND target_version = ?`,
		at, track, expectVersion)
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
//
// It also clears `emergency`: a finished track is not "紧急发布中", and leaving
// the column at 1 left the red 紧急发布中（已跳过分批） badge sitting next to
// 已完成 on the dashboard forever. Nothing reads emergency once status is no
// longer 'rolling' (handleUpdateCheck returns before the emergency branch), so
// this is a display fix, not a behaviour change — and every path back into
// 'rolling' (SetTargetVersion, ResumeRolloutTrack) already sets it explicitly.
// ok=false means the track was no longer rolling when this landed (already
// halted, already completed, or advanced past the state this decision was
// computed from) — the caller must not treat the transition as having
// happened.
func (s *SQLiteStore) CompleteRolloutTrack(ctx context.Context, track string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET status = 'complete', current_node_id = '', emergency = 0, stage_started_at = ?
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
//
// WHERE target_version = expectTargetVersion closes the same window against an
// admin RETARGET rather than against another instance: a retarget leaves
// status='rolling' and resets byo_batch to 0, so a stale 10->50 advance computed
// from the previous target used to match (byo_batch was momentarily still 10 in
// the losing instance's read) and land against the NEW rollout — skipping the
// 10% canary's whole observation window, and commanding the nodes it computed
// with the version that is no longer the target.
//
// ok=false means the row already moved (halted, completed, retargeted, or
// advanced by another instance) since this decision was computed — the caller
// must not command the batch it computed as if it were now open, and should
// answer "not eligible" for this poll instead.
func (s *SQLiteStore) AdvanceByoBatch(ctx context.Context, track, expectTargetVersion string, fromBatch, toBatch int, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE node_rollout SET byo_batch = ?, stage_started_at = ?
		   WHERE track = ? AND status = 'rolling' AND byo_batch = ? AND target_version = ?`,
		toBatch, at, track, fromBatch, expectTargetVersion)
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
//
// Uninstalled nodes (removed_at != 0) ARE filtered out, and that is a different
// question from being offline: a deregistered machine is not coming back, so it
// must never be picked for an update. It still looks online for the ~90 seconds
// its last heartbeat stays fresh, and decideFleet's candidate filter is just
// "online and not on target" — so without this the fleet track could command an
// update to a machine that is being uninstalled right now, then halt the whole
// track on "silent since update started" and wait for an operator.
func (s *SQLiteStore) NodesByOwnerType(ctx context.Context, ownerType string) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type = ? AND removed_at = 0 ORDER BY id`, ownerType)
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

// ClearPassedOverResults wipes the update results that decideFleet reads as
// "this node has already had its turn in the rollout that is running now" --
// "skipped" and "unreachable" -- for one ownership class of nodes.
//
// It is what makes passedOverResult correct as a bare one-argument predicate.
// nodes.update_result deliberately outlives a rollout (it survives re-register
// and heartbeat, and CommandNodeUpdate is otherwise the only thing that clears
// it), and a node excluded by its own result is by construction never
// re-commanded, so it could never clear its own flag: without this the first
// pass-over would strand the node in EVERY later rollout, permanently. Scoping
// the exclusion at the read instead was tried twice and cannot work -- see
// passedOverResult. Clearing it at the one write that starts a new rollout can:
// afterwards a passed-over result can only belong to the rollout in flight.
//
// ownerType comes from rolloutOwnerClass, so retargeting one track can never
// clear the other track's node rows -- the fleet and byo rollouts are
// independent, and a byo retarget must not silently re-admit a fleet node the
// fleet rollout has already passed over.
//
// The other update_* columns are deliberately left alone: update_started_at and
// update_from_version are what the silence, wedge and BYO-attribution checks
// read, and clearing them here would make a node commanded moments before a
// retarget look like one that was never commanded at all.
func (s *SQLiteStore) ClearPassedOverResults(ctx context.Context, ownerType string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET update_result = '' WHERE owner_type = ? AND update_result IN ('skipped', 'unreachable')`,
		ownerType)
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
// last commanded ("ok" | "failed" | "rolled_back" | "skipped" | "unreachable").
// It is written before any rollout decision is taken, so a report is never
// lost to a subsequent decision error.
func (s *SQLiteStore) SetNodeUpdateResult(ctx context.Context, nodeID, result string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET update_result = ? WHERE id = ?`, result, nodeID)
	return err
}
