package linkrtc

// The bounded lifetime of a RELAYED link, derived from the credential the
// server actually issued — a port of web/src/lib/relay-deadline.ts (A09b M4).
//
// A TURN REST username is `<unix-expiry>:<token>` (server/account/turn.go);
// when it lapses the allocation behind the link goes with it, silently. So the
// deadline is derived ONCE, up front, from the configuration the link was
// built with, and the link ends with a truthful "pair again" before the
// credential dies rather than after. It is a client-side bound on the client's
// own behaviour: it changes nothing on the wire and GRANTS NOTHING. Being
// wrong in the safe direction (ending slightly early) is the design goal.
//
// Two rules make "the deadline never extends a credential" structural:
//
//   - RelayDeadlineFor takes the EARLIEST expiry over every TURN credential in
//     the configuration (legacy list and whole pool), so an extra entry — a
//     forged or merely longer-lived `relays[]` member — can only leave the
//     bound where it is or move it earlier;
//   - DeadlineLatch holds the first bound it is given and only ever moves
//     earlier, so nothing a caller does later (a second configuration, a
//     re-derivation against a stepped clock) can push it out.

import (
	"strconv"
	"sync"
	"time"
)

// TURNClockSkew is `TURN_CLOCK_SKEW_MS`: the local-clock error the margin
// absorbs. A local clock BEHIND the server's would present dead credentials
// as live, so the margin is subtracted.
const TURNClockSkew = 60 * time.Second

// RelayDeadlineWarn is `RELAY_DEADLINE_WARN_MS`: how long before the deadline
// the live link says so.
const RelayDeadlineWarn = 5 * time.Minute

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER, the Web's bound.
const maxSafeInteger = 1<<53 - 1

// RelayDeadline is the Web's `RelayDeadline`, as absolute local-clock times.
type RelayDeadline struct {
	// ExpiresAt is the earliest server-stated expiry.
	ExpiresAt time.Time
	// DeadlineAt is when the relayed link must be terminal.
	DeadlineAt time.Time
	// WarnAt is when the live link must warn; never after DeadlineAt.
	WarnAt time.Time
}

// restExpirySeconds is the Web's strict parse: only `^\d+$` (ASCII digits)
// before the first colon counts, as a positive value inside the range
// JavaScript integers are exact in. Anything else states no expiry.
func restExpirySeconds(username string) (int64, bool) {
	colon := -1
	for i := 0; i < len(username); i++ {
		if username[i] == ':' {
			colon = i
			break
		}
	}
	if colon <= 0 {
		return 0, false
	}
	head := username[:colon]
	for i := 0; i < len(head); i++ {
		if head[i] < '0' || head[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(head, 10, 64)
	if err != nil || n <= 0 || n > maxSafeInteger {
		return 0, false
	}
	return n, true
}

// EarliestTURNExpiry is `earliestTurnExpiry`: the earliest unix-second expiry
// stated by a credential on an entry with a turn:/turns: URL. A STUN entry's
// username is ignored (it has no allocation to lose, and reading it would let
// a hostile body impose a deadline on a link that never relays). Malformed
// entries are skipped; valid siblings still bound the list.
func EarliestTURNExpiry(servers []ICEServer) (int64, bool) {
	var earliest int64
	found := false
	for _, s := range servers {
		if !HasTURNServer([]ICEServer{s}) {
			continue
		}
		u, ok := s.UsernameString()
		if !ok {
			continue
		}
		secs, ok := restExpirySeconds(u)
		if !ok {
			continue
		}
		if !found || secs < earliest {
			earliest, found = secs, true
		}
	}
	return earliest, found
}

// RelayDeadlineFor is `relayDeadline`: the bound for one configuration, or
// false when nothing in it states a TURN expiry (LAN, a STUN-only code room).
// Derived against now, once; both instants are clamped to now, so an
// already-expired credential yields an immediate deadline, never "none".
func RelayDeadlineFor(cfg ICEConfig, now time.Time) (RelayDeadline, bool) {
	earliest, found := EarliestTURNExpiry(cfg.ICEServers)
	for _, r := range cfg.Relays {
		if secs, ok := EarliestTURNExpiry(r.ICEServers); ok && (!found || secs < earliest) {
			earliest, found = secs, true
		}
	}
	if !found {
		return RelayDeadline{}, false
	}
	expires := time.Unix(earliest, 0)
	deadline := laterOf(now, expires.Add(-TURNClockSkew))
	return RelayDeadline{
		ExpiresAt:  expires,
		DeadlineAt: deadline,
		WarnAt:     laterOf(now, deadline.Add(-RelayDeadlineWarn)),
	}, true
}

func laterOf(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// DeadlineLatch holds a link's relay bound. The first Tighten sets it; every
// later one can only move it EARLIER. There is deliberately no way to clear or
// extend it: renewal (A11) is the only thing that may ever move a relayed
// link's end, and it will do so through its own reviewed path.
type DeadlineLatch struct {
	mu  sync.Mutex
	set bool
	d   RelayDeadline
}

// Tighten folds d into the latch and returns the bound now in force.
func (l *DeadlineLatch) Tighten(d RelayDeadline) RelayDeadline {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.set {
		l.set, l.d = true, d
		return l.d
	}
	if d.ExpiresAt.Before(l.d.ExpiresAt) {
		l.d.ExpiresAt = d.ExpiresAt
	}
	if d.DeadlineAt.Before(l.d.DeadlineAt) {
		l.d.DeadlineAt = d.DeadlineAt
	}
	if d.WarnAt.Before(l.d.WarnAt) {
		l.d.WarnAt = d.WarnAt
	}
	return l.d
}

// Bound is the bound in force, if any.
func (l *DeadlineLatch) Bound() (RelayDeadline, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.d, l.set
}
