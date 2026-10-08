package signal

import (
	"net"
	"net/http"
	"testing"
)

// mustCIDR parses a CIDR for tests, failing hard on error.
func mustCIDR(t *testing.T, s string) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		t.Fatalf("parse cidr %q: %v", s, err)
	}
	return n
}

func TestIPFromRemoteAddr(t *testing.T) {
	x := NewIPExtractor(nil)
	r := &http.Request{RemoteAddr: "203.0.113.7:54321", Header: http.Header{}}
	if got := x.IP(r); got != "203.0.113.7" {
		t.Fatalf("got %q", got)
	}
}

// Without any trusted proxies, X-Forwarded-For is a forgeable header and MUST be
// ignored — the direct peer address is authoritative.
func TestIPIgnoresForwardedForByDefault(t *testing.T) {
	x := NewIPExtractor(nil)
	r := &http.Request{RemoteAddr: "203.0.113.7:54321", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "198.51.100.9")
	if got := x.IP(r); got != "203.0.113.7" {
		t.Fatalf("XFF must be ignored without a trusted proxy, got %q", got)
	}
	if got := x.RoomKey(r); got != "203.0.113.7" {
		t.Fatalf("RoomKey must ignore XFF too, got %q", got)
	}
}

// When the request arrives from an UNtrusted peer, XFF is ignored even if the
// server also lists (other) trusted proxies — the peer itself isn't trusted.
func TestIPIgnoresForwardedForFromUntrustedPeer(t *testing.T) {
	x := NewIPExtractor([]*net.IPNet{mustCIDR(t, "10.0.0.0/8")})
	r := &http.Request{RemoteAddr: "203.0.113.7:1", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "198.51.100.9")
	if got := x.IP(r); got != "203.0.113.7" {
		t.Fatalf("untrusted peer XFF must be ignored, got %q", got)
	}
}

// When the direct peer IS a trusted proxy, the real client is the right-most XFF
// entry that is not itself a trusted proxy.
func TestIPTrustsForwardedForFromTrustedProxy(t *testing.T) {
	x := NewIPExtractor([]*net.IPNet{mustCIDR(t, "10.0.0.0/8")})
	r := &http.Request{RemoteAddr: "10.0.0.1:1", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.2")
	if got := x.IP(r); got != "198.51.100.9" {
		t.Fatalf("got %q, want 198.51.100.9", got)
	}
	if got := x.RoomKey(r); got != "198.51.100.9" {
		t.Fatalf("RoomKey got %q", got)
	}
}

// A spoofed left-most entry from the client is discarded: we take the right-most
// non-proxy hop, not the first.
func TestIPRejectsSpoofedLeadingForwardedFor(t *testing.T) {
	x := NewIPExtractor([]*net.IPNet{mustCIDR(t, "10.0.0.0/8")})
	r := &http.Request{RemoteAddr: "10.0.0.1:1", Header: http.Header{}}
	// Attacker injects "1.2.3.4" hoping it becomes the rate-limit key; the real
	// client 198.51.100.9 was appended by the proxy to its right.
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 198.51.100.9")
	if got := x.IP(r); got != "198.51.100.9" {
		t.Fatalf("must take right-most non-proxy hop, got %q", got)
	}
}

// When every XFF entry is itself a trusted proxy, fall back to the direct peer.
func TestIPFallsBackWhenAllHopsTrusted(t *testing.T) {
	x := NewIPExtractor([]*net.IPNet{mustCIDR(t, "10.0.0.0/8")})
	r := &http.Request{RemoteAddr: "10.0.0.1:1", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "10.0.0.2, 10.0.0.3")
	if got := x.IP(r); got != "10.0.0.1" {
		t.Fatalf("got %q, want direct peer 10.0.0.1", got)
	}
}

// A same-host reverse proxy connects from loopback (nginx → 127.0.0.1:8080).
// Loopback is ALWAYS trusted — only a same-host process can connect from it, so
// its X-Forwarded-For is authoritative — WITHOUT needing -trusted-proxies. This
// is the standard documented deployment; forgetting to list loopback used to
// collapse every visitor into one "127.0.0.1" LAN room.
func TestIPTrustsLoopbackProxyByDefault(t *testing.T) {
	x := NewIPExtractor(nil) // no configured proxies at all
	for _, peer := range []string{"127.0.0.1:12345", "[::1]:12345", "127.0.0.5:9"} {
		r := &http.Request{RemoteAddr: peer, Header: http.Header{}}
		r.Header.Set("X-Forwarded-For", "203.0.113.7")
		if got := x.IP(r); got != "203.0.113.7" {
			t.Fatalf("loopback peer %s: IP = %q, want 203.0.113.7 (XFF must be trusted)", peer, got)
		}
		if got := x.RoomKey(r); got != "203.0.113.7" {
			t.Fatalf("loopback peer %s: RoomKey = %q, want 203.0.113.7", peer, got)
		}
	}
}

// A loopback entry appended inside X-Forwarded-For is itself treated as a proxy
// hop and skipped, so the resolved client is never a loopback address.
func TestIPSkipsLoopbackInsideForwardedFor(t *testing.T) {
	x := NewIPExtractor(nil)
	r := &http.Request{RemoteAddr: "127.0.0.1:1", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 127.0.0.1")
	if got := x.IP(r); got != "203.0.113.7" {
		t.Fatalf("got %q, want 203.0.113.7 (loopback XFF hop must be skipped)", got)
	}
}

// A genuinely remote/public peer still cannot get its X-Forwarded-For trusted
// by default — the loopback auto-trust must NOT weaken this security property.
func TestIPStillIgnoresForwardedForFromPublicPeer(t *testing.T) {
	x := NewIPExtractor(nil)
	r := &http.Request{RemoteAddr: "198.51.100.23:443", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "10.9.9.9")
	if got := x.IP(r); got != "198.51.100.23" {
		t.Fatalf("public peer XFF must stay ignored, got %q", got)
	}
}

func TestRateLimitKeyNormalizesAddressFamilies(t *testing.T) {
	tests := map[string]string{
		"203.0.113.7":              "203.0.113.7",
		"::ffff:203.0.113.7":       "203.0.113.7",
		"2001:db8:1234:5678::1":    "2001:db8:1234:5678::/64",
		"2001:db8:1234:5678::abcd": "2001:db8:1234:5678::/64",
		"2001:db8:1234:5679::1":    "2001:db8:1234:5679::/64",
		"":                         "invalid-ip",
		"not-an-address":           "invalid-ip",
	}
	for input, want := range tests {
		if got := RateLimitKey(input); got != want {
			t.Errorf("RateLimitKey(%q) = %q, want %q", input, got, want)
		}
	}
}

// RateLimitKey and RoomKey now agree on what an IPv6 address is: both group by
// the network's /64. They still differ in their fallback for a value that is not
// an address at all (RoomKey returns it unchanged; RateLimitKey collapses it to
// "invalid-ip"), which is the separation the previous form of this test
// protected. The room half is covered by TestRoomKeyGroupsIPv6ByPrefix.
func TestRateLimitKeyAndRoomKeyAgreeOnIPv6Prefix(t *testing.T) {
	x := NewIPExtractor(nil)
	r := &http.Request{RemoteAddr: "[::1]:443", Header: http.Header{}}
	r.Header.Set("X-Forwarded-For", "2001:db8:1234:5678::beef")
	if got := x.RateLimitKey(r); got != "2001:db8:1234:5678::/64" {
		t.Fatalf("RateLimitKey = %q", got)
	}
	if got := x.RoomKey(r); got != "2001:db8:1234:5678::/64" {
		t.Fatalf("RoomKey = %q", got)
	}
}

// A network shares one /64, so every device on it must land in one LAN room.
// Keying on the exact address gave each device a room of its own, which silently
// disabled LAN discovery on every IPv6 network: both clients reached a ready
// state and simply never saw each other.
func TestRoomKeyGroupsIPv6ByPrefix(t *testing.T) {
	x := NewIPExtractor(nil)
	room := func(ip string) string {
		r := &http.Request{RemoteAddr: net.JoinHostPort(ip, "443"), Header: http.Header{}}
		return x.RoomKey(r)
	}

	// Addresses in one /64 are one network and must share a room.
	const want = "2001:db8:1234:5678::/64"
	for _, ip := range []string{
		"2001:db8:1234:5678::1",
		"2001:db8:1234:5678::abcd",
		"2001:db8:1234:5678::beef",
	} {
		if got := room(ip); got != want {
			t.Errorf("RoomKey(%q) = %q, want %q", ip, got, want)
		}
	}

	// A different /64 is a different network and must never be merged with it.
	if got := room("2001:db8:1234:5679::1"); got != "2001:db8:1234:5679::/64" {
		t.Errorf("different /64: RoomKey = %q", got)
	}

	// IPv4 is unchanged — one NATed address was already one room.
	if got := room("203.0.113.7"); got != "203.0.113.7" {
		t.Errorf("IPv4: RoomKey = %q, want 203.0.113.7", got)
	}

	// A value that is not an address is returned as-is, not guessed at.
	if got := room("not-an-address"); got != "not-an-address" {
		t.Errorf("non-address: RoomKey = %q, want it unchanged", got)
	}
}

// The /64 boundary is exact, spelling does not matter, and the address-family
// split is decided on the parsed address rather than on what the text looks
// like. An IPv4-mapped IPv6 address is IPv4 to RoomKey and so keeps the exact
// observed spelling; it is never widened to a /64 that would hold every IPv4
// client. A zoned link-local spelling does not parse and is returned unchanged.
func TestRoomKeyIPv6PrefixBoundaries(t *testing.T) {
	x := NewIPExtractor(nil)
	room := func(remote string) string {
		return x.RoomKey(&http.Request{RemoteAddr: remote, Header: http.Header{}})
	}
	for _, tc := range []struct {
		remote, want string
	}{
		{"[2001:db8:1234:5678::]:443", "2001:db8:1234:5678::/64"},
		{"[2001:db8:1234:5678:ffff:ffff:ffff:ffff]:443", "2001:db8:1234:5678::/64"},
		{"[2001:0DB8:1234:5678:0:0:0:BEEF]:443", "2001:db8:1234:5678::/64"},
		{"[2001:db8:1234:5679::]:443", "2001:db8:1234:5679::/64"},
		{"[2001:db8:1234:5677:ffff:ffff:ffff:ffff]:443", "2001:db8:1234:5677::/64"},
		{"[::ffff:203.0.113.7]:443", "::ffff:203.0.113.7"},
		{"203.0.113.7:443", "203.0.113.7"},
		{"203.0.113.8:443", "203.0.113.8"},
		{"[fe80::1%eth0]:443", "fe80::1%eth0"},
	} {
		if got := room(tc.remote); got != tc.want {
			t.Errorf("RoomKey(%s) = %q, want %q", tc.remote, got, tc.want)
		}
	}
}

// The /64 is computed from the address the extractor resolved, so a spoofed
// X-Forwarded-For is no more able to pick a room than it was before grouping:
// an untrusted peer is keyed on its own address, and behind a trusted proxy a
// left-padded entry is skipped in favour of the right-most untrusted hop.
func TestRoomKeyUsesOnlyTheResolvedClientAddress(t *testing.T) {
	x := NewIPExtractor(nil)
	untrusted := &http.Request{RemoteAddr: "[2001:db8:aaaa:bbbb::9]:443", Header: http.Header{}}
	untrusted.Header.Set("X-Forwarded-For", "2001:db8:1234:5678::1")
	if got := x.RoomKey(untrusted); got != "2001:db8:aaaa:bbbb::/64" {
		t.Fatalf("untrusted peer RoomKey = %q", got)
	}
	padded := &http.Request{RemoteAddr: "127.0.0.1:443", Header: http.Header{}}
	padded.Header.Set("X-Forwarded-For", "2001:db8:1234:5678::1, 2001:db8:dead:beef::2")
	if got := x.RoomKey(padded); got != "2001:db8:dead:beef::/64" {
		t.Fatalf("left-padded RoomKey = %q", got)
	}
}
