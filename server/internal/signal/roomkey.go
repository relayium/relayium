package signal

import (
	"net"
	"net/http"
	"strings"
)

// IPExtractor resolves the client's public IP as observed by the server. It
// consults the X-Forwarded-For header ONLY when the immediate connection peer
// (r.RemoteAddr) is trusted — i.e. it is a loopback address (always trusted; see
// below) or falls inside one of the configured trusted-proxy CIDRs; otherwise it
// always uses the direct connection's remote host (port stripped).
//
// This IP is the source of the rate-limit key (/api/pair, /ws?code=) and of
// the LAN room key (see RateLimitKey and RoomKey). Trusting a forgeable header
// from an untrusted peer would let an attacker bypass the pairing-code rate
// limits or hijack another user's LAN room, so a genuinely remote/public peer's
// XFF is never trusted by default.
//
// LOOPBACK IS ALWAYS TRUSTED. The standard deployment is a same-host reverse
// proxy (nginx/Caddy → 127.0.0.1:8080), so the server's direct peer is loopback
// on every request. Only a same-host process can connect from a loopback address
// — the kernel drops loopback-sourced packets arriving from off-host — so its
// X-Forwarded-For is authoritative and safe to trust with NO configuration.
// Without this, the documented same-host deployment silently used the loopback
// RemoteAddr (127.0.0.1) as the room key, collapsing every visitor into one
// shared "LAN" room. A loopback entry appearing inside XFF is likewise treated
// as a proxy hop and skipped, so the resolved client is never a loopback address.
//
// DEPLOYMENT CONTRACT: a same-host (loopback) proxy needs no configuration. For
// a proxy that reaches the server from a NON-loopback address (a container
// bridge IP, a separate LB host), set -trusted-proxies to its CIDR(s). Only
// requests arriving directly from a trusted peer have their X-Forwarded-For
// consulted, and the right-most XFF entry that is NOT itself a trusted proxy is
// taken as the real client — so a client that pre-injects a spoofed left-most
// entry cannot escape its true source.
type IPExtractor struct {
	trusted []*net.IPNet
}

// NewIPExtractor builds an extractor that trusts the given proxy CIDRs. A nil
// or empty list yields the default-safe behavior (X-Forwarded-For ignored).
func NewIPExtractor(trusted []*net.IPNet) *IPExtractor {
	return &IPExtractor{trusted: trusted}
}

// remoteHost returns r.RemoteAddr with any port stripped.
func remoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// trusts reports whether ip (a textual address) is a trusted proxy hop: any
// loopback address is always trusted (only a same-host process can originate
// from it), plus any address inside a configured trusted CIDR.
func (x *IPExtractor) trusts(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	if parsed.IsLoopback() {
		return true
	}
	if x != nil {
		for _, n := range x.trusted {
			if n.Contains(parsed) {
				return true
			}
		}
	}
	return false
}

// IP resolves the client IP for r.
func (x *IPExtractor) IP(r *http.Request) string {
	direct := remoteHost(r)
	// Only consult X-Forwarded-For when the direct peer is trusted (loopback or a
	// configured proxy CIDR). A genuinely remote peer's XFF is forgeable.
	if !x.trusts(direct) {
		return direct
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return direct
	}
	// Walk right-to-left: the first entry that is not itself a trusted proxy hop
	// is the closest untrusted hop, i.e. the real client. Everything to its left
	// is attacker-controlled and must be discarded.
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		ip := strings.TrimSpace(parts[i])
		if ip == "" {
			continue
		}
		if !x.trusts(ip) {
			return ip
		}
	}
	// All XFF entries were themselves trusted proxies; fall back to the peer.
	return direct
}

// RateLimitKey returns the stable per-client key used by public abuse
// throttles. IPv4 remains per-address. IPv6 is grouped by /64 so rotating an
// interface identifier does not mint a fresh budget. Parse failures collapse
// to one fail-safe key instead of letting attacker-controlled spellings create
// unbounded independent budgets.
func RateLimitKey(ip string) string {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil {
		return "invalid-ip"
	}
	if v4 := parsed.To4(); v4 != nil {
		return v4.String()
	}
	return parsed.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// RateLimitKey resolves the trusted client address before normalizing it. It
// stays separate from RoomKey even though both group IPv6 by /64: they differ
// on a value that is not an address (RoomKey returns it unchanged, RateLimitKey
// collapses it to "invalid-ip"), and an abuse budget and a discovery room are
// separate decisions that should be able to change independently.
func (x *IPExtractor) RateLimitKey(r *http.Request) string {
	return RateLimitKey(x.IP(r))
}

// RoomKey is the code-less LAN discovery room for r: clients with the same key
// see each other in the roster. It is a heuristic for "probably the same
// network", never an authorization: membership grants no trust and changes
// nothing about the end-to-end handshake or how a receiver admits a transfer.
//
// IPv4 keys on the exact observed address, the shared public address of a
// typical NATed network. IPv6 keys on the observed address's /64. Devices on an
// IPv6 network usually reach the server from distinct global addresses (IPv6
// NAT is uncommon but exists), and those addresses usually share the network's
// /64, the prefix SLAAC assigns from. Keying on the exact address put devices
// with distinct observed addresses in separate rooms, so they could not discover
// each other.
//
// What the /64 does not prove: that two clients are physically near each other
// or can reach each other directly. And what it misses: a device that reaches
// the server over IPv4 while another uses IPv6, devices on different prefixes
// (multiple prefixes; a VPN or privacy relay may cause this), and a device
// whose address changes, since an open WebSocket stays in the room it joined.
// Pairing codes cover those cases. A value that is not an address is returned
// unchanged.
func (x *IPExtractor) RoomKey(r *http.Request) string {
	ip := x.IP(r)
	if parsed := net.ParseIP(ip); parsed != nil && parsed.To4() == nil {
		return parsed.Mask(net.CIDRMask(64, 128)).String() + "/64"
	}
	return ip
}
