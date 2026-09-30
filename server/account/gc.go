package account

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net"
	"sync"
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

// gcPassBudget bounds each GC pass, and nodeDeleteTimeout each blob delete a
// pass (or a request's cleanup) sends to a storage node.
//
// The sweep is serial and runs from main on context.Background(), so before
// these existed ONE node that accepted TCP and never answered — a stalled TLS
// handshake had no timeout at all — froze every pass after the one that
// reached it: expired files, pending deletes, owed bills, inbox leases,
// session pruning and the account purge alike, for as long as the node stayed
// that way. Now a delete gives up after nodeDeleteTimeout, a pass after
// gcPassBudget, and a node that timed out once is not asked again in the same
// sweep (see stalledNodes). Nothing a pass leaves undone is lost: every row it
// did not reach is still listed next sweep, and every blob it could not delete
// is still queued. Variables so tests can shrink them.
var (
	gcPassBudget      = 2 * time.Minute
	nodeDeleteTimeout = 20 * time.Second
)

// stalledNodes remembers, for one sweep, the storage nodes whose delete or
// probe TIMED OUT, so the rest of the sweep skips them instead of paying the
// timeout once per blob. Without it one hung node holding many queued blobs
// spends every pass's whole budget and starves the blobs on healthy nodes
// listed after it. It rides the context, so drainPending and friends called
// directly (tests, one-off callers) have no memo and ask every time.
type stalledNodes struct {
	mu  sync.Mutex
	ids map[string]bool
}

type stalledNodesKey struct{}

var errNodeStalled = errors.New("gc: storage node timed out earlier in this sweep")

func withStalledNodes(ctx context.Context) context.Context {
	return context.WithValue(ctx, stalledNodesKey{}, &stalledNodes{ids: map[string]bool{}})
}

func nodeStalled(ctx context.Context, nodeID string) bool {
	sn, _ := ctx.Value(stalledNodesKey{}).(*stalledNodes)
	if sn == nil || nodeID == "" {
		return false
	}
	sn.mu.Lock()
	defer sn.mu.Unlock()
	return sn.ids[nodeID]
}

// noteNodeErr records nodeID as stalled when err is a timeout that belongs to
// the node — not the pass's own deadline running out, which says nothing about
// the node and would wrongly skip it in the passes after.
func noteNodeErr(ctx context.Context, nodeID string, err error) {
	sn, _ := ctx.Value(stalledNodesKey{}).(*stalledNodes)
	if sn == nil || nodeID == "" || err == nil || ctx.Err() != nil || !isTimeout(err) {
		return
	}
	sn.mu.Lock()
	sn.ids[nodeID] = true
	sn.mu.Unlock()
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// pass runs one GC pass on its own deadline, derived from the sweep's context
// so cancelling Run still stops it.
func (g *GC) pass(ctx context.Context, name string, fn func(context.Context)) {
	pctx, cancel := context.WithTimeout(ctx, gcPassBudget)
	defer cancel()
	fn(pctx)
	if errors.Is(pctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
		g.Log.Printf("gc: %s ran out of its %v budget; what it did not reach is still listed or queued for the next sweep", name, gcPassBudget)
	}
}

// deleteIntentStore is what GC's delete passes, the share-delete route and the
// account-deletion cleanup REQUIRE of their store: removing a row together with
// its blob's delete intent in one transaction, clearing an intent after a
// successful delete, and the drain's retry order. SQLiteStore implements it.
//
// It is asserted rather than added to Store only because store.go is outside
// this change; it is not optional. A store without it gets
// errNoDeleteIntentStore and the caller does nothing destructive — the rows
// stay, the route answers 500 — rather than falling back to a non-atomic
// sequence that can either orphan a blob or delete one a surviving row still
// names. Test wrappers that embed Store forward these methods explicitly
// (intentForwarding in the tests).
type deleteIntentStore interface {
	DeleteStoredFileQueuingBlob(ctx context.Context, id string, now int64) (bool, error)
	DeleteTaskObjectIfReclaimableQueuingBlob(ctx context.Context, id string, now, bindGrace int64) (bool, error)
	DischargePendingNodeDelete(ctx context.Context, blobKey, nodeID string, now int64) error
	MarkPendingNodeDeleteAttempted(ctx context.Context, blobKey, nodeID string) error
}

var errNoDeleteIntentStore = errors.New("account: store does not implement the transactional delete-intent methods (deleteIntentStore); refusing to delete without them")

func intentStore(st Store) (deleteIntentStore, error) {
	if q, ok := st.(deleteIntentStore); ok {
		return q, nil
	}
	return nil, errNoDeleteIntentStore
}

// removeStoredFileQueuingBlob deletes f's row and durably queues its blob for
// deletion, both or neither. deleted=false with a nil error means the row was
// already gone. On error the row is still there and still owns its blob.
func removeStoredFileQueuingBlob(ctx context.Context, st Store, f StoredFile, now int64) (bool, error) {
	q, err := intentStore(st)
	if err != nil {
		return false, err
	}
	return q.DeleteStoredFileQueuingBlob(ctx, f.ID, now)
}

// dischargePendingNodeDelete clears a delete intent whose blob was just deleted
// (see SQLiteStore.DischargePendingNodeDelete for which rows it leaves).
func dischargePendingNodeDelete(ctx context.Context, st Store, blobKey, nodeID string, now int64) error {
	q, err := intentStore(st)
	if err != nil {
		return err
	}
	return q.DischargePendingNodeDelete(ctx, blobKey, nodeID, now)
}

func (g *GC) sweep(ctx context.Context) {
	now := g.Now()
	ctx = withStalledNodes(ctx)
	g.pass(ctx, "expired stored files", func(ctx context.Context) { g.expireStoredFiles(ctx, now) })
	g.pass(ctx, "task-object reclaim", func(ctx context.Context) { g.reclaimTaskObjects(ctx, now) })
	// Pair rooms: void the ones whose deadline passed with nobody joining, and
	// drop long-closed rows. A BACKSTOP only — every read and write path voids on
	// the spot (pairroom.go), so this catches the room nobody touches again and
	// must never be what makes the five-minute rule true.
	if g.SweepPairRooms != nil {
		g.pass(ctx, "pair-room sweep", func(ctx context.Context) { g.SweepPairRooms(ctx, now) })
	}
	g.pass(ctx, "pending-delete drain", g.drainPending)
	// Bills that could not be written when they became known. Normally a no-op;
	// when it is not, it is the retry that keeps "every accepted byte is billed"
	// true across a database that was briefly refusing writes (see UnbilledMeter).
	g.pass(ctx, "owed-bill settle", g.settleOwedBills)
	if g.ReapSessions != nil {
		// Takes no context: ReapPendingUploads bounds itself (30 s).
		g.ReapSessions(now)
	}
	g.pass(ctx, "prunes", func(ctx context.Context) { g.prune(ctx, now) })
	g.pass(ctx, "account deletions", func(ctx context.Context) { g.sweepAccountDeletions(ctx, now) })
}

// expireStoredFiles deletes every expired stored file. Row and delete intent go
// in one transaction first, the physical delete after, and a successful delete
// clears the intent again. Expiry is monotonic, so the row going before the
// blob is safe; the reverse order used to be paired with an enqueue whose error
// was ignored, which left an unreachable node's blob with no owner at all.
func (g *GC) expireStoredFiles(ctx context.Context, now int64) {
	if _, err := intentStore(g.Store); err != nil {
		g.Log.Printf("gc: expired stored files: %v", err)
		return
	}
	expired, err := g.Store.ListExpiredStoredFiles(ctx, now)
	if err != nil {
		g.Log.Printf("gc: list expired: %v", err)
		return
	}
	for i, f := range expired {
		if ctx.Err() != nil {
			g.Log.Printf("gc: out of budget with %d of %d expired file(s) left for the next sweep", len(expired)-i, len(expired))
			return
		}
		deleted, err := removeStoredFileQueuingBlob(ctx, g.Store, f, now)
		if err != nil {
			g.Log.Printf("gc: delete file %s: %v", f.ID, err) // row kept; it still owns the blob
			continue
		}
		if !deleted {
			continue // already removed by whoever owns its blob now
		}
		if err := g.deleteBlob(ctx, f.NodeID, f.BlobKey); err == nil {
			if err := dischargePendingNodeDelete(ctx, g.Store, f.BlobKey, f.NodeID, now); err != nil {
				g.Log.Printf("gc: clear delete intent %s@%s: %v", f.BlobKey, nodeLabelForLog(f.NodeID), err)
			}
		}
	}
}

// prune runs the table-bounding passes: ledgers, the audit trail, spent auth
// rows, and the Device Inbox queue.
func (g *GC) prune(ctx context.Context, now int64) {
	if err := g.Store.PruneUploadEvents(ctx, now-pruneMargin); err != nil {
		g.Log.Printf("gc: prune upload events: %v", err)
	}
	// Direct-download receipt dedup rows: prune well past any possible in-flight
	// download (24h) so a duplicate receipt can never re-appear as "first".
	if err := g.Store.PruneDownloadReceipts(ctx, now-receiptRetention); err != nil {
		g.Log.Printf("gc: prune download receipts: %v", err)
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
	// Retired nodes (A-M3): a deleted node's row is kept only while a queued
	// delete, upload session or stored object still needs its storage endpoint.
	// Once the drain, the reaper and expiry have taken all of them, the row goes;
	// its tombstone keeps the id refused to anyone else.
	if n, err := g.Store.PurgeRetiredNodes(ctx); err != nil {
		g.Log.Printf("gc: purge retired nodes: %v", err)
	} else if n != 0 {
		g.Log.Printf("gc: purged %d retired node row(s)", n)
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
	if _, err := intentStore(g.Store); err != nil {
		g.Log.Printf("gc: task-object reclaim: %v", err)
		return
	}
	grace := int64(taskObjectBindGrace / time.Second)
	objs, err := g.Store.ListReclaimableTaskObjects(ctx, now, grace)
	if err != nil {
		g.Log.Printf("gc: list reclaimable task objects: %v", err)
		return
	}
	var reclaimed int
	for i, f := range objs {
		if ctx.Err() != nil {
			g.Log.Printf("gc: out of budget with %d of %d task object(s) left for the next sweep", len(objs)-i, len(objs))
			break
		}
		ok, err := g.deleteTaskObjectQueuingBlob(ctx, f, now, grace)
		if err != nil {
			g.Log.Printf("gc: reclaim task object %s: %v", f.ID, err)
			continue
		}
		if !ok {
			continue // bound to a live delivery again since the list; keep it
		}
		reclaimed++
		// The retry queue already owns the blob (same transaction as the row);
		// this delete is only promptness, and its success clears that intent.
		if err := g.deleteBlob(ctx, f.NodeID, f.BlobKey); err == nil {
			if err := dischargePendingNodeDelete(ctx, g.Store, f.BlobKey, f.NodeID, now); err != nil {
				g.Log.Printf("gc: clear delete intent %s@%s: %v", f.BlobKey, nodeLabelForLog(f.NodeID), err)
			}
		}
	}
	if reclaimed != 0 {
		g.Log.Printf("gc: inbox task objects reclaimed=%d", reclaimed)
	}
}

// deleteTaskObjectQueuingBlob deletes a reclaimable task object's row and
// queues its blob in one transaction (the condition re-checked by the DELETE).
func (g *GC) deleteTaskObjectQueuingBlob(ctx context.Context, f StoredFile, now, grace int64) (bool, error) {
	q, err := intentStore(g.Store)
	if err != nil {
		return false, err
	}
	return q.DeleteTaskObjectIfReclaimableQueuingBlob(ctx, f.ID, now, grace)
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
	if nodeStalled(ctx, p.NodeID) {
		return 0, false
	}
	pctx, cancel := probeContext(ctx)
	defer cancel()
	size, err := bs.Append(pctx, p.BlobKey, p.BilledThrough, bytes.NewReader(nil))
	if err == nil || errors.Is(err, storage.ErrOffsetMismatch) {
		return size, true
	}
	noteNodeErr(ctx, p.NodeID, err)
	return 0, false
}

// deleteBlob deletes one blob, bounded by nodeDeleteTimeout (and the pass's own
// deadline), skipping a node that already timed out in this sweep.
func (g *GC) deleteBlob(ctx context.Context, nodeID, blobKey string) error {
	if nodeStalled(ctx, nodeID) {
		return errNodeStalled
	}
	dctx, cancel := context.WithTimeout(ctx, nodeDeleteTimeout)
	defer cancel()
	err := g.deleteBlobOn(dctx, nodeID, blobKey)
	noteNodeErr(ctx, nodeID, err)
	return err
}

func (g *GC) deleteBlobOn(ctx context.Context, nodeID, blobKey string) error {
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
// whose meter AND journal writes both failed, a late append that landed after
// everything else was gone, or the residual of an upload that never became an
// object (the orphan cleanup claim, the set-based purge, a refused finalize;
// see residualOwed). SettleBlobBilling forgives an obligation whose account is
// gone or pending deletion instead of billing it. For those rows the bytes are
// asked about and the answer made durable BEFORE the delete, because the delete
// destroys the only copy of the number; a settle that cannot complete keeps the
// blob AND the row for the next sweep. The settle is idempotent (a monotonic
// floor advanced atomically with each billing write), so re-asking every sweep
// costs a probe and can never double-charge.
func (g *GC) drainPending(ctx context.Context) {
	q, err := intentStore(g.Store)
	if err != nil {
		g.Log.Printf("gc: pending-delete drain: %v", err)
		return
	}
	// Every row this pass attempts and leaves in place goes to the back of the
	// retry order (ListPendingNodeDeletes), so the next sweep starts with the
	// rows this one did not reach. That, not the budget, is what guarantees a
	// healthy node's blob and a billing obligation are reached however many
	// stalled nodes sit ahead of them. The stamp is written on a detached,
	// short context: the attempt that used up the pass's budget must still be
	// moved back, or it would be first again next sweep.
	requeue := func(p PendingNodeDelete) {
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := q.MarkPendingNodeDeleteAttempted(sctx, p.BlobKey, p.NodeID); err != nil {
			g.Log.Printf("gc: move pending delete %s@%s back in the retry order: %v", p.BlobKey, nodeLabelForLog(p.NodeID), err)
		}
	}
	pend, err := g.Store.ListPendingNodeDeletes(ctx)
	if err != nil {
		g.Log.Printf("gc: list pending node deletes: %v", err)
		return
	}
	for i, p := range pend {
		if ctx.Err() != nil {
			g.Log.Printf("gc: out of budget with %d of %d pending delete(s) left for the next sweep", len(pend)-i, len(pend))
			break // not return: the retirement and the retained-row warning below still run
		}
		if p.BillUserID != "" {
			size, ok := g.probePendingBlob(ctx, p)
			if !ok {
				requeue(p)
				continue // cannot learn the number; keep blob and row, retry next sweep
			}
			if to := min(size, p.BillMax); to > p.BilledThrough {
				billed, serr := g.Store.SettleBlobBilling(ctx, p.BlobKey, p.NodeID, to, g.Now())
				if serr != nil {
					// The obligation is still not durable, so the evidence must not be
					// destroyed: skip the delete entirely and come back.
					g.Log.Printf("gc: settle billing for pending blob %s@%s: %v; keeping the blob until the bill lands",
						p.BlobKey, nodeLabelForLog(p.NodeID), serr)
					requeue(p)
					continue
				}
				if billed > 0 {
					g.Log.Printf("gc: billed %d bytes blob %s@%s held that nothing had settled",
						billed, p.BlobKey, nodeLabelForLog(p.NodeID))
				}
			}
		}
		if err := g.deleteBlob(ctx, p.NodeID, p.BlobKey); err != nil {
			requeue(p)
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
			requeue(p)
			continue
		}
		if err := g.Store.DeletePendingNodeDelete(ctx, p.BlobKey, p.NodeID); err != nil {
			g.Log.Printf("gc: clear pending delete %s@%s: %v", p.BlobKey, p.NodeID, err)
			// Attempted and still in place, like every other branch that keeps
			// the row: to the back, so it is not first again next sweep.
			requeue(p)
		}
	}
	// On a short detached context, like requeue: the sweeps whose budget a
	// stalled node used up are exactly the ones whose "never once succeeded"
	// count must still be reported, and a discharged row is no less retirable
	// because a stalled one was ahead of it.
	rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer rcancel()
	retired, retained, err := g.Store.RetirePendingNodeDeletes(rctx, g.Now()-pendingDeleteMaxAge)
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
