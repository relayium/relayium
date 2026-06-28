package account

import (
	"encoding/json"
	"net/http"
	"time"
)

const sessionCookie = "relayium_session"

func (s *Service) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/magic/request", s.handleMagicRequest)
	mux.HandleFunc("GET /api/auth/magic/verify", s.handleMagicVerify)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.RequireSession(s.handleMe))
	return mux
}

func (s *Service) setSessionCookie(w http.ResponseWriter, sess Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.ID,
		Path:     "/",
		Expires:  time.Unix(sess.ExpiresAt, 0),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

// RequireSession wraps a handler, injecting the authenticated user or 401ing.
func (s *Service) RequireSession(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		u, ok, err := s.ValidateSession(r.Context(), c.Value)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r, u)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Service) handleMagicRequest(w http.ResponseWriter, r *http.Request) {
	email := r.FormValue("email")
	// Always respond 200, regardless of whether sending succeeds or the email is new,
	// to avoid account enumeration. Log errors server-side only.
	if email != "" {
		_ = s.RequestMagicLink(r.Context(), email)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Service) handleMagicVerify(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	sess, err := s.VerifyMagicLink(r.Context(), token)
	if err != nil {
		http.Redirect(w, r, "/?login=expired", http.StatusFound)
		return
	}
	s.setSessionCookie(w, sess)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_ = s.store.RevokeSession(r.Context(), c.Value)
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request, u User) {
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{"id": u.ID, "email": u.Email, "displayName": u.DisplayName},
	})
}
