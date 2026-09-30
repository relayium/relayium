package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/relayium/relayium/authx"
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

// clearOAuthCookie expires a one-shot login cookie (state or nonce). A callback
// clears it on every outcome, so a state value is spent by its first use and
// cannot be replayed for the rest of its lifetime. The attributes mirror the
// ones it was set with, which is what makes browsers replace rather than add.
func (s *Service) clearOAuthCookie(w http.ResponseWriter, name string, sameSite http.SameSite) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.CookieSecure(), SameSite: sameSite,
	})
}

func (s *Service) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	s.clearOAuthCookie(w, oauthStateCookie, http.SameSiteLaxMode)
	fail := func() { http.Redirect(w, r, "/?login=error", http.StatusFound) }
	stateCookie, err := r.Cookie(oauthStateCookie)
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		fail()
		return
	}
	sub, email, name, verified, err := s.fetchGoogleUser(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		fail()
		return
	}
	// The subject is the account key and the email the only linking and
	// verification evidence; a response missing either is not a usable login.
	email = normEmail(email)
	if strings.TrimSpace(sub) == "" || email == "" || !verified {
		fail()
		return
	}
	// Resolve by the Google subject first. The email Google reports is mutable
	// (a user can rename their Google address, and a released address can be
	// re-registered by someone else), so once a subject is linked it — not the
	// email — decides which account signs in.
	resolved, found, err := s.store.GetUserByIdentity(r.Context(), "google", sub)
	if err != nil {
		fail()
		return
	}
	if !found {
		// Unseen subject: keep verified-email linking, so a user who recreated
		// their Google account with the same verified address still reaches it.
		resolved, err = s.store.UpsertUserByEmail(r.Context(), email, name)
		if err != nil {
			fail()
			return
		}
	}
	// Credential fence: read the epoch BEFORE the account state this login acts
	// on, and insert the session only at that epoch (as Login does). An account
	// deletion commits its session purge and epoch bump together, so a deletion
	// landing anywhere after this read leaves no session behind — not even one
	// that a later reactivation would make usable again.
	epoch, err := s.store.CredentialEpoch(r.Context(), resolved.ID)
	if err != nil {
		fail()
		return
	}
	u, err := s.store.GetUserByID(r.Context(), resolved.ID)
	if err != nil {
		fail()
		return
	}
	// emailProven: Google has verified that this caller controls u's stored
	// address. Only then may the login verify that address or clear a password
	// planted on it while unverified. A linked subject whose Google email has
	// changed signs in to its own account but proves nothing about that
	// account's stored address, and never touches the account holding the new one.
	emailProven := normEmail(u.Email) == email
	// Frozen-login guard (Task 4): a pending-deletion account must not get a
	// live session via OAuth either — checked right after u is resolved,
	// before any of LinkIdentity/SetEmailVerified/IssueSession run.
	if u.DeletedAt > 0 {
		var raw string
		if found {
			// Subject-resolved: the reactivate token is earned by the linked
			// Google credential itself (like a password login of a pending
			// account), whatever address Google reports now — so it is minted
			// only while that link still stands, in the same statement.
			var ok bool
			raw, ok, err = s.issueReactivateTokenForIdentity(r.Context(), u.ID, u.Email, "google", sub)
			if err == nil && !ok {
				err = errIdentityMoved
			}
		} else {
			// Unseen subject: the verified email is the credential (unchanged).
			raw, err = s.issueReactivateToken(r.Context(), u.ID, u.Email)
		}
		if err != nil {
			fail()
			return
		}
		// Token goes in the URL fragment, not the query: fragments are never sent
		// to the server (access logs) or in a Referer header, so this multi-week
		// reactivate credential doesn't leak off-box. The SPA reads it from
		// location.hash and scrubs it from the URL.
		http.Redirect(w, r, "/#account=pending_deletion&token="+url.QueryEscape(raw), http.StatusFound)
		return
	}
	if !found {
		if err := s.store.LinkIdentity(r.Context(), "google", sub, u.ID); err != nil {
			fail()
			return
		}
	}
	// Confirm the subject maps to this account before anything is verified.
	// LinkIdentity is INSERT OR IGNORE, so its success does not prove the row is
	// ours: a concurrent first login of the same subject may have linked it to
	// another account, and a linked subject may have been unlinked since it was
	// read. Either way this login is refused. The session insert below repeats
	// the check atomically, so a change after this point is caught there too.
	owner, linked, err := s.store.GetUserByIdentity(r.Context(), "google", sub)
	if err != nil || !linked || owner.ID != u.ID {
		fail()
		return
	}
	if emailProven {
		// Pre-hijack defense: drop any password planted on this email while it
		// was unverified, before we verify it via Google (see dropUnverifiedPassword).
		if err := s.dropUnverifiedPassword(r.Context(), u.ID); err != nil {
			fail()
			return
		}
		// Google only reaches this path with verified == true (checked above).
		if err := s.store.SetEmailVerified(r.Context(), u.ID); err != nil {
			fail()
			return
		}
	}
	now := s.now()
	sess := Session{
		ID:        authx.RandToken(),
		UserID:    u.ID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.SessionTTL).Unix(),
	}
	// One statement: epoch unchanged, account not pending deletion, subject
	// still linked to u. Any of those failing means a deletion, reset or unlink
	// committed after the checks above, and no session may exist for it.
	ok, err := s.store.CreateSessionForIdentityAtEpoch(r.Context(), sess, epoch, "google", sub)
	if err != nil || !ok {
		fail()
		return
	}
	s.setSessionCookie(w, sess)
	http.Redirect(w, r, "/", http.StatusFound)
}

// errIdentityMoved reports that a provider identity no longer maps to the
// account a login resolved, so no credential may be issued for it.
var errIdentityMoved = errors.New("identity no longer linked to the resolved account")

// issueReactivateTokenForIdentity is issueReactivateToken for a login proven
// by a linked provider identity: the token is inserted only while
// identities(provider, subject) still maps to userID (ok=false otherwise).
func (s *Service) issueReactivateTokenForIdentity(ctx context.Context, userID, email, provider, subject string) (string, bool, error) {
	raw := authx.RandToken()
	now := s.now()
	st := s.ResolveSettings(ctx)
	ok, err := s.store.CreateEmailTokenForIdentity(ctx, EmailToken{
		TokenHash: authx.HashToken(raw),
		UserID:    userID,
		Email:     email,
		Purpose:   "reactivate",
		CreatedAt: now.Unix(),
		ExpiresAt: now.Unix() + st.AccountGraceDays*86400,
	}, provider, subject)
	if err != nil || !ok {
		return "", false, err
	}
	return raw, true, nil
}
