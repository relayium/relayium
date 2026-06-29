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

type fakeSink struct {
	transfers map[string]account.Transfer   // token → transfer
	recorded  map[string]account.UsageEvent // alloc_id → event (mimics INSERT OR IGNORE)
}

func (f *fakeSink) GetTransfer(ctx context.Context, token string) (account.Transfer, error) {
	tr, ok := f.transfers[token]
	if !ok {
		return account.Transfer{}, account.ErrNotFound
	}
	return tr, nil
}

func (f *fakeSink) RecordUsage(ctx context.Context, e account.UsageEvent) error {
	if _, exists := f.recorded[e.AllocID]; exists {
		return nil // idempotent, like the real store
	}
	f.recorded[e.AllocID] = e
	return nil
}

func (f *fakeSink) total(userID string) int64 {
	var t int64
	for _, e := range f.recorded {
		if e.UserID == userID {
			t += e.RelayedBytes
		}
	}
	return t
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

func TestWorkerRecordsAndAttributes(t *testing.T) {
	sink := &fakeSink{
		transfers: map[string]account.Transfer{"tok": {Token: "tok", UserID: "u1"}},
		recorded:  map[string]account.UsageEvent{},
	}
	runWith(t, sink, []UsageEvent{{AllocID: "a1", Username: "1000:tok", RelayedBytes: 1500}})
	if got := sink.total("u1"); got != 1500 {
		t.Fatalf("total = %d, want 1500", got)
	}
	if rec := sink.recorded["a1"]; rec.Token != "tok" || rec.UserID != "u1" || rec.RecordedAt != 1234 {
		t.Fatalf("recorded event wrong: %+v", rec)
	}
}

func TestWorkerSkipsUnknownToken(t *testing.T) {
	sink := &fakeSink{transfers: map[string]account.Transfer{}, recorded: map[string]account.UsageEvent{}}
	runWith(t, sink, []UsageEvent{{AllocID: "a1", Username: "1000:ghost", RelayedBytes: 100}})
	if len(sink.recorded) != 0 {
		t.Fatalf("unknown token must not record, got %+v", sink.recorded)
	}
}

func TestWorkerSkipsMalformedUsername(t *testing.T) {
	sink := &fakeSink{transfers: map[string]account.Transfer{}, recorded: map[string]account.UsageEvent{}}
	runWith(t, sink, []UsageEvent{{AllocID: "a1", Username: "nocolon", RelayedBytes: 100}})
	if len(sink.recorded) != 0 {
		t.Fatalf("malformed username must not record, got %+v", sink.recorded)
	}
}

func TestWorkerIdempotentOnAllocID(t *testing.T) {
	sink := &fakeSink{
		transfers: map[string]account.Transfer{"tok": {Token: "tok", UserID: "u1"}},
		recorded:  map[string]account.UsageEvent{},
	}
	runWith(t, sink, []UsageEvent{
		{AllocID: "a1", Username: "1000:tok", RelayedBytes: 100},
		{AllocID: "a1", Username: "1000:tok", RelayedBytes: 999},
	})
	if got := sink.total("u1"); got != 100 {
		t.Fatalf("idempotent total = %d, want 100", got)
	}
}
