package signal

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP returns the client's public IP as observed by the server: the first
// X-Forwarded-For entry when a reverse proxy sets it, else the connection's
// remote host (port stripped).
//
// DEPLOYMENT CONTRACT: the reverse proxy MUST be configured to OVERWRITE
// (set, not append) X-Forwarded-For with the real client IP. If it instead
// appends (e.g. nginx proxy_add_x_forwarded_for), an attacker can inject an
// arbitrary leading entry and bypass the per-IP rate limits on /api/pair and
// /ws?code=.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// RoomKey groups clients sharing a public IP into one room (pseudo-LAN discovery).
func RoomKey(r *http.Request) string {
	return ClientIP(r)
}
