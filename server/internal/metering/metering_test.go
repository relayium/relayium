package metering

import (
	"context"
	"io"
	"log"
	"testing"

	"github.com/relayium/relayium/internal/account"
)

type fakeSource struct{ events []UsageEvent }

func (f *fakeSource) Events(ctx context.Context) (<-chan UsageEvent, error) {
	ch := make(chan UsageEvent, len(f.events))
	for _, e := range f.events {
		ch <- e
	}
	close(ch)
	return ch, nil
}

// fakeSink records usage events, keeping only the max RelayedBytes per
// AllocID (mirrors the real store's keep-max upsert).
type fakeSink struct {
	recorded []account.UsageEvent
}

func (f *fakeSink) RecordUsage(ctx context.Context, e account.UsageEvent) error {
	for i, cur := range f.recorded {
		if cur.AllocID == e.AllocID {
			if e.RelayedBytes > cur.RelayedBytes {
				f.recorded[i] = e
			}
			return nil
		}
	}
	f.recorded = append(f.recorded, e)
	return nil
}

func newWorker(sink *fakeSink) *Worker {
	return &Worker{Sink: sink, Now: func() int64 { return 1234 }, Log: log.New(io.Discard, "", 0)}
}

func runWith(t *testing.T, sink *fakeSink, events []UsageEvent) {
	t.Helper()
	if err := newWorker(sink).Run(context.Background(), &fakeSource{events: events}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestWorkerRecordsAnonymously(t *testing.T) {
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 42 }, Log: log.New(io.Discard, "", 0)}
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "99:424242", RelayedBytes: 7})
	if len(sink.recorded) != 1 {
		t.Fatalf("want 1 usage row, got %d", len(sink.recorded))
	}
	got := sink.recorded[0]
	if got.Token != "424242" || got.UserID != "" || got.RelayedBytes != 7 || got.RecordedAt != 42 {
		t.Fatalf("unexpected record: %+v", got)
	}
}

func TestWorkerSkipsMalformedUsername(t *testing.T) {
	sink := &fakeSink{}
	runWith(t, sink, []UsageEvent{{AllocID: "a1", Username: "nocolon", RelayedBytes: 100}})
	if len(sink.recorded) != 0 {
		t.Fatalf("malformed username must not record, got %+v", sink.recorded)
	}
}

func TestWorkerKeepsMaxPerAlloc(t *testing.T) {
	sink := &fakeSink{}
	runWith(t, sink, []UsageEvent{
		{AllocID: "a1", Username: "1000:tok", RelayedBytes: 100},
		{AllocID: "a1", Username: "1000:tok", RelayedBytes: 999},
	})
	if len(sink.recorded) != 1 || sink.recorded[0].RelayedBytes != 999 {
		t.Fatalf("keep-max record wrong: %+v", sink.recorded)
	}
}
