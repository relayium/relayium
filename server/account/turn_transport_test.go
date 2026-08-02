package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A plain `turn:` URL is UDP-only in the browser. coturn listens on TCP at the
// same port, but nothing ever said so, which is why a peer on a UDP-blocking
// network (mobile carrier, corporate, campus) gathered no relay candidate at
// all — and, because the cross-network path forces iceTransportPolicy "relay",
// had no direct path left either. These tests pin the widening that closes it.
func TestWithTCPTransportPairsPlainTurnURLs(t *testing.T) {
	got := withTCPTransport([]string{"turn:relay.example.com:3478"})
	want := []string{"turn:relay.example.com:3478", "turn:relay.example.com:3478?transport=tcp"}
	if len(got) != len(want) {
		t.Fatalf("withTCPTransport = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("withTCPTransport = %v, want %v", got, want)
		}
	}
}

// UDP must stay first: ICE prefers the higher-priority UDP relay candidate, so
// the path selected on a network where UDP works is unchanged by this widening.
func TestWithTCPTransportKeepsUDPFirst(t *testing.T) {
	got := withTCPTransport([]string{"turn:a:3478", "turn:b:3478"})
	if got[0] != "turn:a:3478" || got[2] != "turn:b:3478" {
		t.Fatalf("UDP entries must lead their TCP siblings, got %v", got)
	}
	if got[1] != "turn:a:3478?transport=tcp" || got[3] != "turn:b:3478?transport=tcp" {
		t.Fatalf("each plain turn: URL needs its own TCP sibling, got %v", got)
	}
}

// An explicit transport is the deployment's own decision and must be preserved
// verbatim; `turns:` is already TLS-over-TCP per RFC 7065, so it needs nothing.
// A URL that already carries a query is left alone whatever the query says —
// appending a second `?transport=` would produce a URL no browser can parse.
func TestWithTCPTransportLeavesExplicitAndTLSAlone(t *testing.T) {
	in := []string{
		"turn:a:3478?transport=udp",
		"turn:b:3478?transport=tcp",
		"turn:e:3478?something=else",
		"turns:c:5349",
		"stun:d:3478",
	}
	got := withTCPTransport(in)
	if len(got) != len(in) {
		t.Fatalf("no URL should be widened here, got %v", got)
	}
	for i := range in {
		if got[i] != in[i] {
			t.Fatalf("withTCPTransport = %v, want %v unchanged", got, in)
		}
	}
}

// Re-widening an already-widened list must be a no-op, so a config that spells
// both forms out by hand does not end up with duplicate candidates.
func TestWithTCPTransportIsIdempotent(t *testing.T) {
	once := withTCPTransport([]string{"turn:a:3478"})
	twice := withTCPTransport(once)
	if len(twice) != len(once) {
		t.Fatalf("widening twice changed the list: %v then %v", once, twice)
	}
}

// relayium-node listens on UDP only (one PacketConnConfig in
// cmd/relayium-node/relay.go, no ListenerConfigs). Widening a node's URLs would
// hand every client a TCP candidate that can never allocate, so the widening is
// scoped to the two static, deployer-configured sources instead.
func TestICEDoesNotAdvertiseTCPForUDPOnlyNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner, _ := st.UpsertUserByEmail(ctx, "nodes@x.com", "n")
	st.SetEmailVerified(ctx, owner.ID)
	st.UpsertNode(ctx, Node{ID: "own", OwnerType: "user", OwnerUserID: owner.ID,
		URLs: []string{"turn:own:3478"}, TURNSecret: "so", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{ID: "fleet", OwnerType: "fleet",
		URLs: []string{"turn:fleet:3478"}, TURNSecret: "sf", CreatedAt: 1, LastSeenAt: now.Unix()})

	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:l:3478"},
			TURNSecret: "ourturnsecret", TURNURLs: []string{"turn:ours:3478"},
			TURNRelays: []RelayConfig{{ID: "static", Secret: "ss", URLs: []string{"turn:static:3478"}}}}}
	s.pairCodeOwner = func(string) (string, bool) { return owner.ID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)
	var resp struct {
		ICEServers []ICEServer  `json:"iceServers"`
		Relays     []relayEntry `json:"relays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	urlsOf := func(id string) []string {
		for _, e := range resp.Relays {
			if e.ID != id {
				continue
			}
			var out []string
			for _, srv := range e.ICEServers {
				out = append(out, srv.URLs...)
			}
			return out
		}
		t.Fatalf("relay %q missing from %+v", id, resp.Relays)
		return nil
	}

	for _, id := range []string{"own", "fleet"} {
		for _, u := range urlsOf(id) {
			if strings.Contains(u, "transport=tcp") {
				t.Fatalf("node %q is UDP-only but was advertised over TCP: %v", id, urlsOf(id))
			}
		}
	}

	// The deployer-configured relay pool entry is coturn, and does get widened.
	var staticTCP bool
	for _, u := range urlsOf("static") {
		if u == "turn:static:3478?transport=tcp" {
			staticTCP = true
		}
	}
	if !staticTCP {
		t.Fatalf("a configured static relay should offer TCP too, got %v", urlsOf("static"))
	}
}

// End to end: a browser holding a live pairing code must be handed the TCP form
// alongside the UDP one, under the same single ephemeral credential (one
// credential keeps coturn's metering attribution to the owning account intact).
func TestICEAdvertisesTCPTransportForPairingCode(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	owner := verifiedOwner(t, store, "tcp-owner@example.com")
	svc.SetPairCodeOwner(ownerResolver(owner, "K7M4XR"))

	resp, err := ts.Client().Get(ts.URL + "/api/ice?code=K7M4XR")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get: err=%v status=%v", err, resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)

	var turn *ICEServer
	for i := range servers {
		for _, u := range servers[i].URLs {
			if strings.HasPrefix(u, "turn:") {
				turn = &servers[i]
			}
		}
	}
	if turn == nil {
		t.Fatalf("expected a TURN entry for a live code, got %+v", servers)
	}
	var udp, tcp bool
	for _, u := range turn.URLs {
		if u == "turn:turn.example.com:3478" {
			udp = true
		}
		if u == "turn:turn.example.com:3478?transport=tcp" {
			tcp = true
		}
	}
	if !udp || !tcp {
		t.Fatalf("expected both UDP and TCP TURN URLs, got %v", turn.URLs)
	}
	if turn.Username == "" || turn.Credential == "" {
		t.Fatalf("both transports must share one ephemeral credential, got %+v", turn)
	}
}
