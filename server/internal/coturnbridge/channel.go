// Package coturnbridge turns coturn's Redis accounting into durable,
// immutable cumulative snapshots and delivers them to central's coturn
// metering ingest (F02). Standard library only.
//
// Provider facts this package relies on (coturn 4.6.1 source):
//   - …/traffic is a per-interval DELTA, published when the four packet
//     counters reach a multiple of 4096, after which they reset
//     (ns_ioalib_engine_impl.c turn_report_session_usage).
//   - …/total_traffic is the allocation's final cumulative, published once on
//     delete after a forced flush (turn_report_allocation_delete).
//   - The …/peer variants use uint32 counters that wrap; they are ignored.
//   - CLI psd lists live sessions with, per counter, MAX(lifetime total of
//     reported intervals, current interval) as of coturn's last session-info
//     refresh (ns_turn_server.c turn_session_info_copy_from): a lower bound
//     of the true total, never a sum.
//   - coturn has no SIGTERM handler: a stop/crash publishes no final.
package coturnbridge

import (
	"errors"
	"regexp"
	"strconv"
	"strings"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// Event kinds the bridge acts on.
const (
	KindNew       = "new"       // status "new lifetime=…"
	KindRefreshed = "refreshed" // status "refreshed lifetime=…"
	KindDeleted   = "deleted"   // status "deleted"
	KindTraffic   = "traffic"   // interval delta
	KindTotal     = "total"     // final cumulative
	KindIgnored   = "ignored"   // …/peer counters (uint32, wrap) and other statuses
	// KindUnattributed: a session with no username — coturn reports usage
	// for unauthenticated STUN-only sessions (e.g. a Binding request) under
	// "user//allocation/…". Never an allocation and never billable; counted
	// for monitoring only.
	KindUnattributed = "unattributed"
)

// Event is one parsed coturn pub/sub message.
type Event struct {
	Kind      string
	Username  string
	SessionID string
	// Bytes is rcvb + sentb (client side) for KindTraffic/KindTotal.
	Bytes uint64
}

var (
	reCounters = regexp.MustCompile(`^rcvp=([0-9]{1,20}), rcvb=([0-9]{1,20}), sentp=([0-9]{1,20}), sentb=([0-9]{1,20})$`)
	reLifetime = regexp.MustCompile(`^(new|refreshed) lifetime=[0-9]{1,10}, `)
)

// ErrMalformed marks a message the bridge cannot attribute or parse. It is
// quarantined and alerted, never billed.
var ErrMalformed = errors.New("coturnbridge: malformed coturn message")

// ParseMessage parses one message on channel
// turn/realm/<realm>/user/<username>/allocation/<%018llu>/<kind>. realm must
// match exactly; the username must have the exact shape central issues.
func ParseMessage(realm, channel, payload string) (Event, error) {
	prefix := "turn/realm/" + realm + "/user/"
	rest, ok := strings.CutPrefix(channel, prefix)
	if !ok || realm == "" {
		return Event{}, ErrMalformed
	}
	username, rest, ok := strings.Cut(rest, "/allocation/")
	if !ok || (username != "" && !wire.ValidUsername(username)) {
		return Event{}, ErrMalformed
	}
	sid, kind, ok := strings.Cut(rest, "/")
	if !ok || !wire.ValidSessionID(sid) {
		return Event{}, ErrMalformed
	}
	if username == "" {
		switch kind {
		case "traffic", "total_traffic":
			n, err := parseCounters(payload)
			if err != nil {
				return Event{}, err
			}
			return Event{Kind: KindUnattributed, SessionID: sid, Bytes: n}, nil
		case "traffic/peer", "total_traffic/peer", "status":
			return Event{Kind: KindUnattributed, SessionID: sid}, nil
		}
		return Event{}, ErrMalformed
	}
	ev := Event{Username: username, SessionID: sid}
	switch kind {
	case "traffic", "total_traffic":
		n, err := parseCounters(payload)
		if err != nil {
			return Event{}, err
		}
		ev.Bytes = n
		ev.Kind = KindTraffic
		if kind == "total_traffic" {
			ev.Kind = KindTotal
		}
	case "traffic/peer", "total_traffic/peer":
		ev.Kind = KindIgnored
	case "status":
		switch {
		case payload == "deleted":
			ev.Kind = KindDeleted
		case reLifetime.MatchString(payload):
			ev.Kind = KindNew
			if strings.HasPrefix(payload, "refreshed") {
				ev.Kind = KindRefreshed
			}
		default:
			ev.Kind = KindIgnored
		}
	default:
		return Event{}, ErrMalformed
	}
	return ev, nil
}

// parseCounters returns rcvb + sentb from "rcvp=…, rcvb=…, sentp=…, sentb=…".
func parseCounters(payload string) (uint64, error) {
	m := reCounters.FindStringSubmatch(payload)
	if m == nil {
		return 0, ErrMalformed
	}
	rcvb, err1 := strconv.ParseUint(m[2], 10, 64)
	sentb, err2 := strconv.ParseUint(m[4], 10, 64)
	if err1 != nil || err2 != nil || rcvb > wire.MaxCumulative || sentb > wire.MaxCumulative {
		return 0, ErrMalformed
	}
	return rcvb + sentb, nil // both ≤ 2^62: no overflow
}

// satAdd adds without wrapping, saturating at wire.MaxCumulative.
func satAdd(a, b uint64) uint64 {
	if a > wire.MaxCumulative || b > wire.MaxCumulative-a {
		return wire.MaxCumulative
	}
	return a + b
}
