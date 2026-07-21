package account

import (
	"context"
	"log"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// pruneMargin keeps upload_events ~25h: a touch beyond the 24h quota window so a
// rolling-window sum never loses a row it still needs.
const pruneMargin = int64(90000) // 25h

// pendingDeleteMaxAge bounds the orphan-retry queue: a permanently-dead node's
// pending_node_deletes rows would otherwise retry forever and never self-clean.
const pendingDeleteMaxAge = int64(7 * 24 * 3600) // 7 days

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
		if err := g.Store.DeleteStoredFile(ctx, f.ID); err != nil {
			g.Log.Printf("gc: delete file %s: %v", f.ID, err)
		}
	}
	g.drainPending(ctx)
	if g.ReapSessions != nil {
		g.ReapSessions(now)
	}
	if err := g.Store.PruneUploadEvents(ctx, now-pruneMargin); err != nil {
		g.Log.Printf("gc: prune upload events: %v", err)
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

// drainPending retries orphaned node deletes recorded when a node was
// unreachable at expiry; each success clears its row, each failure stays queued.
func (g *GC) drainPending(ctx context.Context) {
	pend, err := g.Store.ListPendingNodeDeletes(ctx)
	if err != nil {
		g.Log.Printf("gc: list pending node deletes: %v", err)
		return
	}
	for _, p := range pend {
		if err := g.deleteBlob(ctx, p.NodeID, p.BlobKey); err != nil {
			continue // node still unreachable; retry next sweep
		}
		if err := g.Store.DeletePendingNodeDelete(ctx, p.BlobKey, p.NodeID); err != nil {
			g.Log.Printf("gc: clear pending delete %s@%s: %v", p.BlobKey, p.NodeID, err)
		}
	}
	if err := g.Store.DeletePendingNodeDeletesOlderThan(ctx, g.Now()-pendingDeleteMaxAge); err != nil {
		g.Log.Printf("gc: evict aged pending deletes: %v", err)
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
