// Package metering ingests coturn's per-allocation relay accounting and records
// it against the user who owns the transfer token. The Redis dependency lives in
// redis.go; this file is Redis-free and unit-testable with fakes.
package metering

import (
	"context"
	"log"
	"strings"

	"github.com/relayium/relayium/internal/account"
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
	GetTransfer(ctx context.Context, token string) (account.Transfer, error)
	RecordUsage(ctx context.Context, e account.UsageEvent) error
}

// Worker consumes usage events and records them. Now is injected for testability.
type Worker struct {
	Sink Sink
	Now  func() int64
	Log  *log.Logger
}

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

// tokenFromUsername returns the token after the first ':' in "<expiry>:<token>",
// or "" if the username is malformed.
func tokenFromUsername(username string) string {
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 || parts[1] == "" {
		return ""
	}
	return parts[1]
}

func (w *Worker) handle(ctx context.Context, ev UsageEvent) {
	token := tokenFromUsername(ev.Username)
	if token == "" {
		w.Log.Printf("metering: skip alloc %s, malformed username %q", ev.AllocID, ev.Username)
		return
	}
	tr, err := w.Sink.GetTransfer(ctx, token)
	if err != nil {
		w.Log.Printf("metering: skip alloc %s, unknown token: %v", ev.AllocID, err)
		return
	}
	rec := account.UsageEvent{
		AllocID:      ev.AllocID,
		Token:        token,
		UserID:       tr.UserID,
		RelayedBytes: ev.RelayedBytes,
		RecordedAt:   w.Now(),
	}
	if err := w.Sink.RecordUsage(ctx, rec); err != nil {
		w.Log.Printf("metering: record alloc %s failed: %v", ev.AllocID, err)
	}
}
