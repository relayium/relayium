package account

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

const sessionCookie = "relayium_session"

// cookieSecure reports whether auth cookies should carry the Secure attribute.
// Derived from the base URL scheme: production (https) gets Secure cookies,
// while plain http://localhost development keeps real-browser login working.
func (s *Service) cookieSecure() bool {
	return strings.HasPrefix(s.cfg.BaseURL, "https://")
}

func (s *Service) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/magic/request", s.handleMagicRequest)
	mux.HandleFunc("GET /api/auth/magic/verify", s.handleMagicVerify)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.RequireSession(s.handleMe))
	mux.HandleFunc("GET /api/auth/google/start", s.handleGoogleStart)
	mux.HandleFunc("GET /api/auth/google/callback", s.handleGoogleCallback)
	mux.HandleFunc("GET /api/devices", s.RequireSession(s.handleListDevices))
	mux.HandleFunc("POST /api/devices", s.RequireSession(s.handleUpsertDevice))
	mux.HandleFunc("PATCH /api/devices/{id}", s.RequireSession(s.handleRenameDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", s.RequireSession(s.handleDeleteDevice))
	mux.HandleFunc("POST /api/transfers", s.RequireSession(s.handleCreateTransfer))
	mux.HandleFunc("GET /api/ice", s.handleICE)
	mux.HandleFunc("GET /api/usage", s.RequireSession(s.handleUsage))
	return mux
}

func (s *Service) handleListDevices(w http.ResponseWriter, r *http.Request, u User) {
	ds, err := s.store.ListDevices(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": ds})
}

func (s *Service) handleUpsertDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if in.ID == "" {
		in.ID = newID()
	}
	d, err := s.store.UpsertDevice(r.Context(), Device{
		ID: in.ID, UserID: u.ID, Name: in.Name, CreatedAt: s.now().Unix(),
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": d})
}

func (s *Service) handleRenameDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.store.RenameDevice(r.Context(), r.PathValue("id"), u.ID, in.Name); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleDeleteDevice(w http.ResponseWriter, r *http.Request, u User) {
	if err := s.store.DeleteDevice(r.Context(), r.PathValue("id"), u.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) setSessionCookie(w http.ResponseWriter, sess Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.ID,
		Path:     "/",
		Expires:  time.Unix(sess.ExpiresAt, 0),
		HttpOnly: true,
		Secure:   s.cookieSecure(),
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
		Secure:   s.cookieSecure(),
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

func (s *Service) handleCreateTransfer(w http.ResponseWriter, r *http.Request, u User) {
	t, err := s.CreateTransfer(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     t.Token,
		"expiresAt": t.ExpiresAt,
	})
}

func (s *Service) handleUsage(w http.ResponseWriter, r *http.Request, u User) {
	total, err := s.store.UserUsageTotal(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"relayedBytes": total})
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request, u User) {
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{"id": u.ID, "email": u.Email, "displayName": u.DisplayName},
	})
}
