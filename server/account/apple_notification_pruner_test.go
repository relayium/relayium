package account

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"testing"
	"time"
)

type appleNotificationPruneStoreStub struct {
	before chan int64
	err    error
}

func (s *appleNotificationPruneStoreStub) PruneTerminalAppleNotifications(_ context.Context, before int64) error {
	s.before <- before
	return s.err
}

func TestAppleNotificationPrunerRunsImmediatelyWithRetentionCutoff(t *testing.T) {
	store := &appleNotificationPruneStoreStub{before: make(chan int64, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &AppleNotificationPruner{
		Store: store,
		Now:   func() int64 { return appleNotificationRetention + 123 },
		Log:   log.New(&bytes.Buffer{}, "", 0),
	}

	done := make(chan struct{})
	go func() {
		p.Run(ctx, time.Hour)
		close(done)
	}()

	select {
	case before := <-store.before:
		if before != 123 {
			t.Fatalf("cutoff = %d, want 123", before)
		}
	case <-time.After(time.Second):
		t.Fatal("initial notification prune did not run")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("notification pruner did not stop after cancellation")
	}
}

func TestAppleNotificationPrunerLogsStoreFailure(t *testing.T) {
	store := &appleNotificationPruneStoreStub{
		before: make(chan int64, 1),
		err:    errors.New("database unavailable"),
	}
	var logs bytes.Buffer
	p := &AppleNotificationPruner{
		Store: store,
		Now:   func() int64 { return appleNotificationRetention },
		Log:   log.New(&logs, "", 0),
	}

	p.sweep(context.Background())
	if got := logs.String(); !strings.Contains(got, "apple-notification-pruner: database unavailable") {
		t.Fatalf("log = %q", got)
	}
}
