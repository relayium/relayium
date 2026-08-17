package account

import (
	"net"
	"net/http"
	"strings"

	"github.com/relayium/relayium/authx"
)

const browserDeviceCookie = "relayium_browser_device"

// UserFromAuth resolves the caller as an authenticated User from EITHER the
// session cookie (browser) OR an "Authorization: Bearer rlm_cli_…" header (CLI
// token, Task 5's cli_tokens table). A valid bearer touches the token's
// last_seen_at.
//
// RequireAuth is the wrapper form. This is the same resolution exposed to
// handlers mounted on the ROOT mux — POST /api/pair — which need the user
// without the wrapper's 401-and-stop behaviour.
func (s *Service) UserFromAuth(r *http.Request) (User, bool) {
	if u, ok := s.UserFromRequest(r); ok { // session cookie
		return u, true
	}
	const bearerPrefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, bearerPrefix) {
		return User{}, false
	}
	raw := strings.TrimSpace(h[len(bearerPrefix):])
	hash := authx.HashToken(raw)
	uid, _, ok, err := s.store.GetCLITokenUser(r.Context(), hash)
	if err != nil || !ok {
		return User{}, false
	}
	u, gerr := s.store.GetUserByID(r.Context(), uid)
	// Mirror the cookie path's central frozen-account guard (ValidateSession
	// rejects DeletedAt>0): a pending-delete/frozen account must not keep
	// CLI/API access via a bearer token either.
	if gerr != nil || u.DeletedAt != 0 {
		return User{}, false
	}
	_ = s.store.TouchCLIToken(r.Context(), hash, s.now().Unix(), canonicalDeviceIP(s.clientIP(r)))
	return u, true
}

// canonicalDeviceIP bounds the account-facing hint to one actual address. It
// rejects forwarded-header text, ports and hostnames; the trusted-proxy-aware
// extractor has already decided which hop is the client.
func canonicalDeviceIP(raw string) string {
	ip := net.ParseIP(strings.TrimSpace(raw))
	if ip == nil {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// bearerDeviceID returns the device row that ACTUALLY AUTHENTICATED this
// request, or "" when a bearer is not what let the caller in.
//
// It has to answer the same question UserFromAuth answered, or the two disagree
// about who is calling. UserFromAuth prefers a valid session cookie and only
// falls through to the Authorization header when there is no usable one, so a
// request carrying both is a cookie request that happens to have a header on
// it. Marking that header's device as "this device" would label a row on a
// browser's own list — with the most destructive button on the screen next to
// it — on the strength of a credential the request was not admitted under.
//
// The two guards are separate and both load-bearing:
//
//   - the cookie check keeps this consistent with whoever authenticated, which
//     is what the response contract promises ("no row is current for a
//     cookie-authenticated request");
//   - the userID comparison is fail-closed for everything else — a valid bearer
//     for another account must never name a row on this account's list.
//
// The useful fallback is deliberately preserved: an INVALID or expired cookie
// alongside a valid bearer is a bearer request (that is exactly how UserFromAuth
// resolved it), and its device is marked.
//
// Deliberately a second lookup rather than state threaded out of UserFromAuth:
// only the device list needs it, and a read of one indexed row on that path is
// cheaper than giving every authenticated request a context value to carry.
func (s *Service) bearerDeviceID(r *http.Request, userID string) string {
	if _, ok := s.UserFromRequest(r); ok {
		return "" // a session cookie authenticated this request, not a bearer
	}
	const bearerPrefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, bearerPrefix) {
		return ""
	}
	raw := strings.TrimSpace(h[len(bearerPrefix):])
	if raw == "" {
		return ""
	}
	uid, deviceID, ok, err := s.store.GetCLITokenUser(r.Context(), authx.HashToken(raw))
	if err != nil || !ok || uid != userID {
		return ""
	}
	return deviceID
}

// authenticatedSourceDeviceID returns the server-minted device row proved by
// the credential used for a v3 send. Native/CLI callers use Authorization;
// browsers use a separate HttpOnly installation credential alongside their
// session. No request-body value participates in this decision.
func (s *Service) authenticatedSourceDeviceID(r *http.Request, userID string) string {
	if _, session := s.UserFromRequest(r); !session {
		return s.bearerDeviceID(r, userID)
	}
	c, err := r.Cookie(browserDeviceCookie)
	if err != nil || c.Value == "" {
		return ""
	}
	uid, deviceID, ok, err := s.store.GetCLITokenUser(r.Context(), authx.HashToken(c.Value))
	if err != nil || !ok || uid != userID {
		return ""
	}
	_ = s.store.TouchCLIToken(r.Context(), authx.HashToken(c.Value), s.now().Unix(), canonicalDeviceIP(s.clientIP(r)))
	return deviceID
}

// RequireAuth wraps a handler, resolving the caller with UserFromAuth and
// 401ing when it cannot. This is a superset of RequireSession: cookie-based
// tests/behavior are unaffected, and CLI callers reach the same endpoints with
// a bearer token instead of a cookie.
func (s *Service) RequireAuth(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.UserFromAuth(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r, u)
	}
}
