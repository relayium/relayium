package account

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Nit (CSRFGuard): an admin state change with no Origin header is judged by
// Sec-Fetch-Site when the browser sends it.
func TestCSRFGuardAdminRequiresSameOriginFetchSite(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{BaseURL: "https://relayium.test", SessionTTL: time.Hour})
	h := svc.CSRFGuard(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	cases := []struct {
		method, path, site, origin string
		want                       int
	}{
		{"POST", "/admin/settings", "cross-site", "", http.StatusForbidden},
		{"POST", "/admin/users/grant", "same-site", "", http.StatusForbidden},
		{"POST", "/admin/login", "cross-site", "", http.StatusForbidden},
		{"POST", "/admin/settings", "same-origin", "", http.StatusNoContent},
		{"POST", "/admin/settings", "none", "", http.StatusNoContent},
		{"POST", "/admin/settings", "", "", http.StatusNoContent}, // non-browser client
		{"POST", "/admin/settings", "same-origin", "https://relayium.test", http.StatusNoContent},
		{"POST", "/admin/settings", "", "https://evil.test", http.StatusForbidden}, // unchanged Origin rule
		{"GET", "/admin", "cross-site", "", http.StatusNoContent},                  // safe method
		{"POST", "/administrator", "cross-site", "", http.StatusNoContent},         // not the admin tree
		{"POST", "/api/auth/magic/request", "cross-site", "", http.StatusNoContent},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, nil)
		if c.site != "" {
			req.Header.Set("Sec-Fetch-Site", c.site)
		}
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s %s site=%q origin=%q: got %d, want %d", c.method, c.path, c.site, c.origin, rec.Code, c.want)
		}
	}
}
