package metering

import (
	"bytes"
	"context"
	"log"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestWorkerRecordsLastEvent verifies handle() updates the atomic
// last-event-unix and event-count tracking after a successful RecordUsage.
func TestWorkerRecordsLastEvent(t *testing.T) {
	var clk int64 = 500
	now := func() int64 { return atomic.LoadInt64(&clk) }
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: now, Log: log.New(bytes.NewBuffer(nil), "", 0)}

	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "1000:tok", RelayedBytes: 42})

	if got := w.LastEventUnix(); got != 500 {
		t.Fatalf("LastEventUnix() = %d, want 500", got)
	}
	if got := w.EventCount(); got != 1 {
		t.Fatalf("EventCount() = %d, want 1", got)
	}
}

// TestWatchdogWarnsOnSilence drives checkSilence directly (no sleeping) and
// asserts it warns once the pipe has gone quiet past the silence window, but
// stays quiet right after a fresh event.
func TestWatchdogWarnsOnSilence(t *testing.T) {
	buf := &bytes.Buffer{}
	sink := &fakeSink{}
	var clk int64 = 1000
	w := &Worker{Sink: sink, Now: func() int64 { return atomic.LoadInt64(&clk) }, Log: log.New(buf, "", 0)}

	// No event ever recorded: must warn.
	w.checkSilence(1000, 5*time.Minute)
	if !strings.Contains(buf.String(), "no metering events") && !strings.Contains(buf.String(), "no relay events") {
		t.Fatalf("expected silence warning with no prior event, got log: %q", buf.String())
	}

	// Fresh event: must NOT warn right after.
	buf.Reset()
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "1000:tok", RelayedBytes: 42})
	w.checkSilence(w.LastEventUnix(), 5*time.Minute)
	if buf.Len() != 0 {
		t.Fatalf("expected no warning right after an event, got log: %q", buf.String())
	}

	// Time advances well past the silence window since the last event: must warn.
	buf.Reset()
	w.checkSilence(w.LastEventUnix()+int64((5*time.Minute).Seconds())+1, 5*time.Minute)
	if !strings.Contains(buf.String(), "no relay events") {
		t.Fatalf("expected silence warning after window elapses, got log: %q", buf.String())
	}
}

// fakeLister is a test-only AllocationLister.
type fakeLister struct {
	evs []UsageEvent
	err error
}

func (f *fakeLister) LiveAllocations(ctx context.Context) ([]UsageEvent, error) {
	return f.evs, f.err
}

// TestReconcileFeedsGaps verifies Reconcile routes lister results through the
// same handle() path, reusing keep-max + attribution.
func TestReconcileFeedsGaps(t *testing.T) {
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 1234 }, Log: log.New(bytes.NewBuffer(nil), "", 0)}
	lister := &fakeLister{evs: []UsageEvent{
		{AllocID: "a9", Username: "1:owner.code", RelayedBytes: 5000},
	}}

	if err := w.Reconcile(context.Background(), lister); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	found := false
	for _, r := range sink.recorded {
		if r.AllocID == "a9" {
			found = true
			if r.RelayedBytes != 5000 || r.UserID != "owner" || r.Token != "code" {
				t.Fatalf("reconciled record wrong: %+v", r)
			}
		}
	}
	if !found {
		t.Fatalf("expected a9 to be recorded, got %+v", sink.recorded)
	}
}
