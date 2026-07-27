package account

import (
	"net/http"
	"strings"

	"github.com/relayium/relayium/authx"
)

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
	_ = s.store.TouchCLIToken(r.Context(), hash, s.now().Unix())
	return u, true
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
