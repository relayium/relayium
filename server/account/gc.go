package account

import (
	"bytes"
	"context"
	"errors"
	"log"
	"time"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storage"
)

// pruneMargin keeps upload_events ~25h: a touch beyond the 24h quota window so a
// rolling-window sum never loses a row it still needs.
const pruneMargin = int64(90000) // 25h

// receiptRetention keeps direct-download receipt dedup rows for 24h — far longer
// than any download runs, so pruning can never let a late duplicate re-refund.
const receiptRetention = int64(86400) // 24h

// pendingDeleteMaxAge is how old a DISCHARGED orphan-retry row has to be before
// it is swept up — a backstop for a retirement that failed at the moment its
// hold passed, not a horizon after which responsibility lapses.
//
// It used to be the latter, and that was the bug: the prune ran on enqueued_at
// alone, so a blob on a node that had been unreachable for seven days lost the
// only row in the system that knew it existed. Nothing else could: the
// stored_files or upload_sessions row it was created from was deleted in the
// same transaction that created it, which is the entire reason it exists. The
// rule that replaced it is in Store.RetirePendingNodeDeletes.
const pendingDeleteMaxAge = int64(7 * 24 * 3600) // 7 days

// auditRetentionDefault is how long admin_audit rows are kept: TWO YEARS.
//
// This is deliberately far more generous than the other retentions in this
// file, and the reason is the asymmetry of the mistake. Pruning upload_events
// too early costs a quota-window rounding error; pruning the audit trail too
// early destroys the only record of who changed what — and an audit trail is
// consulted AFTER an incident, which is routinely discovered months later
// (credential misuse, a quietly relaxed setting, a node retired by someone who
// should not have been able to). A window shorter than the discovery delay
// silently deletes exactly the evidence the table exists to preserve, and
// unlike a missing metric it cannot be reconstructed from anywhere else.
//
// Two years also comfortably covers the usual one-year "keep your logs" bar in
// security questionnaires, while still bounding a table nobody would otherwise
// ever shrink. The cost of being generous is a few tens of MB.
//
// Overridable per deployment via -audit-retention-days /
// RELAYIUM_AUDIT_RETENTION_DAYS (main.go), the same flag+env mechanism the
// other retention knobs use; GC.AuditRetention carries the resolved seconds.
//
// TWO RESIDUALS, named because they are easy to be surprised by:
//
//  1. The age prune (Store.PruneAudit) is NOT scoped to machine rows. Setting
//     a short retention deletes the ADMIN trail of that age as well — "who
//     changed this setting" entries included. The row cap below is the only
//     part of audit pruning that spares human rows; this flag is not.
//  2. GC itself is only constructed in main.go's stored-transfers-enabled
//     branch. With stored transfers OFF, no sweep runs at all and admin_audit
//     is never pruned by either half — the table simply grows, and the
//     retention configured here has no effect.
const auditRetentionDefault = int64(730 * 24 * 3600) // 2 years

// auditNodeRowsMax bounds the MACHINE-written share of admin_audit
// (auth 'node-token'). Age retention does not bound a burst: a node-token
// holder looping register→deregister writes one genuine node.deregister row
// per iteration and /api/nodes/register has no rate limit, so within the
// two-year window the table is otherwise unbounded. 100k rows is ~20 MB and
// several orders of magnitude above any real fleet+BYO deregistration rate,
// so a healthy deployment never reaches it. Admin/human rows are never
// touched by this cap — see SQLiteStore.PruneNodeAudit.
const auditNodeRowsMax = 100_000

// appleNotificationRetention keeps completed App Store notification claims for
// two years. That is long enough for delayed support and billing investigations,
// while bounding a renewal-driven ledger that would otherwise retain Apple
// subscription identifiers forever. Unfinished states are never age-pruned.
const appleNotificationRetention = int64(730 * 24 * 3600) // 2 years

// GC periodically deletes expired stored files (and their blobs) and prunes the
// upload-events ledger. Modeled on metering.Worker; Now is injected for tests.
type GC struct {
	Store Store
	Blobs storage.BlobStore
	Now   func() int64
	Log   *log.Logger

	// BlobFor resolves the blob store for a file's node_id (central-local or a
	// remote node). When nil, GC falls back to Blobs (SP1 behavior).
	BlobFor func(ctx context.Context, nodeID string) (storage.BlobStore, error)

	// Mailer sends the pre-purge reminder and final "account deleted" emails
	// (Task 5). When nil, the reminder/purge passes are skipped entirely —
	// existing tests that construct a GC without these deletion-lifecycle
	// dependencies keep exercising only the file/session/token reclamation
	// passes above.
	Mailer Mailer
	// ReminderWindow returns the live reminder window in seconds
	// (Settings.AccountReminderDays*86400), read fresh each sweep so an admin
	// setting change takes effect without a restart.
	ReminderWindow func(ctx context.Context) int64
	// ReactivateLink mints a fresh reactivate token for userID/email and
	// returns its full URL, for the pre-purge reminder email. Shared with the
	// Task 3/4 reactivate-token issuer (Service.IssueReactivateLink).
	ReactivateLink func(ctx context.Context, userID, email string) (string, error)

	// ReapSessions, when set, drops abandoned in-memory chunked-upload sessions
	// (and their partial blobs) each sweep. Wired to Service.ReapPendingUploads.
	ReapSessions func(now int64)

	// SweepPairRooms, when set, voids pairing rooms whose join deadline passed
	// and purges long-closed rows. Wired to Service.SweepPairRooms; nil in the
	// bare GCs that tests build for the file/session/token passes.
	SweepPairRooms func(ctx context.Context, now int64)

	// AuditRetention is how long admin_audit rows are kept, in seconds.
	// <= 0 falls back to auditRetentionDefault — a zero/garbage configuration
	// must not be read as "prune everything".
	AuditRetention int64
}

// auditRetention resolves the configured audit window, falling back to the
// default when unset.
func (g *GC) auditRetention() int64 {
	if g.AuditRetention <= 0 {
		return auditRetentionDefault
	}
	return g.AuditRetention
}

func (g *GC) sweep(ctx context.Context) {
	now := g.Now()
	expired, err := g.Store.ListExpiredStoredFiles(ctx, now)
	if err != nil {
		g.Log.Printf("gc: list expired: %v", err)
		return
	}
	for _, f := range expired {
		if err := g.deleteBlob(ctx, f.NodeID, f.BlobKey); err != nil {
			_ = g.Store.EnqueueNodeDelete(ctx, f.BlobKey, f.NodeID, now)
		}
		if err := g.Store.DeleteStoredFile(ctx, f.ID, now); err != nil {
			g.Log.Printf("gc: delete file %s: %v", f.ID, err)
		}
	}
	g.reclaimTaskObjects(ctx, now)
	// Pair rooms: void the ones whose deadline passed with nobody joining, and
	// drop long-closed rows. A BACKSTOP only — every read and write path voids on
	// the spot (pairroom.go), so this catches the room nobody touches again and
	// must never be what makes the five-minute rule true.
	if g.SweepPairRooms != nil {
		g.SweepPairRooms(ctx, now)
	}
	g.drainPending(ctx)
	// Bills that could not be written when they became known. Normally a no-op;
	// when it is not, it is the retry that keeps "every accepted byte is billed"
	// true across a database that was briefly refusing writes (see UnbilledMeter).
	g.settleOwedBills(ctx)
	if g.ReapSessions != nil {
		g.ReapSessions(now)
	}
	if err := g.Store.PruneUploadEvents(ctx, now-pruneMargin); err != nil {
		g.Log.Printf("gc: prune upload events: %v", err)
	}
	// Direct-download receipt dedup rows: prune well past any possible in-flight
	// download (24h) so a duplicate receipt can never re-appear as "first".
	if err := g.Store.PruneDownloadReceipts(ctx, now-receiptRetention); err != nil {
		g.Log.Printf("gc: prune download receipts: %v", err)
	}
	if err := g.Store.PruneTerminalAppleNotifications(ctx, now-appleNotificationRetention); err != nil {
		g.Log.Printf("gc: prune terminal apple notifications: %v", err)
	}
	// Admin audit trail: age-based prune (long window — see
	// auditRetentionDefault) plus a ceiling on the machine-written rows, which
	// age alone cannot bound against a burst.
	if err := g.Store.PruneAudit(ctx, now-g.auditRetention()); err != nil {
		g.Log.Printf("gc: prune audit: %v", err)
	}
	if err := g.Store.PruneNodeAudit(ctx, auditNodeRowsMax); err != nil {
		g.Log.Printf("gc: cap machine audit rows: %v", err)
	}
	// Auth tables are otherwise append-only: expired/revoked sessions and
	// spent/expired magic tokens are never deleted on the request path, so GC
	// reclaims them to keep the tables bounded.
	if err := g.Store.DeleteExpiredSessions(ctx, now); err != nil {
		g.Log.Printf("gc: delete expired sessions: %v", err)
	}
	if err := g.Store.DeleteSpentMagicTokens(ctx, now); err != nil {
		g.Log.Printf("gc: delete spent magic tokens: %v", err)
	}
	if err := g.Store.DeleteSpentEmailTokens(ctx, now); err != nil {
		g.Log.Printf("gc: delete spent email tokens: %v", err)
	}
	if err := g.Store.DeleteExpiredDeviceAuth(ctx, now); err != nil {
		g.Log.Printf("gc: delete expired device-auth: %v", err)
	}
	if err := g.Store.PurgeExpiredAdminSessions(ctx, now); err != nil {
		g.Log.Printf("gc: purge expired admin sessions: %v", err)
	}
	// Device Inbox queue: reclaim leases whose claimant died, expire tasks past
	// the TTL they inherited from their Stored Object, and drop terminal rows
	// past retention. The claim path reclaims its own device's stale leases too,
	// so this pass is what keeps a device that never comes back from pinning
	// rows — not the only thing standing between a crashed CLI and its queue.
	if reclaimed, expired, pruned, err := g.Store.SweepInboxTasks(ctx, now, int64(inbox.TerminalTaskRetention/time.Second)); err != nil {
		g.Log.Printf("gc: sweep inbox tasks: %v", err)
	} else if reclaimed != 0 || expired != 0 || pruned != 0 {
		g.Log.Printf("gc: inbox tasks reclaimed=%d expired=%d pruned=%d", reclaimed, expired, pruned)
	}
	g.sweepAccountDeletions(ctx, now)
}

// sweepAccountDeletions runs the self-deletion lifecycle's two remaining
// steps: a one-time pre-purge reminder email, then the hard purge of accounts
// whose grace period has fully elapsed. Requires Mailer/ReminderWindow/
// ReactivateLink to be wired (main.go); skipped entirely when they aren't, so
// tests that construct a bare GC for the file/session/token passes above are
// unaffected.
func (g *GC) sweepAccountDeletions(ctx context.Context, now int64) {
	if g.Mailer == nil || g.ReminderWindow == nil || g.ReactivateLink == nil {
		return
	}

	toRemind, err := g.Store.ListUsersToRemind(ctx, now, g.ReminderWindow(ctx))
	if err != nil {
		g.Log.Printf("gc: list users to remind: %v", err)
	}
	for _, u := range toRemind {
		link, err := g.ReactivateLink(ctx, u.ID, u.Email)
		if err != nil {
			g.Log.Printf("gc: mint reactivate link for %s: %v", u.ID, err)
			continue
		}
		if err := g.Mailer.SendAccountDeletionReminder(ctx, u.Email, u.PurgeAfter, link); err != nil {
			g.Log.Printf("gc: send purge reminder for %s: %v", u.ID, err)
			continue // retry next sweep rather than mark it sent on a failed send
		}
		if err := g.Store.MarkPurgeReminderSent(ctx, u.ID, now); err != nil {
			g.Log.Printf("gc: mark purge reminder sent for %s: %v", u.ID, err)
		}
	}

	toPurge, err := g.Store.ListUsersToPurge(ctx, now)
	if err != nil {
		g.Log.Printf("gc: list users to purge: %v", err)
		return
	}
	for _, u := range toPurge {
		email := u.Email // capture before the row is gone
		if err := g.Store.ArchiveAndPurgeUser(ctx, u.ID, now); err != nil {
			g.Log.Printf("gc: purge user %s: %v", u.ID, err)
			continue
		}
		if err := g.Mailer.SendAccountDeleted(ctx, email); err != nil {
			g.Log.Printf("gc: send final deletion email for %s: %v", u.ID, err)
		}
	}
}

// reclaimTaskObjects releases the ciphertext of Device Inbox deliveries that
// can no longer happen (Phase 1D-A).
//
// A task-purpose object is invisible by design: no link, no file-list row, no
// public endpoint. That is exactly why it needs a sweeper — a share the user can
// see is a share the user can delete, and this one they cannot. The three cases
// it reclaims are defined once, in SQL, by reclaimableTaskObjectSQL.
//
// The ORDER is the safety property, and it is the reverse of the expiry pass
// above. There, expiry is monotonic, so deleting the blob first is fine. Here
// the condition can go from true to false — a create binding the object may land
// between the list and the delete — so the ROW is deleted first, under a
// conditional statement that re-checks the condition, and the blob only follows
// once that row is provably gone. The worst case is a retryable orphan blob, not
// ciphertext destroyed under a live delivery.
func (g *GC) reclaimTaskObjects(ctx context.Context, now int64) {
	grace := int64(taskObjectBindGrace / time.Second)
	objs, err := g.Store.ListReclaimableTaskObjects(ctx, now, grace)
	if err != nil {
		g.Log.Printf("gc: list reclaimable task objects: %v", err)
		return
	}
	var reclaimed int
	for _, f := range objs {
		ok, err := g.Store.DeleteTaskObjectIfReclaimable(ctx, f.ID, now, grace)
		if err != nil {
			g.Log.Printf("gc: reclaim task object %s: %v", f.ID, err)
			continue
		}
		if !ok {
			continue // bound to a live delivery again since the list; keep it
		}
		reclaimed++
		if err := g.deleteBlob(ctx, f.NodeID, f.BlobKey); err != nil {
			// Node unreachable: the existing retry queue owns it from here, the
			// same as every other orphaned blob in this file.
			_ = g.Store.EnqueueNodeDelete(ctx, f.BlobKey, f.NodeID, now)
		}
	}
	if reclaimed != 0 {
		g.Log.Printf("gc: inbox task objects reclaimed=%d", reclaimed)
	}
}

// probePendingBlob asks a queued blob how many bytes it really holds, the same
// zero-byte-append probe the reclaim paths use (see Service.probeBlobSize): a
// blob still at the row's billing floor accepts it and answers that number, one
// holding more refuses with the real size, and a blob that no longer exists
// answers 0 — which is definitive, not unknown, and lets the row settle to "owes
// nothing". ok=false means nothing could ask (node unreachable / no store),
// which must keep both the blob and the row.
func (g *GC) probePendingBlob(ctx context.Context, p PendingNodeDelete) (int64, bool) {
	var bs storage.BlobStore
	if g.BlobFor != nil {
		resolved, err := g.BlobFor(ctx, p.NodeID)
		if err != nil {
			return 0, false
		}
		bs = resolved
	} else {
		bs = g.Blobs
	}
	if bs == nil {
		return 0, false
	}
	pctx, cancel := probeContext(ctx)
	defer cancel()
	size, err := bs.Append(pctx, p.BlobKey, p.BilledThrough, bytes.NewReader(nil))
	if err == nil || errors.Is(err, storage.ErrOffsetMismatch) {
		return size, true
	}
	return 0, false
}

func (g *GC) deleteBlob(ctx context.Context, nodeID, blobKey string) error {
	if g.BlobFor != nil {
		bs, err := g.BlobFor(ctx, nodeID)
		if err != nil {
			return err
		}
		return bs.Delete(ctx, blobKey)
	}
	if g.Blobs != nil {
		return g.Blobs.Delete(ctx, blobKey) // SP1 fallback
	}
	return nil
}

// drainPending retries the node deletes GC has taken durable responsibility for
// — a node that was unreachable at expiry, or a blob whose last referencing row
// has been removed. Each success clears its row, each failure stays queued.
//
// A row may carry a HOLD (PendingNodeDelete.NotBefore), and the delete is
// attempted either way: the hold governs when the responsibility is discharged,
// never when the bytes go. That is what makes it work — a blob re-created by an
// append that was in flight when its row was deleted is removed by the next
// sweep, because the sweep keeps asking for the whole window rather than
// trusting one success and forgetting the key.
//
// A row may also carry a BILLING OBLIGATION (PendingNodeDelete.BillUserID): the
// blob is the last evidence of bytes that may never have been billed — a void
// whose meter AND journal writes both failed, or a late append that landed
// after everything else was gone. For those rows the bytes are asked about and
// the answer made durable BEFORE the delete, because the delete destroys the
// only copy of the number; a settle that cannot complete keeps the blob AND the
// row for the next sweep. The settle is idempotent (a monotonic floor advanced
// atomically with each billing write), so re-asking every sweep costs a probe
// and can never double-charge.
func (g *GC) drainPending(ctx context.Context) {
	pend, err := g.Store.ListPendingNodeDeletes(ctx)
	if err != nil {
		g.Log.Printf("gc: list pending node deletes: %v", err)
		return
	}
	for _, p := range pend {
		if p.BillUserID != "" {
			size, ok := g.probePendingBlob(ctx, p)
			if !ok {
				continue // cannot learn the number; keep blob and row, retry next sweep
			}
			if to := min(size, p.BillMax); to > p.BilledThrough {
				billed, serr := g.Store.SettleBlobBilling(ctx, p.BlobKey, p.NodeID, to, g.Now())
				if serr != nil {
					// The obligation is still not durable, so the evidence must not be
					// destroyed: skip the delete entirely and come back.
					g.Log.Printf("gc: settle billing for pending blob %s@%s: %v; keeping the blob until the bill lands",
						p.BlobKey, nodeLabelForLog(p.NodeID), serr)
					continue
				}
				if billed > 0 {
					g.Log.Printf("gc: billed %d bytes blob %s@%s held that nothing had settled",
						billed, p.BlobKey, nodeLabelForLog(p.NodeID))
				}
			}
		}
		if err := g.deleteBlob(ctx, p.NodeID, p.BlobKey); err != nil {
			continue // node still unreachable; retry next sweep
		}
		if p.NotBefore > g.Now() {
			// Deleted, but something may still be able to put it back, so the row
			// stays. What is recorded is that the delete SUCCEEDED — the difference
			// between a row holding a discharged responsibility open and a row that
			// is a blob's only owner, which is what age eviction is allowed to act on
			// (see RetirePendingNodeDeletes). Stamped once; the WHERE keeps the first.
			if p.DeletedAt == 0 {
				if err := g.Store.MarkPendingNodeDeleteDone(ctx, p.BlobKey, p.NodeID, g.Now()); err != nil {
					g.Log.Printf("gc: record that pending delete %s@%s has landed: %v", p.BlobKey, p.NodeID, err)
				}
			}
			continue
		}
		if err := g.Store.DeletePendingNodeDelete(ctx, p.BlobKey, p.NodeID); err != nil {
			g.Log.Printf("gc: clear pending delete %s@%s: %v", p.BlobKey, p.NodeID, err)
		}
	}
	retired, retained, err := g.Store.RetirePendingNodeDeletes(ctx, g.Now()-pendingDeleteMaxAge)
	if err != nil {
		g.Log.Printf("gc: retire pending deletes: %v", err)
	}
	if retired != 0 {
		g.Log.Printf("gc: retired %d pending delete(s)", retired)
	}
	if retained != 0 {
		// The rows age alone is NOT allowed to throw away. Said out loud on every
		// sweep, because a growing number here means real ciphertext is sitting on a
		// node that has not accepted a delete in over a week, and the fix is an
		// operator bringing that node back or explicitly deleting it — not a timer.
		g.Log.Printf("gc: %d pending delete(s) older than %d s have never once succeeded; their blobs still exist and this queue is their only owner",
			retained, pendingDeleteMaxAge)
	}
}

// Run sweeps once immediately, then every interval until ctx is cancelled.
func (g *GC) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	g.sweep(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			g.sweep(ctx)
		}
	}
}
