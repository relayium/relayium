package account

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/relayium/relayium/internal/authx"
)

func (s *Service) googleConfig() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     s.cfg.GoogleClientID,
		ClientSecret: s.cfg.GoogleSecret,
		RedirectURL:  s.cfg.GoogleRedirect,
		Endpoint:     google.Endpoint,
		Scopes:       []string{"openid", "email", "profile"},
	}
}

// realFetchGoogleUser exchanges the code and reads the userinfo endpoint.
func (s *Service) realFetchGoogleUser(ctx context.Context, code string) (sub, email, name string, verified bool, err error) {
	tok, err := s.googleConfig().Exchange(ctx, code)
	if err != nil {
		return "", "", "", false, err
	}
	client := s.googleConfig().Client(ctx, tok)
	resp, err := client.Get("https://openidconnect.googleapis.com/v1/userinfo")
	if err != nil {
		return "", "", "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", "", false, fmt.Errorf("userinfo status %d", resp.StatusCode)
	}
	var info struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		Name          string `json:"name"`
		EmailVerified bool   `json:"email_verified"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", "", "", false, err
	}
	return info.Sub, info.Email, info.Name, info.EmailVerified, nil
}

const oauthStateCookie = "relayium_oauth_state"

func (s *Service) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	state := authx.RandToken()
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: state, Path: "/", MaxAge: 600,
		HttpOnly: true, Secure: s.CookieSecure(), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, s.googleConfig().AuthCodeURL(state), http.StatusFound)
}

func (s *Service) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie(oauthStateCookie)
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	sub, email, name, verified, err := s.fetchGoogleUser(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	if !verified {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	u, err := s.store.UpsertUserByEmail(r.Context(), email, name)
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	// Frozen-login guard (Task 4): a pending-deletion account must not get a
	// live session via OAuth either — checked right after u is resolved,
	// before any of LinkIdentity/SetEmailVerified/IssueSession run.
	if u.DeletedAt > 0 {
		raw, terr := s.issueReactivateToken(r.Context(), u.ID, u.Email)
		if terr != nil {
			http.Redirect(w, r, "/?login=error", http.StatusFound)
			return
		}
		// Token goes in the URL fragment, not the query: fragments are never sent
		// to the server (access logs) or in a Referer header, so this multi-week
		// reactivate credential doesn't leak off-box. The SPA reads it from
		// location.hash and scrubs it from the URL.
		http.Redirect(w, r, "/#account=pending_deletion&token="+url.QueryEscape(raw), http.StatusFound)
		return
	}
	err = s.store.LinkIdentity(r.Context(), "google", sub, u.ID)
	if err == nil {
		// Pre-hijack defense: drop any password planted on this email while it
		// was unverified, before we verify it via Google (see dropUnverifiedPassword).
		err = s.dropUnverifiedPassword(r.Context(), u.ID)
	}
	if err == nil {
		// Google only reaches this path with verified == true (checked above).
		err = s.store.SetEmailVerified(r.Context(), u.ID)
	}
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	sess, err := s.IssueSession(r.Context(), u.ID)
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	s.setSessionCookie(w, sess)
	http.Redirect(w, r, "/", http.StatusFound)
}
