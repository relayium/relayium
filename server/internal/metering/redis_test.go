package metering

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

const sampleChannel = "turn/realm/relayium.app/user/1751200000:abc123def/allocation/alloc-77/total_traffic"

// fakeSub delivers a fixed list of payloads, then returns an error on the next
// receive to simulate a dropped connection.
type fakeSub struct {
	payloads []string
	idx      int
}

func (f *fakeSub) ReceiveMessage(ctx context.Context) (*redis.Message, error) {
	if f.idx >= len(f.payloads) {
		return nil, errors.New("connection reset")
	}
	m := &redis.Message{Channel: sampleChannel, Payload: f.payloads[f.idx]}
	f.idx++
	return m, nil
}

func (f *fakeSub) Close() error { return nil }

// After a subscription drops, ingest must reconnect and keep emitting events
// rather than silently stopping.
func TestIngestReconnectsAfterDrop(t *testing.T) {
	var calls int32
	subscribe := func(ctx context.Context) (msgReceiver, error) {
		switch atomic.AddInt32(&calls, 1) {
		case 1:
			return &fakeSub{payloads: []string{"rcvb=1000, sentb=0"}}, nil
		case 2:
			return &fakeSub{payloads: []string{"rcvb=0, sentb=500"}}, nil
		default:
			return nil, errors.New("redis down")
		}
	}

	out := make(chan UsageEvent, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Immediate, non-blocking backoff that still honors cancellation.
	sleep := func(ctx context.Context, _ time.Duration) bool { return ctx.Err() == nil }

	done := make(chan struct{})
	go func() { ingest(ctx, subscribe, out, sleep); close(done) }()

	ev1 := <-out // from the first connection
	ev2 := <-out // proves it reconnected after the first dropped
	if ev1.RelayedBytes != 1000 || ev2.RelayedBytes != 500 {
		t.Fatalf("events = %d, %d; want 1000, 500", ev1.RelayedBytes, ev2.RelayedBytes)
	}

	// The 3rd+ subscribe attempts fail; cancel to unwind the loop and confirm it
	// actually stops on ctx cancellation.
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ingest did not stop after ctx cancellation")
	}
}

// ingest must stop promptly when its context is already cancelled.
func TestIngestStopsOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var calls int32
	subscribe := func(ctx context.Context) (msgReceiver, error) {
		atomic.AddInt32(&calls, 1)
		return &fakeSub{}, nil
	}
	done := make(chan struct{})
	go func() {
		ingest(ctx, subscribe, make(chan UsageEvent), sleepCtx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ingest ignored a cancelled context")
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("should not subscribe with a cancelled context, got %d calls", calls)
	}
}

func TestAllocIDFromChannel(t *testing.T) {
	if got := allocIDFromChannel(sampleChannel); got != "alloc-77" {
		t.Fatalf("allocID = %q, want alloc-77", got)
	}
	if got := allocIDFromChannel("garbage"); got != "" {
		t.Fatalf("garbage channel should yield empty allocID, got %q", got)
	}
}

func TestUsernameFromChannel(t *testing.T) {
	if got := usernameFromChannel(sampleChannel); got != "1751200000:abc123def" {
		t.Fatalf("username = %q, want 1751200000:abc123def", got)
	}
}

func TestRelayedBytesFromPayload(t *testing.T) {
	// coturn total_traffic payload (key=value pairs).
	n, err := relayedBytesFromPayload("rcvp=10, rcvb=2000, sentp=8, sentb=1500")
	if err != nil || n != 3500 {
		t.Fatalf("bytes = %d (err %v), want 3500", n, err)
	}
	// Tolerant of ordering/spacing.
	n, err = relayedBytesFromPayload("sentb=1 rcvb=2")
	if err != nil || n != 3 {
		t.Fatalf("bytes = %d (err %v), want 3", n, err)
	}
	// No traffic fields → error.
	if _, err := relayedBytesFromPayload("rcvp=10, sentp=8"); err == nil {
		t.Fatalf("payload without rcvb/sentb should error")
	}
}
