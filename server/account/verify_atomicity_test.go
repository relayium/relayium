package account

// Email verification is all-or-nothing (A29 R1), and a mistyped password does
// not silently drop the registration password (A29 R1b).
//
// VerifyEmail used to spend the link first and then run the password drop, the
// verified flag and the session insert as separate statements. An interruption
// after the spend — a database error, a real SQLITE_BUSY from another writer, a
// cancelled request — stranded the account unverified, passwordless and with
// its link spent; resend and reset both need a password, so with magic links off
// nothing could recover it. A mistyped password was treated like the explicit
// "continue without a password" choice and dropped the password the user chose.
//
// Faults are injected at STATEMENT level with SQLite triggers on the real,
// file-backed store, so the code under test is the production code with no test
// hook in it. The BUSY case holds the write lock from a second connection, as
// another process sharing the file would.

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

const (
	vEmail    = "verify-atomic@example.com"
	vPassword = "chosen-password-1"

	failTokenSpend     = `CREATE TRIGGER inject_fault BEFORE UPDATE OF used_at ON email_tokens BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
	failPasswordDrop   = `CREATE TRIGGER inject_fault BEFORE UPDATE OF password_hash ON users BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
	failIdentityDelete = `CREATE TRIGGER inject_fault BEFORE DELETE ON identities BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
	failSessionInsert  = `CREATE TRIGGER inject_fault BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected fault'); END`
)

func newFileTestService(t *testing.T) (*Service, *captureMailer, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "verify.db")
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	m := &captureMailer{}
	svc := NewService(st, m, Config{
		BaseURL:    "https://relayium.com",
		SessionTTL: time.Hour, MagicTTL: 15 * time.Minute, VerifyTTL: 24 * time.Hour, ResetTTL: time.Hour,
	})
	return svc, m, path
}

// registered creates an unverified password account and returns its raw verify token.
func registered(t *testing.T, svc *Service, m *captureMailer) (User, string) {
	t.Helper()
	u, err := svc.Register(context.Background(), vEmail, vPassword, "V")
	if err != nil {
		t.Fatal(err)
	}
	return u, tokenFromLink(t, m.verify)
}

type verifyState struct {
	Verified    bool
	HasPassword bool
	Identities  string
	Sessions    int
	LinkUnspent bool
}

func readVerifyState(t *testing.T, svc *Service, userID, rawToken string) verifyState {
	t.Helper()
	ctx := context.Background()
	st := sqliteOf(t, svc)
	var s verifyState
	var hash sql.NullString
	if err := st.db.QueryRow(`SELECT email_verified, password_hash FROM users WHERE id = ?`, userID).
		Scan(&s.Verified, &hash); err != nil {
		t.Fatal(err)
	}
	s.HasPassword = hash.Valid && hash.String != ""
	rows, err := st.db.Query(`SELECT provider FROM identities WHERE user_id = ? ORDER BY provider`, userID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, p)
	}
	rows.Close()
	s.Identities = strings.Join(ids, ",")
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ?`, userID).Scan(&s.Sessions); err != nil {
		t.Fatal(err)
	}
	_, s.LinkUnspent, err = st.PeekEmailToken(ctx, authx.HashToken(rawToken), "verify", svc.now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func passwordLoginWorks(svc *Service) bool {
	_, err := svc.Login(context.Background(), vEmail, vPassword)
	return err == nil
}

func TestVerifyEmailInterruptedAtAnyStatementAppliesNothing(t *testing.T) {
	cases := []struct {
		name     string
		password string // "" = the explicit "continue without a password" choice
		trigger  string
	}{
		{"no password / token spend", "", failTokenSpend},
		{"no password / password drop", "", failPasswordDrop},
		{"no password / password identity delete", "", failIdentityDelete},
		{"no password / email-verified write", "", failVerifiedWrite},
		{"no password / session insert", "", failSessionInsert},
		{"confirmed password / email-verified write", vPassword, failVerifiedWrite},
		{"confirmed password / session insert", vPassword, failSessionInsert},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			svc, m, _ := newFileTestService(t)
			u, raw := registered(t, svc, m)
			before := readVerifyState(t, svc, u.ID, raw)
			if before.Verified || !before.HasPassword || !before.LinkUnspent || before.Sessions != 0 {
				t.Fatalf("unexpected starting state %+v", before)
			}

			armFault(t, svc, tc.trigger)
			_, err := svc.VerifyEmail(ctx, raw, tc.password)
			disarmFault(t, svc)
			if err == nil || !strings.Contains(err.Error(), "injected fault") {
				t.Fatalf("the injected fault must surface to the caller, got %v", err)
			}

			// NOTHING was applied: still unverified, the password and its
			// identity intact, no session, and the link NOT spent.
			if after := readVerifyState(t, svc, u.ID, raw); after != before {
				t.Fatalf("an interrupted verification changed state:\n before %+v\n after  %+v", before, after)
			}

			// The same link works on retry, and this time everything is applied.
			sess, err := svc.VerifyEmail(ctx, raw, tc.password)
			if err != nil {
				t.Fatalf("the same link must still work after a failed attempt: %v", err)
			}
			if !live(t, svc, sess) {
				t.Fatal("the retry must issue a live session")
			}
			final := readVerifyState(t, svc, u.ID, raw)
			if !final.Verified || final.LinkUnspent || final.Sessions != 1 {
				t.Fatalf("the retry must verify, spend the link and leave one session: %+v", final)
			}
			if wantPw := tc.password != ""; final.HasPassword != wantPw || passwordLoginWorks(svc) != wantPw {
				t.Fatalf("password kept=%v login=%v, want %v", final.HasPassword, passwordLoginWorks(svc), wantPw)
			}
			if tc.password == "" && strings.Contains(final.Identities, "password") {
				t.Fatalf("a dropped password must take its identity with it: %q", final.Identities)
			}
		})
	}
}

func TestVerifyEmailOnACancelledRequestAppliesNothing(t *testing.T) {
	svc, m, _ := newFileTestService(t)
	u, raw := registered(t, svc, m)
	before := readVerifyState(t, svc, u.ID, raw)

	gone, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := svc.VerifyEmail(gone, raw, ""); err == nil {
		t.Fatal("a verification on a cancelled request reported success")
	}
	if after := readVerifyState(t, svc, u.ID, raw); after != before {
		t.Fatalf("a cancelled verification changed state:\n before %+v\n after  %+v", before, after)
	}
	if _, err := svc.VerifyEmail(context.Background(), raw, ""); err != nil {
		t.Fatalf("the link must still work after the cancelled attempt: %v", err)
	}
}

// verifyLocker holds the database write lock from a second connection.
type verifyLocker struct {
	db   *sql.DB
	conn *sql.Conn
}

func newVerifyLocker(t *testing.T, path string) *verifyLocker {
	t.Helper()
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return &verifyLocker{db: db}
}

func (l *verifyLocker) grab(t *testing.T) {
	t.Helper()
	c, err := l.db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("locker: %v", err)
	}
	l.conn = c
}

func (l *verifyLocker) release() {
	if l.conn != nil {
		_, _ = l.conn.ExecContext(context.Background(), "ROLLBACK")
		l.conn.Close()
		l.conn = nil
	}
}

// A real SQLITE_BUSY: another connection holds the write lock from before the
// call for longer than the store's busy_timeout. The verification must fail as
// a whole and the retry after release must succeed.
func TestVerifyEmailUnderRealSQLiteBusyAppliesNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out the 5 s busy_timeout")
	}
	for _, pw := range []string{"", vPassword} {
		t.Run("password="+pw, func(t *testing.T) {
			svc, m, path := newFileTestService(t)
			u, raw := registered(t, svc, m)
			before := readVerifyState(t, svc, u.ID, raw)
			l := newVerifyLocker(t, path)

			l.grab(t)
			_, err := svc.VerifyEmail(context.Background(), raw, pw)
			l.release()
			if err == nil || !strings.Contains(err.Error(), "SQLITE_BUSY") {
				t.Fatalf("want a real SQLITE_BUSY, got %v", err)
			}
			if after := readVerifyState(t, svc, u.ID, raw); after != before {
				t.Fatalf("a BUSY verification changed state:\n before %+v\n after  %+v", before, after)
			}
			if _, err := svc.VerifyEmail(context.Background(), raw, pw); err != nil {
				t.Fatalf("the retry after the lock is released must succeed: %v", err)
			}
		})
	}
}

// The lock is taken by another writer in the middle of the unfixed sequence:
// after the service has decided to drop the password and, in the old code,
// had already spent the link, dropped the password and its identity — right
// before the verified flag. This is the exact A29 V1 reproduction (real BUSY
// at SetEmailVerified). The fixed code never calls SetEmailVerified; the same
// hook fires on entry to its single transaction instead.
type busyAtFirstWrite struct {
	Store
	grab func()
	once sync.Once
}

func (b *busyAtFirstWrite) fire() { b.once.Do(b.grab) }

func (b *busyAtFirstWrite) SetEmailVerified(ctx context.Context, userID string) error {
	b.fire()
	return b.Store.SetEmailVerified(ctx, userID)
}

func (b *busyAtFirstWrite) VerifyEmailWithToken(ctx context.Context, h string, now int64, drop bool, sess Session) (VerifyOutcome, string, error) {
	b.fire()
	return b.Store.VerifyEmailWithToken(ctx, h, now, drop, sess)
}

func TestVerifyEmailBusyAfterTheDecisionDoesNotStrandTheAccount(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out the 5 s busy_timeout")
	}
	svc, m, path := newFileTestService(t)
	u, raw := registered(t, svc, m)
	before := readVerifyState(t, svc, u.ID, raw)
	l := newVerifyLocker(t, path)
	real := svc.store
	svc.store = &busyAtFirstWrite{Store: real, grab: func() { l.grab(t) }}

	_, err := svc.VerifyEmail(context.Background(), raw, "")
	l.release()
	svc.store = real
	if err == nil || !strings.Contains(err.Error(), "SQLITE_BUSY") {
		t.Fatalf("want a real SQLITE_BUSY, got %v", err)
	}
	after := readVerifyState(t, svc, u.ID, raw)
	if !after.Verified && !after.HasPassword && !after.LinkUnspent {
		t.Fatalf("STRANDED: unverified, passwordless and link spent: %+v", after)
	}
	if after != before {
		t.Fatalf("a BUSY verification changed state:\n before %+v\n after  %+v", before, after)
	}
	if _, err := svc.VerifyEmail(context.Background(), raw, ""); err != nil {
		t.Fatalf("the retry after the lock is released must succeed: %v", err)
	}
}

// R1b: a mistyped password is refused, changes nothing and leaves the link
// usable; only the explicit empty-password choice drops the password.
func TestVerifyEmailMismatchedPasswordChangesNothing(t *testing.T) {
	ctx := context.Background()
	svc, m, _ := newFileTestService(t)
	u, raw := registered(t, svc, m)
	before := readVerifyState(t, svc, u.ID, raw)

	_, err := svc.VerifyEmail(ctx, raw, vPassword+"x")
	if !errors.Is(err, ErrVerifyPasswordMismatch) {
		t.Fatalf("a mistyped password must be refused with ErrVerifyPasswordMismatch, got %v", err)
	}
	if after := readVerifyState(t, svc, u.ID, raw); after != before {
		t.Fatalf("a mismatched password changed state:\n before %+v\n after  %+v", before, after)
	}

	// The same link then verifies with the right password, which is kept.
	if _, err := svc.VerifyEmail(ctx, raw, vPassword); err != nil {
		t.Fatalf("the same link must verify after a mismatch: %v", err)
	}
	if s := readVerifyState(t, svc, u.ID, raw); !s.Verified || !s.HasPassword || !passwordLoginWorks(svc) {
		t.Fatalf("the confirmed password must be kept: %+v", s)
	}
}

func TestVerifyEmailExplicitNoPasswordStillDropsAfterAMismatch(t *testing.T) {
	ctx := context.Background()
	svc, m, _ := newFileTestService(t)
	u, raw := registered(t, svc, m)
	if _, err := svc.VerifyEmail(ctx, raw, "planted-by-someone-else"); !errors.Is(err, ErrVerifyPasswordMismatch) {
		t.Fatalf("want mismatch, got %v", err)
	}
	sess, err := svc.VerifyEmail(ctx, raw, "")
	if err != nil {
		t.Fatal(err)
	}
	s := readVerifyState(t, svc, u.ID, raw)
	if !s.Verified || s.HasPassword || strings.Contains(s.Identities, "password") || passwordLoginWorks(svc) {
		t.Fatalf("the explicit choice must drop the registration password: %+v", s)
	}
	if !live(t, svc, sess) {
		t.Fatal("the explicit choice must sign the user in")
	}
}

// A mismatch no longer spends the link, so repeated guesses are capped: at the
// pwLogins threshold the link is spent, with the account (password included)
// left untouched so resend and reset keep working.
func TestVerifyEmailMismatchesAreCappedPerLink(t *testing.T) {
	ctx := context.Background()
	svc, m, _ := newFileTestService(t)
	u, raw := registered(t, svc, m)
	var err error
	for i := 1; i < adminLoginMaxFails; i++ {
		if _, err = svc.VerifyEmail(ctx, raw, "guess"); !errors.Is(err, ErrVerifyPasswordMismatch) {
			t.Fatalf("attempt %d: want mismatch, got %v", i, err)
		}
	}
	if _, err = svc.VerifyEmail(ctx, raw, "guess"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("the attempt at the threshold must spend the link, got %v", err)
	}
	s := readVerifyState(t, svc, u.ID, raw)
	if s.LinkUnspent || s.Verified || !s.HasPassword || s.Sessions != 0 {
		t.Fatalf("capped link: want spent link, untouched unverified account with its password: %+v", s)
	}
	if _, err := svc.VerifyEmail(ctx, raw, vPassword); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("a spent link must not verify even with the right password, got %v", err)
	}
	// Recovery: a fresh link (what resend sends, since the password is intact) works.
	if err := svc.SendVerifyEmail(ctx, u); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), vPassword); err != nil {
		t.Fatalf("a fresh link must verify: %v", err)
	}
}

// An already-verified account keeps its password whatever a stale verify link
// is submitted with (the pre-R1b behaviour for verified accounts).
func TestVerifyEmailStaleLinkOnVerifiedAccountKeepsPassword(t *testing.T) {
	ctx := context.Background()
	svc, m, _ := newFileTestService(t)
	u, first := registered(t, svc, m)
	if _, err := svc.VerifyEmail(ctx, first, vPassword); err != nil {
		t.Fatal(err)
	}
	for _, pw := range []string{"", "wrong"} {
		if err := svc.SendVerifyEmail(ctx, u); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), pw); err != nil {
			t.Fatalf("pw=%q: %v", pw, err)
		}
		if !passwordLoginWorks(svc) {
			t.Fatalf("pw=%q: a verified account lost its password", pw)
		}
	}
}

// Adversarial: many concurrent submissions of one link yield exactly one
// success and exactly one session.
func TestVerifyEmailConcurrentDoubleSubmitSucceedsOnce(t *testing.T) {
	for _, pw := range []string{"", vPassword} {
		t.Run("password="+pw, func(t *testing.T) {
			svc, m, _ := newFileTestService(t)
			u, raw := registered(t, svc, m)
			const n = 8
			var wg sync.WaitGroup
			errs := make([]error, n)
			start := make(chan struct{})
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					_, errs[i] = svc.VerifyEmail(context.Background(), raw, pw)
				}(i)
			}
			close(start)
			wg.Wait()
			ok := 0
			for _, err := range errs {
				switch {
				case err == nil:
					ok++
				case errors.Is(err, ErrInvalidToken):
				default:
					t.Fatalf("unexpected error: %v", err)
				}
			}
			if ok != 1 {
				t.Fatalf("want exactly one success, got %d", ok)
			}
			if s := readVerifyState(t, svc, u.ID, raw); s.Sessions != 1 || !s.Verified || s.LinkUnspent {
				t.Fatalf("want one session on a verified account with a spent link: %+v", s)
			}
		})
	}
}

// The service checks for a pending deletion before the transaction. An account
// frozen between that check and the transaction must roll back with the link
// unspent, so the frozen-account path can spend it and offer reactivation.
func TestVerifyTransactionRefusesAnAccountFrozenAfterTheCheck(t *testing.T) {
	ctx := context.Background()
	svc, m, _ := newFileTestService(t)
	u, raw := registered(t, svc, m)
	st := sqliteOf(t, svc)
	if err := st.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatal(err)
	}
	before := readVerifyState(t, svc, u.ID, raw)
	sess := Session{ID: authx.RandToken(), UserID: u.ID, CreatedAt: 1, ExpiresAt: svc.now().Add(time.Hour).Unix()}
	outcome, userID, err := st.VerifyEmailWithToken(ctx, authx.HashToken(raw), svc.now().Unix(), true, sess)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != VerifyAccountFrozen || userID != u.ID {
		t.Fatalf("outcome=%v user=%q, want VerifyAccountFrozen for %q", outcome, userID, u.ID)
	}
	if after := readVerifyState(t, svc, u.ID, raw); after != before {
		t.Fatalf("a refused transaction changed state:\n before %+v\n after  %+v", before, after)
	}
	// And through the service: the frozen path answers with reactivation.
	var pd *PendingDeletionError
	if _, err := svc.VerifyEmail(ctx, raw, ""); !errors.As(err, &pd) {
		t.Fatalf("want PendingDeletionError, got %v", err)
	}
}
