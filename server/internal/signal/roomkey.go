package signal

import (
	"net"
	"net/http"
	"strings"
)

// IPExtractor resolves the client's public IP as observed by the server. It
// consults the X-Forwarded-For header ONLY when the immediate connection peer
// (r.RemoteAddr) falls inside one of the configured trusted-proxy CIDRs;
// otherwise it always uses the direct connection's remote host (port stripped).
//
// This IP is used as a rate-limit key (/api/pair, /ws?code=) and as the LAN
// room key. Trusting a forgeable header from an untrusted peer would let an
// attacker bypass the pairing-code rate limits or hijack another user's LAN
// room, so the default (no trusted proxies) is fully safe: XFF is ignored and
// only RemoteAddr is used.
//
// DEPLOYMENT CONTRACT: set -trusted-proxies to the CIDR(s) of your reverse
// proxy / load balancer. Only requests arriving directly from those proxies
// have their X-Forwarded-For consulted, and the right-most XFF entry that is
// NOT itself a trusted proxy is taken as the real client — so a client that
// pre-injects a spoofed left-most entry cannot escape its true source.
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

// isTrusted reports whether ip (a textual address) is inside a trusted CIDR.
func (x *IPExtractor) isTrusted(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	for _, n := range x.trusted {
		if n.Contains(parsed) {
			return true
		}
	}
	return false
}

// IP resolves the client IP for r.
func (x *IPExtractor) IP(r *http.Request) string {
	direct := remoteHost(r)
	// Only consult X-Forwarded-For when the direct peer is a trusted proxy.
	if x == nil || len(x.trusted) == 0 || !x.isTrusted(direct) {
		return direct
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return direct
	}
	// Walk right-to-left: the first entry that is not itself a trusted proxy is
	// the closest untrusted hop, i.e. the real client. Everything to its left is
	// attacker-controlled and must be discarded.
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		ip := strings.TrimSpace(parts[i])
		if ip == "" {
			continue
		}
		if !x.isTrusted(ip) {
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
