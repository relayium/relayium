package metering

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
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

func (r *RedisSource) Events(ctx context.Context) (<-chan UsageEvent, error) {
	pubsub := r.client.PSubscribe(ctx, trafficChannelPattern)
	out := make(chan UsageEvent)
	go func() {
		defer close(out)
		defer pubsub.Close()
		for {
			msg, err := pubsub.ReceiveMessage(ctx)
			if err != nil {
				return // ctx cancelled or connection closed
			}
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
				return
			}
		}
	}()
	return out, nil
}
