package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

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

// oauthStateTTL is how long a browser OAuth attempt may take, from the start
// redirect to the provider's callback. The state cookie and the server-side
// state row share it.
const oauthStateTTL = 600 // seconds

// oauthStateBudget caps the unexpired server-side OAuth states across all
// clients, so a start-flood from many addresses (each within its per-IP
// throttle) cannot grow the table without bound. A variable so tests can
// shrink it.
var oauthStateBudget = 100_000

// errOAuthStateBudget: the outstanding-state budget is exhausted.
var errOAuthStateBudget = errors.New("account: oauth state budget exhausted")

// SetOAuthStartLimiter caps the browser OAuth start routes (Google, Apple web)
// per IP. nil = unlimited.
func (s *Service) SetOAuthStartLimiter(rl rateLimiter) { s.oauthStartLimiter = rl }

// beginOAuth runs the shared admission for a browser OAuth start: the per-IP
// throttle, then a state minted within the global budget. It writes the
// refusal itself and returns ok=false when the start must not proceed.
func (s *Service) beginOAuth(w http.ResponseWriter, r *http.Request) (string, bool) {
	if s.oauthStartLimiter != nil && !s.oauthStartLimiter.Allow(s.rateLimitIP(r)) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return "", false
	}
	state, err := s.mintOAuthState(r.Context())
	if errors.Is(err, errOAuthStateBudget) {
		log.Printf("oauth: outstanding state budget (%d) exhausted; refusing new sign-in starts until states expire", oauthStateBudget)
		http.Error(w, "sign-in temporarily unavailable", http.StatusServiceUnavailable)
		return "", false
	}
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return "", false
	}
	return state, true
}

// mintOAuthState issues a fresh state for a browser OAuth attempt and records
// its hash server-side until oauthStateTTL, so the callback can spend it
// exactly once (consumeOAuthState). It fails with errOAuthStateBudget when
// oauthStateBudget unexpired states already exist.
func (s *Service) mintOAuthState(ctx context.Context) (string, error) {
	state := authx.RandToken()
	now := s.now().Unix()
	ok, err := s.store.CreateOAuthState(ctx, authx.HashToken(state), now, now+oauthStateTTL, oauthStateBudget)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errOAuthStateBudget
	}
	return state, nil
}

// consumeOAuthState spends a state the callback has already matched against
// its cookie. It deletes the server-side row in one statement, so a copied
// state/cookie pair — replayed, or raced against the original — is honoured at
// most once, and an expired or never-issued state not at all. Callers spend it
// before redeeming the provider's code.
func (s *Service) consumeOAuthState(ctx context.Context, state string) bool {
	ok, err := s.store.ConsumeOAuthState(ctx, authx.HashToken(state), s.now().Unix())
	return err == nil && ok
}

func (s *Service) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	state, ok := s.beginOAuth(w, r)
	if !ok {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: state, Path: "/", MaxAge: oauthStateTTL,
		HttpOnly: true, Secure: s.CookieSecure(), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, s.googleConfig().AuthCodeURL(state), http.StatusFound)
}

// clearOAuthCookie expires a login cookie (state or nonce). A callback clears it
// on every outcome so the browser drops it after its first use. The one-use
// guarantee itself is server-side (consumeOAuthState); this only keeps the
// browser from holding a spent value. The attributes mirror the ones it was set
// with, which is what makes browsers replace rather than add.
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
	if !s.consumeOAuthState(r.Context(), stateCookie.Value) {
		fail()
		return
	}
	sub, email, name, verified, err := s.fetchGoogleUser(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		fail()
		return
	}
	// The proof (code exchange + userinfo) is validated: fence it now, before
	// any account is resolved (loginProof).
	proof := s.newLoginProof(0)
	// The subject is the account key and the email the only linking and
	// verification evidence; a response missing either is not a usable login.
	email = normEmail(email)
	if strings.TrimSpace(sub) == "" || email == "" || !verified {
		fail()
		return
	}
	s.finishWebIdentityLogin(w, r, proof, "google", sub, email, verified, name)
}

// finishWebIdentityLogin turns a verified provider identity (Google, Apple web)
// into a browser session, a pending-deletion recovery redirect, or a login
// error. email must be normalized ("" when the provider sent none); verified
// is the provider's claim that the caller controls it.
//
// proof is the login's proof-time fence (loginProof): every credential written
// here requires the deadline to hold and the account to predate the proof.
func (s *Service) finishWebIdentityLogin(w http.ResponseWriter, r *http.Request, proof loginProof, provider, sub, email string, verified bool, name string) {
	fail := func() { http.Redirect(w, r, "/?login=error", http.StatusFound) }
	// Resolve by the provider subject first. The email a provider reports is
	// mutable (a user can rename their address, and a released address can be
	// re-registered by someone else), so once a subject is linked it — not the
	// email — decides which account signs in.
	resolved, found, err := s.store.GetUserByIdentity(r.Context(), provider, sub)
	if err != nil {
		fail()
		return
	}
	created := false
	if !found {
		// Unseen subject: keep verified-email linking, so a user who recreated
		// their provider account with the same verified address still reaches
		// it. An address the provider has not verified must not attach this
		// subject to whichever account holds it.
		if email == "" || !verified {
			fail()
			return
		}
		resolved, created, err = s.store.UpsertUserByEmailForLogin(r.Context(), email, name)
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
	// emailProven: the provider has verified that this caller controls u's
	// stored address. Only then may the login verify that address or clear a
	// password planted on it while unverified. A linked subject whose provider
	// email has changed signs in to its own account but proves nothing about
	// that account's stored address, and never touches the account holding the
	// new one.
	emailProven := verified && email != "" && normEmail(u.Email) == email
	if !found && !emailProven {
		// Email-based linking needs the account to still hold the address it
		// was selected by; an address change in between voids the match.
		fail()
		return
	}
	// Proof-time fence for every credential below (loginProof): u must predate
	// the proof unless this request's own first sign-in created it. created_at
	// never changes for an id and everything below is keyed on u.ID, so this
	// early check is exact; it also keeps the subject from being linked to a
	// replacement. The writes repeat it atomically.
	fenceAt := proof.fence(u, created)
	if u.CreatedAt > fenceAt || !s.proofLive(proof) {
		fail()
		return
	}
	// Frozen-login guard (Task 4): a pending-deletion account must not get a
	// live session via OAuth either — checked right after u is resolved,
	// before any of LinkIdentity/SetEmailVerified/IssueSession run.
	if u.DeletedAt > 0 {
		// The token is minted in one statement that re-checks, at insert time,
		// that the account is still pending deletion at the epoch read above and
		// that the subject predicate this decision rests on still holds:
		//   - subject-resolved: the linked credential itself earns the token
		//     (like a password login of a pending account), whatever address
		//     the provider reports now — so the link must still stand;
		//   - unseen subject: the verified email is the credential, so the
		//     subject must still be linked to no account (a concurrent login
		//     that linked it elsewhere wins) and the account must still hold
		//     exactly this address.
		if !s.proofLive(proof) {
			fail()
			return
		}
		raw, ok, err := s.issueReactivateTokenForIdentityLogin(r.Context(), u.ID, u.Email, epoch, provider, sub, found, fenceAt)
		if err == nil && !ok {
			err = errIdentityMoved
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
		if err := s.store.LinkIdentity(r.Context(), provider, sub, u.ID); err != nil {
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
	owner, linked, err := s.store.GetUserByIdentity(r.Context(), provider, sub)
	if err != nil || !linked || owner.ID != u.ID {
		fail()
		return
	}
	if emailProven {
		// Pre-hijack defense: drop any password planted on this email while it
		// was unverified, then verify it via the provider — one transaction
		// guarded by the epoch, active state, stored email and subject mapping,
		// so a password reset that commits after the epoch read is never
		// overwritten (see VerifyEmailForIdentityLogin).
		if !s.proofLive(proof) {
			fail()
			return
		}
		ok, err := s.store.VerifyEmailForIdentityLogin(r.Context(), u.ID, email, epoch, provider, sub, fenceAt)
		if err != nil || !ok {
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
	if !s.proofLive(proof) {
		fail()
		return
	}
	ok, err := s.store.CreateSessionForIdentityAtEpoch(r.Context(), sess, epoch, provider, sub, fenceAt)
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

// issueReactivateTokenForIdentityLogin mints a "reactivate" token for a
// provider login through CreateReactivateTokenForIdentityLogin (ok=false: the
// account or subject state moved since it was read, and nothing was minted).
func (s *Service) issueReactivateTokenForIdentityLogin(ctx context.Context, userID, email string, epoch int64, provider, subject string, linked bool, proofAt int64) (string, bool, error) {
	raw := authx.RandToken()
	now := s.now()
	st := s.ResolveSettings(ctx)
	ok, err := s.store.CreateReactivateTokenForIdentityLogin(ctx, EmailToken{
		TokenHash: authx.HashToken(raw),
		UserID:    userID,
		Email:     email,
		Purpose:   "reactivate",
		CreatedAt: now.Unix(),
		ExpiresAt: now.Unix() + st.AccountGraceDays*86400,
	}, epoch, provider, subject, linked, proofAt)
	if err != nil || !ok {
		return "", false, err
	}
	return raw, true, nil
}

// loginProofTTL bounds how long a provider login may take from the moment its
// proof was validated to its last credential write.
const loginProofTTL = 10 * time.Minute

// loginProof is the proof-time fence of a provider login (Google, Apple web,
// Apple native). It is taken the moment the provider's proof was validated —
// the code exchange and identity-token verification — and before the account
// is resolved, so it binds the proof to the accounts that existed then:
//
//   - at (wall clock, the clock users.created_at is written with): every
//     credential write requires the account's created_at <= the fence. An
//     account created after the proof — say the address was deleted, purged
//     and re-registered while this request was paused, so that the unseen-
//     subject fallback now resolves to the replacement — is never bound to it.
//     The one exception is the account this request's own first sign-in
//     created after the proof (fence); the writes are keyed on its id, which a
//     replacement could not share.
//   - deadline (the service clock): every credential write happens no later
//     than loginProofTTL after the proof, nor after the provider token expires.
type loginProof struct {
	at       int64
	deadline int64
}

func (s *Service) wallClock() time.Time {
	if s.wallNow != nil {
		return s.wallNow()
	}
	return time.Now()
}

// newLoginProof records a proof validated now; tokenExp (0 = none) caps the
// deadline at the provider token's own expiry.
func (s *Service) newLoginProof(tokenExp int64) loginProof {
	deadline := s.now().Add(loginProofTTL).Unix()
	if tokenExp > 0 && tokenExp < deadline {
		deadline = tokenExp
	}
	return loginProof{at: s.wallClock().Unix(), deadline: deadline}
}

// live reports whether a credential may still be written on this proof.
func (s *Service) proofLive(p loginProof) bool { return s.now().Unix() <= p.deadline }

// fence is the created_at bound for u: the proof time, or u's own creation
// time when this request's first sign-in created u (created == true).
func (p loginProof) fence(u User, created bool) int64 {
	if created && u.CreatedAt > p.at {
		return u.CreatedAt
	}
	return p.at
}
