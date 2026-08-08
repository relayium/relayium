package account

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inbox"
)

// Device Inbox task queue storage (Phase 1B).
//
// Every method here is scoped by user id AND device id, and every state change
// goes through inbox.CanTransitionTask — there is no second transition rule in
// this file. What this file adds on top of that table is the three things a
// table cannot express: who may act on a task (the claim token), when a claim
// stops being valid (the lease), and what happens to queued work when the key
// it was sealed to is withdrawn.

// Device Inbox task errors. Distinct because each implies different CLIENT
// behaviour, which is the whole reason not to collapse them into one 500.
var (
	// ErrIdempotencyKeyConflict: the same (account, idempotency key) was reused
	// for a DIFFERENT task. Returning the first task would tell the sender their
	// second, different file was queued — so this fails loudly instead.
	ErrIdempotencyKeyConflict = errors.New("account: inbox idempotency key reused for a different task")
	// ErrInboxQueueFull: the target device already holds the maximum number of
	// unfinished tasks. A row-count bound, not a byte quota — see
	// inbox.MaxPendingTasksPerDevice.
	ErrInboxQueueFull = errors.New("account: device inbox queue is full")
	// ErrDeviceCannotReceive: the target is not a legitimate queue target
	// (unenrolled, revoked, unsupported protocol version, or holding no active
	// key). Deliberately NOT about presence: an offline device is a valid
	// target, which is why the queue exists.
	ErrDeviceCannotReceive = errors.New("account: device cannot receive inbox tasks")
	// ErrStaleTargetKey: the sender sealed the content key to a key that is not
	// the device's current one. Fails rather than queueing a task the device may
	// be unable to open.
	ErrStaleTargetKey = errors.New("account: inbox task target key is stale")
	// ErrStaleClaim: the reporting device does not hold the current claim. Its
	// lease expired and was reclaimed, or another claim superseded it. It must
	// stop and re-claim rather than overwrite whoever holds the task now.
	ErrStaleClaim = errors.New("account: stale inbox task claim")
	// ErrTaskTerminal: the task is finished. Reported back to a returning
	// claimant so it stops retrying, with the terminal state in the response.
	ErrTaskTerminal = errors.New("account: inbox task is already terminal")
	// ErrStoredObjectUnavailable: the referenced Stored Object does not exist
	// under this account, or has already expired/burned.
	ErrStoredObjectUnavailable = errors.New("account: referenced stored object is unavailable")
	// ErrStoredObjectAlreadyBound: a task-purpose Stored Object is already
	// delivering for another task. It is ciphertext uploaded for ONE delivery,
	// so a second send has to be a second upload. Deliberately NOT converged
	// onto the existing task: the caller asked to queue a different delivery,
	// and answering with someone else's task id would be a lie about what was
	// queued and to which device.
	ErrStoredObjectAlreadyBound = errors.New("account: stored object is already bound to a task")
)

const inboxTaskCols = `id, user_id, target_device_id, source_device_id, idempotency_key,
	stored_file_id, enc_manifest, wrap_algorithm, wrapped_key, target_key_id,
	target_key_generation, ciphertext_bytes, state, claim_token_hash, lease_expires_at,
	attempts, next_attempt_at, error_code, created_at, updated_at, expires_at,
	notified_at, saved_at, terminal_at`

// terminalStateSQL is the SQL spelling of inbox's terminal set. A test asserts
// it matches inbox.IsTerminalTaskState for every state, so the two cannot drift.
const terminalStateSQL = `('saved','expired','revoked','failed_terminal')`

// claimableStateSQL is what a claim may lease from. Deliberately excludes
// attention_required (waiting on a person) and failed_retryable (waiting on its
// backoff — requeueDueRetries moves it back to queued when the backoff is up,
// so a task is claimable only through the one state that means "ready now").
const claimableStateSQL = `('queued','notified')`

func scanInboxTask(row rowScanner) (InboxTask, error) {
	var t InboxTask
	err := row.Scan(&t.ID, &t.UserID, &t.TargetDeviceID, &t.SourceDeviceID, &t.IdempotencyKey,
		&t.StoredFileID, &t.EncManifest, &t.WrapAlgorithm, &t.WrappedKey, &t.TargetKeyID,
		&t.TargetKeyGeneration, &t.CiphertextBytes, &t.State, &t.ClaimTokenHash, &t.LeaseExpiresAt,
		&t.Attempts, &t.NextAttemptAt, &t.ErrorCode, &t.CreatedAt, &t.UpdatedAt, &t.ExpiresAt,
		&t.NotifiedAt, &t.SavedAt, &t.TerminalAt)
	return t, err
}

func scanInboxTasks(rows *sql.Rows) ([]InboxTask, error) {
	defer rows.Close()
	var out []InboxTask
	for rows.Next() {
		t, err := scanInboxTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// CreateInboxTask inserts one task, idempotently on (user_id, idempotency_key).
//
// Everything that decides whether the task may exist is re-checked INSIDE the
// transaction rather than taken from the handler's earlier reads: device
// ownership, the enrolment's ability to receive, the target key binding, the
// referenced Stored Object, and the per-device row bound. A create that raced a
// revocation, a rotation, or a file delete must lose, and the only way to
// guarantee that is to look again while holding the write lock.
//
// The starting state is DERIVED here from the target device's own
// automatic-receive policy, not supplied by the caller. Two consequences, both
// deliberate: no caller can create a task directly in `downloading` or `saved`,
// and a policy that changed between the handler's read and this write is the one
// that applies — a device switched to `off` a moment ago does not receive a task
// that raced the switch.
func (s *SQLiteStore) CreateInboxTask(ctx context.Context, t InboxTask) (InboxTask, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InboxTask{}, false, err
	}
	defer tx.Rollback()

	// Idempotent replay, checked before any other refusal: a client retrying a
	// create it already succeeded at must converge even if the device has since
	// been revoked or the key rotated. Otherwise the lost-response case would
	// look like a hard failure for a task that is actually queued and fine.
	existing, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks WHERE user_id = ? AND idempotency_key = ?`,
		t.UserID, t.IdempotencyKey))
	switch {
	case err == nil:
		if !sameInboxTaskRequest(existing, t) {
			return InboxTask{}, false, ErrIdempotencyKeyConflict
		}
		if expired, err := expireLoadedInboxTask(ctx, tx, &existing, t.CreatedAt); err != nil {
			return InboxTask{}, false, err
		} else if expired {
			return existing, false, nil
		}
		return existing, false, nil
	case !errors.Is(err, sql.ErrNoRows):
		return InboxTask{}, false, err
	}

	if err := deviceOwned(ctx, tx, t.TargetDeviceID, t.UserID); err != nil {
		return InboxTask{}, false, err
	}
	in, err := scanDeviceInbox(tx.QueryRowContext(ctx,
		`SELECT `+deviceInboxCols+` FROM device_inbox WHERE device_id = ? AND user_id = ?`,
		t.TargetDeviceID, t.UserID))
	if errors.Is(err, sql.ErrNoRows) {
		return InboxTask{}, false, ErrDeviceCannotReceive
	}
	if err != nil {
		return InboxTask{}, false, err
	}
	key, err := scanDeviceKey(tx.QueryRowContext(ctx,
		`SELECT `+deviceKeyCols+` FROM device_keys
		  WHERE device_id = ? AND user_id = ? AND superseded_at = 0 AND revoked_at = 0`,
		t.TargetDeviceID, t.UserID))
	hasKey := true
	if errors.Is(err, sql.ErrNoRows) {
		hasKey = false
	} else if err != nil {
		return InboxTask{}, false, err
	}
	if !DeviceCanReceive(in, key, hasKey) {
		return InboxTask{}, false, ErrDeviceCannotReceive
	}
	// `off` refuses outright; `ask` starts held for a person at the device;
	// `auto` queues only when the device announced the versioned auto-accept
	// behaviour and last reported a usable receive directory.
	t.State, err = inbox.InitialTaskState(in.AutoAccept, in.Capabilities, in.ReceiveDirReady)
	if err != nil {
		return InboxTask{}, false, err
	}
	// The sender must have sealed to the key that is current RIGHT NOW, both id
	// and generation. Generation is checked as well as id so a replayed create
	// carrying a stale (id, generation) pair cannot be accepted merely because
	// the id was reused — it cannot be, but the binding is cheap and the
	// generation is what the device uses to pick a private key.
	if t.TargetKeyID != key.ID || t.TargetKeyGeneration != key.Generation {
		return InboxTask{}, false, ErrStaleTargetKey
	}

	// The ciphertext must be a live Stored Object of THIS account. Size and
	// expiry are taken from the row, never from the request: the sender does not
	// get to describe how big its own ciphertext is or how long it lives.
	var (
		fileUser              string
		encManifest           []byte
		fileSize, fileExpires int64
		maxDownloads, burn    int64
		filePurpose, boundTo  string
	)
	err = tx.QueryRowContext(ctx,
		`SELECT user_id, enc_manifest, size, expires_at, max_downloads, burn_after_read,
		        purpose, inbox_task_id
		   FROM stored_files WHERE id = ?`, t.StoredFileID).
		Scan(&fileUser, &encManifest, &fileSize, &fileExpires, &maxDownloads, &burn,
			&filePurpose, &boundTo)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && fileUser != t.UserID) {
		return InboxTask{}, false, ErrStoredObjectUnavailable
	}
	if err != nil {
		return InboxTask{}, false, err
	}
	// A limited/burn object can disappear because an unrelated public-link read
	// spends its final slot. The reference data path cannot reserve an independent
	// delivery slot, so accepting one would advertise reliability central cannot
	// provide. Inbox uploads use unlimited-until-TTL retention instead.
	if fileExpires <= t.CreatedAt || maxDownloads > 0 || burn != 0 {
		return InboxTask{}, false, ErrStoredObjectUnavailable
	}
	filePurpose = purposeOrShare(filePurpose)
	if !isValidStoredPurpose(filePurpose) {
		// Persisted authorization vocabulary is a closed set. A future or
		// corrupted purpose cannot silently inherit the share-backed task path.
		return InboxTask{}, false, ErrStoredObjectUnavailable
	}
	// A task-purpose object is ciphertext uploaded for ONE delivery. If it is
	// already bound, refuse here — next to the other statements about what this
	// object is — rather than only through the conditional UPDATE below. Two
	// independent guards: this one names the reason at the point a reader looks
	// for it, and the UPDATE is what still holds under a concurrent create.
	if filePurpose == StoredPurposeDeviceTask && boundTo != "" {
		return InboxTask{}, false, ErrStoredObjectAlreadyBound
	}
	// The encrypted manifest is COPIED from the object, never accepted from the
	// request. It is already the manifest that this ciphertext's content key
	// opens, so taking it from the row makes the two impossible to disagree and
	// removes a client-supplied blob from the write path entirely.
	t.EncManifest = encManifest
	t.CiphertextBytes = fileSize
	// The task inherits the object's expiry. It cannot outlive the ciphertext it
	// points at, so there is no second TTL to keep consistent with the first and
	// no way to invent a longer retention than the account's plan allows.
	t.ExpiresAt = fileExpires
	// Queue capacity is a bound on unfinished work, not on rows awaiting the
	// periodic sweeper. Expire due tasks in this same transaction before
	// counting so an elapsed TTL cannot falsely block a new delivery.
	if _, err := expireDueInboxTasks(ctx, tx, t.TargetDeviceID, t.UserID, t.CreatedAt); err != nil {
		return InboxTask{}, false, err
	}

	var pending int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM inbox_tasks
		  WHERE target_device_id = ? AND user_id = ? AND state NOT IN `+terminalStateSQL,
		t.TargetDeviceID, t.UserID).Scan(&pending); err != nil {
		return InboxTask{}, false, err
	}
	if pending >= inbox.MaxPendingTasksPerDevice {
		return InboxTask{}, false, ErrInboxQueueFull
	}

	// Bind a TASK-PURPOSE object to this task, exactly once (Phase 1D-A).
	//
	// The conditional UPDATE is the whole mechanism: `inbox_task_id = ''` means
	// only an unbound object can be taken, so two concurrent creates naming the
	// same object produce one winner and one ErrStoredObjectAlreadyBound rather
	// than two deliveries of one ciphertext. It runs inside the create's own
	// transaction, so a create that fails any later step releases the binding
	// with it — an object is never left owned by a task that does not exist.
	//
	// A SHARE is deliberately left alone (Phase 1B compatibility): it may back
	// several tasks, it keeps its link, and no task owns it.
	if filePurpose == StoredPurposeDeviceTask {
		res, err := tx.ExecContext(ctx,
			`UPDATE stored_files SET inbox_task_id = ?
			  WHERE id = ? AND user_id = ? AND purpose = ? AND inbox_task_id = ''`,
			t.ID, t.StoredFileID, t.UserID, StoredPurposeDeviceTask)
		if err != nil {
			return InboxTask{}, false, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return InboxTask{}, false, ErrStoredObjectAlreadyBound
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO inbox_tasks (`+inboxTaskCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, '', ?, ?, ?, 0, 0, 0)`,
		t.ID, t.UserID, t.TargetDeviceID, t.SourceDeviceID, t.IdempotencyKey,
		t.StoredFileID, t.EncManifest, t.WrapAlgorithm, t.WrappedKey, t.TargetKeyID,
		t.TargetKeyGeneration, t.CiphertextBytes, t.State,
		t.CreatedAt, t.CreatedAt, t.ExpiresAt); err != nil {
		return InboxTask{}, false, err
	}
	saved, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks WHERE id = ?`, t.ID))
	if err != nil {
		return InboxTask{}, false, err
	}
	return saved, true, tx.Commit()
}

// sameInboxTaskRequest decides whether a repeated idempotency key describes the
// SAME task. It compares exactly what the SENDER chose — target device, stored
// object, sealed key and key binding — and ignores everything central derived
// (id, manifest, size, expiry, state), which cannot differ for identical input.
func sameInboxTaskRequest(existing, req InboxTask) bool {
	return existing.TargetDeviceID == req.TargetDeviceID &&
		existing.StoredFileID == req.StoredFileID &&
		existing.WrapAlgorithm == req.WrapAlgorithm &&
		existing.WrappedKey == req.WrappedKey &&
		existing.TargetKeyID == req.TargetKeyID &&
		existing.TargetKeyGeneration == req.TargetKeyGeneration
}

func (s *SQLiteStore) GetInboxTask(ctx context.Context, taskID, userID string, now int64) (InboxTask, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InboxTask{}, false, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = ?, lease_expires_at = 0, terminal_at = ?, updated_at = ?
		  WHERE id = ? AND user_id = ? AND expires_at <= ?
		    AND state NOT IN `+terminalStateSQL,
		inbox.TaskExpired, now, now, taskID, userID, now); err != nil {
		return InboxTask{}, false, err
	}
	t, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks WHERE id = ? AND user_id = ?`, taskID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return InboxTask{}, false, nil
	}
	if err != nil {
		return InboxTask{}, false, err
	}
	return t, true, tx.Commit()
}

func (s *SQLiteStore) ListInboxTasks(ctx context.Context, deviceID, userID string, now int64, limit int) ([]InboxTask, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := expireDueInboxTasks(ctx, tx, deviceID, userID, now); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks
		  WHERE target_device_id = ? AND user_id = ?
		  ORDER BY created_at DESC, id DESC LIMIT ?`, deviceID, userID, limit)
	if err != nil {
		return nil, err
	}
	out, err := scanInboxTasks(rows)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

// DeleteInboxTask removes one task the account owns, and — only when the task
// OWNED its ciphertext — the Stored Object with it.
//
// The two cases are genuinely different, which is why this is a branch and not a
// policy:
//
//   - a SHARE is untouched. The task merely referenced it; the object is the
//     account's own stored transfer with its own link, TTL and delete control,
//     and destroying it here would break a download link the user may still be
//     handing out. This is the Phase 1B rule, unchanged.
//   - a TASK-PURPOSE object is deleted. It exists only for this delivery, has no
//     link, and is deliberately absent from the account's file list — so leaving
//     it behind would strand storage the user can neither see nor reclaim, and
//     the binding index would keep it unusable for anything else forever.
//
// The returned StoredFile is the object this call orphaned physically: its row
// is gone, so the CALLER must drop the blob (and queue a retry if the node is
// unreachable). A zero value means nothing was released. Doing it in this order
// — row first, blob second — means a failed blob delete leaks a retryable
// orphan rather than destroying ciphertext whose row still promises a delivery.
func (s *SQLiteStore) DeleteInboxTask(ctx context.Context, taskID, userID string) (bool, StoredFile, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, StoredFile{}, err
	}
	defer tx.Rollback()
	// Read the owned object BEFORE the task row goes, since the binding is the
	// only thing that connects the two.
	owned, err := scanStoredFile(tx.QueryRowContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files
		  WHERE inbox_task_id = ? AND user_id = ? AND purpose = ?`,
		taskID, userID, StoredPurposeDeviceTask))
	switch {
	case errors.Is(err, sql.ErrNoRows):
		owned = StoredFile{}
	case err != nil:
		return false, StoredFile{}, err
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM inbox_tasks WHERE id = ? AND user_id = ?`, taskID, userID)
	if err != nil {
		return false, StoredFile{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Nothing was deleted (already gone, or not this account's): touch
		// nothing else, and report no release.
		return false, StoredFile{}, tx.Commit()
	}
	if owned.ID != "" {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM stored_files WHERE id = ? AND user_id = ? AND purpose = ? AND inbox_task_id = ?`,
			owned.ID, userID, StoredPurposeDeviceTask, taskID); err != nil {
			return false, StoredFile{}, err
		}
	}
	return true, owned, tx.Commit()
}

func (s *SQLiteStore) CountPendingInboxTasks(ctx context.Context, deviceID, userID string) (int64, error) {
	var n int64
	err := s.reader().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM inbox_tasks
		  WHERE target_device_id = ? AND user_id = ? AND state NOT IN `+terminalStateSQL,
		deviceID, userID).Scan(&n)
	return n, err
}

// NotifyInboxTasks marks a device's claimable tasks `notified` and returns the
// pending set.
//
// `notified` means "central has told the device about this task" (PRD §10 item
// 4). In the polling transport that IS this call: the device asked, central
// answered. Recording it here rather than at claim time keeps the two facts
// separate — a device can know about work it has not started, which is exactly
// what a device deferring to its backoff or its pause state looks like.
func (s *SQLiteStore) NotifyInboxTasks(ctx context.Context, deviceID, userID string, now int64, limit int) ([]InboxTask, error) {
	if limit <= 0 || limit > inbox.MaxClaimBatch {
		limit = inbox.MaxClaimBatch
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := requireReceivingDevice(ctx, tx, deviceID, userID); err != nil {
		return nil, err
	}
	if _, err := reclaimExpiredLeases(ctx, tx, deviceID, userID, now); err != nil {
		return nil, err
	}
	if _, err := expireDueInboxTasks(ctx, tx, deviceID, userID, now); err != nil {
		return nil, err
	}
	if err := requeueDueRetries(ctx, tx, deviceID, userID, now); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks SET state = ?, notified_at = ?, updated_at = ?
		  WHERE target_device_id = ? AND user_id = ? AND state = ?
		    AND expires_at > ? AND next_attempt_at <= ?`,
		inbox.TaskNotified, now, now, deviceID, userID, inbox.TaskQueued, now, now); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks
		  WHERE target_device_id = ? AND user_id = ? AND state NOT IN `+terminalStateSQL+`
		    AND expires_at > ?
		  ORDER BY created_at ASC, id ASC LIMIT ?`, deviceID, userID, now, limit)
	if err != nil {
		return nil, err
	}
	out, err := scanInboxTasks(rows)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

// ClaimInboxTasks leases up to max tasks for the target device and returns each
// with a freshly minted RAW claim token — returned exactly once; only the hash
// is stored.
//
// "Exactly one claimant" rests on TWO independent guards, either of which is
// sufficient today: the candidate SELECT filters on the claimable states, and
// each lease is then taken with `WHERE id = ? AND state IN (claimable)`, so a
// caller that lost sees RowsAffected == 0 and moves on. Because the store holds
// a single writer connection with an immediate txlock, the transactions are
// serialized and the SELECT alone already excludes a task another caller has
// taken — which means no test can make the conditional UPDATE the deciding
// factor. It is kept deliberately: it is what would still hold if this store
// ever gained a second writer, and it costs one WHERE clause. A test proves the
// property fails when BOTH guards are removed.
//
// Expired leases are reclaimed FIRST, in the same transaction, so a crashed
// claimant's task becomes available on the next poll instead of waiting for the
// GC sweep — which is what "the CLI restarts and continues" (PRD §14) requires.
func (s *SQLiteStore) ClaimInboxTasks(ctx context.Context, deviceID, userID string, now int64, max int) ([]InboxTask, []string, error) {
	if max <= 0 {
		max = inbox.DefaultClaimBatch
	}
	if max > inbox.MaxClaimBatch {
		max = inbox.MaxClaimBatch
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	if err := requireReceivingDevice(ctx, tx, deviceID, userID); err != nil {
		return nil, nil, err
	}
	if _, err := reclaimExpiredLeases(ctx, tx, deviceID, userID, now); err != nil {
		return nil, nil, err
	}
	if _, err := expireDueInboxTasks(ctx, tx, deviceID, userID, now); err != nil {
		return nil, nil, err
	}
	if err := requeueDueRetries(ctx, tx, deviceID, userID, now); err != nil {
		return nil, nil, err
	}

	rows, err := tx.QueryContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks
		  WHERE target_device_id = ? AND user_id = ? AND state IN `+claimableStateSQL+`
		    AND expires_at > ? AND next_attempt_at <= ?
		  ORDER BY created_at ASC, id ASC LIMIT ?`,
		deviceID, userID, now, now, max)
	if err != nil {
		return nil, nil, err
	}
	candidates, err := scanInboxTasks(rows)
	if err != nil {
		return nil, nil, err
	}

	var (
		claimed []InboxTask
		tokens  []string
	)
	lease := now + int64(inbox.TaskLeaseTTL.Seconds())
	for _, c := range candidates {
		// The key this task was sealed to must still be usable. A SUPERSEDED key
		// is fine — the device kept that private key and can drain tasks queued
		// before the rotation (PRD §16.2). A REVOKED one is not: nothing can open
		// the task any more, so it becomes terminal here rather than being handed
		// out and failing on the device.
		usable, err := targetKeyUsable(ctx, tx, c.TargetDeviceID, c.TargetKeyID)
		if err != nil {
			return nil, nil, err
		}
		if !usable {
			if _, err := tx.ExecContext(ctx,
				`UPDATE inbox_tasks
				    SET state = ?, error_code = ?, lease_expires_at = 0,
				        terminal_at = ?, updated_at = ?
				  WHERE id = ? AND state NOT IN `+terminalStateSQL,
				inbox.TaskRevoked, inbox.TaskErrKeyRevoked, now, now, c.ID); err != nil {
				return nil, nil, err
			}
			continue
		}
		raw := authx.RandToken()
		claimLease := lease
		if claimLease > c.ExpiresAt {
			claimLease = c.ExpiresAt
		}
		res, err := tx.ExecContext(ctx,
			`UPDATE inbox_tasks
			    SET state = ?, claim_token_hash = ?, lease_expires_at = ?,
			        attempts = attempts + 1, error_code = '', updated_at = ?
			  WHERE id = ? AND state IN `+claimableStateSQL,
			inbox.TaskDownloading, authx.HashToken(raw), claimLease, now, c.ID)
		if err != nil {
			return nil, nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			continue // lost the race for this task; the winner has it
		}
		got, err := scanInboxTask(tx.QueryRowContext(ctx,
			`SELECT `+inboxTaskCols+` FROM inbox_tasks WHERE id = ?`, c.ID))
		if err != nil {
			return nil, nil, err
		}
		claimed = append(claimed, got)
		tokens = append(tokens, raw)
	}
	return claimed, tokens, tx.Commit()
}

// ReportInboxTask applies one device-asserted transition under its claim token.
func (s *SQLiteStore) ReportInboxTask(ctx context.Context, req InboxTaskReport) (InboxTask, error) {
	if !inbox.IsDeviceReportableState(req.To) {
		return InboxTask{}, inbox.ErrInvalidTransition
	}
	if err := inbox.ValidateDeviceErrorCode(req.ErrorCode); err != nil {
		return InboxTask{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InboxTask{}, err
	}
	defer tx.Rollback()
	if err := requireReceivingDevice(ctx, tx, req.DeviceID, req.UserID); err != nil {
		return InboxTask{}, err
	}
	t, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks
		  WHERE id = ? AND target_device_id = ? AND user_id = ?`,
		req.TaskID, req.DeviceID, req.UserID))
	if errors.Is(err, sql.ErrNoRows) {
		return InboxTask{}, ErrNotFound
	}
	if err != nil {
		return InboxTask{}, err
	}
	// The claim check comes first, before anything is revealed or decided about
	// the task. A device whose lease was reclaimed holds a token that no longer
	// matches, and must re-claim rather than overwrite the current claimant's
	// progress. An unclaimed task (hash "") rejects every token, so reporting
	// without claiming is impossible.
	if t.ClaimTokenHash == "" ||
		subtle.ConstantTimeCompare([]byte(t.ClaimTokenHash), []byte(authx.HashToken(req.RawClaimToken))) != 1 {
		return InboxTask{}, ErrStaleClaim
	}
	if expired, err := expireLoadedInboxTask(ctx, tx, &t, req.Now); err != nil {
		return InboxTask{}, err
	} else if expired {
		return t, ErrTaskTerminal
	}
	// A lease is a deadline, not merely a value reclaimed by a later poll. An
	// old worker reporting after it elapsed must not revive itself in the gap
	// before ClaimInboxTasks or GC performs the reclaim.
	if (t.State == inbox.TaskDownloading || t.State == inbox.TaskVerifying) &&
		(t.LeaseExpiresAt == 0 || t.LeaseExpiresAt <= req.Now) {
		return InboxTask{}, ErrStaleClaim
	}

	// Repeat of the state the task is already in. Two distinct meanings, both
	// idempotent:
	//   - terminal: a retried final report. The stored row is returned UNCHANGED,
	//     so the saved timestamp stays the moment the device actually committed
	//     rather than the moment it retried telling us.
	//   - non-terminal: a progress heartbeat. It renews the lease and nothing
	//     else, which is how a download longer than TaskLeaseTTL stays claimed.
	if t.State == req.To {
		if inbox.IsTerminalTaskState(t.State) {
			return t, nil
		}
		// Only work actually in flight renews a lease. Repeating a report of
		// `attention_required` or `failed_retryable` — states in which nobody is
		// working and nobody holds the task — must not attach a lease to it,
		// which nothing would then ever reclaim (the reclaim pass only looks at
		// downloading/verifying).
		lease := t.LeaseExpiresAt
		if t.State == inbox.TaskDownloading || t.State == inbox.TaskVerifying {
			lease = req.Now + int64(inbox.TaskLeaseTTL.Seconds())
			if lease > t.ExpiresAt {
				lease = t.ExpiresAt
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE inbox_tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND claim_token_hash = ?`,
			lease, req.Now, t.ID, t.ClaimTokenHash); err != nil {
			return InboxTask{}, err
		}
		t.LeaseExpiresAt, t.UpdatedAt = lease, req.Now
		return t, tx.Commit()
	}
	if inbox.IsTerminalTaskState(t.State) {
		return t, ErrTaskTerminal
	}

	to, errCode := req.To, req.ErrorCode
	// A retryable failure that has used its budget is terminal. Recorded as
	// central's own code, not the device's, because it is central's decision.
	if to == inbox.TaskFailedRetryable && t.Attempts >= inbox.MaxTaskAttempts {
		to, errCode = inbox.TaskFailedTerminal, inbox.TaskErrAttemptsExhausted
	}
	if err := inbox.ValidateTaskTransition(t.State, to); err != nil {
		return InboxTask{}, err
	}
	// `saved` is the one transition that may never be inferred. The device must
	// state that authenticated decryption, complete verification and the atomic
	// local commit all succeeded; the state name alone is not that statement.
	if to == inbox.TaskSaved && !req.SavedAssertion {
		return InboxTask{}, inbox.ErrSavedNotAsserted
	}

	var (
		lease      int64
		savedAt    int64
		terminalAt int64
		nextAt     = t.NextAttemptAt
	)
	switch to {
	case inbox.TaskDownloading, inbox.TaskVerifying:
		lease = req.Now + int64(inbox.TaskLeaseTTL.Seconds()) // still working
	case inbox.TaskSaved:
		savedAt, terminalAt = req.Now, req.Now
	case inbox.TaskFailedTerminal:
		terminalAt = req.Now
	case inbox.TaskFailedRetryable:
		// Bounded exponential backoff off the attempt count, so a device failing
		// in a loop backs away instead of re-claiming immediately.
		nextAt = req.Now + int64(inbox.TaskRetryBackoff(t.Attempts).Seconds())
	}
	if lease > t.ExpiresAt {
		lease = t.ExpiresAt
	}
	// claim_token_hash is NOT cleared here. It stays as the record of who last
	// held the task, which is what lets this same claimant retry its final report
	// and get the original row back instead of a stale-claim rejection. Only a
	// return to the claimable pool (lease reclaim, accept) clears it.
	if _, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = ?, error_code = ?, lease_expires_at = ?, next_attempt_at = ?,
		        saved_at = ?, terminal_at = ?, updated_at = ?
		  WHERE id = ? AND state = ? AND claim_token_hash = ?`,
		to, errCode, lease, nextAt, savedAt, terminalAt, req.Now,
		t.ID, t.State, t.ClaimTokenHash); err != nil {
		return InboxTask{}, err
	}
	out, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks WHERE id = ?`, t.ID))
	if err != nil {
		return InboxTask{}, err
	}
	return out, tx.Commit()
}

// expireLoadedInboxTask applies the TTL inside an active task mutation instead
// of waiting for GC. That keeps report/accept outcomes independent of sweep
// timing. Terminal history is never rewritten.
func expireLoadedInboxTask(ctx context.Context, tx *sql.Tx, t *InboxTask, now int64) (bool, error) {
	if inbox.IsTerminalTaskState(t.State) || t.ExpiresAt > now {
		return false, nil
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = ?, error_code = '', lease_expires_at = 0,
		        terminal_at = ?, updated_at = ?
		  WHERE id = ? AND state NOT IN `+terminalStateSQL,
		inbox.TaskExpired, now, now, t.ID)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return false, nil
	}
	t.State = inbox.TaskExpired
	t.ErrorCode = inbox.TaskErrNone
	t.LeaseExpiresAt = 0
	t.TerminalAt = now
	t.UpdatedAt = now
	return true, tx.Commit()
}

// AuthorizeInboxTaskBlob proves that this device's current worker may read the
// ciphertext for a live, actively leased task. The public Stored Object id is
// not an authorization mechanism for Inbox delivery.
func (s *SQLiteStore) AuthorizeInboxTaskBlob(ctx context.Context, taskID, deviceID, userID, rawClaimToken string, now int64) (InboxTask, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InboxTask{}, err
	}
	defer tx.Rollback()
	if err := requireReceivingDevice(ctx, tx, deviceID, userID); err != nil {
		return InboxTask{}, err
	}
	t, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks
		  WHERE id = ? AND target_device_id = ? AND user_id = ?`, taskID, deviceID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return InboxTask{}, ErrNotFound
	}
	if err != nil {
		return InboxTask{}, err
	}
	if t.ClaimTokenHash == "" ||
		subtle.ConstantTimeCompare([]byte(t.ClaimTokenHash), []byte(authx.HashToken(rawClaimToken))) != 1 {
		return InboxTask{}, ErrStaleClaim
	}
	if expired, err := expireLoadedInboxTask(ctx, tx, &t, now); err != nil {
		return InboxTask{}, err
	} else if expired {
		return InboxTask{}, ErrTaskTerminal
	}
	if (t.State != inbox.TaskDownloading && t.State != inbox.TaskVerifying) ||
		t.LeaseExpiresAt == 0 || t.LeaseExpiresAt <= now {
		return InboxTask{}, ErrStaleClaim
	}
	// The object must still be a legitimate source for THIS task. For a share
	// that is the Phase 1B condition unchanged; for a task-purpose object the
	// binding is checked as well, so ciphertext owned by delivery A can never be
	// streamed through delivery B — the task id in the path is not, by itself,
	// authority over whatever row it happens to point at.
	var available int
	err = tx.QueryRowContext(ctx,
		`SELECT 1 FROM stored_files
		  WHERE id = ? AND user_id = ? AND expires_at > ?
		    AND max_downloads = 0 AND burn_after_read = 0
		    AND (purpose = ? OR (purpose = ? AND inbox_task_id = ?))`,
		t.StoredFileID, userID, now, StoredPurposeShare, StoredPurposeDeviceTask, t.ID).Scan(&available)
	if errors.Is(err, sql.ErrNoRows) {
		state, code := inbox.TaskFailedTerminal, inbox.TaskErrStoredObjectUnavailable
		if t.ExpiresAt <= now {
			state, code = inbox.TaskExpired, inbox.TaskErrNone
		}
		if _, uerr := tx.ExecContext(ctx,
			`UPDATE inbox_tasks
			    SET state = ?, error_code = ?, lease_expires_at = 0,
			        terminal_at = ?, updated_at = ?
			  WHERE id = ? AND state NOT IN `+terminalStateSQL,
			state, code, now, now, t.ID); uerr != nil {
			return InboxTask{}, uerr
		}
		if err := tx.Commit(); err != nil {
			return InboxTask{}, err
		}
		return InboxTask{}, ErrStoredObjectUnavailable
	}
	if err != nil {
		return InboxTask{}, err
	}
	lease := now + int64(inbox.TaskLeaseTTL.Seconds())
	if lease > t.ExpiresAt {
		lease = t.ExpiresAt
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks SET lease_expires_at = ?, updated_at = ?
		  WHERE id = ? AND claim_token_hash = ?`,
		lease, now, t.ID, t.ClaimTokenHash); err != nil {
		return InboxTask{}, err
	}
	t.LeaseExpiresAt, t.UpdatedAt = lease, now
	return t, tx.Commit()
}

// AcceptInboxTask resolves an attention_required task from the target device.
//
// Device-self and unleased by design: `attention_required` is the state in which
// a PERSON at that machine decides (PRD §8 "ask"), so it is not held by a
// claimant and needs no claim token. accept=true returns it to the queue for a
// normal claim; accept=false ends it as declined.
//
// Accepting CLEARS the claim token: the task goes back to the claimable pool, so
// whatever claimant last touched it must claim again to act on it.
func (s *SQLiteStore) AcceptInboxTask(ctx context.Context, taskID, deviceID, userID string, accept bool, now int64) (InboxTask, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InboxTask{}, err
	}
	defer tx.Rollback()
	if err := requireReceivingDevice(ctx, tx, deviceID, userID); err != nil {
		return InboxTask{}, err
	}
	t, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks
		  WHERE id = ? AND target_device_id = ? AND user_id = ?`, taskID, deviceID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return InboxTask{}, ErrNotFound
	}
	if err != nil {
		return InboxTask{}, err
	}
	if inbox.IsTerminalTaskState(t.State) {
		return t, ErrTaskTerminal
	}
	if expired, err := expireLoadedInboxTask(ctx, tx, &t, now); err != nil {
		return InboxTask{}, err
	} else if expired {
		return t, ErrTaskTerminal
	}
	// Only a HELD task may be accepted or declined. The transition table alone
	// would also permit downloading -> queued here, which would let a device
	// cancel its own live lease and reset next_attempt_at — a way to spin past
	// the retry backoff. Accepting is about a person's decision, and the only
	// state waiting on one is attention_required.
	if t.State != inbox.TaskAttentionRequired {
		return t, inbox.ErrInvalidTransition
	}
	to := inbox.TaskQueued
	errCode, terminalAt := inbox.TaskErrNone, int64(0)
	if !accept {
		to, errCode, terminalAt = inbox.TaskFailedTerminal, inbox.TaskErrUserDeclined, now
	}
	if err := inbox.ValidateTaskTransition(t.State, to); err != nil {
		return InboxTask{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = ?, error_code = ?, claim_token_hash = '', lease_expires_at = 0,
		        next_attempt_at = 0, terminal_at = ?, updated_at = ?
		  WHERE id = ? AND state = ?`,
		to, errCode, terminalAt, now, t.ID, t.State); err != nil {
		return InboxTask{}, err
	}
	out, err := scanInboxTask(tx.QueryRowContext(ctx,
		`SELECT `+inboxTaskCols+` FROM inbox_tasks WHERE id = ?`, t.ID))
	if err != nil {
		return InboxTask{}, err
	}
	return out, tx.Commit()
}

// SweepInboxTasks is GC's pass over the queue.
//
// Three passes, in this order and for this reason:
//  1. Reclaim expired leases first, so a task whose claimant died is judged as
//     queued work rather than as in-flight work.
//  2. Expire everything past its TTL. The TTL is the referenced Stored Object's
//     own expiry, so this cannot outlive the ciphertext.
//  3. Delete terminal rows past retention, which is the only thing that bounds
//     the table over time.
func (s *SQLiteStore) SweepInboxTasks(ctx context.Context, now, terminalRetention int64) (int64, int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, 0, err
	}
	defer tx.Rollback()
	reclaimed, err := reclaimExpiredLeases(ctx, tx, "", "", now)
	if err != nil {
		return 0, 0, 0, err
	}
	// terminal_at is set so the retention pass below has a clock for these rows;
	// claim_token_hash is deliberately kept, so a device that comes back finds a
	// truthful "this expired" instead of a stale-claim rejection.
	res, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = ?, lease_expires_at = 0, terminal_at = ?, updated_at = ?
		  WHERE expires_at <= ? AND state NOT IN `+terminalStateSQL,
		inbox.TaskExpired, now, now, now)
	if err != nil {
		return 0, 0, 0, err
	}
	expired, _ := res.RowsAffected()
	res, err = tx.ExecContext(ctx,
		`DELETE FROM inbox_tasks
		  WHERE state IN `+terminalStateSQL+` AND terminal_at > 0 AND terminal_at <= ?`,
		now-terminalRetention)
	if err != nil {
		return 0, 0, 0, err
	}
	pruned, _ := res.RowsAffected()
	return reclaimed, expired, pruned, tx.Commit()
}

// reclaimExpiredLeases returns leased tasks whose claimant stopped reporting to
// the claimable pool.
//
// Below the retry budget it CLEARS claim_token_hash, which is what makes the old
// claimant stale: its token stops matching, so a device that was paused,
// swapped out or partitioned cannot resume writing progress onto a task another
// worker now holds. At the budget it instead becomes failed_terminal and keeps
// the claimant hash as terminal history. next_attempt_at gets the backoff for
// attempts still eligible to retry, so a device that crashes repeatedly neither
// spins nor evades MaxTaskAttempts.
//
// deviceID/userID may be "" to sweep globally (GC); otherwise the reclaim is
// scoped to one device, which is what the claim and notify paths want.
func reclaimExpiredLeases(ctx context.Context, tx *sql.Tx, deviceID, userID string, now int64) (int64, error) {
	q := `SELECT id, attempts, lease_expires_at FROM inbox_tasks
	       WHERE lease_expires_at > 0 AND lease_expires_at <= ?
	         AND state IN ('downloading','verifying')`
	args := []any{now}
	if deviceID != "" {
		q += ` AND target_device_id = ? AND user_id = ?`
		args = append(args, deviceID, userID)
	}
	rows, err := tx.QueryContext(ctx, q, args...)
	if err != nil {
		return 0, err
	}
	type stale struct {
		id       string
		attempts int64
		lostAt   int64
	}
	var found []stale
	for rows.Next() {
		var s stale
		if err := rows.Scan(&s.id, &s.attempts, &s.lostAt); err != nil {
			rows.Close()
			return 0, err
		}
		found = append(found, s)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	// Updated one at a time so the backoff comes from inbox.TaskRetryBackoff —
	// the same function the report path uses — instead of a second copy of the
	// formula written in SQL. The set is bounded by the leases outstanding at one
	// instant, so the loop is small.
	//
	// The backoff runs from when the lease was LOST, not from when the reclaim
	// happened to notice. Otherwise a sweep arriving late would restart a delay
	// that has already elapsed, and a device coming back after a long outage
	// would have to wait all over again for work it was ready to do.
	var n int64
	for _, s := range found {
		if s.attempts >= inbox.MaxTaskAttempts {
			res, err := tx.ExecContext(ctx,
				`UPDATE inbox_tasks
				    SET state = ?, lease_expires_at = 0, error_code = ?,
				        terminal_at = ?, updated_at = ?
				  WHERE id = ? AND lease_expires_at > 0 AND lease_expires_at <= ?`,
				inbox.TaskFailedTerminal, inbox.TaskErrAttemptsExhausted,
				now, now, s.id, now)
			if err != nil {
				return 0, err
			}
			if k, _ := res.RowsAffected(); k == 1 {
				n++
			}
			continue
		}
		res, err := tx.ExecContext(ctx,
			`UPDATE inbox_tasks
			    SET state = ?, claim_token_hash = '', lease_expires_at = 0,
			        error_code = ?, next_attempt_at = ?, updated_at = ?
			  WHERE id = ? AND lease_expires_at > 0 AND lease_expires_at <= ?`,
			inbox.TaskQueued, inbox.TaskErrLeaseExpired,
			s.lostAt+int64(inbox.TaskRetryBackoff(s.attempts).Seconds()), now, s.id, now)
		if err != nil {
			return 0, err
		}
		if k, _ := res.RowsAffected(); k == 1 {
			n++
		}
	}
	return n, nil
}

// expireDueInboxTasks makes polling itself a truth-maintenance boundary. A
// delayed GC sweep must never let an already-expired task appear pending or be
// claimed. Keeping this in the same transaction also means a lease reclaimed
// above cannot briefly re-enter the queue after the task's overall TTL elapsed.
func expireDueInboxTasks(ctx context.Context, tx *sql.Tx, deviceID, userID string, now int64) (int64, error) {
	res, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = ?, lease_expires_at = 0, terminal_at = ?, updated_at = ?
		  WHERE target_device_id = ? AND user_id = ? AND expires_at <= ?
		    AND state NOT IN `+terminalStateSQL,
		inbox.TaskExpired, now, now, deviceID, userID, now)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// requeueDueRetries returns failed_retryable tasks whose backoff has elapsed to
// the claimable pool.
//
// This is the transition that makes `failed_retryable` mean "not yet" rather
// than "never": without it the state would be a quiet dead end, indistinguishable
// from failed_terminal to everyone except the row itself. Central owns it — a
// device that could requeue its own task could reset its own backoff and spin.
//
// error_code is deliberately preserved: until the task is actually leased again
// the last failure is still the truthful explanation of why nothing has landed.
// The claim clears it at the moment work genuinely restarts.
func requeueDueRetries(ctx context.Context, tx *sql.Tx, deviceID, userID string, now int64) error {
	q := `UPDATE inbox_tasks SET state = ?, updated_at = ?
	       WHERE state = ? AND next_attempt_at <= ? AND expires_at > ?
	         AND target_device_id = ? AND user_id = ?`
	_, err := tx.ExecContext(ctx, q, inbox.TaskQueued, now,
		inbox.TaskFailedRetryable, now, now, deviceID, userID)
	return err
}

// requireReceivingDevice re-checks, inside the caller's transaction, that this
// device may still act on its queue at all: it exists under this account, its
// enrolment is not revoked, and it holds an active key.
//
// Every device-side entry point calls it. Revocation has to stop work already in
// flight, not merely stop new claims — a stolen laptop whose key was revoked
// must not be able to finish draining the queue it had already been told about.
func requireReceivingDevice(ctx context.Context, tx *sql.Tx, deviceID, userID string) error {
	if err := deviceOwned(ctx, tx, deviceID, userID); err != nil {
		return err
	}
	in, err := scanDeviceInbox(tx.QueryRowContext(ctx,
		`SELECT `+deviceInboxCols+` FROM device_inbox WHERE device_id = ? AND user_id = ?`,
		deviceID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return ErrDeviceCannotReceive
	}
	if err != nil {
		return err
	}
	if in.RevokedAt != 0 {
		return ErrDeviceInboxRevoked
	}
	key, err := scanDeviceKey(tx.QueryRowContext(ctx,
		`SELECT `+deviceKeyCols+` FROM device_keys
		  WHERE device_id = ? AND user_id = ? AND superseded_at = 0 AND revoked_at = 0`,
		deviceID, userID))
	hasKey := true
	if errors.Is(err, sql.ErrNoRows) {
		hasKey = false
	} else if err != nil {
		return err
	}
	if !DeviceCanReceive(in, key, hasKey) {
		return ErrDeviceCannotReceive
	}
	return nil
}

// targetKeyUsable reports whether the key a task was sealed to can still open
// it: the row exists, belongs to this device, and is not revoked. Superseded is
// explicitly fine — that is the rotation-preserves-queued-work rule.
func targetKeyUsable(ctx context.Context, tx *sql.Tx, deviceID, keyID string) (bool, error) {
	var revokedAt int64
	err := tx.QueryRowContext(ctx,
		`SELECT revoked_at FROM device_keys WHERE id = ? AND device_id = ?`, keyID, deviceID).
		Scan(&revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return revokedAt == 0, nil
}

// terminateTasksForKey marks every unfinished task sealed to keyID as revoked.
//
// Called from the two places a key stops existing for its device — revocation
// and clearing the enrolment. Both destroy the ability to open those tasks, so
// leaving them queued would advertise deliveries that can never complete. It
// runs in the CALLER's transaction so the key change and the queue consequence
// commit together; a gap between them is a window in which a task sealed to a
// withdrawn key is still claimable.
func terminateTasksForKey(ctx context.Context, tx *sql.Tx, deviceID, keyID string, now int64) error {
	_, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = ?, error_code = ?, lease_expires_at = 0,
		        terminal_at = ?, updated_at = ?
		  WHERE target_device_id = ? AND target_key_id = ? AND state NOT IN `+terminalStateSQL,
		inbox.TaskRevoked, inbox.TaskErrKeyRevoked, now, now, deviceID, keyID)
	return err
}
