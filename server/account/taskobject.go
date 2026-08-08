package account

import (
	"context"
	"database/sql"
	"net/url"
	"strconv"
	"time"
)

// Task-purpose Stored Objects (Device Inbox, Phase 1D-A).
//
// A Stored Object is one ciphertext blob plus its encrypted manifest. Until now
// there was exactly one kind: a SHARE, whose whole point is that anyone holding
// the capability link can fetch it without authenticating. The Device Inbox
// sender needs the opposite: ciphertext that exists ONLY to be delivered to one
// of the account's own devices, and that no link, no list and no unauthenticated
// reader may ever reach.
//
// Those two are not the same object with a different UI. They differ in who may
// read them, who may consume them, and when they stop existing — so the
// difference is persisted explicitly, in one column, rather than inferred from
// the presence of a task somewhere else. Inference would mean an object with no
// task yet (the window between upload and create) reads as a share, which is
// precisely the window a leaked id would be exploited in.
//
// PRE-IMPLEMENTATION INVARIANTS. Each is asserted by a test in
// deviceinbox_taskobject_test.go.
//
//  1. SAME MACHINERY. A task-purpose object goes through the same placement,
//     daily quota, storage cap, traffic cap, max-file-size, TTL/plan-retention
//     cap, expiry and GC paths as a share. Nothing about it is cheaper, and
//     nothing about it is free.
//  2. NO CAPABILITY-LINK SEMANTICS. `liveFile` — the ONE resolver both public
//     endpoints use — refuses it, so `GET /api/files/{id}/meta` and
//     `/blob` are 404 for everyone including its owner. It is absent from the
//     account file list, and a fleet download receipt cannot refund against it.
//  3. ONE BINDING, FOREVER. It is bound to at most one task, once, by the
//     account that uploaded it. A partial unique index makes a second binding
//     impossible even if the application check were bypassed.
//  4. ONE READER. Only the target device's current claim holder may stream it,
//     and only through the task it is bound to.
//  5. BOUNDED LIFETIME, NEVER PREMATURE. Unbound past the bind grace, bound to
//     a task that no longer exists, or bound to a task that is terminal — all
//     three mean no legitimate reader remains, and GC reclaims the row and then
//     the blob, in that order. While ANY of those is false the ciphertext is
//     kept, because a delivery may still legally read it.
//
// The Phase 1B by-reference path (a task pointing at an ordinary SHARE) is
// deliberately untouched: it does not bind, it does not own, and deleting such a
// task still leaves the share and its link intact. That compatibility is a
// separate branch everywhere the two differ, never a shared default.

const (
	// StoredPurposeShare is the ordinary capability-link object: public
	// meta/blob, listed in the account's files, consumed by download slots.
	// The zero value on every row that predates this column.
	StoredPurposeShare = "share"
	// StoredPurposeDeviceTask is ciphertext uploaded solely to be delivered to
	// one of the account's own devices through the Device Inbox queue.
	StoredPurposeDeviceTask = "device_task"
)

// taskObjectBindGrace is how long a task-purpose object may sit UNBOUND before
// GC treats it as an abandoned upload and reclaims it.
//
// The sender binds it moments after the upload finishes — create is the very
// next call — so this window exists for the failure case: a browser closed
// between finalize and create, a request lost on the way back. It has to be long
// enough that a slow or retrying client is never robbed of ciphertext it is
// about to bind, and short enough that a failed send does not hold storage the
// user cannot see or delete. One hour is the same order as pendingUploadTTL,
// which bounds the analogous "started an upload and vanished" case.
const taskObjectBindGrace = time.Hour

// isValidStoredPurpose reports whether p is a purpose this server understands.
func isValidStoredPurpose(p string) bool {
	return p == StoredPurposeShare || p == StoredPurposeDeviceTask
}

// purposeOrShare resolves an unset purpose to `share`. Every call site that
// writes or reads one funnels through it, so "empty" never has to be a third
// meaning anyone interprets: a row or a struct that names no purpose is the
// capability-link object that was the only kind before Phase 1D-A.
func purposeOrShare(p string) string {
	if p == "" {
		return StoredPurposeShare
	}
	return p
}

// storedObjectServesTask reports whether sf may be streamed as the ciphertext of
// task taskID.
//
// A share may back any task the account creates (Phase 1B by reference, and a
// share can legitimately be sent to several devices). A task-purpose object
// serves EXACTLY the task it is bound to — checked at every read, not only at
// creation, so a task row repointed by any means still cannot borrow another
// delivery's ciphertext.
func storedObjectServesTask(sf StoredFile, taskID string) bool {
	switch sf.Purpose {
	case StoredPurposeShare:
		return true
	case StoredPurposeDeviceTask:
		return sf.InboxTaskID != "" && sf.InboxTaskID == taskID
	default:
		// Unknown persisted purposes fail closed. A future object kind must opt
		// into its own authorization semantics explicitly; it must never inherit
		// either a public share read or a Device Inbox read by accident.
		return false
	}
}

// resolveUploadRetention turns an upload's query parameters into the purpose and
// retention the object is created with, or reports a refusal.
//
// Shared by the single-shot and resumable init paths so the two cannot drift on
// the one decision that changes an object's authorization model.
//
// A task-purpose upload MUST be unlimited-until-TTL: the queue refuses a limited
// object outright, because an unrelated reader spending its final slot would
// strand a delivery central had promised. So:
//
//   - an explicit burn/maxDownloads request is REFUSED rather than rewritten.
//     Silently turning "burn after read" into "unlimited" would hand the caller
//     an object with retention it did not ask for;
//   - the admin-wide DEFAULT retention policy is not applied. That policy
//     governs public shares; a device delivery is not one, and inheriting a
//     deployment default of burn-after-read would make every task upload fail
//     at create for a reason the sender could neither see nor change.
//
// The TTL is resolved identically for both purposes — clamping and the plan cap
// belong to the account, not to the object's purpose.
func resolveUploadRetention(q url.Values, st Settings) (purpose string, ttl, maxDL int64, ok bool) {
	purpose = q.Get("purpose")
	if purpose == "" {
		purpose = StoredPurposeShare
	}
	if !isValidStoredPurpose(purpose) {
		return "", 0, 0, false
	}
	burn := q.Get("burnAfterRead") == "1"
	reqTTL, _ := strconv.ParseInt(q.Get("ttl"), 10, 64)
	reqMaxDL, _ := strconv.ParseInt(q.Get("maxDownloads"), 10, 64)
	if purpose == StoredPurposeDeviceTask {
		if burn || reqMaxDL > 0 {
			return "", 0, 0, false
		}
		return purpose, clampTTL(reqTTL, st), 0, true
	}
	ttl, maxDL = resolveRetention(burn, reqTTL, reqMaxDL, st)
	return purpose, ttl, maxDL, true
}

// backfillStoredFilePurpose gives every row that predates the purpose column the
// only value it can truthfully have: it was a share, because nothing else
// existed.
//
// Run on EVERY boot rather than gated on the ALTER succeeding, for the same
// reason as the burn/max_downloads backfill next to it: a process that died
// between a successful ALTER and this UPDATE would otherwise see "duplicate
// column name" forever and leave those rows with an empty purpose — which
// `liveFile` would refuse, silently 404ing every pre-existing share. Scoping it
// to the empty-purpose rows makes it idempotent and cheap.
func backfillStoredFilePurpose(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx,
		`UPDATE stored_files SET purpose = ? WHERE purpose = ''`, StoredPurposeShare)
	return err
}
