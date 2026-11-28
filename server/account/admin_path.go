package account

import (
	"fmt"
	"regexp"
)

const DefaultAdminPath = "/admin"

var adminPathPattern = regexp.MustCompile(`^/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// ResolveAdminPath accepts one unambiguous path segment, never a URL or a
// subtree overlapping public routes. Empty preserves the historical default.
func ResolveAdminPath(value string) (string, error) {
	if value == "" {
		return DefaultAdminPath, nil
	}
	if !adminPathPattern.MatchString(value) {
		return "", fmt.Errorf("invalid admin path: use / followed by 1–64 ASCII letters, digits, underscores or hyphens")
	}
	switch value {
	case "/device", "/apps", "/ar", "/de", "/es", "/fr", "/ja", "/ko", "/pt", "/releases", "/shots", "/support", "/gh", "/me", "/cli", "/pricing", "/security", "/privacy", "/terms", "/guides", "/how-to", "/compare", "/zh", "/en", "/api", "/health", "/healthz", "/ready", "/readyz", "/metrics", "/debug", "/ws", "/s", "/d", "/f", "/u", "/assets", "/static", "/downloads", "/.well-known":
		return "", fmt.Errorf("admin path conflicts with a reserved route")
	}
	return value, nil
}

func (s *Service) AdminPath() string { return adminPathDefault(s.cfg.AdminPath) }
func adminPathDefault(value string) string {
	if value == "" {
		return DefaultAdminPath
	}
	return value
}
func optionalAdminPath(values []string) string {
	if len(values) > 0 {
		return adminPathDefault(values[0])
	}
	return DefaultAdminPath
}

// Embedded by every admin template's root, including nested rollout panels.
// The zero value keeps direct template rendering and older callers compatible.
type adminRouteData struct{ BasePath string }

func (d adminRouteData) AdminPath() string        { return adminPathDefault(d.BasePath) }
func (s *Service) adminRouteData() adminRouteData { return adminRouteData{BasePath: s.AdminPath()} }
