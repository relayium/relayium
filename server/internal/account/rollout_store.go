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
