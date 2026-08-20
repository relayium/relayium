package account

import (
	"context"
	"crypto/subtle"
	"database/sql"
)

// SQLite side of the pair-room lifecycle. Every deadline RULE lives in
// pairroom.go; nothing here re-derives one. What these methods provide is
// atomicity — the two writes that must not be seen apart are the room's deadline
// and the deadline carried by the objects inside it.

// retention_secs is LAST because it was added by ALTER TABLE; the list is
// explicit everywhere so the order only has to agree with scanPairRoom and the
// one INSERT below.
const pairRoomCols = `id, code, user_id, created_at, last_upload_at, joined_at, closed_at, expires_at, retention_secs`

func scanPairRoom(sc rowScanner) (PairRoom, error) {
	var r PairRoom
	err := sc.Scan(&r.ID, &r.Code, &r.UserID, &r.CreatedAt, &r.LastUploadAt,
		&r.JoinedAt, &r.ClosedAt, &r.ExpiresAt, &r.RetentionSecs)
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
		`INSERT INTO pair_rooms (`+pairRoomCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.Code, r.UserID, r.CreatedAt, r.LastUploadAt, r.JoinedAt, r.ClosedAt,
		r.ExpiresAt, r.RetentionSecs); err != nil {
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
//
// The PairRoomTouch it hands back is the row's own answer to "what may the
// pairing code be extended to now", read after the write inside this same
// transaction. It is deliberately not derivable by the caller: a stale touch's
// row already stands further out than anything this request could project, and
// a JOINED room has no such instant at all (pairRoomCodeDeadline).
func (s *SQLiteStore) TouchPairRoomUpload(ctx context.Context, id string, at, expiresAt int64) (PairRoomTouch, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PairRoomTouch{}, err
	}
	defer tx.Rollback()
	open, err := touchPairRoomOn(ctx, tx, id, at, expiresAt)
	if err != nil {
		return PairRoomTouch{}, err
	}
	if !open {
		return PairRoomTouch{}, ErrPairRoomClosed
	}
	// Re-read rather than reuse the value the precondition saw: the UPDATE above
	// is this transaction's own move, and the answer has to include it. Inside the
	// write-locked transaction, so nothing can land between the write and the read
	// it is reported from.
	room, found, err := pairRoomRowOn(ctx, tx, id)
	if err != nil {
		return PairRoomTouch{}, err
	}
	if !found {
		return PairRoomTouch{}, ErrPairRoomClosed
	}
	if err := tx.Commit(); err != nil {
		return PairRoomTouch{}, err
	}
	return PairRoomTouch{CodeDeadline: pairRoomCodeDeadline(room)}, nil
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
	r, found, err := pairRoomRowOn(ctx, tx, id)
	if err != nil || !found {
		return false, err
	}
	return pairRoomOpenAt(r, at), nil
}

// pairRoomOpenAt is that same test applied to a row the caller has ALREADY read,
// so a transaction that needs the room's other columns as well (the join
// deadline it now carries — see CommitUploadProgress) does not have to read it
// twice or restate the rule to reuse it.
func pairRoomOpenAt(r PairRoom, at int64) bool {
	return r.ClosedAt == 0 && at < r.ExpiresAt
}

// pairRoomRowOn reads the room's whole row inside the caller's transaction —
// the same read pairRoomOpenOn is built on, kept separate because a caller that
// must also REPORT the room (rather than only decide whether to write to it)
// needs the columns the deadline is derived from, and reading them anywhere but
// inside the write-locked transaction is exactly the stale snapshot this is
// here to avoid.
func pairRoomRowOn(ctx context.Context, tx *sql.Tx, id string) (PairRoom, bool, error) {
	r, err := scanPairRoom(tx.QueryRowContext(ctx,
		`SELECT `+pairRoomCols+` FROM pair_rooms WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return PairRoom{}, false, nil
	}
	if err != nil {
		return PairRoom{}, false, err
	}
	return r, true, nil
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
// The stored_files rows are removed here too, through deleteStoredFileOn rather
// than a bare DELETE so its inbox-task side effects stay centralized. Keeping
// this in the same transaction is what makes a successful close mean storage
// quota was actually released: a caller must never report success after the
// room closed while one of its forever-live accounting rows survived.
func (s *SQLiteStore) ClosePairRoom(ctx context.Context, id string, at, holdUntil int64) (PairRoomClosure, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PairRoomClosure{}, err
	}
	defer tx.Rollback()
	out, err := closePairRoomOn(ctx, tx, id, at, holdUntil)
	if err != nil {
		return PairRoomClosure{}, err
	}
	return out, tx.Commit()
}

// CloseOwnedPairRoom is the account-facing destructive boundary. Ownership,
// joined state, upload idleness and the close are decided under one writer
// transaction. Foreign, absent and already-closed ids deliberately share one
// outcome so this endpoint cannot become an existence oracle.
func (s *SQLiteStore) CloseOwnedPairRoom(ctx context.Context, userID, id string, at, holdUntil int64) (PairRoomClosure, PairRoomOwnerReleaseOutcome, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PairRoomClosure{}, PairRoomOwnerReleaseGone, err
	}
	defer tx.Rollback()
	room, err := scanPairRoom(tx.QueryRowContext(ctx,
		`SELECT `+pairRoomCols+` FROM pair_rooms WHERE id = ? AND user_id = ? AND closed_at = 0`, id, userID))
	if err == sql.ErrNoRows {
		return PairRoomClosure{}, PairRoomOwnerReleaseGone, tx.Commit()
	}
	if err != nil {
		return PairRoomClosure{}, PairRoomOwnerReleaseGone, err
	}
	if room.JoinedAt == 0 {
		return PairRoomClosure{}, PairRoomOwnerReleaseWaiting, tx.Commit()
	}
	var busy int
	if err := tx.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE pair_room_id = ?)`, id).Scan(&busy); err != nil {
		return PairRoomClosure{}, PairRoomOwnerReleaseGone, err
	}
	if busy != 0 {
		return PairRoomClosure{}, PairRoomOwnerReleaseUploading, tx.Commit()
	}
	out, err := closePairRoomOn(ctx, tx, id, at, holdUntil)
	if err != nil {
		return PairRoomClosure{}, PairRoomOwnerReleaseGone, err
	}
	if err := tx.Commit(); err != nil {
		return PairRoomClosure{}, PairRoomOwnerReleaseGone, err
	}
	return out, PairRoomOwnerReleaseDone, nil
}

func closePairRoomOn(ctx context.Context, tx *sql.Tx, id string, at, holdUntil int64) (PairRoomClosure, error) {
	var out PairRoomClosure
	res, err := tx.ExecContext(ctx,
		`UPDATE pair_rooms SET closed_at = ? WHERE id = ? AND closed_at = 0`, at, id)
	if err != nil {
		return out, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return out, nil
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
	for _, sf := range out.Objects {
		if err := deleteStoredFileOn(ctx, tx, sf.ID, at); err != nil {
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
	return out, nil
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

// pairRoomHoldingWhere is the ONE definition of "a pair room this account is
// being charged for and may release", shared byte for byte by the listing and by
// its totals so a row can never appear in one and be missing from the other.
//
// Each condition is load-bearing:
//
//   - user_id = ?: the whole authorization. There is no shape of this query that
//     can reach another account's room, so the listing is not "filtered" by
//     ownership — it is defined by it.
//   - closed_at = 0: a closed room's ciphertext is already gone. Its row lingers
//     for pairRoomPurgeAfter so a late request can be answered, and offering a
//     release button for it would be offering to delete nothing.
//   - joined_at > 0: THE SAFETY BOUNDARY, and the one choice here worth arguing.
//     An UNJOINED room is on a clock (pairRoomJoinDeadline) that ends it and
//     deletes its ciphertext within minutes, entirely without the user; it is
//     also the state a pre-upload is IN while it is happening, and while a batch
//     is between its files there is no upload session bound to the room at all,
//     so an eligibility test could not tell "idle" from "mid-batch". Listing one
//     would put a delete control next to a transfer that is still being uploaded,
//     and offer a destructive answer to a problem that solves itself. A JOINED
//     room is the opposite on both counts: no clock will ever end it (invariant
//     5), and no new upload can bind to it (pairRoomForUpload refuses a joined
//     room), so its contents are settled. That is the storage this surface
//     exists for.
//   - the JOIN to stored_files: a room holding no finalized object is holding no
//     ciphertext and is costing the account nothing. GC's own hygiene pass
//     collects it (CloseEmptyJoinedPairRooms); a 0-byte row in a storage list is
//     an invitation to click something for no reason.
const pairRoomHoldingWhere = `r.user_id = ? AND r.closed_at = 0 AND r.joined_at > 0`

// ListPairRoomHoldings answers "what pair-room ciphertext is this account
// holding", bounded.
//
// TWO QUERIES, because the answer has two halves with different bounds: the page
// is capped at `limit` rows, and the totals are not capped at all. Reporting a
// total that stopped at the cap would understate the storage this surface exists
// to explain, which is worse than showing no number.
//
// ORDER IS TOTAL, not merely "by date": created_at DESC, id DESC. Rooms created
// in the same second are ordinary (a batch opens exactly one room, but two
// separate transfers a moment apart are not), and an ORDER BY that leaves ties
// to SQLite's discretion makes the page boundary — and therefore what a user
// sees — nondeterministic between two identical requests.
//
// The two statements are not in one transaction. A room that ends between them
// can make the totals disagree with the page by one room, which is a stale
// number on a screen that is about to be refreshed rather than a wrong decision:
// nothing is authorized from this answer — release re-derives every precondition
// under the writer lock — and Truncated is derived so that the disagreement
// cannot turn into a false "there is more than this".
func (s *SQLiteStore) ListPairRoomHoldings(ctx context.Context, userID string, limit int) (PairRoomHoldings, error) {
	var out PairRoomHoldings
	if limit <= 0 {
		return out, nil
	}
	if err := s.reader().QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT r.id), COUNT(f.id), COALESCE(SUM(f.size), 0)
		   FROM pair_rooms r JOIN stored_files f ON f.pair_room_id = r.id
		  WHERE `+pairRoomHoldingWhere, userID).
		Scan(&out.Total.Rooms, &out.Total.Objects, &out.Total.Bytes); err != nil {
		return PairRoomHoldings{}, err
	}
	if out.Total.Rooms == 0 {
		return out, nil
	}
	rows, err := s.reader().QueryContext(ctx,
		`SELECT r.id, r.created_at, r.joined_at, COUNT(f.id), COALESCE(SUM(f.size), 0),
		        NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.pair_room_id = r.id)
		   FROM pair_rooms r JOIN stored_files f ON f.pair_room_id = r.id
		  WHERE `+pairRoomHoldingWhere+`
		  GROUP BY r.id
		  ORDER BY r.created_at DESC, r.id DESC
		  LIMIT ?`, userID, limit)
	if err != nil {
		return PairRoomHoldings{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var h PairRoomHolding
		if err := rows.Scan(&h.RoomID, &h.CreatedAt, &h.JoinedAt, &h.Objects, &h.Bytes,
			&h.Releasable); err != nil {
			return PairRoomHoldings{}, err
		}
		out.Rooms = append(out.Rooms, h)
	}
	if err := rows.Err(); err != nil {
		return PairRoomHoldings{}, err
	}
	// Both conditions, not just the second: the totals were read a statement
	// earlier, so a room that ended in between would make "more rooms than rows"
	// true for a page that is in fact complete — and tell the user their list is
	// partial when it is not. A page that did not reach the cap cannot have been
	// cut by it.
	out.Truncated = len(out.Rooms) == limit && out.Total.Rooms > int64(len(out.Rooms))
	return out, nil
}

// CompletePairRoomObject is the receiver's "I have it" — the authoritative half,
// in one transaction.
//
// It is the counterpart to ClosePairRoom rather than a variation on it. A close
// is the room's DEADLINE arriving and takes everything; this is one object being
// collected on purpose, by somebody holding a capability for that object alone,
// while its siblings and any upload still arriving carry on untouched.
//
// THE CHECK IS INSIDE THE TRANSACTION, and that is not tidiness. Two receivers —
// or one receiver retrying a request whose answer it never saw — reach this at
// once, and a verdict reached outside would let both act on it: two delete
// intents for one blob, two releases of one room. Checking under the writer lock
// means the loser finds no row and is answered "already done", which is both true
// and safe.
//
// THE ORDER INSIDE IT IS INTENT FIRST, exactly as ClosePairRoom's is, and for the
// same reason. Deleting the row removes the only thing a generic sweep could ever
// have found the blob through, so the responsibility has to be older than the
// removal. Commit in this order and every crash leaves a blob with an owner;
// commit in the other and a crash between the two leaves ciphertext nothing
// points at.
//
// The PHYSICAL delete is not here and must not be: it talks to a node, which can
// be slow, unreachable or hostile, and none of those may hold up an answer or
// leave the database half-changed. The caller does it afterwards, best-effort,
// against the intent this already wrote.
//
// Four outcomes, and the three refusals are deliberately not one:
//
//   - GONE covers absent, already completed, and not-a-pair-room-object. One
//     answer for all three, because this endpoint is unauthenticated and telling
//     them apart is an existence oracle over every stored object. It is also what
//     makes a share or a Device Inbox object untouchable here: the purpose test
//     is part of the same SELECT that finds the row.
//   - NO VERIFIER is a pair-room object whose sender never asked for a completion
//     capability. Its own outcome because the receiver has to be able to tell it
//     from a wrong proof — one means "keep trying", the other means "this object
//     cannot be ended this way at all".
//   - MISMATCH is a wrong proof, and nothing is written.
//   - DONE removed the row. RoomClosed says whether it also ended the room.
//
// THE ROOM'S OWN DEADLINE IS NOT CONSULTED, deliberately. An object whose room is
// over is void either way, so completing it deletes ciphertext that was already
// forfeit — the same outcome by a shorter path — and it cannot close the room,
// because an expired room is by definition unjoined and the join test below
// refuses it. The room's deadline stays exactly what ends an unjoined room.
//
// It opens the WRITE transaction even for the refusals, which on an
// unauthenticated endpoint is worth stating rather than glossing: SQLite has one
// writer, so a flood of wrong proofs serializes against every other write. The
// protection is the per-IP budget the handler spends first — the same one the
// blob route uses — and the work inside is one indexed lookup. The alternative,
// a cheap read outside the transaction to reject early, would put the purpose and
// verifier rules in two places and let a stale read answer differently from the
// authoritative one; that is the wrong trade for a saved lock on a path that
// cannot even reach a row unless pre-upload is enabled.
func (s *SQLiteStore) CompletePairRoomObject(ctx context.Context, id string, verifier []byte, at, holdUntil int64) (PairRoomCompletion, error) {
	var out PairRoomCompletion
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	f, err := scanStoredFile(tx.QueryRowContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE id = ? AND purpose = ?`,
		id, StoredPurposePairRoom))
	if err == sql.ErrNoRows {
		return out, tx.Commit() // gone, never was, or never this endpoint's to touch
	}
	if err != nil {
		return out, err
	}
	if len(f.CompletionVerifier) == 0 {
		out.Outcome = PairRoomCompletionNoVerifier
		return out, tx.Commit()
	}
	// Constant time, because the alternative leaks how much of a guess was right
	// and turns a 32-byte credential into a byte-at-a-time search. ConstantTimeCompare
	// answers 0 for a length mismatch as well, which is the right answer for a
	// value that is not a verifier at all.
	if subtle.ConstantTimeCompare(f.CompletionVerifier, verifier) != 1 {
		out.Outcome = PairRoomCompletionMismatch
		return out, tx.Commit()
	}
	if err := enqueueNodeDeleteOn(ctx, tx, f.BlobKey, f.NodeID, at, holdUntil); err != nil {
		return PairRoomCompletion{}, err
	}
	if err := deleteStoredFileOn(ctx, tx, f.ID, at); err != nil {
		return PairRoomCompletion{}, err
	}
	out.Outcome, out.Object = PairRoomCompletionDone, f
	closed, room, err := closeEmptiedPairRoomOn(ctx, tx, f.PairRoomID, at)
	if err != nil {
		return PairRoomCompletion{}, err
	}
	out.RoomClosed, out.Room = closed, room
	return out, tx.Commit()
}

// closeEmptiedPairRoomOn ends a room that has just run out of things to hold —
// but only if somebody has JOINED it.
//
// The join condition is the whole rule, and it is not a safety margin. An
// unjoined room is still WAITING: nobody has arrived, more files of the batch may
// be on their way, and closing it would refuse the next upload and strand a
// sender mid-transfer. What ends an unjoined room is its deadline, which is
// untouched by any of this. A joined room has no deadline at all (invariant 5),
// so a completion is the only thing that can ever end one — which is precisely
// why this is here.
//
// "Holds nothing" is objects AND upload sessions. A session is an upload still
// arriving, and §3 of the protocol promises that an upload already in flight when
// the peer joined is allowed to finish; closing the room out from under it would
// break that promise and throw away bytes the sender has already been billed for.
//
// Read inside the caller's transaction, so the emptiness and the close cannot be
// separated: SQLite has one writer, so nothing can bind a new object or session
// to the room between the two.
func closeEmptiedPairRoomOn(ctx context.Context, tx *sql.Tx, roomID string, at int64) (bool, PairRoom, error) {
	if roomID == "" {
		return false, PairRoom{}, nil
	}
	room, found, err := pairRoomRowOn(ctx, tx, roomID)
	if err != nil || !found {
		return false, PairRoom{}, err
	}
	if room.ClosedAt != 0 || room.JoinedAt == 0 {
		return false, PairRoom{}, nil
	}
	empty, err := pairRoomHoldsNothingOn(ctx, tx, roomID)
	if err != nil || !empty {
		return false, PairRoom{}, err
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE pair_rooms SET closed_at = ? WHERE id = ? AND closed_at = 0`, at, roomID)
	if err != nil {
		return false, PairRoom{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, PairRoom{}, nil
	}
	room.ClosedAt = at
	return true, room, nil
}

// pairRoomHoldsNothingOn reports whether a room has neither a stored object nor
// an upload session left. Both halves, always: a room is empty when there is
// nothing to fetch AND nothing still arriving.
func pairRoomHoldsNothingOn(ctx context.Context, tx *sql.Tx, roomID string) (bool, error) {
	var any int
	err := tx.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM stored_files   WHERE pair_room_id = ?)
		     OR EXISTS(SELECT 1 FROM upload_sessions WHERE pair_room_id = ?)`,
		roomID, roomID).Scan(&any)
	return any == 0, err
}

// CloseEmptyJoinedPairRooms is GC's hygiene pass for the one room shape nothing
// else can ever collect.
//
// A joined room has no deadline (invariant 5), so ListDeadPairRooms cannot see
// it, and a completion closes it only when the completion is what empties it. The
// gap those two leave is real and is reachable by ordinary use: the last object
// is completed while an upload is still in flight — correctly leaving the room
// open — and that upload is then abandoned rather than finalized, so the generic
// reaper takes its session and the room is left holding nothing, open, forever.
// The row is small, but "forever" times one per abandoned transfer is not a
// bound, and a table nothing can ever delete from is the kind of leak that is
// discovered years later.
//
// THE AGE GUARD IS NOT COSMETIC. A room is created by the request that starts the
// first pre-upload, and its session row is inserted a statement later; a sweep
// landing in that gap, for a room joined in the same instant, would close a room
// whose upload is about to bind to it. `before` is the caller's grace period and
// is orders of magnitude longer than that gap, so the sweep only ever sees rooms
// whose emptiness is settled rather than momentary.
//
// Bounded, like every other sweep here, so a backlog drains over several ticks
// instead of holding the single writer for one long pass.
//
// IT ANSWERS WITH THE ROOMS, NOT A COUNT, and that is a requirement rather than a
// convenience. Closing a room is only half of a void: a room that is over takes
// its CODE with it (revokePairCode), and the revoke is bounded by the room's own
// identity — owner and join deadline (PairCodes.RevokeFor). A count cannot be
// revoked against, and re-reading the rows afterwards would be reading them after
// the fact: the caller needs the row as it was when this transaction changed it,
// because a re-read can be a different incarnation of the same digits. Each
// returned room is its pre-close row with closed_at stamped, which is exactly what
// the revoke's owner-and-deadline guard is defined over (the join deadline is
// derived from created_at/last_upload_at and is untouched by the close).
//
// SELECT-then-UPDATE in ONE transaction rather than one UPDATE ... FROM/RETURNING:
// this pool's transactions are IMMEDIATE (DSN _txlock), so the write lock is held
// from the first statement and nothing can bind an object or a session to a
// candidate room between the read and the write. The per-row `closed_at = 0` guard
// is what makes the returned set exactly the set this call changed — a room some
// other path closed first is simply not in it, so its code is not revoked twice.
func (s *SQLiteStore) CloseEmptyJoinedPairRooms(ctx context.Context, before, at int64, limit int) ([]PairRoom, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx,
		`SELECT `+pairRoomCols+` FROM pair_rooms
		  WHERE closed_at = 0 AND joined_at > 0 AND created_at <= ?
		    AND NOT EXISTS (SELECT 1 FROM stored_files    WHERE pair_room_id = pair_rooms.id)
		    AND NOT EXISTS (SELECT 1 FROM upload_sessions WHERE pair_room_id = pair_rooms.id)
		  LIMIT ?`, before, limit)
	if err != nil {
		return nil, err
	}
	var candidates []PairRoom
	for rows.Next() {
		r, err := scanPairRoom(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var closed []PairRoom
	for _, r := range candidates {
		res, err := tx.ExecContext(ctx,
			`UPDATE pair_rooms SET closed_at = ? WHERE id = ? AND closed_at = 0`, at, r.ID)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		r.ClosedAt = at
		closed = append(closed, r)
	}
	// Nothing is reported unless it committed. A caller that revoked codes for a
	// close this transaction then rolled back would leave live rooms nobody can
	// reach — so a failed commit answers with no rooms at all, not with the ones
	// it meant to close.
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return closed, nil
}
