package account

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"github.com/relayium/relayium/authx"
)

// N-0930-5 (Codex r1 finding 1): every proof-based reactivation issuer —
// password login, magic link, reset link, verify link — mints its token only
// for the deletion generation the proof was made in. Each test runs Codex's
// ordering: the proof is checked and the pending state read in generation G1;
// the owner then recovers, (for a password: resets it,) and deletes again
// into G2; the paused request resumes. It must mint nothing.

// n5IssuerHooks fires a hook once, right after the issuer's account-state read.
type n5IssuerHooks struct {
	*SQLiteStore
	afterGetUser func()
	afterUpsert  func()
}

func (s *n5IssuerHooks) GetUserByID(ctx context.Context, id string) (User, error) {
	u, err := s.SQLiteStore.GetUserByID(ctx, id)
	if s.afterGetUser != nil {
		hook := s.afterGetUser
		s.afterGetUser = nil
		hook()
	}
	return u, err
}

func (s *n5IssuerHooks) UpsertUserByEmail(ctx context.Context, email, name string) (User, error) {
	u, err := s.SQLiteStore.UpsertUserByEmail(ctx, email, name)
	if s.afterUpsert != nil {
		hook := s.afterUpsert
		s.afterUpsert = nil
		hook()
	}
	return u, err
}

// n5ReactivateTokensOtherThanDeletion counts reactivate tokens not minted by
// the n5Delete deletion transactions (those carry the "n5-react-" prefix).
func n5IssuedTokens(t *testing.T, store *SQLiteStore, userID string, deletionRaws ...string) int {
	t.Helper()
	n := googleSubCount(t, store, `SELECT COUNT(*) FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate'`, userID)
	for _, raw := range deletionRaws {
		n -= googleSubCount(t, store, `SELECT COUNT(*) FROM email_tokens WHERE token_hash = ?`, authx.HashToken(raw))
	}
	return n
}

// n5OwnerRecoversAndRedeletes is the overtaking owner: recover G1, optionally
// reset the password, delete again into G2. It returns G2's deletion token.
func n5OwnerRecoversAndRedeletes(t *testing.T, store *SQLiteStore, userID string, resetPassword bool) string {
	t.Helper()
	ctx := context.Background()
	if err := store.ClearAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if resetPassword {
		u, err := store.GetUserByID(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		resetHash := authx.HashToken("n5-reset-" + userID)
		if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: resetHash, UserID: userID, Email: u.Email,
			Purpose: "reset", CreatedAt: n5Now, ExpiresAt: n5Now + 3600}); err != nil {
			t.Fatal(err)
		}
		if outcome, uid, _, err := store.ResetPasswordWithToken(ctx, resetHash, n5Now, "owner-new-hash"); err != nil || outcome != ResetApplied || uid != userID {
			t.Fatalf("owner reset: outcome=%v uid=%q err=%v", outcome, uid, err)
		}
	}
	return n5Delete(t, store, userID, "g2", n5Now-100)
}

func TestReactivateN0930PasswordLoginProofCannotMintForNextGeneration(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "pwgen@example.com")
	hash, err := bcrypt.GenerateFromPassword([]byte("old-password-1"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetPassword(ctx, u.ID, string(hash)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	var g2 string
	hs := &n5IssuerHooks{SQLiteStore: store}
	hs.afterGetUser = func() { g2 = n5OwnerRecoversAndRedeletes(t, store, u.ID, true) }
	svc.store = hs

	_, err = svc.Login(ctx, "pwgen@example.com", "old-password-1")
	if hs.afterGetUser != nil {
		t.Fatal("the login never reached the interleaving point")
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		t.Fatalf("an old-generation password proof was handed a reactivate token")
	}
	if !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials for the stale proof, got %v", err)
	}
	if n := n5IssuedTokens(t, store, u.ID, g1, g2); n != 0 {
		t.Fatalf("no reactivate token may be minted for the next generation, found %d", n)
	}
	if acc, _ := store.GetUserByID(ctx, u.ID); acc.DeletedAt == 0 {
		t.Fatal("generation G2 must stay pending")
	}
}

// The password-hash predicate on its own: a password change that did not move
// the epoch (not a path the product has today) still voids the proof.
func TestReactivateN0930PasswordLoginProofBoundToCheckedHash(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "pwhash@example.com")
	hash, err := bcrypt.GenerateFromPassword([]byte("old-password-1"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetPassword(ctx, u.ID, string(hash)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	hs := &n5IssuerHooks{SQLiteStore: store}
	hs.afterGetUser = func() {
		if _, err := store.db.Exec(`UPDATE users SET password_hash = 'swapped' WHERE id = ?`, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	svc.store = hs
	_, err = svc.Login(ctx, "pwhash@example.com", "old-password-1")
	if !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("want ErrBadCredentials, got %v", err)
	}
	if n := n5IssuedTokens(t, store, u.ID, g1); n != 0 {
		t.Fatalf("no token for a proof against a replaced hash, found %d", n)
	}
}

// Without interference the password login still hands back a working token.
func TestReactivateN0930PasswordLoginFrozenStillOffersToken(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "pwok@example.com")
	hash, _ := bcrypt.GenerateFromPassword([]byte("old-password-1"), bcrypt.MinCost)
	if err := store.SetPassword(ctx, u.ID, string(hash)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	n5Delete(t, store, u.ID, "g1", n5Now-1000)
	_, err := svc.Login(ctx, "pwok@example.com", "old-password-1")
	var pd *PendingDeletionError
	if !errors.As(err, &pd) || pd.ReactivateToken == "" {
		t.Fatalf("want a reactivation offer, got %v", err)
	}
	if rec := postReactivate(svc, pd.ReactivateToken); rec.Code != 200 || sessionUser(t, store, rec) != u.ID {
		t.Fatalf("the offered token must recover: %d %s", rec.Code, rec.Body.String())
	}
}

func TestReactivateN0930MagicLinkProofCannotMintForNextGeneration(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "magicgen@example.com")
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	raw := "n5-magic-" + u.ID
	if err := store.CreateMagicToken(ctx, MagicToken{TokenHash: authx.HashToken(raw), Email: u.Email,
		CreatedAt: n5Now, ExpiresAt: n5Now + 600}); err != nil {
		t.Fatal(err)
	}
	var g2 string
	hs := &n5IssuerHooks{SQLiteStore: store}
	hs.afterUpsert = func() { g2 = n5OwnerRecoversAndRedeletes(t, store, u.ID, false) }
	svc.store = hs
	_, err := svc.VerifyMagicLink(ctx, raw)
	if hs.afterUpsert != nil {
		t.Fatal("the magic login never reached the interleaving point")
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) || err == nil {
		t.Fatalf("a G1 magic-link proof must mint nothing for G2, got %v", err)
	}
	if n := n5IssuedTokens(t, store, u.ID, g1, g2); n != 0 {
		t.Fatalf("no reactivate token may be minted, found %d", n)
	}
}

func TestReactivateN0930ResetLinkCannotMintForNextGeneration(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "resetgen@example.com")
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	raw := "n5-resetlink-" + u.ID
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken(raw), UserID: u.ID, Email: u.Email,
		Purpose: "reset", CreatedAt: n5Now, ExpiresAt: n5Now + 3600}); err != nil {
		t.Fatal(err)
	}
	var g2 string
	hs := &n5IssuerHooks{SQLiteStore: store}
	hs.afterGetUser = func() { g2 = n5OwnerRecoversAndRedeletes(t, store, u.ID, false) }
	svc.store = hs
	_, err := svc.ResetPassword(ctx, raw, "brand-new-password-1")
	if hs.afterGetUser != nil {
		t.Fatal("the reset never reached the interleaving point")
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) || !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("a G1 reset link must mint nothing for G2, want ErrInvalidToken, got %v", err)
	}
	if n := n5IssuedTokens(t, store, u.ID, g1, g2); n != 0 {
		t.Fatalf("no reactivate token may be minted, found %d", n)
	}
}

func TestReactivateN0930VerifyLinkCannotMintForNextGeneration(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "verifygen@example.com")
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	raw := "n5-verifylink-" + u.ID
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken(raw), UserID: u.ID, Email: u.Email,
		Purpose: "verify", CreatedAt: n5Now, ExpiresAt: n5Now + 3600}); err != nil {
		t.Fatal(err)
	}
	var g2 string
	hs := &n5IssuerHooks{SQLiteStore: store}
	hs.afterGetUser = func() { g2 = n5OwnerRecoversAndRedeletes(t, store, u.ID, false) }
	svc.store = hs
	_, err := svc.VerifyEmail(ctx, raw, "")
	if hs.afterGetUser != nil {
		t.Fatal("the verification never reached the interleaving point")
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) || !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("a G1 verify link must mint nothing for G2, want ErrInvalidToken, got %v", err)
	}
	if n := n5IssuedTokens(t, store, u.ID, g1, g2); n != 0 {
		t.Fatalf("no reactivate token may be minted, found %d", n)
	}
}

// The reminder issuer (no login proof) mints only for the address the account
// still holds.
func TestReactivateN0930ReminderRefusesChangedAddress(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "remind@example.com")
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	if _, err := store.db.Exec(`UPDATE users SET email = 'moved@example.com' WHERE id = ?`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IssueReactivateLink(ctx, u.ID, "remind@example.com"); !errors.Is(err, errReactivationStateMoved) {
		t.Fatalf("a reminder for an address the account no longer holds must mint nothing, got %v", err)
	}
	if n := n5IssuedTokens(t, store, u.ID, g1); n != 0 {
		t.Fatalf("no reactivate token may be minted, found %d", n)
	}
}

// A proof made while pending must not mint once the owner has recovered the
// account (no new deletion, so the epoch did not move): the insert requires
// pending state.
func TestReactivateN0930PasswordLoginAfterRecoveryMintsNothing(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "pwrec@example.com")
	hash, _ := bcrypt.GenerateFromPassword([]byte("old-password-1"), bcrypt.MinCost)
	if err := store.SetPassword(ctx, u.ID, string(hash)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	hs := &n5IssuerHooks{SQLiteStore: store}
	hs.afterGetUser = func() {
		if err := store.ClearAccountDeletion(ctx, u.ID); err != nil {
			t.Fatal(err)
		}
	}
	svc.store = hs
	_, err := svc.Login(ctx, "pwrec@example.com", "old-password-1")
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		t.Fatal("a recovered account must not be handed a reactivate token")
	}
	if n := n5IssuedTokens(t, store, u.ID, g1); n != 0 {
		t.Fatalf("no reactivate token may be minted for an active account, found %d", n)
	}
}

// n5MagicHooks fires once immediately after the magic link is spent — before
// any later epoch read — whichever consumption call the login uses.
type n5MagicHooks struct {
	*SQLiteStore
	afterConsume func()
}

func (s *n5MagicHooks) fire() {
	if s.afterConsume != nil {
		hook := s.afterConsume
		s.afterConsume = nil
		hook()
	}
}

func (s *n5MagicHooks) UseMagicToken(ctx context.Context, tokenHash string, now int64) (MagicToken, bool, error) {
	t, ok, err := s.SQLiteStore.UseMagicToken(ctx, tokenHash, now)
	s.fire()
	return t, ok, err
}

func (s *n5MagicHooks) UseMagicTokenWithEpoch(ctx context.Context, tokenHash string, now int64) (MagicToken, int64, bool, error) {
	t, e, ok, err := s.SQLiteStore.UseMagicTokenWithEpoch(ctx, tokenHash, now)
	s.fire()
	return t, e, ok, err
}

func n5MagicLink(t *testing.T, store *SQLiteStore, email string) string {
	t.Helper()
	raw := "n5-magic2-" + email
	if err := store.CreateMagicToken(context.Background(), MagicToken{TokenHash: authx.HashToken(raw), Email: email,
		CreatedAt: n5Now, ExpiresAt: n5Now + 600}); err != nil {
		t.Fatal(err)
	}
	return raw
}

// Codex r2: a magic link spent in G1, paused right after the spend (before any
// later epoch read) while the owner recovers, resets the password and deletes
// again into G2, mints nothing for G2.
func TestReactivateN0930MagicLinkPausedAfterConsumptionMintsNothing(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "magicspent@example.com")
	if err := store.SetPassword(ctx, u.ID, "old-hash"); err != nil {
		t.Fatal(err)
	}
	g1 := n5Delete(t, store, u.ID, "g1", n5Now-1000)
	raw := n5MagicLink(t, store, u.Email)
	var g2 string
	hs := &n5MagicHooks{SQLiteStore: store}
	hs.afterConsume = func() { g2 = n5OwnerRecoversAndRedeletes(t, store, u.ID, true) }
	svc.store = hs
	_, err := svc.VerifyMagicLink(ctx, raw)
	if hs.afterConsume != nil {
		t.Fatal("the magic login never reached the interleaving point")
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) || err == nil {
		t.Fatalf("a magic link spent in G1 must mint nothing for G2, got %v", err)
	}
	if n := n5IssuedTokens(t, store, u.ID, g1, g2); n != 0 {
		t.Fatalf("no reactivate token may be minted, found %d", n)
	}
}

// The same pause on an active account: a password reset committing after the
// spend leaves the magic login without a session (session fence at the
// consumption epoch).
func TestReactivateN0930MagicLinkSessionFencedAtConsumptionEpoch(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "magicsess@example.com")
	if err := store.SetPassword(ctx, u.ID, "old-hash"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	raw := n5MagicLink(t, store, u.Email)
	hs := &n5MagicHooks{SQLiteStore: store}
	hs.afterConsume = func() {
		resetHash := authx.HashToken("n5-mreset-" + u.ID)
		if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: resetHash, UserID: u.ID, Email: u.Email,
			Purpose: "reset", CreatedAt: n5Now, ExpiresAt: n5Now + 3600}); err != nil {
			t.Fatal(err)
		}
		if outcome, _, _, err := store.ResetPasswordWithToken(ctx, resetHash, n5Now, "owner-new-hash"); err != nil || outcome != ResetApplied {
			t.Fatalf("owner reset: outcome=%v err=%v", outcome, err)
		}
	}
	svc.store = hs
	if _, err := svc.VerifyMagicLink(ctx, raw); err == nil {
		t.Fatal("a magic link spent before a password reset must not sign in after it")
	}
	if hs.afterConsume != nil {
		t.Fatal("the magic login never reached the interleaving point")
	}
	if n := liveSessions(t, store, u.ID); n != 0 {
		t.Fatalf("no session may survive the reset, found %d", n)
	}
}

// A magic link for an address with no account still creates the account and
// signs in (epoch 0, the new account's starting value).
func TestReactivateN0930MagicLinkNewAccountStillSignsIn(t *testing.T) {
	svc, store := n5Service(t)
	raw := n5MagicLink(t, store, "fresh@example.com")
	sess, err := svc.VerifyMagicLink(context.Background(), raw)
	if err != nil || sess.UserID == "" {
		t.Fatalf("a first magic login must create the account and sign in: %v", err)
	}
	if n := liveSessions(t, store, sess.UserID); n != 1 {
		t.Fatalf("want one session, got %d", n)
	}
}

// n5MagicVerifyHooks fires once at the magic login's password-drop decision:
// after the verification-state read of the legacy two-step path, or right
// before the guarded VerifyEmailForEmailProof transaction.
type n5MagicVerifyHooks struct {
	*SQLiteStore
	beforePasswordWrite func()
}

func (s *n5MagicVerifyHooks) fire() {
	if s.beforePasswordWrite != nil {
		hook := s.beforePasswordWrite
		s.beforePasswordWrite = nil
		hook()
	}
}

func (s *n5MagicVerifyHooks) EmailVerified(ctx context.Context, userID string) (bool, error) {
	v, err := s.SQLiteStore.EmailVerified(ctx, userID)
	s.fire()
	return v, err
}

func (s *n5MagicVerifyHooks) VerifyEmailForEmailProof(ctx context.Context, userID, email string, epoch int64) (bool, error) {
	s.fire()
	return s.SQLiteStore.VerifyEmailForEmailProof(ctx, userID, email, epoch)
}

// A password reset committing between the magic link's spend and its
// password drop survives: the stale login neither clears nor overwrites the
// reset password, and gets no session.
func TestReactivateN0930MagicLinkResetBeforeClearSurvives(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "magicplant@example.com")
	if err := store.SetPassword(ctx, u.ID, "planted-hash"); err != nil {
		t.Fatal(err)
	}
	raw := n5MagicLink(t, store, u.Email)
	resetHash := authx.HashToken("n5-mplant-" + u.ID)
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: resetHash, UserID: u.ID, Email: u.Email,
		Purpose: "reset", CreatedAt: n5Now, ExpiresAt: n5Now + 3600}); err != nil {
		t.Fatal(err)
	}
	hs := &n5MagicVerifyHooks{SQLiteStore: store}
	hs.beforePasswordWrite = func() {
		if outcome, _, _, err := store.ResetPasswordWithToken(ctx, resetHash, n5Now, "owner-reset-hash"); err != nil || outcome != ResetApplied {
			t.Fatalf("owner reset: outcome=%v err=%v", outcome, err)
		}
	}
	svc.store = hs
	_, err := svc.VerifyMagicLink(ctx, raw)
	if hs.beforePasswordWrite != nil {
		t.Fatal("the magic login never reached the password-drop decision")
	}
	if got := passwordHash(t, store, u.ID); got != "owner-reset-hash" {
		t.Fatalf("a completed password reset must never be overwritten, password is now %q", got)
	}
	if err == nil || liveSessions(t, store, u.ID) != 0 {
		t.Fatalf("the stale magic login must get no session: err=%v", err)
	}
}

// Without interference the magic login still applies the pre-hijack defense:
// the planted password is dropped and the address verified, and it signs in.
func TestReactivateN0930MagicLinkDropsPlantedPassword(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "magicdrop@example.com")
	if err := store.SetPassword(ctx, u.ID, "planted-hash"); err != nil {
		t.Fatal(err)
	}
	sess, err := svc.VerifyMagicLink(ctx, n5MagicLink(t, store, u.Email))
	if err != nil || sess.UserID != u.ID {
		t.Fatalf("magic login must sign in: %v", err)
	}
	if passwordHash(t, store, u.ID) != "" || !mustVerified(t, store, u.ID) {
		t.Fatal("the planted password must be dropped and the address verified")
	}
}

// A password change that leaves the address unverified (epoch bump only)
// between the spend and the drop is not overwritten either: the guarded
// transaction requires the epoch captured at the spend.
func TestReactivateN0930MagicLinkPasswordChangeBeforeClearSurvives(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "magicchg@example.com")
	if err := store.SetPassword(ctx, u.ID, "planted-hash"); err != nil {
		t.Fatal(err)
	}
	raw := n5MagicLink(t, store, u.Email)
	hs := &n5MagicVerifyHooks{SQLiteStore: store}
	hs.beforePasswordWrite = func() {
		epoch, err := store.CredentialEpoch(ctx, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.ChangePasswordAndRevokeSessions(ctx, u.ID, "changed-hash", "", "", epoch); err != nil {
			t.Fatalf("change password: %v", err)
		}
	}
	svc.store = hs
	_, err := svc.VerifyMagicLink(ctx, raw)
	if hs.beforePasswordWrite != nil {
		t.Fatal("the magic login never reached the password-drop decision")
	}
	if got := passwordHash(t, store, u.ID); got != "changed-hash" {
		t.Fatalf("a concurrent password change must not be overwritten, password is now %q", got)
	}
	if mustVerified(t, store, u.ID) {
		t.Fatal("a stale magic login must not verify the address")
	}
	if err == nil || liveSessions(t, store, u.ID) != 0 {
		t.Fatalf("the stale magic login must get no session: err=%v", err)
	}
}
