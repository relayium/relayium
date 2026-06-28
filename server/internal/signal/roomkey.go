package signal

import (
	"net"
	"net/http"
	"strings"
)

// RoomKey groups clients sharing a public IP into one room (pseudo-LAN discovery).
func RoomKey(r *http.Request) string {
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
