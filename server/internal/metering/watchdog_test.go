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

// TestWatchdogNoEventsYetStaysQuietBeforeWindow verifies a freshly started
// worker (no metering event ever recorded) does NOT warn on every tick — only
// once it has been up longer than the silence window with still nothing
// received. A just-started server with no traffic yet is normal, not an
// alarm.
func TestWatchdogNoEventsYetStaysQuietBeforeWindow(t *testing.T) {
	buf := &bytes.Buffer{}
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 1000 }, Log: log.New(buf, "", 0)}

	start := int64(1000)
	silence := 5 * time.Minute

	// Right at start: no warning.
	w.checkSilence(start, start, silence)
	if buf.Len() != 0 {
		t.Fatalf("expected no warning immediately after start, got log: %q", buf.String())
	}

	// Still within the silence window: no warning.
	w.checkSilence(start, start+int64(silence.Seconds())-1, silence)
	if buf.Len() != 0 {
		t.Fatalf("expected no warning before silence window elapses, got log: %q", buf.String())
	}
}

// TestWatchdogNoEventsYetWarnsAfterWindow verifies that once the process has
// been up longer than the silence window with still no event ever recorded,
// checkSilence does warn.
func TestWatchdogNoEventsYetWarnsAfterWindow(t *testing.T) {
	buf := &bytes.Buffer{}
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 1000 }, Log: log.New(buf, "", 0)}

	start := int64(1000)
	silence := 5 * time.Minute
	now := start + int64(silence.Seconds()) + 1

	w.checkSilence(start, now, silence)
	if !strings.Contains(buf.String(), "no metering events") {
		t.Fatalf("expected silence warning once uptime exceeds the window with no events, got log: %q", buf.String())
	}
}

// TestWatchdogGoneQuietAfterEvents drives checkSilence directly (no sleeping)
// and asserts the already-correct "gone quiet after events" branch still
// warns once the pipe has gone silent past the silence window, and stays
// quiet right after a fresh event.
func TestWatchdogGoneQuietAfterEvents(t *testing.T) {
	buf := &bytes.Buffer{}
	sink := &fakeSink{}
	var clk int64 = 1000
	w := &Worker{Sink: sink, Now: func() int64 { return atomic.LoadInt64(&clk) }, Log: log.New(buf, "", 0)}

	silence := 5 * time.Minute

	// Fresh event: must NOT warn right after.
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "1000:tok", RelayedBytes: 42})
	w.checkSilence(w.LastEventUnix(), w.LastEventUnix(), silence)
	if buf.Len() != 0 {
		t.Fatalf("expected no warning right after an event, got log: %q", buf.String())
	}

	// Time advances well past the silence window since the last event: must warn.
	buf.Reset()
	now := w.LastEventUnix() + int64(silence.Seconds()) + 1
	w.checkSilence(w.LastEventUnix(), now, silence)
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
