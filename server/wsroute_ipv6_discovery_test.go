package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// These tests drive the code-less LAN room through the real /ws route, the real
// ServeWS read loop and the real Hub. The httptest server's direct peer is
// loopback, which signal.IPExtractor always trusts, so the X-Forwarded-For each
// client sends stands in for the address the production reverse proxy observed.
// Nothing here asserts an absence by sleeping: every "not in the room" claim is
// read off a roster that is already known to postdate the join it excludes.

// discoveryServer is one /ws endpoint backed by a real Hub. remoteAddr, when
// set, replaces the direct peer address the route sees, to model a client that
// reaches the server without going through a trusted proxy.
type discoveryServer struct {
	t   *testing.T
	hub *signal.Hub
	url string
}

func newDiscoveryServer(t *testing.T, liveCode, codeRoom, remoteAddr string) *discoveryServer {
	t.Helper()
	route := newTestRoute(liveCode, func() int64 { return 1_000 })
	route.ipx = signal.NewIPExtractor(nil)
	if codeRoom != "" {
		route.resolvePair = func(code string) (string, bool) {
			return codeRoom, code == liveCode
		}
	}
	hub := signal.NewHub()
	var ids atomic.Int64
	route.handle = signal.ServeWS(hub, func() string { return fmt.Sprintf("peer-%d", ids.Add(1)) })
	h := route.handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if remoteAddr != "" {
			r.RemoteAddr = remoteAddr
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return &discoveryServer{t: t, hub: hub, url: "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"}
}

// discoveryClient is one joined signaling connection and what its welcome said.
type discoveryClient struct {
	t    *testing.T
	conn *websocket.Conn
	id   string // server-issued peer id (welcome.name)
	ip   string // server-observed address (welcome.ip)
}

// join dials with the given X-Forwarded-For and optional pairing code, sends a
// join and returns once the welcome has arrived, i.e. once the Hub has admitted
// the connection to whatever room the route chose.
func (s *discoveryServer) join(xff, code, name string) *discoveryClient {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	u := s.url
	if code != "" {
		u += "?code=" + code
	}
	hdr := http.Header{}
	if xff != "" {
		hdr.Set("X-Forwarded-For", xff)
	}
	conn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		s.t.Fatalf("dial %s: %v", name, err)
	}
	s.t.Cleanup(func() { conn.CloseNow() })
	payload, _ := json.Marshal(map[string]string{"type": signal.TypeJoin, "name": name})
	if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
		s.t.Fatalf("join %s: %v", name, err)
	}
	c := &discoveryClient{t: s.t, conn: conn}
	for {
		e := c.read(ctx, name)
		if e.Type == signal.TypeWelcome {
			c.id, c.ip = e.Name, e.IP
			return c
		}
	}
}

func (c *discoveryClient) read(ctx context.Context, what string) signal.Envelope {
	c.t.Helper()
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("read (%s): %v", what, err)
	}
	var e signal.Envelope
	if err := json.Unmarshal(data, &e); err != nil {
		c.t.Fatalf("decode (%s): %v", what, err)
	}
	return e
}

// awaitRosterWith reads frames until a roster lists every id in want, and
// returns that roster's ids, sorted. Bounded by a deadline, never by a sleep.
func (c *discoveryClient) awaitRosterWith(want ...string) []string {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		e := c.read(ctx, fmt.Sprintf("roster with %v", want))
		if e.Type != signal.TypePeers {
			continue
		}
		got := make([]string, 0, len(e.Peers))
		seen := map[string]bool{}
		for _, p := range e.Peers {
			got = append(got, p.ID)
			seen[p.ID] = true
		}
		all := true
		for _, id := range want {
			all = all && seen[id]
		}
		if all {
			sort.Strings(got)
			return got
		}
	}
}

func sortedIDs(ids ...string) []string {
	out := append([]string(nil), ids...)
	sort.Strings(out)
	return out
}

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Two devices on one IPv6 network hold different global addresses in the same
// /64. They must meet in one LAN room, and each must still be told its own
// exact observed address rather than the room's prefix.
func TestLANDiscoveryGroupsDistinctIPv6AddressesInOne64(t *testing.T) {
	s := newDiscoveryServer(t, "", "", "")
	a := s.join("2001:db8:1234:5678::a", "", "laptop")
	b := s.join("2001:db8:1234:5678:ffff:eeee:dddd:b", "", "phone")

	if a.ip != "2001:db8:1234:5678::a" || b.ip != "2001:db8:1234:5678:ffff:eeee:dddd:b" {
		t.Fatalf("welcome.ip = %q / %q, want each client's exact observed address", a.ip, b.ip)
	}
	want := sortedIDs(a.id, b.id)
	if got := a.awaitRosterWith(b.id); !sameIDs(got, want) {
		t.Fatalf("laptop roster = %v, want %v", got, want)
	}
	if got := b.awaitRosterWith(a.id); !sameIDs(got, want) {
		t.Fatalf("phone roster = %v, want %v", got, want)
	}
	if got := s.hub.PeerCount("2001:db8:1234:5678::/64"); got != 2 {
		t.Fatalf("/64 room peers = %d, want 2", got)
	}
}

// A neighbouring /64 is a different network. Its client joins between the two
// same-network clients, so the roster that first shows the second same-network
// client necessarily postdates it, and must not list it.
func TestLANDiscoveryKeepsDifferentIPv6PrefixesApart(t *testing.T) {
	s := newDiscoveryServer(t, "", "", "")
	a := s.join("2001:db8:1234:5678::a", "", "home-a")
	other := s.join("2001:db8:1234:5679::a", "", "neighbour")
	c := s.join("2001:db8:1234:5678::c", "", "home-c")

	if got, want := a.awaitRosterWith(c.id), sortedIDs(a.id, c.id); !sameIDs(got, want) {
		t.Fatalf("home roster = %v, want %v (neighbour %s must not appear)", got, want, other.id)
	}
	if got, want := other.awaitRosterWith(other.id), []string{other.id}; !sameIDs(got, want) {
		t.Fatalf("neighbour roster = %v, want only itself", got)
	}
	if s.hub.PeerCount("2001:db8:1234:5678::/64") != 2 || s.hub.PeerCount("2001:db8:1234:5679::/64") != 1 {
		t.Fatal("prefix rooms were merged")
	}
}

// IPv4 keeps its exact-address room: one NATed address is one room, and an
// adjacent address in the same /24 is not merged into it.
func TestLANDiscoveryKeepsIPv4ExactAddressRooms(t *testing.T) {
	s := newDiscoveryServer(t, "", "", "")
	a := s.join("203.0.113.7", "", "office-a")
	other := s.join("203.0.113.8", "", "next-door")
	c := s.join("203.0.113.7", "", "office-c")

	if a.ip != "203.0.113.7" || other.ip != "203.0.113.8" {
		t.Fatalf("welcome.ip = %q / %q", a.ip, other.ip)
	}
	if got, want := a.awaitRosterWith(c.id), sortedIDs(a.id, c.id); !sameIDs(got, want) {
		t.Fatalf("office roster = %v, want %v (next-door %s must not appear)", got, want, other.id)
	}
	if s.hub.PeerCount("203.0.113.7") != 2 || s.hub.PeerCount("203.0.113.8") != 1 {
		t.Fatal("IPv4 rooms are not keyed on the exact address")
	}
}

// A pairing code names its own room. Two parties on unrelated networks meet
// there, and a LAN client sharing one party's /64 is not pulled into it.
func TestPairingCodeRoomIsNotGroupedByAddress(t *testing.T) {
	const code = "424242"
	const codeRoom = "c:" + code + ":opaque-generation"
	s := newDiscoveryServer(t, code, codeRoom, "")
	lan := s.join("2001:db8:1234:5678::1", "", "lan-only")
	sender := s.join("2001:db8:1234:5678::2", code, "sender")
	receiver := s.join("2001:db8:aaaa:bbbb::3", code, "receiver")

	if sender.ip != "2001:db8:1234:5678::2" || receiver.ip != "2001:db8:aaaa:bbbb::3" {
		t.Fatalf("welcome.ip = %q / %q", sender.ip, receiver.ip)
	}
	if got, want := sender.awaitRosterWith(receiver.id), sortedIDs(sender.id, receiver.id); !sameIDs(got, want) {
		t.Fatalf("code roster = %v, want %v (LAN peer %s must not appear)", got, want, lan.id)
	}
	if s.hub.PeerCount(codeRoom) != 2 || s.hub.PeerCount("2001:db8:1234:5678::/64") != 1 {
		t.Fatalf("code room=%d /64 room=%d, want 2 and 1",
			s.hub.PeerCount(codeRoom), s.hub.PeerCount("2001:db8:1234:5678::/64"))
	}
}

// Grouping by /64 widens nothing about whose address is believed. A client
// that left-pads X-Forwarded-For with a victim's address behind a trusted proxy
// is still keyed on the right-most untrusted hop, the one the proxy saw.
func TestLANDiscoveryIgnoresSpoofedLeftmostForwardedFor(t *testing.T) {
	s := newDiscoveryServer(t, "", "", "")
	victim := s.join("2001:db8:1234:5678::a", "", "victim")
	attacker := s.join("2001:db8:1234:5678::66, 2001:db8:dead:beef::1", "", "attacker")
	mate := s.join("2001:db8:1234:5678::b", "", "victim-mate")

	if attacker.ip != "2001:db8:dead:beef::1" {
		t.Fatalf("attacker welcome.ip = %q, want the proxy-observed hop", attacker.ip)
	}
	if got, want := victim.awaitRosterWith(mate.id), sortedIDs(victim.id, mate.id); !sameIDs(got, want) {
		t.Fatalf("victim roster = %v, want %v (attacker %s must not appear)", got, want, attacker.id)
	}
}

// An untrusted direct peer's X-Forwarded-For is never read, so forging a
// victim's /64 there neither places it in that room nor changes its welcome.
func TestLANDiscoveryIgnoresForwardedForFromUntrustedPeer(t *testing.T) {
	s := newDiscoveryServer(t, "", "", "198.51.100.9:40000")
	c := s.join("2001:db8:1234:5678::66", "", "forger")
	if c.ip != "198.51.100.9" {
		t.Fatalf("welcome.ip = %q, want the direct peer address", c.ip)
	}
	if s.hub.PeerCount("198.51.100.9") != 1 || s.hub.PeerCount("2001:db8:1234:5678::/64") != 0 {
		t.Fatal("an untrusted peer's forwarded address chose its room")
	}
}
