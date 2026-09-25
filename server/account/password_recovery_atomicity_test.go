package account

// Password reset and password change are all-or-nothing.
//
// Both used to be a sequence of independent statements. Interrupted after the
// password write — by a database error, a cancelled request context or a restart
// — they left the new password live and EVERY older session valid, including the
// one an attacker holds, while telling the caller the operation had failed.
// Signing in with the new password revokes nothing, so that state did not heal.
//
// Faults are injected at STATEMENT level with SQLite triggers on the real store,
// so the code under test is the production code with no test hook in it.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/relayium/relayium/authx"
)

const (
	failPasswordWrite = `CREATE TRIGGER inject_fault BEFORE UPDATE OF password_hash ON users BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
	failVerifiedWrite = `CREATE TRIGGER inject_fault BEFORE UPDATE OF email_verified ON users BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
	failSessionRevoke = `CREATE TRIGGER inject_fault BEFORE UPDATE OF revoked ON sessions BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
	failIdentityLink  = `CREATE TRIGGER inject_fault BEFORE INSERT ON identities BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
)

func sqliteOf(t *testing.T, svc *Service) *SQLiteStore {
	t.Helper()
	st, ok := svc.store.(*SQLiteStore)
	if !ok {
		t.Fatalf("test needs the real SQLite store, got %T", svc.store)
	}
	return st
}

func armFault(t *testing.T, svc *Service, trigger string) {
	t.Helper()
	if _, err := sqliteOf(t, svc).db.Exec(trigger); err != nil {
		t.Fatal(err)
	}
}

func disarmFault(t *testing.T, svc *Service) {
	t.Helper()
	if _, err := sqliteOf(t, svc).db.Exec(`DROP TRIGGER IF EXISTS inject_fault`); err != nil {
		t.Fatal(err)
	}
}

// victim registers and verifies a password user and returns two live sessions.
// `stolen` stands for the session an attacker holds — the reason a user resets.
func victim(t *testing.T, svc *Service, m *captureMailer) (u User, mine, stolen Session) {
	t.Helper()
	ctx := context.Background()
	u, err := svc.Register(ctx, "victim@example.com", "old-password-1", "Victim")
	if err != nil {
		t.Fatal(err)
	}
	if mine, err = svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), "old-password-1"); err != nil {
		t.Fatal(err)
	}
	if stolen, err = svc.Login(ctx, "victim@example.com", "old-password-1"); err != nil {
		t.Fatal(err)
	}
	return u, mine, stolen
}

func live(t *testing.T, svc *Service, s Session) bool {
	t.Helper()
	_, ok, err := svc.ValidateSession(context.Background(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func canLogin(svc *Service, password string) bool {
	_, err := svc.Login(context.Background(), "victim@example.com", password)
	return err == nil
}

func resetLink(t *testing.T, svc *Service, m *captureMailer) string {
	t.Helper()
	if err := svc.RequestPasswordReset(context.Background(), "victim@example.com"); err != nil {
		t.Fatal(err)
	}
	return tokenFromLink(t, m.reset)
}

func TestResetPasswordInterruptedAtAnyStatementAppliesNothing(t *testing.T) {
	for name, trigger := range map[string]string{
		"password write":       failPasswordWrite,
		"email-verified write": failVerifiedWrite,
		"session revocation":   failSessionRevoke,
	} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			svc, m := newTestService(t)
			_, mine, stolen := victim(t, svc, m)
			raw := resetLink(t, svc, m)

			armFault(t, svc, trigger)
			_, err := svc.ResetPassword(ctx, raw, "new-password-2")
			disarmFault(t, svc)
			if err == nil || !strings.Contains(err.Error(), "injected fault") {
				t.Fatalf("the injected fault must surface to the caller, got %v", err)
			}

			// NOTHING was applied: the caller was told it failed, so it failed.
			if !live(t, svc, stolen) || !live(t, svc, mine) {
				t.Fatal("a failed reset must not have revoked sessions on its own")
			}
			if canLogin(svc, "new-password-2") {
				t.Fatal("a failed reset left the NEW password live while older sessions stayed valid")
			}
			if !canLogin(svc, "old-password-1") {
				t.Fatal("a failed reset destroyed the old password")
			}

			// …and the link was not spent, so the retry the user is invited to make works,
			// and this time EVERYTHING is applied.
			sess, err := svc.ResetPassword(ctx, raw, "new-password-2")
			if err != nil {
				t.Fatalf("the same link must still work after a failed attempt: %v", err)
			}
			if live(t, svc, stolen) || live(t, svc, mine) {
				t.Fatal("a completed reset must revoke every older session")
			}
			if !live(t, svc, sess) || !canLogin(svc, "new-password-2") || canLogin(svc, "old-password-1") {
				t.Fatal("a completed reset must leave exactly the new password and the new session")
			}
		})
	}
}

// The handlers pass r.Context(), which a disconnecting client cancels. The
// unfixed service ran its statements one by one on that context, so a cancel
// after the password write stranded the account exactly like a database fault.
// Inside one transaction a cancelled context can only roll back; what a test
// can pin without a hook in production code is the boundary case — a request
// that is already gone applies nothing and leaves the link usable.
func TestResetPasswordOnACancelledRequestAppliesNothing(t *testing.T) {
	svc, m := newTestService(t)
	_, _, stolen := victim(t, svc, m)
	raw := resetLink(t, svc, m)

	gone, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := svc.ResetPassword(gone, raw, "new-password-2"); err == nil {
		t.Fatal("a reset on a cancelled request reported success")
	}
	if canLogin(svc, "new-password-2") || !canLogin(svc, "old-password-1") || !live(t, svc, stolen) {
		t.Fatal("a reset on a cancelled request changed the account")
	}
	if _, err := svc.ResetPassword(context.Background(), raw, "new-password-2"); err != nil {
		t.Fatalf("the link must still work after the cancelled attempt: %v", err)
	}
	if live(t, svc, stolen) {
		t.Fatal("the completed reset must revoke the older session")
	}
}

// The service checks for a pending deletion before it hashes. An account that
// becomes frozen between that check and the transaction must still not have its
// password replaced, and the link must come back UNSPENT so the frozen-account
// path can spend it and offer reactivation.
func TestResetTransactionRefusesAnAccountFrozenAfterTheCheck(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	raw := resetLink(t, svc, m)
	tokenHash := authx.HashToken(raw)
	st := sqliteOf(t, svc)
	if err := st.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatal(err)
	}

	now := svc.now().Unix()
	outcome, userID, _, err := st.ResetPasswordWithToken(ctx, tokenHash, now, "replacement-hash-that-must-not-land")
	if err != nil {
		t.Fatal(err)
	}
	if outcome != ResetAccountFrozen || userID != u.ID {
		t.Fatalf("outcome=%v user=%q, want ResetAccountFrozen for %q", outcome, userID, u.ID)
	}
	if _, ok, err := st.PeekEmailToken(ctx, tokenHash, "reset", now); err != nil || !ok {
		t.Fatalf("the link must be unspent after a refused transaction (ok=%v err=%v)", ok, err)
	}
	if _, hash, _, _ := st.GetCredentials(ctx, "victim@example.com"); hash == "replacement-hash-that-must-not-land" {
		t.Fatal("a frozen account's password was replaced")
	}
	var revoked int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ? AND revoked <> 0`, u.ID).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked != 0 {
		t.Fatalf("a refused transaction revoked %d session(s)", revoked)
	}

	// Through the service the same state ends where a frozen account always
	// ends: link spent, reactivation offered, no session.
	_, err = svc.ResetPassword(ctx, raw, "new-password-2")
	var pending *PendingDeletionError
	if !errors.As(err, &pending) || pending.ReactivateToken == "" {
		t.Fatalf("want a pending-deletion answer with a reactivation token, got %v", err)
	}
	if _, ok, _ := st.PeekEmailToken(ctx, tokenHash, "reset", now); ok {
		t.Fatal("the frozen-account path must spend the link, as it always has")
	}
}

func TestChangePasswordInterruptedAtRevocationAppliesNothing(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, mine, stolen := victim(t, svc, m)

	armFault(t, svc, failSessionRevoke)
	err := svc.ChangePassword(ctx, u, mine.ID, "old-password-1", "new-password-2")
	disarmFault(t, svc)
	if err == nil || !strings.Contains(err.Error(), "injected fault") {
		t.Fatalf("the injected fault must surface to the caller, got %v", err)
	}
	if canLogin(svc, "new-password-2") {
		t.Fatal("a failed change left the NEW password live while other sessions stayed valid")
	}
	// The retry the user naturally makes — old password as the current one — works.
	if err := svc.ChangePassword(ctx, u, mine.ID, "old-password-1", "new-password-2"); err != nil {
		t.Fatalf("retrying with the old password must work after a failed change: %v", err)
	}
	if live(t, svc, stolen) {
		t.Fatal("a completed change must revoke every other session")
	}
	if !live(t, svc, mine) {
		t.Fatal("a completed change must keep the session that made it")
	}
}

func TestFirstPasswordInterruptedAtIdentityLinkAppliesNothing(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestService(t)
	st := sqliteOf(t, svc)
	u, err := st.UpsertUserByEmail(ctx, "victim@example.com", "Victim")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	mine, err := svc.IssueSession(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	other, err := svc.IssueSession(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}

	armFault(t, svc, failIdentityLink)
	err = svc.ChangePassword(ctx, u, mine.ID, "", "first-password-1")
	disarmFault(t, svc)
	if err == nil || !strings.Contains(err.Error(), "injected fault") {
		t.Fatalf("the injected fault must surface to the caller, got %v", err)
	}
	if canLogin(svc, "first-password-1") {
		t.Fatal("a failed first-password set left the password live")
	}
	// Still a first-time set on retry: no current password is asked for.
	if err := svc.ChangePassword(ctx, u, mine.ID, "", "first-password-1"); err != nil {
		t.Fatalf("retrying the first-password set must work: %v", err)
	}
	providers, err := st.ListIdentityProviders(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !canLogin(svc, "first-password-1") || len(providers) != 1 || providers[0] != "password" {
		t.Fatalf("completed first-password set: login=%v providers=%v", canLogin(svc, "first-password-1"), providers)
	}
	if live(t, svc, other) || !live(t, svc, mine) {
		t.Fatal("a completed first-password set revokes the other sessions and keeps the current one")
	}
}

func TestResetTokenIsSingleUseUnderConcurrency(t *testing.T) {
	svc, m := newTestService(t)
	victim(t, svc, m)
	raw := resetLink(t, svc, m)

	const n = 6
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = svc.ResetPassword(context.Background(), raw, "new-password-2")
		}(i)
	}
	wg.Wait()
	won := 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrInvalidToken):
		default:
			t.Fatalf("a losing reset must see ErrInvalidToken, got %v", err)
		}
	}
	if won != 1 {
		t.Fatalf("%d of %d concurrent resets with one link succeeded; want exactly 1", won, n)
	}
}

func TestResetPasswordRejectsABogusOrSpentTokenWithoutTouchingTheAccount(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	_, _, stolen := victim(t, svc, m)
	if _, err := svc.ResetPassword(ctx, "not-a-token", "new-password-2"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("bogus token: got %v", err)
	}
	raw := resetLink(t, svc, m)
	if _, err := svc.ResetPassword(ctx, raw, "new-password-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ResetPassword(ctx, raw, "new-password-3"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("spent token: got %v", err)
	}
	if canLogin(svc, "new-password-3") || live(t, svc, stolen) {
		t.Fatal("a spent link changed the account")
	}
}
