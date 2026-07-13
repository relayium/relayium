package account

import (
	"net/http"
	"strings"
)

// RequireAuth wraps a handler, resolving the caller as an authenticated User
// from EITHER the session cookie (browser) OR an "Authorization: Bearer
// rlm_cli_…" header (CLI token, Task 5's cli_tokens table), 401ing otherwise.
// This is a superset of RequireSession: cookie-based tests/behavior are
// unaffected, and CLI callers can now reach the same endpoints with a bearer
// token instead of a cookie. A valid bearer touches the token's last_seen_at.
func (s *Service) RequireAuth(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if u, ok := s.UserFromRequest(r); ok { // session cookie
			next(w, r, u)
			return
		}
		const bearerPrefix = "Bearer "
		h := r.Header.Get("Authorization")
		if strings.HasPrefix(h, bearerPrefix) {
			raw := strings.TrimSpace(h[len(bearerPrefix):])
			hash := hashToken(raw)
			uid, _, ok, err := s.store.GetCLITokenUser(r.Context(), hash)
			if err == nil && ok {
				u, gerr := s.store.GetUserByID(r.Context(), uid)
				// Mirror the cookie path's central frozen-account guard
				// (ValidateSession rejects DeletedAt>0): a pending-delete/frozen
				// account must not keep CLI/API access via a bearer token either.
				if gerr == nil && u.DeletedAt == 0 {
					_ = s.store.TouchCLIToken(r.Context(), hash, s.now().Unix())
					next(w, r, u)
					return
				}
			}
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}
