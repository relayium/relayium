// Package metering ingests coturn's per-allocation relay accounting and
// records it keyed by pairing code, attributed to the code's owner when the
// username token carries one (see relayusage.SplitAttrib). The Redis
// dependency lives in redis.go; this file is Redis-free and unit-testable
// with fakes.
package metering

import (
	"context"
	"log"
	"sync/atomic"
	"time"

	"github.com/relayium/relayium/internal/account"
	"github.com/relayium/relayium/internal/relayusage"
)

// UsageEvent is one coturn allocation's relay accounting as ingested from a
// StatsSource (before token→user resolution).
type UsageEvent struct {
	AllocID      string
	Username     string // coturn credential username: "<expiry>:<token>"
	RelayedBytes int64  // rcvb + sentb
}

// StatsSource yields one UsageEvent per coturn total_traffic report (coturn may
// report a cumulative total more than once per allocation; the store keeps the
// max per alloc_id).
type StatsSource interface {
	Events(ctx context.Context) (<-chan UsageEvent, error)
}

// Sink is the subset of account.Store the worker needs.
type Sink interface {
	RecordUsage(ctx context.Context, e account.UsageEvent) error
}

// Worker consumes usage events and records them. Now is injected for testability.
//
// Residual: if the app is down for an allocation's ENTIRE lifetime AND that
// allocation closes during the outage, its bytes are unrecoverable — pub/sub
// is fire-and-forget and no closed-allocation history is queryable. The
// reconcile pass (see Reconcile) only covers allocations still live when it
// runs; Watchdog only surfaces that the pipe has gone silent, it cannot
// recover what was lost while it was down.
type Worker struct {
	Sink Sink
	Now  func() int64
	Log  *log.Logger

	lastEventUnix atomic.Int64
	eventCount    atomic.Int64
}

// LastEventUnix returns the unix-seconds timestamp of the last successfully
// recorded usage event, or 0 if none has been recorded yet.
func (w *Worker) LastEventUnix() int64 { return w.lastEventUnix.Load() }

// EventCount returns the number of usage events successfully recorded so far.
func (w *Worker) EventCount() int64 { return w.eventCount.Load() }

// Run consumes events until the source channel closes or ctx is cancelled.
func (w *Worker) Run(ctx context.Context, src StatsSource) error {
	ch, err := src.Events(ctx)
	if err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			w.handle(ctx, ev)
		}
	}
}

func (w *Worker) handle(ctx context.Context, ev UsageEvent) {
	token := relayusage.TokenFromUsername(ev.Username)
	if token == "" {
		w.Log.Printf("metering: skip alloc %s, malformed username %q", ev.AllocID, ev.Username)
		return
	}
	userID, code := relayusage.SplitAttrib(token)
	rec := account.UsageEvent{
		AllocID:      ev.AllocID,
		Token:        code,
		UserID:       userID,
		RelayedBytes: ev.RelayedBytes,
		RecordedAt:   w.Now(),
	}
	if err := w.Sink.RecordUsage(ctx, rec); err != nil {
		w.Log.Printf("metering: record alloc %s failed: %v", ev.AllocID, err)
		return
	}
	w.lastEventUnix.Store(rec.RecordedAt)
	w.eventCount.Add(1)
}

// checkSilence warns once when metering is wired but has gone quiet for longer
// than silence — the common blinding case (routine restart / reconnect window),
// which UserRelayedSince would otherwise under-count with no signal. When no
// event has ever arrived (last == 0), it only warns once the process has been
// up longer than silence with still nothing received: a freshly started
// server naturally has no events yet, so it must not alarm on every tick
// before that window has elapsed.
func (w *Worker) checkSilence(start, now int64, silence time.Duration) {
	last := w.lastEventUnix.Load()
	if last == 0 {
		if now-start > int64(silence.Seconds()) {
			w.Log.Printf("metering: WARNING no metering events received yet (pipe may be down)")
		}
		return
	}
	if now-last > int64(silence.Seconds()) {
		w.Log.Printf("metering: WARNING no relay events for %ds (last=%d); coturn→redis pipe may be down", now-last, last)
	}
}

// Watchdog periodically flags a silent metering pipe until ctx is cancelled.
func (w *Worker) Watchdog(ctx context.Context, check, silence time.Duration) {
	t := time.NewTicker(check)
	defer t.Stop()
	start := w.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.checkSilence(start, w.Now(), silence)
		}
	}
}

// AllocationLister yields the CURRENT cumulative totals of live coturn
// allocations, used to fill pub/sub gaps. Implemented over the coturn CLI in
// a follow-up if the version supports it; nil disables reconciliation.
type AllocationLister interface {
	LiveAllocations(ctx context.Context) ([]UsageEvent, error)
}

// Reconcile pulls current cumulative totals for live allocations and records
// them (keep-max upsert dedupes against pub/sub events), filling gaps where a
// total_traffic message was missed. Best-effort: a lister error is returned to
// the loop, which logs and retries next tick. Only allocations still live when
// this runs can be recovered this way; see the Worker doc for the residual.
func (w *Worker) Reconcile(ctx context.Context, lister AllocationLister) error {
	evs, err := lister.LiveAllocations(ctx)
	if err != nil {
		return err
	}
	for _, ev := range evs {
		w.handle(ctx, ev)
	}
	return nil
}

// ReconcileLoop runs Reconcile on a fixed interval until ctx is cancelled.
func (w *Worker) ReconcileLoop(ctx context.Context, lister AllocationLister, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := w.Reconcile(ctx, lister); err != nil {
				w.Log.Printf("metering: reconcile pass failed: %v", err)
			}
		}
	}
}
