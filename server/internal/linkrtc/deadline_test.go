package linkrtc

// web/src/lib/relay-deadline.test.ts as vectors, plus the M4 adversarial
// cases: an extra (forged or longer-lived) credential and a second derivation
// can never move a link's end LATER.

import (
	"fmt"
	"testing"
	"time"
)

func turnSrv(username string, urls ...string) ICEServer {
	if len(urls) == 0 {
		urls = []string{"turn:relay.example:3478"}
	}
	return ICEServer{URLs: urls, Username: username, Credential: "x", hasUsername: true, hasCredential: true}
}

var stunSrv = ICEServer{URLs: []string{"stun:stun.example:3478"}}

func TestEarliestTURNExpiryWebVectors(t *testing.T) {
	if got, ok := EarliestTURNExpiry([]ICEServer{turnSrv("1900000000:owner.123456")}); !ok || got != 1_900_000_000 {
		t.Errorf("reads the TURN REST username's unix-second prefix: %d %t", got, ok)
	}
	got, ok := EarliestTURNExpiry([]ICEServer{
		turnSrv("1900000900:owner.123456"),
		turnSrv("1900000300:owner.123456", "turns:relay2.example:5349"),
		turnSrv("1900000600:owner.123456", "turn:relay3.example:3478", "turn:relay3.example:3478?transport=tcp"),
	})
	if !ok || got != 1_900_000_300 {
		t.Errorf("takes the EARLIEST of several relays: %d %t", got, ok)
	}
	for _, list := range [][]ICEServer{{stunSrv}, {}, nil} {
		if _, ok := EarliestTURNExpiry(list); ok {
			t.Errorf("has no expiry for a STUN-only list: %+v", list)
		}
	}
	stunWithUser := ICEServer{URLs: []string{"stun:stun.example:3478"}, Username: "1:x", Credential: "x", hasUsername: true, hasCredential: true}
	if _, ok := EarliestTURNExpiry([]ICEServer{stunWithUser}); ok {
		t.Error("ignores a username on an entry that carries no turn:/turns: URL")
	}
	malformed := map[string]string{
		"no colon at all":       "notatimestamp",
		"a non-numeric prefix":  "abc:owner.123456",
		"an empty prefix":       ":owner.123456",
		"a signed prefix":       "+1900000000:owner.123456",
		"a fractional prefix":   "1900000000.5:owner.123456",
		"a hex prefix":          "0x71b1b900:owner.123456",
		"whitespace padding":    " 1900000000:owner.123456",
		"a non-positive prefix": "0:owner.123456",
		"a negative prefix":     "-1900000000:owner.123456",
		"an absurd prefix":      "99999999999999999999:owner.123456",
		"an empty username":     "",
		"beyond 2^53-1":         "9007199254740992:owner.123456",
		"non-ASCII digits":      "١٩٠٠:owner",
	}
	for label, u := range malformed {
		if got, ok := EarliestTURNExpiry([]ICEServer{turnSrv(u)}); ok {
			t.Errorf("ignores a malformed credential with %s: got %d", label, got)
		}
	}
	noUser := ICEServer{URLs: []string{"turn:relay.example:3478"}}
	if _, ok := EarliestTURNExpiry([]ICEServer{noUser}); ok {
		t.Error("no username")
	}
	if got, ok := EarliestTURNExpiry([]ICEServer{turnSrv("garbage"), turnSrv("1900000000:owner.123456")}); !ok || got != 1_900_000_000 {
		t.Errorf("keeps a valid sibling when one entry is malformed: %d %t", got, ok)
	}
	hostile := []ICEServer{
		{URLs: nil},
		{URLs: []string{"turn:relay.example:3478"}, hasUsername: true, badUsername: true},
	}
	if _, ok := EarliestTURNExpiry(hostile); ok {
		t.Error("never reads an expiry from a hostile body shape")
	}
}

func TestRelayDeadlineWebVectors(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	inMinutes := func(m int) int64 { return now.Add(time.Duration(m) * time.Minute).Unix() }
	user := func(m int) string { return fmt.Sprintf("%d:owner.123456", inMinutes(m)) }

	d, ok := RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{stunSrv, turnSrv(user(60))}}, now)
	if !ok || !d.ExpiresAt.Equal(now.Add(60*time.Minute)) || !d.DeadlineAt.Equal(now.Add(60*time.Minute-TURNClockSkew)) ||
		!d.WarnAt.Equal(d.DeadlineAt.Add(-RelayDeadlineWarn)) {
		t.Errorf("subtracts a clock-skew margin from the earliest expiry: %+v", d)
	}

	d, _ = RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{stunSrv}, Relays: []RelayEntry{
		{ID: "a", ICEServers: []ICEServer{turnSrv(user(50))}},
		{ID: "b", ICEServers: []ICEServer{turnSrv(user(20))}},
	}}, now)
	if !d.ExpiresAt.Equal(now.Add(20 * time.Minute)) {
		t.Errorf("folds the relay pool in, not just the legacy top-level entry: %+v", d)
	}

	for _, cfg := range []ICEConfig{
		{ICEServers: []ICEServer{stunSrv}},
		{},
		{ICEServers: []ICEServer{stunSrv}, Relays: []RelayEntry{{ID: "a", ICEServers: []ICEServer{stunSrv}}}},
	} {
		if _, ok := RelayDeadlineFor(cfg, now); ok {
			t.Errorf("has no deadline for a STUN-only config: %+v", cfg)
		}
	}

	d, _ = RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{turnSrv(user(-30))}}, now)
	if !d.DeadlineAt.Equal(now) || !d.WarnAt.Equal(now) {
		t.Errorf("clamps a credential that is already expired to an immediate deadline: %+v", d)
	}

	d, _ = RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{turnSrv(user(2))}}, now)
	if !d.DeadlineAt.Equal(now.Add(2*time.Minute-TURNClockSkew)) || !d.WarnAt.Equal(now) || d.WarnAt.After(d.DeadlineAt) {
		t.Errorf("clamps the warning to the deadline when less than the warning lead remains: %+v", d)
	}

	a, _ := RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{turnSrv(user(60))}}, now)
	b, _ := RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{turnSrv(user(60))}}, now.Add(10*time.Minute))
	if !a.DeadlineAt.Equal(b.DeadlineAt) {
		t.Errorf("is a plain absolute local-clock pair: %v vs %v", a.DeadlineAt, b.DeadlineAt)
	}
}

// M4 adversarial: a forged relays[] entry stating a far-future expiry (with a
// credential that could never authenticate) cannot make the link outlive the
// real credential — the bound is the EARLIEST expiry, whatever else is listed,
// and in whatever order.
func TestForgedRelayEntryCannotExtendDeadline(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	real := turnSrv(fmt.Sprintf("%d:owner.tag", now.Add(10*time.Minute).Unix()))
	forged := RelayEntry{ID: "forged", ICEServers: []ICEServer{turnSrv("4102444800:attacker.tag", "turn:evil.example:3478")}}
	stunForged := RelayEntry{ID: "stunforged", ICEServers: []ICEServer{
		{URLs: []string{"stun:evil.example:3478"}, Username: "4102444800:x", hasUsername: true},
	}}
	base, _ := RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{real}}, now)
	for _, cfg := range []ICEConfig{
		{ICEServers: []ICEServer{real}, Relays: []RelayEntry{forged}},
		{Relays: []RelayEntry{forged, {ID: "r", ICEServers: []ICEServer{real}}}},
		{ICEServers: []ICEServer{turnSrv("4102444800:attacker.tag"), real}},
		{ICEServers: []ICEServer{real}, Relays: []RelayEntry{stunForged, forged}},
	} {
		d, ok := RelayDeadlineFor(cfg, now)
		if !ok || d.DeadlineAt.After(base.DeadlineAt) || d.ExpiresAt.After(base.ExpiresAt) {
			t.Errorf("forged entry moved the bound: %+v vs %+v (cfg %+v)", d, base, cfg)
		}
	}
	// Only a forged entry and no real credential: the bound is the forged
	// expiry, but that credential cannot allocate (the relay verifies the
	// HMAC), so it relays nothing; the deadline is then an upper bound on a
	// link that never had a relay. Proven end to end in cmd/relayium.
}

// M4: the latch never moves later, however it is fed.
func TestDeadlineLatchNeverExtends(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	mk := func(m int) RelayDeadline {
		d, _ := RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{turnSrv(fmt.Sprintf("%d:o.t", now.Add(time.Duration(m)*time.Minute).Unix()))}}, now)
		return d
	}
	var l DeadlineLatch
	if _, ok := l.Bound(); ok {
		t.Fatal("an empty latch has a bound")
	}
	first := l.Tighten(mk(30))
	if got := l.Tighten(mk(90)); !got.DeadlineAt.Equal(first.DeadlineAt) || !got.WarnAt.Equal(first.WarnAt) || !got.ExpiresAt.Equal(first.ExpiresAt) {
		t.Fatalf("a later credential extended the latch: %+v -> %+v", first, got)
	}
	earlier := l.Tighten(mk(10))
	if !earlier.DeadlineAt.Before(first.DeadlineAt) {
		t.Fatalf("an earlier credential did not tighten: %+v", earlier)
	}
	// Re-deriving the SAME credential against a clock stepped back an hour
	// cannot move it later either.
	back := now.Add(-time.Hour)
	d, _ := RelayDeadlineFor(ICEConfig{ICEServers: []ICEServer{turnSrv(fmt.Sprintf("%d:o.t", now.Add(10*time.Minute).Unix()))}}, back)
	if got := l.Tighten(d); got.DeadlineAt.After(earlier.DeadlineAt) {
		t.Fatalf("a stepped clock extended the latch: %+v", got)
	}
	if b, _ := l.Bound(); !b.DeadlineAt.Equal(earlier.DeadlineAt) {
		t.Fatalf("bound %+v", b)
	}
}
