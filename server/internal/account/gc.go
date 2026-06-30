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

// GC periodically deletes expired stored files (and their blobs) and prunes the
// upload-events ledger. Modeled on metering.Worker; Now is injected for tests.
type GC struct {
	Store Store
	Blobs storage.BlobStore
	Now   func() int64
	Log   *log.Logger
}

func (g *GC) sweep(ctx context.Context) {
	now := g.Now()
	expired, err := g.Store.ListExpiredStoredFiles(ctx, now)
	if err != nil {
		g.Log.Printf("gc: list expired: %v", err)
		return
	}
	for _, f := range expired {
		if g.Blobs != nil {
			_ = g.Blobs.Delete(ctx, f.BlobKey)
		}
		if err := g.Store.DeleteStoredFile(ctx, f.ID); err != nil {
			g.Log.Printf("gc: delete file %s: %v", f.ID, err)
		}
	}
	if err := g.Store.PruneUploadEvents(ctx, now-pruneMargin); err != nil {
		g.Log.Printf("gc: prune upload events: %v", err)
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
