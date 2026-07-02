package metering

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Reconnect backoff bounds. A single Redis hiccup used to kill the ingest
// goroutine for good, silently stopping all TURN relay-byte metering; instead
// we reconnect with capped exponential backoff until the context is cancelled.
const (
	minReconnectBackoff = 250 * time.Millisecond
	maxReconnectBackoff = 30 * time.Second
)

// coturn (--redis-statsdb) publishes per-allocation totals to channels like
// turn/realm/<realm>/user/<username>/allocation/<allocId>/total_traffic
const trafficChannelPattern = "turn/realm/*/user/*/allocation/*/total_traffic"

// segAfter returns the path segment immediately following the first occurrence
// of key in a '/'-separated channel string, or "" if not present.
func segAfter(channel, key string) string {
	parts := strings.Split(channel, "/")
	for i, p := range parts {
		if p == key && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}

func allocIDFromChannel(channel string) string  { return segAfter(channel, "allocation") }
func usernameFromChannel(channel string) string { return segAfter(channel, "user") }

var (
	reRcvb  = regexp.MustCompile(`rcvb=(\d+)`)
	reSentb = regexp.MustCompile(`sentb=(\d+)`)
)

// relayedBytesFromPayload sums rcvb + sentb from a coturn traffic payload.
// Returns an error if neither field is present.
func relayedBytesFromPayload(payload string) (int64, error) {
	r := reRcvb.FindStringSubmatch(payload)
	s := reSentb.FindStringSubmatch(payload)
	if r == nil && s == nil {
		return 0, fmt.Errorf("no rcvb/sentb in payload %q", payload)
	}
	var total int64
	if r != nil {
		n, _ := strconv.ParseInt(r[1], 10, 64)
		total += n
	}
	if s != nil {
		n, _ := strconv.ParseInt(s[1], 10, 64)
		total += n
	}
	return total, nil
}

// RedisSource subscribes to coturn's traffic channel and emits UsageEvents.
type RedisSource struct {
	client *redis.Client
}

func NewRedisSource(addr string) *RedisSource {
	return &RedisSource{client: redis.NewClient(&redis.Options{Addr: addr})}
}

// msgReceiver is the subset of *redis.PubSub the ingest loop needs. Defining it
// as an interface lets the reconnect logic be unit-tested with a fake that drops
// its connection, without a live Redis.
type msgReceiver interface {
	ReceiveMessage(ctx context.Context) (*redis.Message, error)
	Close() error
}

func (r *RedisSource) Events(ctx context.Context) (<-chan UsageEvent, error) {
	out := make(chan UsageEvent)
	subscribe := func(ctx context.Context) (msgReceiver, error) {
		ps := r.client.PSubscribe(ctx, trafficChannelPattern)
		// PSubscribe is lazy; a dial/auth failure only surfaces on the first
		// receive. Confirm the subscription is live so a dead connection counts
		// as a failure that triggers backoff rather than a "healthy" loop.
		if _, err := ps.Receive(ctx); err != nil {
			_ = ps.Close()
			return nil, err
		}
		return ps, nil
	}
	go func() {
		defer close(out)
		ingest(ctx, subscribe, out, sleepCtx)
	}()
	return out, nil
}

// ingest runs the subscribe→receive loop, reconnecting with capped exponential
// backoff whenever a subscription drops, until ctx is cancelled. It owns each
// msgReceiver it obtains from subscribe (closing it before reconnecting).
func ingest(ctx context.Context, subscribe func(context.Context) (msgReceiver, error), out chan<- UsageEvent, sleep func(context.Context, time.Duration) bool) {
	backoff := minReconnectBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		sub, err := subscribe(ctx)
		if err != nil {
			if !sleep(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
		gotAny := receiveLoop(ctx, sub, out)
		_ = sub.Close()
		if ctx.Err() != nil {
			return
		}
		// A connection that delivered traffic was healthy; reset the backoff so a
		// transient drop reconnects promptly. A connection that produced nothing
		// keeps ramping the delay to avoid hammering a broken Redis.
		if gotAny {
			backoff = minReconnectBackoff
		}
		if !sleep(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

// receiveLoop forwards events until the subscription errors, returning whether
// it received at least one message (i.e. the connection actually worked).
func receiveLoop(ctx context.Context, sub msgReceiver, out chan<- UsageEvent) (gotAny bool) {
	for {
		msg, err := sub.ReceiveMessage(ctx)
		if err != nil {
			return gotAny
		}
		gotAny = true
		bytes, err := relayedBytesFromPayload(msg.Payload)
		if err != nil {
			continue
		}
		ev := UsageEvent{
			AllocID:      allocIDFromChannel(msg.Channel),
			Username:     usernameFromChannel(msg.Channel),
			RelayedBytes: bytes,
		}
		select {
		case out <- ev:
		case <-ctx.Done():
			return gotAny
		}
	}
}

// nextBackoff doubles d, capped at maxReconnectBackoff.
func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > maxReconnectBackoff {
		return maxReconnectBackoff
	}
	return d
}

// sleepCtx waits for d or ctx cancellation, reporting true if the full delay
// elapsed (false if ctx was cancelled first).
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
