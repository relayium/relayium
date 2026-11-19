package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

const adminAccessCapacity = 100000

// AdminAccessPolicy is deployment configuration only. Forwarded headers are
// ignored unless the immediate peer is explicitly trusted. Public user APIs
// deliberately never use this policy.
type AdminAccessPolicy struct {
	allowed map[netip.Addr]bool
	proxies []netip.Prefix
}

func ParseAdminAccessPolicy(allow, trusted string) (AdminAccessPolicy, error) {
	p := AdminAccessPolicy{allowed: map[netip.Addr]bool{}}
	if allow != "" {
		for _, value := range strings.Split(allow, ",") {
			ip, err := parseAdminIP(strings.TrimSpace(value))
			if err != nil {
				return p, fmt.Errorf("invalid admin allowlist: expected comma-separated IP addresses")
			}
			p.allowed[ip] = true
		}
	}
	if trusted != "" {
		for _, value := range strings.Split(trusted, ",") {
			value = strings.TrimSpace(value)
			prefix, err := netip.ParsePrefix(value)
			if err != nil {
				ip, e := parseAdminIP(value)
				if e != nil {
					return p, fmt.Errorf("invalid admin trusted proxy: expected IP addresses or CIDRs")
				}
				prefix = netip.PrefixFrom(ip, ip.BitLen())
			}
			if prefix.Addr().Zone() != "" || prefix.Addr().Is4In6() || prefix.Bits() == 0 {
				return p, fmt.Errorf("admin trusted proxy must be a specific IPv4 or IPv6 range")
			}
			p.proxies = append(p.proxies, prefix.Masked())
		}
	}
	return p, nil
}

func parseAdminIP(value string) (netip.Addr, error) {
	ip, err := netip.ParseAddr(value)
	if err != nil || ip.Zone() != "" {
		return netip.Addr{}, fmt.Errorf("invalid IP address")
	}
	return ip.Unmap(), nil
}
func (p AdminAccessPolicy) enabled() bool { return len(p.allowed) > 0 }
func (p AdminAccessPolicy) trusted(ip netip.Addr) bool {
	for _, prefix := range p.proxies {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}
func (p AdminAccessPolicy) clientIP(r *http.Request) (netip.Addr, error) {
	peer := r.RemoteAddr
	if host, _, err := net.SplitHostPort(peer); err == nil {
		peer = host
	}
	ip, err := parseAdminIP(peer)
	if err != nil {
		return netip.Addr{}, err
	}
	if !p.trusted(ip) {
		return ip, nil
	}
	// Walk from the socket toward the client. A client-supplied leading value
	// cannot override the first untrusted hop appended by a trusted proxy.
	raw := r.Header.Values("X-Forwarded-For")
	if len(raw) == 0 {
		return netip.Addr{}, fmt.Errorf("trusted admin proxy omitted client IP")
	}
	forwarded := strings.Join(raw, ",")
	if len(forwarded) > 2048 {
		return netip.Addr{}, fmt.Errorf("forwarded IP chain too long")
	}
	chain := strings.Split(forwarded, ",")
	if len(chain) > 16 {
		return netip.Addr{}, fmt.Errorf("forwarded IP chain too long")
	}
	for i := len(chain) - 1; i >= 0; i-- {
		if !p.trusted(ip) {
			return ip, nil
		}
		ip, err = parseAdminIP(strings.TrimSpace(chain[i]))
		if err != nil {
			return netip.Addr{}, err
		}
	}
	return ip, nil
}

type adminAccessStore interface {
	AdminAccessAttempt(context.Context, string, bool) (bool, error)
}

func (s *Service) adminAccessGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.adminAccess.enabled() {
			ip, err := s.adminAccess.clientIP(r)
			if err != nil {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			store, ok := s.store.(adminAccessStore)
			if !ok {
				http.Error(w, "admin access unavailable", http.StatusServiceUnavailable)
				return
			}
			accepted, err := store.AdminAccessAttempt(r.Context(), ip.String(), s.adminAccess.allowed[ip])
			if err != nil {
				http.Error(w, "admin access unavailable", http.StatusServiceUnavailable)
				return
			}
			if !accepted {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// AdminAccessAttempt atomically records only denied nonallowlisted access.
// Four attempts is a permanent ban; a later allowlist addition does not clear
// it. No timestamps/expiry or automatic cleanup can silently lift a ban.
func (s *SQLiteStore) AdminAccessAttempt(ctx context.Context, ip string, allowed bool) (bool, error) {
	if allowed {
		var attempts int
		err := s.db.QueryRowContext(ctx, `SELECT attempts FROM admin_ip_access WHERE ip = ?`, ip).Scan(&attempts)
		if errors.Is(err, sql.ErrNoRows) {
			return true, nil
		}
		return err == nil && attempts < 4, err
	}
	var count int
	err := s.db.QueryRowContext(ctx, `INSERT INTO admin_ip_access(ip,attempts)
 SELECT ?,1 WHERE (SELECT count(*) FROM admin_ip_access) < ? OR EXISTS(SELECT 1 FROM admin_ip_access WHERE ip=?)
 ON CONFLICT(ip) DO UPDATE SET attempts = min(admin_ip_access.attempts + 1,4) WHERE admin_ip_access.attempts < 4
 RETURNING attempts`, ip, adminAccessCapacity, ip).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	} // full: deny without evicting permanent bans
	return false, err
}

type AdminIPAccess struct {
	IP       string
	Attempts int
}

func (a *AdminAuthStore) ListIPAccess(ctx context.Context) ([]AdminIPAccess, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT ip,attempts FROM admin_ip_access ORDER BY ip`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminIPAccess{}
	for rows.Next() {
		var row AdminIPAccess
		if err := rows.Scan(&row.IP, &row.Attempts); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
func (a *AdminAuthStore) UnblockIP(ctx context.Context, value string) error {
	ip, err := parseAdminIP(value)
	if err != nil {
		return err
	}
	_, err = a.db.ExecContext(ctx, `DELETE FROM admin_ip_access WHERE ip=?`, ip.String())
	return err
}
