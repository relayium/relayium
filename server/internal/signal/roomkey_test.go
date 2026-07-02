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
