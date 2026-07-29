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
	if !has(ids, "node-a") {
		t.Fatalf("the registered node must survive, got %v", ids)
	}
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
	// One relay, two URLs for the same address: a transport variant of its own
	// first URL. claimAddrs checks every address before claiming any of them,
	// so this candidate never sees itself as already claimed. Collapsing that
	// two-pass shape into a single check-and-claim loop would disqualify this
	// node against its own first URL and drop it -- exactly the operator-
	// written static-config shape relayAddr's docs cite as the motivation for
	// stripping ?transport=tcp.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "node-multi-url",
		URLs: []string{"turn:198.51.100.9:3478", "turn:198.51.100.9:3478?transport=tcp"},
		TURNSecret: "s5", CreatedAt: 1, LastSeenAt: now.Unix()})

	cfg := Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"},
		TURNRelays: []RelayConfig{{ID: "static-z", URLs: []string{"turn:203.0.113.9:3478"}, Secret: "s4"}}}

	ids := icePoolIDs(t, st, cfg, owner, now)
	for _, want := range []string{"node-a", "node-b", "node-c", "node-multi-url", "static-z"} {
		if !has(ids, want) {
			t.Fatalf("distinct relay %s was dropped, got %v", want, ids)
		}
	}
}

// A fleet node's turn: address and a static config entry's turns: address at
// the same host and port are two distinct services -- plaintext TURN and
// TURN-over-TLS can coexist there without conflict, since UDP and TCP port
// spaces are independent. Both must survive in the pool; collapsing them
// would cost TURN-over-TLS reachability for peers on UDP-hostile networks,
// exactly the population that most needs it.
func TestICEStaticTURNSDoesNotDedupeAgainstNodeTURN(t *testing.T) {
	st := newTestStore(t)
	now := time.Unix(10000, 0)
	owner := seedOwner(t, st)
	st.UpsertNode(context.Background(), Node{OwnerType: "fleet", ID: "node-a",
		URLs: []string{"turn:198.51.100.7:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})

	cfg := Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"},
		TURNRelays: []RelayConfig{{ID: "static-tls",
			URLs: []string{"turns:198.51.100.7:3478"}, Secret: "s2"}}}

	ids := icePoolIDs(t, st, cfg, owner, now)
	if !has(ids, "node-a") {
		t.Fatalf("the fleet node's plain turn: relay must survive, got %v", ids)
	}
	if !has(ids, "static-tls") {
		t.Fatalf("the static turns: relay is a distinct service and must survive, got %v", ids)
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
