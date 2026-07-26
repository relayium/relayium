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
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	// Carrier-grade NAT 100.64.0.0/10 (RFC 6598); net.IP.IsPrivate misses it.
	if ip4 := ip.To4(); ip4 != nil && ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
		return true
	}
	return false
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
