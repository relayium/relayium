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
func (s *SQLiteStore) CommandNodeUpdate(ctx context.Context, nodeID, fromVersion string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET update_started_at = ?, update_from_version = ?, update_result = '' WHERE id = ?`,
		at, fromVersion, nodeID)
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
