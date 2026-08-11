package account

import (
	"context"
	"database/sql"
)

// SQLite side of the pair-room lifecycle. Every deadline RULE lives in
// pairroom.go; nothing here re-derives one. What these methods provide is
// atomicity — the two writes that must not be seen apart are the room's deadline
// and the deadline carried by the objects inside it.

const pairRoomCols = `id, code, user_id, created_at, last_upload_at, joined_at, closed_at, expires_at`

func scanPairRoom(sc rowScanner) (PairRoom, error) {
	var r PairRoom
	err := sc.Scan(&r.ID, &r.Code, &r.UserID, &r.CreatedAt, &r.LastUploadAt,
		&r.JoinedAt, &r.ClosedAt, &r.ExpiresAt)
	return r, err
}

// CreatePairRoomIfAbsent opens a room for r.Code unless one is already open and
// unjoined for those digits, in which case it returns THAT room and created=false.
//
// Get-or-create, atomically, because "is there a room for this code" and "make
// one" used to be two statements with a gap between them, and two files starting
// their pre-upload at the same instant is the ordinary way to land in that gap.
// Two rooms for one code strands a file: the join only ever resolves one of them,
// and whichever object is in the other expires unreachable while its uploader is
// told it was delivered.
//
// The read and the insert are one IMMEDIATE transaction (DSN _txlock), so two
// callers serialize; the partial unique index behind it is the backstop that
// makes a second open room impossible even if some future caller forgets to come
// through here.
//
// UNJOINED is the condition, not merely open: a joined room has no deadline at
// all now (pairroom.go), so a code recycled long after its previous holder
// paired must still be able to open its own room. A joined room can never be
// resolved through the digits again anyway — nothing looks up a room to join
// twice — so excluding it costs nothing and refusing service to the new holder
// would cost everything.
func (s *SQLiteStore) CreatePairRoomIfAbsent(ctx context.Context, r PairRoom) (PairRoom, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PairRoom{}, false, err
	}
	defer tx.Rollback()
	existing, err := scanPairRoom(tx.QueryRowContext(ctx,
		`SELECT `+pairRoomCols+` FROM pair_rooms
		 WHERE code = ? AND closed_at = 0 AND joined_at = 0`, r.Code))
	if err == nil {
		return existing, false, tx.Commit()
	}
	if err != sql.ErrNoRows {
		return PairRoom{}, false, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO pair_rooms (`+pairRoomCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.Code, r.UserID, r.CreatedAt, r.LastUploadAt, r.JoinedAt, r.ClosedAt,
		r.ExpiresAt); err != nil {
		return PairRoom{}, false, err
	}
	return r, true, tx.Commit()
}

func (s *SQLiteStore) GetPairRoom(ctx context.Context, id string) (PairRoom, bool, error) {
	r, err := scanPairRoom(s.reader().QueryRowContext(ctx,
		`SELECT `+pairRoomCols+` FROM pair_rooms WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return PairRoom{}, false, nil
	}
	if err != nil {
		return PairRoom{}, false, err
	}
	return r, true, nil
}

// LivePairRoomByCode returns the newest OPEN room for `code`.
//
// "Newest" is the whole safety property. A six-digit code is reusable minutes
// after it was minted, so several rows can carry the same digits over a day;
// resolving to the newest means a reissued code opens its own room and can never
// be handed a previous holder's ciphertext. The caller still checks ownership
// against the live signaling registry, so this alone is not the authorization.
func (s *SQLiteStore) LivePairRoomByCode(ctx context.Context, code string) (PairRoom, bool, error) {
	r, err := scanPairRoom(s.reader().QueryRowContext(ctx,
		`SELECT `+pairRoomCols+` FROM pair_rooms
		 WHERE code = ? AND closed_at = 0 ORDER BY created_at DESC LIMIT 1`, code))
	if err == sql.ErrNoRows {
		return PairRoom{}, false, nil
	}
	if err != nil {
		return PairRoom{}, false, err
	}
	return r, true, nil
}

// TouchPairRoomUpload records upload progress and pushes the deadline out, on
// the room and on every object in it, in one transaction.
//
// Both writes are monotonic (`? > last_upload_at`, `? > expires_at`), which is
// what makes concurrent appends for different files in the same batch safe
// without a lock: they race, the later timestamp wins, and neither can ever move
// a deadline backwards. Projecting onto the objects in the SAME transaction is
// what keeps the first file in a batch alive while the third is still uploading.
//
// Returns ErrPairRoomClosed when the room is closed, gone, or already past its
// deadline — the precondition, not a write failure. Progress that is merely
// STALE (a concurrent sibling append already moved the deadline further out)
// succeeds silently, because it changes nothing and nothing is wrong.
func (s *SQLiteStore) TouchPairRoomUpload(ctx context.Context, id string, at, expiresAt int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	open, err := touchPairRoomOn(ctx, tx, id, at, expiresAt)
	if err != nil {
		return err
	}
	if !open {
		return ErrPairRoomClosed
	}
	return tx.Commit()
}

// touchPairRoomOn is TouchPairRoomUpload's body, so the append path can do it in
// the SAME transaction that advances the offset and bills the bytes: progress,
// its bill and the deadline it buys are one fact, and a partial write of them is
// how ciphertext ends up expiring under an upload the account is still paying
// for.
//
// It reports whether the room was OPEN, which is the distinction the UPDATE
// alone cannot make. Its WHERE clause folds three conditions together —
// "closed", "gone" and "this progress is older than what the room already has" —
// and a zero row count used to be read as success for all three. The first two
// mean bytes are being accepted for ciphertext that is already void; the third
// is the ordinary result of two files in one batch uploading at once. Telling
// them apart needs the row, so this reads it (inside the caller's write-locked
// transaction, so the read and the update cannot be separated by a close).
func touchPairRoomOn(ctx context.Context, tx *sql.Tx, id string, at, expiresAt int64) (bool, error) {
	open, err := pairRoomOpenOn(ctx, tx, id, at)
	if err != nil || !open {
		return false, err
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE pair_rooms SET last_upload_at = ?, expires_at = ?
		 WHERE id = ? AND closed_at = 0 AND ? > last_upload_at AND ? > expires_at`,
		at, expiresAt, id, at, expiresAt)
	if err != nil {
		return true, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return true, nil // open, but already past this point — nothing to project
	}
	_, err = tx.ExecContext(ctx,
		`UPDATE stored_files SET expires_at = ? WHERE pair_room_id = ? AND expires_at < ?`,
		expiresAt, id, expiresAt)
	return true, err
}

// pairRoomOpenOn reports whether the room may still be written to at `at`:
// present, not closed, and inside the deadline it currently carries.
//
// Read inside the CALLER's transaction, which is what makes it a precondition
// rather than an advisory check — SQLite has one writer, so a room this returns
// true for cannot be closed until the caller's transaction commits, and
// whatever the caller writes on the strength of it cannot land in a room that
// is already void.
//
// expires_at is compared rather than re-derived because it is the materialized
// output of pairRoomExpiry (pairroom.go); the rule has one home, and SQL is not
// it.
func pairRoomOpenOn(ctx context.Context, tx *sql.Tx, id string, at int64) (bool, error) {
	var closedAt, expiresAt int64
	err := tx.QueryRowContext(ctx,
		`SELECT closed_at, expires_at FROM pair_rooms WHERE id = ?`, id).Scan(&closedAt, &expiresAt)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return closedAt == 0 && at < expiresAt, nil
}

// JoinPairRoom stamps the join and projects the post-join deadline.
//
// `joined_at = 0` in the WHERE is what makes it exactly-once: the second
// participant sets the clock, and a reconnect, a third connection attempt or a
// duplicate notification cannot re-stamp it and silently extend the storage
// window on every reconnect.
func (s *SQLiteStore) JoinPairRoom(ctx context.Context, id string, at, expiresAt int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`UPDATE pair_rooms SET joined_at = ?, expires_at = ?
		 WHERE id = ? AND closed_at = 0 AND joined_at = 0`, at, expiresAt, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE stored_files SET expires_at = ? WHERE pair_room_id = ? AND expires_at < ?`,
		expiresAt, id, expiresAt); err != nil {
		return err
	}
	return tx.Commit()
}

// ClosePairRoom ends a room and, in the same transaction, performs the whole
// void except the part that has to talk to a node.
//
// The close is conditional on the room still being open, so exactly one caller
// of two racing voids gets a non-empty closure. The other gets an empty one and
// does nothing — which is what stops two callers reclaiming the same artifact
// twice.
//
// WHAT ELSE HAPPENS HERE, AND WHY IT IS HERE. Every step below used to be the
// caller's, done one artifact at a time against a ten-second budget, and each
// one that did not get done left something the room's own promise said was
// already gone:
//
//  1. EVERY SESSION'S METER IS SETTLED. The bytes an append recorded are billed
//     now, before anything can fail. This is ClaimUploadDone's settle, inlined:
//     the same `received - metered`, charged in the same transaction as the
//     state change it belongs to.
//  2. EVERY SESSION ROW IS DELETED — whatever state it was in. An open one is a
//     pre-upload the deadline interrupted. A done one is a finalize that claimed
//     it and has not persisted an object (and, if that finalize crashed, never
//     will). An unresolved one is accounting evidence the ordinary reaper keeps
//     indefinitely and this room may not. The room's deadline outranks all three:
//     leaving any of them held the account's open-session slot and its ciphertext
//     until the generic one-hour reaper, twelve times the window the room
//     promised. A finalize still running against a deleted row fails safely on
//     the room's own precondition and drops the same blob on its way to a 410.
//  3. EVERY BLOB GETS A DURABLE DELETE INTENT, held until holdUntil. This is the
//     step that makes the two above safe. Deleting the rows removes the only
//     thing a generic sweep could have found those blobs through, so the
//     responsibility has to exist BEFORE it — and it has to outlive an append
//     that is still streaming to the node right now, which will land after the
//     delete and re-create the key (see PendingNodeDelete.NotBefore).
//
// The stored_files rows are the one thing NOT deleted here: their removal
// carries side effects that belong in one place (SQLiteStore.DeleteStoredFile,
// which also settles any inbox task pointing at the object), and unlike a
// session row a stored_files row is its own durable owner — GC's expired-file
// sweep finds it whatever else fails. The caller deletes them immediately
// afterwards, still without touching a node.
func (s *SQLiteStore) ClosePairRoom(ctx context.Context, id string, at, holdUntil int64) (PairRoomClosure, error) {
	var out PairRoomClosure
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`UPDATE pair_rooms SET closed_at = ? WHERE id = ? AND closed_at = 0`, at, id)
	if err != nil {
		return out, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return out, tx.Commit()
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE pair_room_id = ?`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		f, err := scanStoredFile(rows)
		if err != nil {
			rows.Close()
			return PairRoomClosure{}, err
		}
		out.Objects = append(out.Objects, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return PairRoomClosure{}, err
	}
	// Every session bound to the room, in every state — see (2) above.
	srows, err := tx.QueryContext(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions WHERE pair_room_id = ?`, id)
	if err != nil {
		return PairRoomClosure{}, err
	}
	for srows.Next() {
		r, err := scanUploadSession(srows)
		if err != nil {
			srows.Close()
			return PairRoomClosure{}, err
		}
		out.Sessions = append(out.Sessions, r)
	}
	srows.Close()
	if err := srows.Err(); err != nil {
		return PairRoomClosure{}, err
	}
	for _, sf := range out.Objects {
		if err := enqueueNodeDeleteOn(ctx, tx, sf.BlobKey, sf.NodeID, at, holdUntil); err != nil {
			return PairRoomClosure{}, err
		}
	}
	for i, r := range out.Sessions {
		// Own-node uploads spend the user's own disk and are never metered against
		// a plan, so there is nothing to settle for them.
		if r.Billable && r.Received > r.Metered {
			if err := recordMeterOn(ctx, tx, r.UserID, MeterUpload, r.Received-r.Metered, at); err != nil {
				return PairRoomClosure{}, err
			}
			// The caller works from these copies; saying "settled" here is what stops
			// the physical phase from billing the same bytes a second time.
			out.Sessions[i].Metered = r.Received
		}
		if r.Billable {
			// The delete intent carries the BILLING OBLIGATION too: whoever destroys
			// this blob's bytes must first durably bill any size past `received`
			// (clamped to max_size) to this user. Written HERE — the same transaction
			// that deletes the session row — because after this commit the blob is the
			// only remaining evidence of the number and this row its only owner: a
			// database that starts refusing writes a millisecond later can fail every
			// meter and every journal INSERT, and the residual still has a durable
			// owner that GC settles before it deletes. See PendingNodeDelete.BillUserID.
			if err := enqueueBilledNodeDeleteOn(ctx, tx, r.BlobKey, r.NodeID, at, holdUntil,
				r.UserID, MeterUpload, r.MaxSize, r.Received); err != nil {
				return PairRoomClosure{}, err
			}
		} else if err := enqueueNodeDeleteOn(ctx, tx, r.BlobKey, r.NodeID, at, holdUntil); err != nil {
			// Own-node uploads are never metered, so their intent is deletion-only.
			return PairRoomClosure{}, err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM upload_sessions WHERE pair_room_id = ?`, id); err != nil {
		return PairRoomClosure{}, err
	}
	return out, tx.Commit()
}

// ListDeadPairRooms returns open rooms whose deadline has passed — GC's backstop
// for a room nobody ever reads or writes again. Bounded, so a backlog drains
// over several sweeps instead of holding the single writer for one long pass.
func (s *SQLiteStore) ListDeadPairRooms(ctx context.Context, now int64, limit int) ([]PairRoom, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+pairRoomCols+` FROM pair_rooms
		 WHERE closed_at = 0 AND expires_at <= ? ORDER BY expires_at LIMIT ?`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PairRoom
	for rows.Next() {
		r, err := scanPairRoom(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PurgeClosedPairRooms drops closed rows once they are old enough that no
// in-flight request can still be resolving them. Their ciphertext went at close
// time; this reclaims the row.
func (s *SQLiteStore) PurgeClosedPairRooms(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM pair_rooms WHERE closed_at > 0 AND closed_at <= ?`, before)
	return err
}
