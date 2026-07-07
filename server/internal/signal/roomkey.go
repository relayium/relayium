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
// This IP is used as a rate-limit key (/api/pair, /ws?code=) and as the LAN
// room key. Trusting a forgeable header from an untrusted peer would let an
// attacker bypass the pairing-code rate limits or hijack another user's LAN
// room, so a genuinely remote/public peer's XFF is never trusted by default.
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

// RoomKey groups clients sharing a public IP into one room (pseudo-LAN discovery).
func (x *IPExtractor) RoomKey(r *http.Request) string {
	return x.IP(r)
}
