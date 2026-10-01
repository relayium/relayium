package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// Codex r4: a provider login is fenced at the moment its proof was validated
// (loginProof). Paused after validation and before the account is resolved,
// while the address's account is deleted, hard-purged and re-created, it must
// not bind the stale proof to the replacement; it must also finish within its
// deadline. A first sign-in that creates the account keeps working.

// pfHooks adds a one-shot hook on the first subject lookup — the start of
// account resolution, after the proof was validated.
type pfHooks struct {
	*n3Hooks
	beforeResolve func()
}

func (s *pfHooks) GetUserByIdentity(ctx context.Context, provider, subject string) (User, bool, error) {
	if s.beforeResolve != nil {
		hook := s.beforeResolve
		s.beforeResolve = nil
		hook()
	}
	return s.SQLiteStore.GetUserByIdentity(ctx, provider, subject)
}

func newPFHooks(store *SQLiteStore) *pfHooks { return &pfHooks{n3Hooks: n3NewHooks(store)} }

// pfOldAccount creates the address's original account, created well before
// the proof (proofAt - 1000).
func pfOldAccount(t *testing.T, store *SQLiteStore, email string, proofAt time.Time) User {
	t.Helper()
	u := googleSubAccount(t, store, email, "", "")
	if _, err := store.db.Exec(`UPDATE users SET created_at = ? WHERE id = ?`, proofAt.Unix()-1000, u.ID); err != nil {
		t.Fatal(err)
	}
	return u
}

// pfReplace deletes and hard-purges old, then re-creates its address as a
// different account holding its own password.
func pfReplace(t *testing.T, store *SQLiteStore, old User) User {
	t.Helper()
	ctx := context.Background()
	commitDeletion(t, store, old.ID) // purge_after = 50_000 + 86_400
	if err := store.ArchiveAndPurgeUser(ctx, old.ID, 50_000+86_400+1); err != nil {
		t.Fatalf("hard purge: %v", err)
	}
	rep, err := store.UpsertUserByEmail(ctx, old.Email, "")
	if err != nil {
		t.Fatal(err)
	}
	if rep.ID == old.ID {
		t.Fatal("the replacement must be a different account")
	}
	if err := store.SetPassword(ctx, rep.ID, "replacement-hash"); err != nil {
		t.Fatal(err)
	}
	return rep
}

func pfAssertReplacementUntouched(t *testing.T, store *SQLiteStore, rep User) {
	t.Helper()
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions WHERE user_id = ?`, rep.ID); n != 0 {
		t.Fatalf("no session for the replacement, found %d", n)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM cli_tokens WHERE user_id = ?`, rep.ID); n != 0 {
		t.Fatalf("no bearer for the replacement, found %d", n)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate'`, rep.ID); n != 0 {
		t.Fatalf("no reactivate token for the replacement, found %d", n)
	}
	if mustVerified(t, store, rep.ID) || passwordHash(t, store, rep.ID) != "replacement-hash" {
		t.Fatal("the replacement must be neither verified nor stripped of its password")
	}
	if providers, _ := store.ListIdentityProviders(context.Background(), rep.ID); len(providers) != 0 {
		t.Fatalf("the replacement must gain no linked identity: %v", providers)
	}
}

func TestProofFenceN0930GoogleReplacementAfterProofGetsNothing(t *testing.T) {
	store := newTestStore(t)
	proofAt := time.Now().Add(-time.Hour)
	old := pfOldAccount(t, store, "pfg@example.com", proofAt)
	var rep User
	hs := newPFHooks(store)
	hs.beforeResolve = func() { rep = pfReplace(t, store, old) }
	svc := googleSubService(t, hs, "sub-pfg", "pfg@example.com", true)
	svc.wallNow = func() time.Time { return proofAt }
	rec := googleSubCallback(t, svc)
	if hs.beforeResolve != nil {
		t.Fatal("the login never reached the interleaving point")
	}
	if loc := rec.Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("want login error, got %q", loc)
	}
	pfAssertReplacementUntouched(t, store, rep)
}

func TestProofFenceN0930AppleWebReplacementAfterProofGetsNothing(t *testing.T) {
	store := newTestStore(t)
	proofAt := time.Now().Add(-time.Hour)
	old := pfOldAccount(t, store, "pfa@example.com", proofAt)
	var rep User
	hs := newPFHooks(store)
	hs.beforeResolve = func() { rep = pfReplace(t, store, old) }
	svc := n3WebService(t, hs, "pfa@example.com")
	svc.wallNow = func() time.Time { return proofAt }
	rec := n3WebCallback(t, svc)
	if hs.beforeResolve != nil {
		t.Fatal("the login never reached the interleaving point")
	}
	if loc := rec.Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("want login error, got %q", loc)
	}
	pfAssertReplacementUntouched(t, store, rep)
}

func TestProofFenceN0930AppleNativeReplacementAfterProofGetsNothing(t *testing.T) {
	f, body := n3NativeFixture(t, "pfn@example.com")
	proofAt := time.Now().Add(-time.Hour)
	old := pfOldAccount(t, f.store, "pfn@example.com", proofAt)
	var rep User
	hs := newPFHooks(f.store)
	hs.beforeResolve = func() { rep = pfReplace(t, f.store, old) }
	f.svc.store = hs
	f.svc.wallNow = func() time.Time { return proofAt }
	rec := f.post(body)
	if hs.beforeResolve != nil {
		t.Fatal("the login never reached the interleaving point")
	}
	if rec.Code == http.StatusOK {
		t.Fatalf("a stale proof must not log in the replacement: %d %s", rec.Code, rec.Body.String())
	}
	pfAssertReplacementUntouched(t, f.store, rep)
}

// The deadline: a login that resumes more than loginProofTTL after its proof
// gets nothing.
func TestProofFenceN0930GoogleDeadlineExceeded(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "pfd@example.com", "sub-pfd", "")
	hs := newPFHooks(store)
	svc := googleSubService(t, hs, "sub-pfd", "pfd@example.com", true)
	base := time.Now()
	svc.now = func() time.Time { return base }
	hs.afterGetUser = func() { svc.now = func() time.Time { return base.Add(loginProofTTL + time.Second) } }
	rec := googleSubCallback(t, svc)
	if hs.afterGetUser != nil {
		t.Fatal("the login never reached the interleaving point")
	}
	assertNoGoogleSession(t, store, rec, u.ID)
}

// For Apple the deadline is also capped by the identity token's own expiry.
func TestProofFenceN0930AppleNativeTokenExpiryBoundsDeadline(t *testing.T) {
	f := newAppleNativeFixture(t)
	now := f.svc.now()
	exp := now.Add(time.Minute).Unix()
	f.setExchange(func(_ context.Context, clientID, code string) (string, error) {
		return f.token(t, map[string]any{"aud": clientID, "email": "pfx@example.com", "exp": exp}), nil
	})
	body := f.validBody(t)
	body["idToken"] = f.token(t, map[string]any{"email": "pfx@example.com", "exp": exp})
	u := n3NativeAccount(t, f.store, "pfx@example.com", "", true)
	hs := newPFHooks(f.store)
	hs.afterGetUser = func() { f.svc.now = func() time.Time { return now.Add(2 * time.Minute) } }
	f.svc.store = hs
	rec := f.post(body)
	if hs.afterGetUser != nil {
		t.Fatal("the login never reached the interleaving point")
	}
	n3AssertNoBearer(t, f.store, rec, u.ID)
}

// First sign-in: the account this request creates after its proof is bound to
// it by construction and still signs in (web and native).
func TestProofFenceN0930FirstSignInStillWorks(t *testing.T) {
	t.Run("google", func(t *testing.T) {
		store := newTestStore(t)
		svc := googleSubService(t, store, "sub-pff", "pff@example.com", true)
		svc.wallNow = func() time.Time { return time.Now().Add(-time.Hour) } // account created after the proof
		rec := googleSubCallback(t, svc)
		if got := sessionUser(t, store, rec); got == "" {
			t.Fatalf("first sign-in must sign in, got %q", rec.Header().Get("Location"))
		}
	})
	t.Run("apple native", func(t *testing.T) {
		f, body := n3NativeFixture(t, "pffn@example.com")
		f.svc.wallNow = func() time.Time { return time.Now().Add(-time.Hour) }
		rec := f.post(body)
		if rec.Code != http.StatusOK {
			t.Fatalf("first native sign-in must succeed: %d %s", rec.Code, rec.Body.String())
		}
	})
}

// ---- round 5 ----

// pfReplaceSameSecond is pfReplace with the replacement's created_at forced to
// the proof's own second — an original already due for purge, purged and
// replaced within the second the proof was validated in.
func pfReplaceSameSecond(t *testing.T, store *SQLiteStore, old User, proofAt time.Time) User {
	t.Helper()
	rep := pfReplace(t, store, old)
	if _, err := store.db.Exec(`UPDATE users SET created_at = ? WHERE id = ?`, proofAt.Unix(), rep.ID); err != nil {
		t.Fatal(err)
	}
	return rep
}

func TestProofFenceN0930SameSecondReplacementRefused(t *testing.T) {
	for _, provider := range []string{"google", "apple web", "apple native"} {
		t.Run(provider, func(t *testing.T) {
			proofAt := time.Now()
			var rep User
			switch provider {
			case "google":
				store := newTestStore(t)
				old := pfOldAccount(t, store, "ss-g@example.com", proofAt)
				hs := newPFHooks(store)
				hs.beforeResolve = func() { rep = pfReplaceSameSecond(t, store, old, proofAt) }
				svc := googleSubService(t, hs, "sub-ss", "ss-g@example.com", true)
				svc.wallNow = func() time.Time { return proofAt }
				rec := googleSubCallback(t, svc)
				if hs.beforeResolve != nil || rec.Header().Get("Location") != "/?login=error" {
					t.Fatalf("want a refused login after the interleaving, got %q", rec.Header().Get("Location"))
				}
				pfAssertReplacementUntouched(t, store, rep)
			case "apple web":
				store := newTestStore(t)
				old := pfOldAccount(t, store, "ss-a@example.com", proofAt)
				hs := newPFHooks(store)
				hs.beforeResolve = func() { rep = pfReplaceSameSecond(t, store, old, proofAt) }
				svc := n3WebService(t, hs, "ss-a@example.com")
				svc.wallNow = func() time.Time { return proofAt }
				rec := n3WebCallback(t, svc)
				if hs.beforeResolve != nil || rec.Header().Get("Location") != "/?login=error" {
					t.Fatalf("want a refused login after the interleaving, got %q", rec.Header().Get("Location"))
				}
				pfAssertReplacementUntouched(t, store, rep)
			case "apple native":
				f, body := n3NativeFixture(t, "ss-n@example.com")
				old := pfOldAccount(t, f.store, "ss-n@example.com", proofAt)
				hs := newPFHooks(f.store)
				hs.beforeResolve = func() { rep = pfReplaceSameSecond(t, f.store, old, proofAt) }
				f.svc.store = hs
				f.svc.wallNow = func() time.Time { return proofAt }
				rec := f.post(body)
				if hs.beforeResolve != nil || rec.Code == http.StatusOK {
					t.Fatalf("want a refused login after the interleaving: %d %s", rec.Code, rec.Body.String())
				}
				pfAssertReplacementUntouched(t, f.store, rep)
			}
		})
	}
}

// pfDeviceHooks moves the clock while the native bearer's device row is
// written — after every earlier deadline check, before the bearer insert.
type pfDeviceHooks struct {
	*SQLiteStore
	duringDevice func()
}

func (s *pfDeviceHooks) UpsertDevice(ctx context.Context, d Device) (Device, error) {
	out, err := s.SQLiteStore.UpsertDevice(ctx, d)
	if s.duringDevice != nil {
		hook := s.duringDevice
		s.duringDevice = nil
		hook()
	}
	return out, err
}

func TestProofFenceN0930NativeExpiryDuringDeviceWrite(t *testing.T) {
	f, body := n3NativeFixture(t, "pfdev@example.com")
	u := n3NativeAccount(t, f.store, "pfdev@example.com", "", true)
	now := f.svc.now()
	hs := &pfDeviceHooks{SQLiteStore: f.store}
	hs.duringDevice = func() { f.svc.now = func() time.Time { return now.Add(loginProofTTL) } }
	f.svc.store = hs
	rec := f.post(body)
	if hs.duringDevice != nil {
		t.Fatal("the login never wrote its device row")
	}
	n3AssertNoBearer(t, f.store, rec, u.ID)
}

// pfSettingsHooks moves the clock while the reactivation issuer resolves its
// settings — after the caller's deadline check, before the token insert.
type pfSettingsHooks struct {
	*SQLiteStore
	duringSettings func()
}

func (s *pfSettingsHooks) GetSetting(ctx context.Context, key string) (int64, bool, error) {
	if s.duringSettings != nil {
		hook := s.duringSettings
		s.duringSettings = nil
		hook()
	}
	return s.SQLiteStore.GetSetting(ctx, key)
}

func TestProofFenceN0930ReactivationExpiryDuringSettings(t *testing.T) {
	store := newTestStore(t)
	u := googleSubAccount(t, store, "pfset@example.com", "sub-pfset", "")
	if err := store.SetAccountDeletion(context.Background(), u.ID, 100, 100+30*86400); err != nil {
		t.Fatal(err)
	}
	hs := &pfSettingsHooks{SQLiteStore: store}
	svc := googleSubService(t, hs, "sub-pfset", "pfset@example.com", true)
	base := time.Now()
	svc.now = func() time.Time { return base }
	hs.duringSettings = func() { svc.now = func() time.Time { return base.Add(loginProofTTL) } }
	rec := googleSubCallback(t, svc)
	if hs.duringSettings != nil {
		t.Fatal("the issuer never resolved its settings")
	}
	if loc := rec.Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("want login error, got %q", loc)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate'`, u.ID); n != 0 {
		t.Fatalf("no reactivate token after the deadline, found %d", n)
	}
}

// Exactly at the Apple token's exp the proof is dead (Apple's own validation
// rejects now >= exp); one second earlier it is live.
func TestProofFenceN0930AppleExactExpiryBoundary(t *testing.T) {
	for _, tc := range []struct {
		name   string
		offset time.Duration
		want   bool
	}{{"at exp", 0, false}, {"one second before exp", -time.Second, true}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppleNativeFixture(t)
			now := f.svc.now()
			exp := now.Add(time.Minute)
			f.setExchange(func(_ context.Context, clientID, code string) (string, error) {
				return f.token(t, map[string]any{"aud": clientID, "email": "pfe@example.com", "exp": exp.Unix()}), nil
			})
			body := f.validBody(t)
			body["idToken"] = f.token(t, map[string]any{"email": "pfe@example.com", "exp": exp.Unix()})
			u := n3NativeAccount(t, f.store, "pfe@example.com", "", true)
			hs := newPFHooks(f.store)
			hs.afterGetUser = func() { f.svc.now = func() time.Time { return exp.Add(tc.offset) } }
			f.svc.store = hs
			rec := f.post(body)
			if !tc.want {
				n3AssertNoBearer(t, f.store, rec, u.ID)
				return
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("a proof one second before exp must still log in: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}
