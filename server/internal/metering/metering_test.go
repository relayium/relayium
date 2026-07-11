package metering

import (
	"context"
	"io"
	"log"
	"testing"

	"github.com/relayium/relayium/internal/account"
	"github.com/relayium/relayium/internal/relayusage"
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

// A username with no owner prefix (legacy no-owner format) can't be attributed
// to any account, so it is skipped rather than written as an orphan row — which
// also keeps user_id referentially valid under foreign_keys=ON. (In current
// operation every credential /api/ice issues carries an owner, so this path is
// effectively dead; the change only drops unattributable legacy/forged rows.)
func TestWorkerSkipsUnattributedUsername(t *testing.T) {
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 42 }, Log: log.New(io.Discard, "", 0)}
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "99:424242", RelayedBytes: 7})
	if len(sink.recorded) != 0 {
		t.Fatalf("unattributed username must not record, got %+v", sink.recorded)
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
		{AllocID: "a1", Username: "1000:u.tok", RelayedBytes: 100},
		{AllocID: "a1", Username: "1000:u.tok", RelayedBytes: 999},
	})
	if len(sink.recorded) != 1 || sink.recorded[0].RelayedBytes != 999 {
		t.Fatalf("keep-max record wrong: %+v", sink.recorded)
	}
}

// TestWorkerOutOfOrderKeepsMax pins the verified cumulative-idempotent
// behavior: coturn may republish an allocation's cumulative total_traffic
// out of order (e.g. a duplicate/replayed lower reading after a higher one),
// and the keep-max upsert must not double-count or regress the total.
func TestWorkerOutOfOrderKeepsMax(t *testing.T) {
	sink := &fakeSink{}
	runWith(t, sink, []UsageEvent{
		{AllocID: "a1", Username: "1000:u.tok", RelayedBytes: 999},
		{AllocID: "a1", Username: "1000:u.tok", RelayedBytes: 100},
	})
	if len(sink.recorded) != 1 || sink.recorded[0].RelayedBytes != 999 {
		t.Fatalf("out-of-order keep-max record wrong: %+v", sink.recorded)
	}
}

func TestSplitAttrib(t *testing.T) {
	cases := []struct{ in, user, code string }{
		{"deadbeefcafe.424242", "deadbeefcafe", "424242"}, // new format
		{"424242", "", "424242"},                          // legacy: no owner
		{"", "", ""},
	}
	for _, c := range cases {
		u, code := relayusage.SplitAttrib(c.in)
		if u != c.user || code != c.code {
			t.Fatalf("relayusage.SplitAttrib(%q) = (%q,%q), want (%q,%q)", c.in, u, code, c.user, c.code)
		}
	}
}

// TestHandleRecordsBillable is a regression test for a quota-bypass bug:
// Worker.handle built account.UsageEvent without setting Billable, so coturn
// relayed bytes were persisted as billable=0 and silently excluded from
// account.UserRelayedSince's SUM(...) WHERE billable=1 — coturn relay usage
// stopped counting against the user's monthly quota. The coturn relay is our
// fleet infrastructure, so its usage must always be billable.
func TestHandleRecordsBillable(t *testing.T) {
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 42 }, Log: log.New(io.Discard, "", 0)}
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "999:deadbeef.424242", RelayedBytes: 500})
	if len(sink.recorded) != 1 {
		t.Fatalf("want 1 usage row, got %d", len(sink.recorded))
	}
	if got := sink.recorded[0].Billable; !got {
		t.Fatalf("recorded.Billable = %v, want true (coturn relay usage must count against quota)", got)
	}
}

func TestHandleAttributesOwner(t *testing.T) {
	sink := &fakeSink{}
	w := &Worker{Sink: sink, Now: func() int64 { return 42 }, Log: log.New(io.Discard, "", 0)}
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "999:deadbeef.424242", RelayedBytes: 500})
	if len(sink.recorded) != 1 {
		t.Fatalf("want 1 usage row, got %d", len(sink.recorded))
	}
	got := sink.recorded[0]
	if got.UserID != "deadbeef" || got.Token != "424242" || got.RelayedBytes != 500 {
		t.Fatalf("recorded = %+v, want UserID=deadbeef Token=424242 Bytes=500", got)
	}
}
