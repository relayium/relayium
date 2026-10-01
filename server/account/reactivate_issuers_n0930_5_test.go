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
