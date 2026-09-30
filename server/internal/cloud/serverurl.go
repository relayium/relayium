package cloud

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// checkSecureServer refuses a cloud server URL whose traffic would carry an
// account credential in cleartext. Login receives the access token from the
// server and Upload sends it back as a bearer token, so both require https.
// Plain http is accepted only for a loopback host (localhost, 127.0.0.0/8,
// ::1): a local development server or test, where the bytes never leave the
// machine. A self-hosted instance must terminate TLS (see docs/self-hosting.md).
func checkSecureServer(server string) error {
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return fmt.Errorf("cloud: server %q is not a valid URL (expected https://host)", server)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("cloud: refusing to send account credentials to %s over plain http; use an https:// server URL", u.Scheme+"://"+u.Host)
	default:
		return fmt.Errorf("cloud: server %q must be an https:// URL", server)
	}
}

func isLoopbackHost(h string) bool {
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
