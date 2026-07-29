# Relay Pool Address Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/api/ice` handing the client the same physical relay twice under two different ids.

**Architecture:** A new pure helper normalises a TURN URL to a comparable `host:port`. The relay-pool builder in `turn.go` gains a second dedup set keyed on those addresses, consulted and claimed by all three of its sources in their existing order, so precedence is unchanged.

**Tech Stack:** Go standard library only (`strings`, `strconv`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-29-relay-pool-address-dedup-design.md`

## Global Constraints

- **The key is `host:port`**, not the URL string. What the client measures is the machine, not the URL, so two spellings of one host:port are one RTT.
  - **Corrected after review:** this key was shipped as plain `host:port` and then changed to `scheme:host:port` — a `turn:` and a `turns:` endpoint on the same host:port are two distinct services, not one machine spelled two ways. See `docs/superpowers/specs/2026-07-29-relay-pool-address-dedup-design.md` for why. This plan is left as originally written below; the code and spec are the current source of truth.
- Scheme defaults: `turn:` → port `3478`, `turns:` → port `5349`.
- Host comparison is case-insensitive. **Never resolve DNS** — two names for one machine stay two entries, because resolving would put a network round trip on `/api/ice`, which must stay fast.
- **A candidate is skipped when *any* of its addresses is already claimed.** A relay advertising several URLs is one machine; accepting it "for the URLs that don't collide" hands the client a second entry pointing at the same box, which is the bug being fixed.
- **Unparseable URLs fail open.** A URL that yields no `host:port` claims nothing and forces no skip; its entry stays in the pool. A parser that cannot read an unusual but working URL must never be able to empty the relay pool.
- **Addresses are claimed only when an entry is actually appended** — never before the other skip checks. A node withheld by the traffic cap must not leave its address claimed behind it.
- Existing precedence must not change: own nodes → fleet nodes → static config.
- **Two of Task 2's tests are regression guards and pass before the change as well as after** — `TestICEKeepsDistinctRelays` and `TestICEKeepsEntriesWithUnparseableURLs`. They pin behaviour that must not change, rather than demonstrating new behaviour, so "it passed before implementation" is their purpose and not a defect. Do not rewrite them to fail first. An over-eager dedup silently shrinks the relay pool, and a shrunken pool looks exactly like a healthy one from the outside; these two are the only thing standing between that and production.
- Conventional commits. Commit messages in English regardless of the working language.
- No real node IP addresses or production relay ids anywhere in this repo. Tests use documentation-range addresses and invented ids.

---

### Task 1: `relayAddr` — normalise a TURN URL to `host:port`

**Files:**
- Create: `server/account/relayaddr.go`
- Create: `server/account/relayaddr_test.go`

**Interfaces:**
- Produces: `relayAddr(raw string) (string, bool)` and `relayAddrs(urls []string) []string` (both consumed by Task 2)
- Consumes: nothing — this task is pure and touches no existing file

- [ ] **Step 1: Write the failing tests**

Create `server/account/relayaddr_test.go`:

```go
package account

import "testing"

func TestRelayAddrNormalises(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain turn", "turn:198.51.100.7:3478", "198.51.100.7:3478"},
		{"transport variant is the same relay", "turn:198.51.100.7:3478?transport=tcp", "198.51.100.7:3478"},
		{"turn default port", "turn:relay.example", "relay.example:3478"},
		{"turns default port", "turns:relay.example", "relay.example:5349"},
		{"turns explicit port", "turns:relay.example:5349", "relay.example:5349"},
		{"host case folds", "turn:Relay.EXAMPLE:3478", "relay.example:3478"},
		{"scheme case folds", "TURN:relay.example:3478", "relay.example:3478"},
		{"ipv6 with port", "turn:[2001:db8::1]:3478", "[2001:db8::1]:3478"},
		{"ipv6 without port", "turn:[2001:db8::1]", "[2001:db8::1]:3478"},
		{"surrounding space", "  turn:relay.example:3478  ", "relay.example:3478"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := relayAddr(tc.in)
			if !ok {
				t.Fatalf("relayAddr(%q) returned not-ok", tc.in)
			}
			if got != tc.want {
				t.Fatalf("relayAddr(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Different ports on one host are different relays. Collapsing them would
// silently shrink a pool that legitimately runs two relays on one machine.
func TestRelayAddrDistinguishesPorts(t *testing.T) {
	a, ok := relayAddr("turn:relay.example:3478")
	if !ok {
		t.Fatal("first url did not parse")
	}
	b, ok := relayAddr("turn:relay.example:3479")
	if !ok {
		t.Fatal("second url did not parse")
	}
	if a == b {
		t.Fatalf("ports collapsed: both normalised to %q", a)
	}
}

// Anything unreadable must report not-ok rather than inventing an address.
// A wrong address is worse than no address: it would drop a working relay.
func TestRelayAddrRejectsUnparseable(t *testing.T) {
	for _, in := range []string{
		"",
		"   ",
		"turn:",
		"stun:relay.example:3478",   // not a TURN url
		"relay.example:3478",        // no scheme
		"turn:relay.example:notaport",
		"turn:relay.example:",
		"turn:[2001:db8::1",         // unterminated bracket
		"turn:2001:db8::1:3478",     // bare ipv6, brackets required
		"turn:[2001:db8::1]junk",    // trailing garbage after the bracket
	} {
		if got, ok := relayAddr(in); ok {
			t.Fatalf("relayAddr(%q) = %q, want not-ok", in, got)
		}
	}
}

// relayAddrs drops what it cannot read instead of failing the whole list --
// this is what makes an entry with one odd URL stay in the pool.
func TestRelayAddrsSkipsUnparseable(t *testing.T) {
	got := relayAddrs([]string{"turn:relay.example:3478", "garbage", "turns:other.example"})
	want := []string{"relay.example:3478", "other.example:5349"}
	if len(got) != len(want) {
		t.Fatalf("relayAddrs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("relayAddrs = %v, want %v", got, want)
		}
	}
}

func TestRelayAddrsEmptyWhenNothingParses(t *testing.T) {
	if got := relayAddrs([]string{"garbage", ""}); len(got) != 0 {
		t.Fatalf("relayAddrs = %v, want empty", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run TestRelayAddr -v`
Expected: FAIL — `undefined: relayAddr`, `undefined: relayAddrs`

- [ ] **Step 3: Write the implementation**

Create `server/account/relayaddr.go`:

```go
package account

import (
	"strconv"
	"strings"
)

// relayAddr normalises one TURN URL to a comparable "host:port", reporting
// false when it cannot read one.
//
// The relay pool dedupes on this rather than on the URL string because what the
// client measures is the MACHINE, not the URL: turn:H:3478 and
// turn:H:3478?transport=tcp are one relay and one RTT. A statically configured
// relay's `urls` array is operator-written and may legitimately list both.
//
// DNS is deliberately not resolved. Two names for one machine stay two entries;
// resolving would put a network round trip on /api/ice, which must stay fast.
func relayAddr(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	lower := strings.ToLower(s)
	var defPort string
	switch {
	case strings.HasPrefix(lower, "turns:"):
		s, defPort = s[len("turns:"):], "5349"
	case strings.HasPrefix(lower, "turn:"):
		s, defPort = s[len("turn:"):], "3478"
	default:
		return "", false
	}
	// Query parameters (?transport=tcp) name a transport, not a relay.
	if i := strings.IndexByte(s, '?'); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}

	host, port := s, defPort
	switch {
	case strings.HasPrefix(s, "["):
		// IPv6 literal: the host runs to the closing bracket, which stays part
		// of the key so "[::1]:3478" cannot be confused with a name.
		end := strings.IndexByte(s, ']')
		if end < 0 {
			return "", false
		}
		host = s[:end+1]
		switch rest := s[end+1:]; {
		case rest == "":
		case strings.HasPrefix(rest, ":"):
			port = rest[1:]
		default:
			return "", false
		}
	default:
		if i := strings.LastIndexByte(s, ':'); i >= 0 {
			host, port = s[:i], s[i+1:]
		}
		// A bare IPv6 would have just been split at its last colon, yielding a
		// host that is really an address prefix. TURN URLs require brackets, so
		// reject it rather than invent a host.
		if strings.Contains(host, ":") {
			return "", false
		}
	}
	if host == "" || port == "" {
		return "", false
	}
	if _, err := strconv.Atoi(port); err != nil {
		return "", false
	}
	return strings.ToLower(host) + ":" + port, true
}

// relayAddrs normalises a relay's URL list, dropping what it cannot read.
//
// Dropping rather than failing is what makes an entry with one odd URL stay in
// the pool: a parser that cannot read an unusual but working URL must never be
// able to empty the relay pool.
func relayAddrs(urls []string) []string {
	out := make([]string, 0, len(urls))
	for _, u := range urls {
		if a, ok := relayAddr(u); ok {
			out = append(out, a)
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./account/ -run TestRelayAddr -v`
Expected: PASS — all five tests, including every subtest of `TestRelayAddrNormalises`.

Then confirm nothing else broke and vet is clean:
`cd server && go build ./... && go vet ./account/ && go test ./account/`
Expected: build clean, vet silent, all tests PASS. This task only adds files, so nothing that passed before may fail now.

- [ ] **Step 5: Commit**

```bash
git add server/account/relayaddr.go server/account/relayaddr_test.go
git commit -m "feat(ice): normalise a TURN url to a comparable host:port

The relay pool is about to dedupe on this. It keys on host:port rather than the
URL string because what the client measures is the machine, not the URL --
turn:H:3478 and turn:H:3478?transport=tcp are one relay and one RTT, and a
statically configured relay's urls array is operator-written and may list both.

DNS is deliberately not resolved: two names for one machine stay two entries,
because resolving would put a network round trip on /api/ice.

Unreadable URLs report not-ok rather than inventing an address. A wrong address
would drop a working relay, which is strictly worse than the duplicate this is
meant to prevent."
```

---

### Task 2: dedupe the pool by address

**Files:**
- Modify: `server/account/relayaddr.go` (add `claimAddrs`)
- Modify: `server/account/turn.go:149-204` (the relay-pool block)
- Create: `server/account/turn_dedup_test.go`

**Interfaces:**
- Consumes: `relayAddrs(urls []string) []string` from Task 1
- Produces: `claimAddrs(seenAddr map[string]bool, urls []string) bool`

- [ ] **Step 1: Write the failing tests**

Create `server/account/turn_dedup_test.go`. Every test uses the same harness shape as the existing `server/account/turn_nodes_test.go`: a verified user seeded as the pairing-code owner so the upstream gates pass and the relay-pool builder is actually reached.

```go
package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// icePoolIDs drives handleICE and returns the ids in the relay pool, in order.
func icePoolIDs(t *testing.T, st *SQLiteStore, cfg Config, ownerID string, now time.Time) []string {
	t.Helper()
	s := &Service{store: st, now: func() time.Time { return now }, cfg: cfg}
	s.pairCodeOwner = func(code string) (string, bool) { return ownerID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("ice: %d", w.Code)
	}
	var resp struct {
		Relays []relayEntry `json:"relays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ids := make([]string, 0, len(resp.Relays))
	for _, e := range resp.Relays {
		ids = append(ids, e.ID)
	}
	return ids
}

// seedOwner creates a verified user usable as the pairing-code owner.
func seedOwner(t *testing.T, st *SQLiteStore) string {
	t.Helper()
	ctx := context.Background()
	owner, err := st.UpsertUserByEmail(ctx, "u@example.com", "u")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := st.SetEmailVerified(ctx, owner.ID); err != nil {
		t.Fatalf("verify user: %v", err)
	}
	return owner.ID
}

func has(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// A static RELAYIUM_TURN_RELAYS entry pointing at the same machine as a
// registered node. Their ids differ -- one is operator-chosen, the other
// generated -- so id-based dedup cannot see the collision. The dynamic node
// wins, which is what turn.go's own comments already claim happens.
func TestICEStaticRelayDuplicatingANodeIsDropped(t *testing.T) {
	st := newTestStore(t)
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(context.Background(), Node{OwnerType: "fleet", ID: "node-a",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})

	cfg := Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"},
		TURNRelays: []RelayConfig{{ID: "static-a", URLs: []string{"turn:198.51.100.7:3478"}, Secret: "s2"}}}

	ids := icePoolIDs(t, st, cfg, owner, now)
	if !has(ids, "node-a") {
		t.Fatalf("the registered node must survive, got %v", ids)
	}
	if has(ids, "static-a") {
		t.Fatalf("static relay duplicates node-a's address and must be dropped, got %v", ids)
	}
}

// A transport variant is the same machine. This is the case a URL-string key
// would miss, and a static relay's urls array is operator-written.
func TestICEStaticRelayDuplicatingViaTransportVariantIsDropped(t *testing.T) {
	st := newTestStore(t)
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(context.Background(), Node{OwnerType: "fleet", ID: "node-a",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})

	cfg := Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"},
		TURNRelays: []RelayConfig{{ID: "static-a",
			URLs: []string{"turn:198.51.100.7:3478?transport=tcp"}, Secret: "s2"}}}

	ids := icePoolIDs(t, st, cfg, owner, now)
	if has(ids, "static-a") {
		t.Fatalf("?transport=tcp names a transport, not a second relay, got %v", ids)
	}
}

// A node that loses state.json re-registers with a fresh id while the old row
// lingers until its heartbeat ages out. OnlineNodes orders by last_seen_at DESC,
// so the live re-registration is reached first and claims the address.
func TestICEStaleNodeRowSharingAnAddressIsDropped(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-old",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix() - 60})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-new",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: now.Unix()})

	ids := icePoolIDs(t, st, Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"}}, owner, now)
	if !has(ids, "node-new") {
		t.Fatalf("the live re-registration must win, got %v", ids)
	}
	if has(ids, "node-old") {
		t.Fatalf("the stale row shares node-new's address and must be dropped, got %v", ids)
	}
}

// The own-nodes loop writes to `seen` but never reads it, so it needs the
// address guard too.
func TestICEOwnNodesSharingAnAddressAreDeduped(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: owner, ID: "own-old",
		URLs: []string{"turn:203.0.113.9:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix() - 60})
	st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: owner, ID: "own-new",
		URLs: []string{"turn:203.0.113.9:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: now.Unix()})

	ids := icePoolIDs(t, st, Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"}}, owner, now)
	if !has(ids, "own-new") {
		t.Fatalf("the live own node must win, got %v", ids)
	}
	if has(ids, "own-old") {
		t.Fatalf("duplicate own-node address must be dropped, got %v", ids)
	}
}

// Precedence is unchanged: an owner's own node beats a fleet node at the same
// address, which beats a static config entry.
func TestICEOwnNodeBeatsFleetNodeAtTheSameAddress(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: owner, ID: "own-a",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "fleet-a",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: now.Unix()})

	ids := icePoolIDs(t, st, Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"}}, owner, now)
	if !has(ids, "own-a") {
		t.Fatalf("the owner's own node must win, got %v", ids)
	}
	if has(ids, "fleet-a") {
		t.Fatalf("fleet node duplicates the own node's address, got %v", ids)
	}
}

// The regression that matters most: an over-eager dedup silently shrinks the
// pool, and a shrunken pool looks exactly like a healthy one from the outside.
func TestICEKeepsDistinctRelays(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-a",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-b",
		URLs: []string{"turn:198.51.100.8:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: now.Unix()})
	// Same host as node-a but a different port: a genuinely different relay.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-c",
		URLs: []string{"turn:198.51.100.7:3479"}, TURNSecret: "s3", CreatedAt: 1, LastSeenAt: now.Unix()})

	cfg := Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"},
		TURNRelays: []RelayConfig{{ID: "static-z", URLs: []string{"turn:203.0.113.9:3478"}, Secret: "s4"}}}

	ids := icePoolIDs(t, st, cfg, owner, now)
	for _, want := range []string{"node-a", "node-b", "node-c", "static-z"} {
		if !has(ids, want) {
			t.Fatalf("distinct relay %s was dropped, got %v", want, ids)
		}
	}
}

// Fail open: a URL the parser cannot read claims nothing and blocks nothing.
// A parser that cannot read an unusual but working URL must never be able to
// empty the relay pool.
func TestICEKeepsEntriesWithUnparseableURLs(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-odd-1",
		URLs: []string{"some-future-scheme:relay.example"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-odd-2",
		URLs: []string{"some-future-scheme:relay.example"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: now.Unix()})

	ids := icePoolIDs(t, st, Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"}}, owner, now)
	for _, want := range []string{"node-odd-1", "node-odd-2"} {
		if !has(ids, want) {
			t.Fatalf("unparseable urls must not remove %s from the pool, got %v", want, ids)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run TestICE -v 2>&1 | tail -40`
Expected: the seven new tests FAIL on the duplicate assertions (e.g. `static relay duplicates node-a's address and must be dropped`), while `TestICEKeepsDistinctRelays` and `TestICEKeepsEntriesWithUnparseableURLs` already PASS — they assert behaviour that must not change. Pre-existing `TestICE*` tests must also still pass at this point.

- [ ] **Step 3: Add `claimAddrs`**

Append to `server/account/relayaddr.go`:

```go
// claimAddrs reports whether every address this candidate advertises is still
// free and, when it is, claims them all for it.
//
// ANY overlap disqualifies the whole candidate: a relay advertising several
// URLs is one machine, so accepting it "for the URLs that don't collide" would
// hand the client a second entry pointing at the same box -- exactly the bug
// this dedup exists to fix.
//
// A candidate whose URLs are all unparseable claims nothing and is admitted.
// That is deliberate: see relayAddrs.
//
// Call this LAST, immediately before appending. Claiming before the other skip
// checks would let a candidate that is then withheld (over its traffic cap, say)
// leave its address claimed behind it, silently removing the relay that would
// otherwise have covered that address.
func claimAddrs(seenAddr map[string]bool, urls []string) bool {
	addrs := relayAddrs(urls)
	for _, a := range addrs {
		if seenAddr[a] {
			return false
		}
	}
	for _, a := range addrs {
		seenAddr[a] = true
	}
	return true
}
```

- [ ] **Step 4: Wire it into the three sources**

In `server/account/turn.go`, declare the set next to `seen` (currently `seen := map[string]bool{}` at line 151):

```go
		seen := map[string]bool{}
		// Second dedup key: the physical relay. `seen` catches a repeated id;
		// this catches one machine offered under two ids -- a static config
		// entry and a registered node at the same address, or a node that lost
		// state.json and re-registered with a fresh id while its old row is
		// still inside nodeOnlineWindow. See claimAddrs.
		seenAddr := map[string]bool{}
```

**Source 1, the owner's own nodes.** Insert the guard after the existing validity check and before `relays = append(...)`:

```go
				if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 {
					continue
				}
				if !claimAddrs(seenAddr, n.URLs) {
					continue
				}
				relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
					ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
				seen[n.ID] = true
```

**Source 2, online fleet nodes.** The guard goes after the traffic-cap check, so a withheld node claims nothing:

```go
					if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 || seen[n.ID] {
						continue
					}
					if cap := usableTraffic(resolveNodeTrafficLimit(n, st)); cap > 0 && monthlyUsed[n.ID] >= cap {
						continue // at/over the 90% scheduling reserve — withhold this node
					}
					if !claimAddrs(seenAddr, n.URLs) {
						continue
					}
					relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
						ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
					seen[n.ID] = true
```

**Source 3, static config.** Same shape:

```go
			for _, rc := range s.cfg.TURNRelays {
				if rc.ID == "" || rc.Secret == "" || len(rc.URLs) == 0 || seen[rc.ID] {
					continue // skip misconfigured or already-covered-by-a-dynamic-node
				}
				if !claimAddrs(seenAddr, rc.URLs) {
					continue // a dynamic node already covers this machine
				}
				relays = append(relays, relayEntry{ID: rc.ID, Region: rc.Region, STUN: rc.STUN,
					ICEServers: []ICEServer{turnCredentials(rc.Secret, token, expiry, rc.URLs)}})
			}
```

- [ ] **Step 5: Run the full suite**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/ -run 'TestICE|TestRelayAddr' -v 2>&1 | tail -40`
Expected: all new and pre-existing `TestICE*` and `TestRelayAddr*` tests PASS.

Then the whole package and the race detector, which CI runs as a separate job:
`cd server && go test ./account/ && go test -race ./account/`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add server/account/relayaddr.go server/account/turn.go server/account/turn_dedup_test.go
git commit -m "fix(ice): dedupe the relay pool by address, not only by id

The pool's \`seen\` map is keyed on the entry id, so two entries describing the
same machine under different ids both reach the client, which then spends two
RTT probes measuring one relay.

Two ways that happens. A statically configured relay and a registered node at
the same address have unrelated ids. And a node that loses state.json
re-registers with a fresh id while its old row stays in the pool until its
heartbeat ages out -- that one needs no misconfiguration at all.

All three sources now claim their host:port addresses in their existing order,
so precedence is unchanged and dynamic nodes still win, which is what the
comments here already claimed happened. Addresses are claimed only on the path
that actually appends, so a node withheld by its traffic cap does not leave its
address claimed behind it."
```

---

## Self-review notes

Two things a reviewer should check specifically, because both are easy to
"simplify" into bugs:

- `claimAddrs` is called **last** in each loop, after every other skip check. Moving it earlier — which reads tidier next to the other `if ... { continue }` guards — would let a node withheld by the traffic cap claim its address and silently suppress the static relay that covers the same machine.
- `TestICEKeepsDistinctRelays` and `TestICEKeepsEntriesWithUnparseableURLs` pass **before** the change as well as after. That is intentional: they are regression guards on behaviour that must not change, not demonstrations of the new behaviour. Do not "fix" them to fail first.
