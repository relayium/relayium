package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// A-L13 Google: the callback resolves an account by the Google subject first.
// These tests drive handleGoogleCallback directly with a stubbed userinfo fetch.

func googleSubService(t *testing.T, store Store, sub, email string, verified bool) *Service {
	t.Helper()
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: time.Minute,
		EnableGoogle: true, AccountGraceDays: 30,
	})
	svc.fetchGoogleUser = func(context.Context, string) (string, string, string, bool, error) {
		return sub, email, "Google Name", verified, nil
	}
	return svc
}

func googleSubCallback(t *testing.T, svc *Service) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/auth/google/callback?code=abc&state=st", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "st"})
	rec := httptest.NewRecorder()
	svc.handleGoogleCallback(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("want 302, got %d", rec.Code)
	}
	return rec
}

// sessionUser returns the user id the response's session cookie belongs to,
// or "" when no session was issued.
func sessionUser(t *testing.T, store *SQLiteStore, rec *httptest.ResponseRecorder) string {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			sess, ok, err := store.GetSession(context.Background(), c.Value)
			if err != nil || !ok {
				t.Fatalf("session cookie without a session row: ok=%v err=%v", ok, err)
			}
			return sess.UserID
		}
	}
	return ""
}

func passwordHash(t *testing.T, store *SQLiteStore, userID string) string {
	t.Helper()
	var h *string
	if err := store.db.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&h); err != nil {
		t.Fatalf("read password hash: %v", err)
	}
	if h == nil {
		return ""
	}
	return *h
}

func mustVerified(t *testing.T, store *SQLiteStore, userID string) bool {
	t.Helper()
	v, err := store.EmailVerified(context.Background(), userID)
	if err != nil {
		t.Fatalf("email verified: %v", err)
	}
	return v
}

// googleSubAccount creates an unverified account holding a password, optionally
// linked to a Google subject.
func googleSubAccount(t *testing.T, store *SQLiteStore, email, sub, hash string) User {
	t.Helper()
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, email, "")
	if err != nil {
		t.Fatalf("upsert %s: %v", email, err)
	}
	if hash != "" {
		if err := store.SetPassword(ctx, u.ID, hash); err != nil {
			t.Fatalf("set password: %v", err)
		}
	}
	if sub != "" {
		if err := store.LinkIdentity(ctx, "google", sub, u.ID); err != nil {
			t.Fatalf("link: %v", err)
		}
	}
	return u
}

// A linked subject whose Google email changed signs in to its own account, and
// neither verifies nor strips a password from that account or the account
// that holds the new address.
func TestGoogleSubChangedEmailSignsInOriginalAccount(t *testing.T) {
	store := newTestStore(t)
	orig := googleSubAccount(t, store, "orig@example.com", "sub-A", "orig-hash")
	other := googleSubAccount(t, store, "new@example.com", "", "other-hash")

	rec := googleSubCallback(t, googleSubService(t, store, "sub-A", "New@Example.com", true))

	if got := sessionUser(t, store, rec); got != orig.ID {
		t.Fatalf("changed email must sign in the subject's account %s, got session for %q (other=%s)", orig.ID, got, other.ID)
	}
	if u, _ := store.GetUserByID(context.Background(), orig.ID); u.Email != "orig@example.com" {
		t.Fatalf("stored email must be kept, got %q", u.Email)
	}
	if mustVerified(t, store, orig.ID) || mustVerified(t, store, other.ID) {
		t.Fatal("a changed Google email must not verify any address")
	}
	if passwordHash(t, store, orig.ID) != "orig-hash" || passwordHash(t, store, other.ID) != "other-hash" {
		t.Fatal("a changed Google email must not change any password")
	}
	if u, ok, _ := store.GetUserByIdentity(context.Background(), "google", "sub-A"); !ok || u.ID != orig.ID {
		t.Fatalf("subject must stay linked to the original account, got ok=%v u=%+v", ok, u)
	}
	if providers, _ := store.ListIdentityProviders(context.Background(), other.ID); len(providers) != 0 {
		t.Fatalf("the account holding the new address must not gain a link: %v", providers)
	}
}

// A linked subject with its unchanged email still verifies the address and
// clears a password planted while it was unverified.
func TestGoogleSubMatchingEmailVerifiesAndDropsPlantedPassword(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "same@example.com", "sub-S", "planted-hash")
	// A non-zero credential epoch (after an earlier reset) must not block a
	// legitimate login: the session is inserted at the epoch actually read.
	if _, err := store.db.Exec(`UPDATE users SET credential_epoch = 5 WHERE id = ?`, u.ID); err != nil {
		t.Fatal(err)
	}

	rec := googleSubCallback(t, googleSubService(t, store, "sub-S", " SAME@example.com ", true))

	if got := sessionUser(t, store, rec); got != u.ID {
		t.Fatalf("want session for %s, got %q", u.ID, got)
	}
	if !mustVerified(t, store, u.ID) {
		t.Fatal("matching Google email must verify the account")
	}
	if passwordHash(t, store, u.ID) != "" {
		t.Fatal("unverified password must be dropped when Google proves the stored email")
	}
}

// A recreated Google account (new subject) with the same verified email still
// reaches the account and gets its new subject linked.
func TestGoogleSubRecreatedSubjectSameEmailLinks(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "recreated@example.com", "sub-old", "")

	rec := googleSubCallback(t, googleSubService(t, store, "sub-new", "recreated@example.com", true))

	if got := sessionUser(t, store, rec); got != u.ID {
		t.Fatalf("want session for %s, got %q", u.ID, got)
	}
	if got, ok, _ := store.GetUserByIdentity(context.Background(), "google", "sub-new"); !ok || got.ID != u.ID {
		t.Fatalf("new subject must link to the account, got ok=%v u=%+v", ok, got)
	}
	if !mustVerified(t, store, u.ID) {
		t.Fatal("verified email linking must verify the account")
	}
}

// An unverified Google email is refused even when the subject is already linked.
func TestGoogleSubUnverifiedEmailRefused(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "linked@example.com", "sub-U", "keep-hash")

	rec := googleSubCallback(t, googleSubService(t, store, "sub-U", "linked@example.com", false))

	if got := sessionUser(t, store, rec); got != "" {
		t.Fatalf("unverified email must not create a session, got %q", got)
	}
	if rec.Header().Get("Location") != "/?login=error" {
		t.Fatalf("want login error, got %q", rec.Header().Get("Location"))
	}
	if mustVerified(t, store, u.ID) || passwordHash(t, store, u.ID) != "keep-hash" {
		t.Fatal("a refused login must not change the account")
	}
}

func TestGoogleSubEmptySubjectOrEmailRefused(t *testing.T) {
	for _, tc := range []struct{ name, sub, email string }{
		{"empty subject", "", "nosub@example.com"},
		{"blank subject", "  ", "nosub@example.com"},
		{"empty email", "sub-noemail", ""},
		{"blank email", "sub-noemail", "   "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			rec := googleSubCallback(t, googleSubService(t, store, tc.sub, tc.email, true))
			if got := sessionUser(t, store, rec); got != "" {
				t.Fatalf("must not create a session, got %q", got)
			}
			if rec.Header().Get("Location") != "/?login=error" {
				t.Fatalf("want login error, got %q", rec.Header().Get("Location"))
			}
			var n int
			if err := store.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil || n != 0 {
				t.Fatalf("must not create a user: n=%d err=%v", n, err)
			}
		})
	}
}

// racingLinkStore simulates a concurrent first login of the same subject that
// links it to another account between this login's lookup and its own link.
// LinkIdentity is INSERT OR IGNORE, so the callback's own insert then succeeds
// without owning the row.
type racingLinkStore struct {
	*SQLiteStore
	rivalID string
}

func (s *racingLinkStore) LinkIdentity(ctx context.Context, provider, subject, userID string) error {
	if err := s.SQLiteStore.LinkIdentity(ctx, provider, subject, s.rivalID); err != nil {
		return err
	}
	return s.SQLiteStore.LinkIdentity(ctx, provider, subject, userID)
}

func TestGoogleSubConcurrentConflictingLinkIssuesNoSession(t *testing.T) {
	store := newTestStore(t)
	victim := googleSubAccount(t, store, "victim@example.com", "", "victim-hash")
	rival := googleSubAccount(t, store, "rival@example.com", "", "")

	svc := googleSubService(t, &racingLinkStore{SQLiteStore: store, rivalID: rival.ID}, "sub-race", "victim@example.com", true)
	rec := googleSubCallback(t, svc)

	if got := sessionUser(t, store, rec); got != "" {
		t.Fatalf("a subject linked to another account must not yield a session, got %q (victim=%s rival=%s)", got, victim.ID, rival.ID)
	}
	if rec.Header().Get("Location") != "/?login=error" {
		t.Fatalf("want login error, got %q", rec.Header().Get("Location"))
	}
	if mustVerified(t, store, victim.ID) || passwordHash(t, store, victim.ID) != "victim-hash" {
		t.Fatal("a conflicting link must not verify or change the selected account")
	}
}

// Pending deletion: the subject-linked account gets the reactivate redirect and
// no session; an account holding the changed Google email is not reactivated.
func TestGoogleSubPendingDeletionAccount(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	frozen := googleSubAccount(t, store, "frozen@example.com", "sub-F", "")
	if err := store.SetAccountDeletion(ctx, frozen.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}
	rec := googleSubCallback(t, googleSubService(t, store, "sub-F", "frozen@example.com", true))
	if got := sessionUser(t, store, rec); got != "" {
		t.Fatalf("pending-deletion account must not get a session, got %q", got)
	}
	if loc := rec.Header().Get("Location"); !strings.HasPrefix(loc, "/#account=pending_deletion&token=") {
		t.Fatalf("want pending_deletion fragment redirect, got %q", loc)
	}
	if mustVerified(t, store, frozen.ID) {
		t.Fatal("frozen login must not verify the email")
	}

	// A different subject whose email names another pending account: the
	// subject resolves to its own active account and nothing reactivates the
	// email's account.
	active := googleSubAccount(t, store, "active@example.com", "sub-X", "")
	rec = googleSubCallback(t, googleSubService(t, store, "sub-X", "frozen@example.com", true))
	if got := sessionUser(t, store, rec); got != active.ID {
		t.Fatalf("want session for the subject's account %s, got %q", active.ID, got)
	}
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Fatalf("changed email must not reach the pending account, got %q", loc)
	}
	if u, _ := store.GetUserByID(ctx, frozen.ID); u.DeletedAt == 0 {
		t.Fatal("pending account must stay pending")
	}
}

// credentialHookStore runs a hook just before the callback's atomic credential
// insert, to land a concurrent deletion or unlink deterministically between the
// callback's checks and its write.
type credentialHookStore struct {
	*SQLiteStore
	beforeSession func()
	beforeToken   func()
	afterGetUser  func()
}

func (s *credentialHookStore) GetUserByID(ctx context.Context, id string) (User, error) {
	u, err := s.SQLiteStore.GetUserByID(ctx, id)
	if s.afterGetUser != nil {
		hook := s.afterGetUser
		s.afterGetUser = nil
		hook()
	}
	return u, err
}

func (s *credentialHookStore) CreateSessionForIdentityAtEpoch(ctx context.Context, sess Session, epoch int64, provider, subject string) (bool, error) {
	if s.beforeSession != nil {
		s.beforeSession()
	}
	return s.SQLiteStore.CreateSessionForIdentityAtEpoch(ctx, sess, epoch, provider, subject)
}

func (s *credentialHookStore) CreateEmailTokenForIdentity(ctx context.Context, t EmailToken, provider, subject string) (bool, error) {
	if s.beforeToken != nil {
		s.beforeToken()
	}
	return s.SQLiteStore.CreateEmailTokenForIdentity(ctx, t, provider, subject)
}

// commitDeletion runs the real account-deletion transaction (session purge,
// epoch bump and deleted_at together).
func commitDeletion(t *testing.T, store *SQLiteStore, userID string) {
	t.Helper()
	ctx := context.Background()
	u, err := store.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	const now = int64(50_000)
	tokenHash := authx.HashToken("delete-" + userID)
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: tokenHash, UserID: u.ID, Email: u.Email,
		Purpose: "delete", CreatedAt: now, ExpiresAt: now + 3600}); err != nil {
		t.Fatal(err)
	}
	react := EmailToken{TokenHash: authx.HashToken("react-" + userID), UserID: u.ID, Purpose: "reactivate", CreatedAt: now, ExpiresAt: now + 86400}
	if _, committed, err := store.CommitAccountDeletion(ctx, tokenHash, u, now, now+86400, react); err != nil || !committed {
		t.Fatalf("commit deletion: committed=%v err=%v", committed, err)
	}
}

func googleSubCount(t *testing.T, store *SQLiteStore, q string, args ...any) int {
	t.Helper()
	var n int
	if err := store.db.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func assertNoGoogleSession(t *testing.T, store *SQLiteStore, rec *httptest.ResponseRecorder, userID string) {
	t.Helper()
	if got := sessionUser(t, store, rec); got != "" {
		t.Fatalf("no session may be issued, got one for %q", got)
	}
	if loc := rec.Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("want login error, got %q", loc)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, userID); n != 0 {
		t.Fatalf("no session row may exist for the account, found %d", n)
	}
}

// Finding 1: a deletion that commits between the callback's checks and its
// session insert leaves no session — and none reappears after reactivation.
func TestGoogleSubDeletionBeforeSessionInsertIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "del@example.com", "sub-D", "")
	hs := &credentialHookStore{SQLiteStore: store}
	hs.beforeSession = func() { commitDeletion(t, store, u.ID) }

	rec := googleSubCallback(t, googleSubService(t, hs, "sub-D", "del@example.com", true))
	assertNoGoogleSession(t, store, rec, u.ID)

	if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, u.ID); n != 0 {
		t.Fatalf("reactivation must not revive a session minted across the deletion, found %d", n)
	}
}

// Epoch fence: deletion AND reactivation both committing between the checks
// and the insert still leave no session (the account state the login read is
// gone even though the account is active again).
func TestGoogleSubDeletionAndReactivationBeforeSessionInsertIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "delre@example.com", "sub-DR", "")
	hs := &credentialHookStore{SQLiteStore: store}
	hs.beforeSession = func() {
		commitDeletion(t, store, u.ID)
		if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
			t.Fatalf("reactivate: %v", err)
		}
	}
	rec := googleSubCallback(t, googleSubService(t, hs, "sub-DR", "delre@example.com", true))
	assertNoGoogleSession(t, store, rec, u.ID)
}

// Frozen fence: an account marked pending deletion without an epoch bump
// between the checks and the insert gets no session.
func TestGoogleSubFrozenBeforeSessionInsertIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "frz@example.com", "sub-Z", "")
	hs := &credentialHookStore{SQLiteStore: store}
	hs.beforeSession = func() {
		if err := store.SetAccountDeletion(context.Background(), u.ID, 100, 100+30*86400); err != nil {
			t.Fatalf("set deletion: %v", err)
		}
	}
	rec := googleSubCallback(t, googleSubService(t, hs, "sub-Z", "frz@example.com", true))
	assertNoGoogleSession(t, store, rec, u.ID)
}

// Finding 2 (session): an unlink between the confirm step and the session
// insert leaves no session.
func TestGoogleSubUnlinkBeforeSessionInsertIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "unl@example.com", "sub-L", "keep")
	hs := &credentialHookStore{SQLiteStore: store}
	hs.beforeSession = func() {
		if err := store.UnlinkIdentity(context.Background(), "google", u.ID); err != nil {
			t.Fatalf("unlink: %v", err)
		}
	}
	rec := googleSubCallback(t, googleSubService(t, hs, "sub-L", "unl@example.com", true))
	assertNoGoogleSession(t, store, rec, u.ID)
}

// Finding 2 (reactivation token): an unlink between the subject lookup and the
// reactivate-token insert of a pending account leaves no token.
func TestGoogleSubUnlinkBeforeReactivationTokenIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "unlf@example.com", "sub-LF", "")
	if err := store.SetAccountDeletion(context.Background(), u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}
	hs := &credentialHookStore{SQLiteStore: store}
	hs.beforeToken = func() {
		if err := store.UnlinkIdentity(context.Background(), "google", u.ID); err != nil {
			t.Fatalf("unlink: %v", err)
		}
	}
	rec := googleSubCallback(t, googleSubService(t, hs, "sub-LF", "unlf@example.com", true))
	if loc := rec.Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("want login error, got %q", loc)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate'`, u.ID); n != 0 {
		t.Fatalf("no reactivate token may be minted after the unlink, found %d", n)
	}
}

// Finding 3: a pending-deletion linked subject whose Google email changed gets
// a reactivate token that recovers exactly the subject's account; the (also
// pending) account holding the changed address is untouched.
func TestGoogleSubFrozenChangedEmailTokenRecoversSubjectAccountOnly(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	subject := googleSubAccount(t, store, "subject@example.com", "sub-R", "")
	other := googleSubAccount(t, store, "changed@example.com", "", "other-hash")
	for _, id := range []string{subject.ID, other.ID} {
		if err := store.SetAccountDeletion(ctx, id, 100, 100+30*86400); err != nil {
			t.Fatalf("set deletion: %v", err)
		}
	}
	svc := googleSubService(t, store, "sub-R", "Changed@Example.com", true)
	rec := googleSubCallback(t, svc)
	loc := rec.Header().Get("Location")
	const prefix = "/#account=pending_deletion&token="
	if !strings.HasPrefix(loc, prefix) {
		t.Fatalf("want pending_deletion redirect, got %q", loc)
	}
	if got := sessionUser(t, store, rec); got != "" {
		t.Fatalf("pending account must not get a session, got %q", got)
	}
	raw, err := url.QueryUnescape(strings.TrimPrefix(loc, prefix))
	if err != nil {
		t.Fatal(err)
	}
	tok, ok, err := store.PeekEmailToken(ctx, authx.HashToken(raw), "reactivate", svc.now().Unix())
	if err != nil || !ok || tok.UserID != subject.ID || tok.Email != "subject@example.com" {
		t.Fatalf("token must be scoped to the subject's account: ok=%v err=%v tok=%+v", ok, err, tok)
	}

	body, _ := json.Marshal(map[string]string{"token": raw})
	rreq := httptest.NewRequest("POST", "/api/account/reactivate", bytes.NewReader(body))
	rreq.Header.Set("Content-Type", "application/json")
	rrec := httptest.NewRecorder()
	svc.handleReactivate(rrec, rreq)
	if rrec.Code != http.StatusOK {
		t.Fatalf("redeem: want 200, got %d %s", rrec.Code, rrec.Body.String())
	}
	if got := sessionUser(t, store, rrec); got != subject.ID {
		t.Fatalf("redeemed token must sign in the subject's account %s, got %q", subject.ID, got)
	}
	if u, _ := store.GetUserByID(ctx, subject.ID); u.DeletedAt != 0 || u.Email != "subject@example.com" {
		t.Fatalf("subject's account must be recovered with its email: %+v", u)
	}
	o, _ := store.GetUserByID(ctx, other.ID)
	if o.DeletedAt == 0 {
		t.Fatal("the account holding the changed address must stay pending deletion")
	}
	if mustVerified(t, store, other.ID) || passwordHash(t, store, other.ID) != "other-hash" {
		t.Fatal("the account holding the changed address must not be verified or changed")
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate'`, other.ID); n != 0 {
		t.Fatalf("no reactivate token may be minted for the changed address's account, found %d", n)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, other.ID); n != 0 {
		t.Fatalf("no session may exist for the changed address's account, found %d", n)
	}
	if providers, _ := store.ListIdentityProviders(ctx, other.ID); len(providers) != 0 {
		t.Fatalf("the changed address's account must not gain a link: %v", providers)
	}
}

// Epoch capture order: the epoch is read BEFORE the account state the login
// acts on. A deletion and reactivation that both commit right after that state
// read leave the state stale, and the session insert must refuse it. The
// account starts at a non-zero epoch so a zero/unread epoch cannot pass by luck.
func TestGoogleSubDeletionAfterStateReadIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "order@example.com", "sub-O", "")
	if _, err := store.db.Exec(`UPDATE users SET credential_epoch = 3 WHERE id = ?`, u.ID); err != nil {
		t.Fatal(err)
	}
	hs := &credentialHookStore{SQLiteStore: store}
	hs.afterGetUser = func() {
		commitDeletion(t, store, u.ID)
		if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
			t.Fatalf("reactivate: %v", err)
		}
	}
	rec := googleSubCallback(t, googleSubService(t, hs, "sub-O", "order@example.com", true))
	assertNoGoogleSession(t, store, rec, u.ID)
}
