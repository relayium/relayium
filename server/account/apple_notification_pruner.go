package account

import (
	"context"
	"log"
	"time"
)

// appleNotificationRetention keeps completed App Store notification claims for
// two years. That is long enough for delayed support and billing investigations,
// while bounding a renewal-driven ledger that would otherwise retain Apple
// subscription identifiers forever. Unfinished states are never age-pruned.
const appleNotificationRetention = int64(730 * 24 * 3600) // 2 years

// AppleNotificationPruneStore is intentionally narrower than Store so this
// maintenance task cannot accidentally grow a dependency on stored transfers.
type AppleNotificationPruneStore interface {
	PruneTerminalAppleNotifications(ctx context.Context, before int64) error
}

// AppleNotificationPruner bounds the durable notification ledger independently
// of blob storage. Now is injected for deterministic tests.
type AppleNotificationPruner struct {
	Store AppleNotificationPruneStore
	Now   func() int64
	Log   *log.Logger
}

func (p *AppleNotificationPruner) sweep(ctx context.Context) {
	if err := p.Store.PruneTerminalAppleNotifications(ctx, p.Now()-appleNotificationRetention); err != nil {
		p.Log.Printf("apple-notification-pruner: %v", err)
	}
}

// Run sweeps once immediately, then every interval until ctx is cancelled.
func (p *AppleNotificationPruner) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	p.sweep(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.sweep(ctx)
		}
	}
}
