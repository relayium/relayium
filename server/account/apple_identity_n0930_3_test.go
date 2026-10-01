package account

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// N-0930-3: Apple web and native logins issue credentials exactly like the
// Google callback — fenced by the epoch captured before the account state,
// the lifecycle and the Apple subject mapping, with the planted-password drop
// inside the guarded verification transaction.

const n3Sub = "001234.apple.n3"

// n3Hooks adds a hook before the native bearer insert to credentialHookStore.
type n3Hooks struct {
	*credentialHookStore
	beforeBearer func()
}

func (s *n3Hooks) CreateCLITokenForIdentityAtEpoch(ctx context.Context, t CLIToken, epoch int64, provider, subject string) (bool, error) {
	if s.beforeBearer != nil {
		s.beforeBearer()
	}
	return s.SQLiteStore.CreateCLITokenForIdentityAtEpoch(ctx, t, epoch, provider, subject)
}

func n3NewHooks(store *SQLiteStore) *n3Hooks {
	return &n3Hooks{credentialHookStore: &credentialHookStore{SQLiteStore: store}}
}

// ---- web ----

// n3WebService is a browser Sign in with Apple service over store whose
// exchange returns an identity token for n3Sub carrying email.
func n3WebService(t *testing.T, store Store, email string) *Service {
	t.Helper()
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: time.Minute, AccountGraceDays: 30,
		EnableApple: true, AppleClientIDs: []string{"com.relayium.web"}, AppleServicesID: "com.relayium.web",
	})
	svc.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	claims := validAppleClaims(svc.now())
	claims["aud"], claims["nonce"], claims["sub"], claims["email"] = "com.relayium.web", "NONCE1", n3Sub, email
	idToken := signAppleJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
	svc.appleKey = func(context.Context, string) (*rsa.PublicKey, error) { return &key.PublicKey, nil }
	svc.exchangeAppleCode = func(context.Context, string) (string, error) { return idToken, nil }
	return svc
}

func n3WebCallback(t *testing.T, svc *Service) *httptest.ResponseRecorder {
	t.Helper()
	seedOAuthState(t, svc, "STATE1")
	form := url.Values{"code": {"CODE1"}, "state": {"STATE1"}}
	req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
	req.AddCookie(&http.Cookie{Name: oauthNonceCookie, Value: "NONCE1"})
	rec := httptest.NewRecorder()
	svc.handleAppleWebCallback(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("want 302, got %d", rec.Code)
	}
	return rec
}

func n3Account(t *testing.T, store *SQLiteStore, email, hash string, linked bool) User {
	t.Helper()
	u := googleSubAccount(t, store, email, "", hash)
	if linked {
		if err := store.LinkIdentity(context.Background(), "apple", n3Sub, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	return u
}

func n3ReactivateCount(t *testing.T, store *SQLiteStore, userID string) int {
	t.Helper()
	// commitDeletion mints its own confirmation-flow token; count only others.
	return googleSubCount(t, store, `SELECT COUNT(*) FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate' AND token_hash != ?`,
		userID, authx.HashToken("react-"+userID))
}

// A password reset committing between the login's decision and its password
// drop survives, and the stale login gets no session.
func TestAppleN0930WebPasswordResetBeforeClearSurvives(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	u := n3Account(t, store, "reset3@example.com", "planted-hash", false)
	const now = int64(50_000)
	resetHash := authx.HashToken("reset3")
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: resetHash, UserID: u.ID, Email: u.Email,
		Purpose: "reset", CreatedAt: now, ExpiresAt: now + 3600}); err != nil {
		t.Fatal(err)
	}
	hs := n3NewHooks(store)
	hs.beforePasswordWrite = func() {
		if _, uid, _, err := store.ResetPasswordWithToken(ctx, resetHash, now, "owner-reset-hash"); err != nil || uid != u.ID {
			t.Fatalf("reset: uid=%q err=%v", uid, err)
		}
	}
	rec := n3WebCallback(t, n3WebService(t, hs, "reset3@example.com"))
	if got := passwordHash(t, store, u.ID); got != "owner-reset-hash" {
		t.Fatalf("a completed password reset must never be overwritten, password is now %q", got)
	}
	assertNoGoogleSession(t, store, rec, u.ID)
}

// A deletion and recovery committing right after the account state was read
// leave that state stale; no session is issued.
func TestAppleN0930WebDeletionAndRecoveryAfterCaptureIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := n3Account(t, store, "cap3@example.com", "", true)
	hs := n3NewHooks(store)
	hs.afterGetUser = func() {
		commitDeletion(t, store, u.ID)
		if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
			t.Fatal(err)
		}
	}
	rec := n3WebCallback(t, n3WebService(t, hs, "cap3@example.com"))
	assertNoGoogleSession(t, store, rec, u.ID)
}

// A deletion committing between the checks and the session insert leaves no
// session (the insert re-checks lifecycle, epoch and link atomically).
func TestAppleN0930WebDeletionBeforeSessionInsertIssuesNothing(t *testing.T) {
	store := newTestStore(t)
	u := n3Account(t, store, "del3@example.com", "", true)
	hs := n3NewHooks(store)
	hs.beforeSession = func() { commitDeletion(t, store, u.ID) }
	rec := n3WebCallback(t, n3WebService(t, hs, "del3@example.com"))
	assertNoGoogleSession(t, store, rec, u.ID)
}

// A pending account recovered and deleted again before the reactivate token
// is minted gets no token, on the linked and the unseen-subject path.
func TestAppleN0930WebPendingMovedBeforeTokenIssuesNothing(t *testing.T) {
	for _, linked := range []bool{true, false} {
		t.Run(map[bool]string{true: "linked", false: "unseen"}[linked], func(t *testing.T) {
			store := newTestStore(t)
			u := n3Account(t, store, "pend3@example.com", "", linked)
			if err := store.SetAccountDeletion(context.Background(), u.ID, 100, 100+30*86400); err != nil {
				t.Fatal(err)
			}
			hs := n3NewHooks(store)
			hs.beforeToken = func() {
				if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
					t.Fatal(err)
				}
				commitDeletion(t, store, u.ID)
			}
			rec := n3WebCallback(t, n3WebService(t, hs, "pend3@example.com"))
			if loc := rec.Header().Get("Location"); loc != "/?login=error" {
				t.Fatalf("want login error, got %q", loc)
			}
			if n := n3ReactivateCount(t, store, u.ID); n != 0 {
				t.Fatalf("no reactivate token may be minted across a lifecycle change, found %d", n)
			}
		})
	}
}

// An unseen subject that a concurrent login links to another account is
// refused: no session, and the account selected by email gains no link.
func TestAppleN0930WebSubjectLinkedElsewhereRefused(t *testing.T) {
	store := newTestStore(t)
	u := n3Account(t, store, "mine3@example.com", "", false)
	rival := n3Account(t, store, "rival3@example.com", "", false)
	hs := n3NewHooks(store)
	hs.afterGetUser = func() {
		if err := store.LinkIdentity(context.Background(), "apple", n3Sub, rival.ID); err != nil {
			t.Fatal(err)
		}
	}
	rec := n3WebCallback(t, n3WebService(t, hs, "mine3@example.com"))
	assertNoGoogleSession(t, store, rec, u.ID)
	if owner, ok, _ := store.GetUserByIdentity(context.Background(), "apple", n3Sub); !ok || owner.ID != rival.ID {
		t.Fatalf("the subject must stay with the account that linked it first: ok=%v owner=%+v", ok, owner)
	}
	if mustVerified(t, store, u.ID) {
		t.Fatal("a refused login must not verify the address")
	}
}

// A linked subject whose Apple email differs from the stored one signs in to
// its own account but neither verifies it nor drops its password.
func TestAppleN0930WebChangedEmailDoesNotVerify(t *testing.T) {
	store := newTestStore(t)
	u := n3Account(t, store, "orig3@example.com", "orig-hash", true)
	rec := n3WebCallback(t, n3WebService(t, store, "relay3@privaterelay.appleid.com"))
	if got := sessionUser(t, store, rec); got != u.ID {
		t.Fatalf("linked subject must sign in its own account, got %q", got)
	}
	if mustVerified(t, store, u.ID) || passwordHash(t, store, u.ID) != "orig-hash" {
		t.Fatal("an Apple email that is not the stored one proves nothing about it")
	}
}

// ---- native ----

func n3NativeFixture(t *testing.T, email string) (*appleNativeFixture, map[string]any) {
	t.Helper()
	f := newAppleNativeFixture(t)
	f.svc.cfg.AccountGraceDays = 30
	f.setExchange(func(_ context.Context, clientID, code string) (string, error) {
		return f.token(t, map[string]any{"aud": clientID, "email": email}), nil
	})
	body := f.validBody(t)
	body["idToken"] = f.token(t, map[string]any{"email": email})
	return f, body
}

func n3NativeAccount(t *testing.T, store *SQLiteStore, email, hash string, linked bool) User {
	t.Helper()
	u := googleSubAccount(t, store, email, "", hash)
	if linked {
		if err := store.LinkIdentity(context.Background(), "apple", nativeSub, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	return u
}

func n3AssertNoBearer(t *testing.T, store *SQLiteStore, rec *httptest.ResponseRecorder, userID string) {
	t.Helper()
	var body struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Token != "" || rec.Code == http.StatusOK {
		t.Fatalf("no bearer may be issued: %d %s", rec.Code, rec.Body.String())
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM cli_tokens WHERE user_id = ?`, userID); n != 0 {
		t.Fatalf("no bearer row may exist, found %d", n)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM devices WHERE user_id = ?`, userID); n != 0 {
		t.Fatalf("no device row may be left behind, found %d", n)
	}
}

func TestAppleN0930NativePasswordResetBeforeClearSurvives(t *testing.T) {
	ctx := context.Background()
	f, body := n3NativeFixture(t, "nreset@example.com")
	u := n3NativeAccount(t, f.store, "nreset@example.com", "planted-hash", false)
	const now = int64(50_000)
	resetHash := authx.HashToken("nreset")
	if err := f.store.CreateEmailToken(ctx, EmailToken{TokenHash: resetHash, UserID: u.ID, Email: u.Email,
		Purpose: "reset", CreatedAt: now, ExpiresAt: now + 3600}); err != nil {
		t.Fatal(err)
	}
	hs := n3NewHooks(f.store)
	hs.beforePasswordWrite = func() {
		if _, uid, _, err := f.store.ResetPasswordWithToken(ctx, resetHash, now, "owner-reset-hash"); err != nil || uid != u.ID {
			t.Fatalf("reset: uid=%q err=%v", uid, err)
		}
	}
	f.svc.store = hs
	rec := f.post(body)
	if got := passwordHash(t, f.store, u.ID); got != "owner-reset-hash" {
		t.Fatalf("a completed password reset must never be overwritten, password is now %q", got)
	}
	n3AssertNoBearer(t, f.store, rec, u.ID)
}

func TestAppleN0930NativeDeletionAndRecoveryAfterCaptureIssuesNothing(t *testing.T) {
	f, body := n3NativeFixture(t, "ncap@example.com")
	u := n3NativeAccount(t, f.store, "ncap@example.com", "", true)
	hs := n3NewHooks(f.store)
	hs.afterGetUser = func() {
		commitDeletion(t, f.store, u.ID)
		if err := f.store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
			t.Fatal(err)
		}
	}
	f.svc.store = hs
	n3AssertNoBearer(t, f.store, f.post(body), u.ID)
}

// The bearer insert itself re-checks the lifecycle and the subject mapping: a
// deletion, or an unlink, committing right before it leaves no bearer.
func TestAppleN0930NativeBearerInsertFenced(t *testing.T) {
	for _, tc := range []struct {
		name  string
		moved func(t *testing.T, store *SQLiteStore, userID string)
	}{
		{"deleted", func(t *testing.T, store *SQLiteStore, userID string) { commitDeletion(t, store, userID) }},
		{"frozen without epoch bump", func(t *testing.T, store *SQLiteStore, userID string) {
			if err := store.SetAccountDeletion(context.Background(), userID, 100, 100+30*86400); err != nil {
				t.Fatal(err)
			}
		}},
		{"unlinked", func(t *testing.T, store *SQLiteStore, userID string) {
			if err := store.UnlinkIdentity(context.Background(), "apple", userID); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, body := n3NativeFixture(t, "nbear@example.com")
			u := n3NativeAccount(t, f.store, "nbear@example.com", "", true)
			hs := n3NewHooks(f.store)
			hs.beforeBearer = func() { tc.moved(t, f.store, u.ID) }
			f.svc.store = hs
			n3AssertNoBearer(t, f.store, f.post(body), u.ID)
		})
	}
}

func TestAppleN0930NativePendingMovedBeforeTokenIssuesNothing(t *testing.T) {
	for _, linked := range []bool{true, false} {
		t.Run(map[bool]string{true: "linked", false: "unseen"}[linked], func(t *testing.T) {
			f, body := n3NativeFixture(t, "npend@example.com")
			u := n3NativeAccount(t, f.store, "npend@example.com", "", linked)
			if err := f.store.SetAccountDeletion(context.Background(), u.ID, 100, 100+30*86400); err != nil {
				t.Fatal(err)
			}
			hs := n3NewHooks(f.store)
			hs.beforeToken = func() {
				if err := f.store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
					t.Fatal(err)
				}
				commitDeletion(t, f.store, u.ID)
			}
			f.svc.store = hs
			rec := f.post(body)
			if strings.Contains(rec.Body.String(), "reactivateToken") {
				t.Fatalf("no reactivation offer across a lifecycle change: %d %s", rec.Code, rec.Body.String())
			}
			if n := n3ReactivateCount(t, f.store, u.ID); n != 0 {
				t.Fatalf("no reactivate token may be minted, found %d", n)
			}
		})
	}
}

func TestAppleN0930NativeSubjectLinkedElsewhereRefused(t *testing.T) {
	f, body := n3NativeFixture(t, "nmine@example.com")
	u := n3NativeAccount(t, f.store, "nmine@example.com", "", false)
	rival := n3NativeAccount(t, f.store, "nrival@example.com", "", false)
	hs := n3NewHooks(f.store)
	hs.afterGetUser = func() {
		if err := f.store.LinkIdentity(context.Background(), "apple", nativeSub, rival.ID); err != nil {
			t.Fatal(err)
		}
	}
	f.svc.store = hs
	rec := f.post(body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409 login_conflict, got %d %s", rec.Code, rec.Body.String())
	}
	n3AssertNoBearer(t, f.store, rec, u.ID)
	n3AssertNoBearer(t, f.store, rec, rival.ID)
	if mustVerified(t, f.store, u.ID) {
		t.Fatal("a refused login must not verify the address")
	}
}
