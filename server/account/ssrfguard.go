package account

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"time"
)

// A BYO relay node's StorageURL is fully user-controlled, and the central server
// makes outbound PUT/GET/DELETE calls to it. Without a guard that is a blind
// SSRF: a user could point StorageURL at 127.0.0.1, a private-LAN host, or the
// cloud metadata endpoint (169.254.169.254) and make central reach into its own
// network. These helpers block that. RELAYIUM_ALLOW_PRIVATE_NODE_URLS=true
// disables the guard for self-hosters running the whole stack on a private LAN.

// isBlockedIP reports whether ip is in a range central must never be steered to
// by a node-supplied URL.
//
// IPv6 forms that carry an IPv4 address (IPv4-mapped ::ffff:a.b.c.d,
// IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d and 6to4 2002:AABB:CCDD::)
// are judged by the IPv4 address they embed, so wrapping a private IPv4 target
// in an IPv6 literal cannot slip past the IPv4 rules.
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		return isBlockedIPv4(ip4)
	}
	if len(ip) != net.IPv6len {
		return true
	}
	if embedded := embeddedIPv4(ip); embedded != nil {
		return isBlockedIP(embedded)
	}
	for _, n := range blockedIPv6Nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// blockedIPv4Nets are the IPv4 ranges net.IP's predicates miss.
var blockedIPv4Nets = mustCIDRs(
	"0.0.0.0/8",     // "this network" (RFC 791); 0.x.y.z reaches local hosts on some stacks
	"100.64.0.0/10", // carrier-grade NAT (RFC 6598)
	"198.18.0.0/15", // benchmarking (RFC 2544), routed internally by some providers
	"240.0.0.0/4",   // reserved (RFC 1112), including broadcast 255.255.255.255
)

// blockedIPv6Nets are IPv6 ranges that are blocked outright because they do
// not carry a recoverable IPv4 address.
var blockedIPv6Nets = mustCIDRs(
	"64:ff9b:1::/48", // local-use NAT64 (RFC 8215): the translator is site-internal
)

var (
	ipv4CompatNet = mustCIDRs("::/96")[0]        // IPv4-compatible (deprecated, RFC 4291)
	nat64Net      = mustCIDRs("64:ff9b::/96")[0] // well-known NAT64 prefix (RFC 6052)
	sixToFourNet  = mustCIDRs("2002::/16")[0]    // 6to4 (RFC 3056)
)

func isBlockedIPv4(ip4 net.IP) bool {
	for _, n := range blockedIPv4Nets {
		if n.Contains(ip4) {
			return true
		}
	}
	return false
}

// embeddedIPv4 returns the IPv4 address an IPv6 transition-mechanism address
// carries, or nil when ip is not one of them. IPv4-mapped addresses are
// handled by net.IP.To4 before this is reached.
func embeddedIPv4(ip net.IP) net.IP {
	switch {
	case ipv4CompatNet.Contains(ip), nat64Net.Contains(ip):
		return net.IPv4(ip[12], ip[13], ip[14], ip[15])
	case sixToFourNet.Contains(ip):
		return net.IPv4(ip[2], ip[3], ip[4], ip[5])
	}
	return nil
}

func mustCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}

// guardedDialContext returns a DialContext that resolves the target host and
// refuses to connect if any resolved address is non-public. Dialing the resolved
// IP literal (not the hostname) closes the DNS-rebinding window between check and
// connect. When allowPrivate is set it is a plain dialer.
func guardedDialContext(allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 10 * time.Second}
	if allowPrivate {
		return d.DialContext
	}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		var target net.IP
		for i := range ips {
			if isBlockedIP(ips[i].IP) {
				return nil, fmt.Errorf("refusing to connect to non-public address %s", ips[i].IP)
			}
			if target == nil {
				target = ips[i].IP
			}
		}
		if target == nil {
			return nil, fmt.Errorf("no address for %s", host)
		}
		return d.DialContext(ctx, network, net.JoinHostPort(target.String(), port))
	}
}

// validateNodeStorageURL is the fast registration-time gate: it enforces
// http/https and a non-empty host, and rejects IP-literal hosts in blocked
// ranges outright. Hostnames are re-validated at dial time by the guarded
// transport (defends against DNS rebinding).
func validateNodeStorageURL(raw string, allowPrivate bool) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid storage URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("storage URL must be http or https")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("storage URL must have a host")
	}
	if allowPrivate {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && isBlockedIP(ip) {
		return fmt.Errorf("storage URL host is a non-public address")
	}
	return nil
}
