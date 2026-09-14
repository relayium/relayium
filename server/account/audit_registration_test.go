package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// AUD-07 regression suite.
//
// Registration used to commit the users row BEFORE hashing the password, so an
// input bcrypt cannot hash (>72 bytes — bcrypt's hard input limit, counted in
// BYTES, which a short multibyte passphrase also exceeds) left behind a user
// row that owned the address and its canonical form but had no credential:
// the retry with a good password answered "email already registered", and
// password reset was a silent no-op because the account had no password. These
// tests assert the INTENDED behaviour (nothing durable is created, and the
// retry succeeds), so they are red on the pre-fix code.

func newRegistrationFixture(t *testing.T) (*Service, *SQLiteStore, *captureMailer) {
	t.Helper()
	st := newTestStore(t)
	m := &captureMailer{}
	svc := NewService(st, m, Config{
		BaseURL: "https://relayium.com", SessionTTL: time.Hour,
		MagicTTL: 15 * time.Minute, VerifyTTL: 24 * time.Hour, ResetTTL: time.Hour,
	})
	return svc, st, m
}

// assertNoAccount fails when ANY durable trace of a registration exists for
// email: the users row, its canonical-email reservation, the credential, or
// the "password" identity. All four together are what "the address is still
// free" means.
func assertNoAccount(t *testing.T, st *SQLiteStore, email, why string) {
	t.Helper()
	ctx := context.Background()
	if u, ok, err := st.UserByCanonicalEmail(ctx, canonicalEmail(email)); err != nil {
		t.Fatalf("%s: canonical lookup: %v", why, err)
	} else if ok {
		t.Errorf("%s: canonical email %q is reserved by user %q", why, canonicalEmail(email), u.ID)
	}
	if _, _, ok, err := st.GetCredentials(ctx, email); err != nil {
		t.Fatalf("%s: credentials lookup: %v", why, err)
	} else if ok {
		t.Errorf("%s: a credential row exists for %q", why, email)
	}
	if u, ok, err := st.GetUserByIdentity(ctx, "password", email); err != nil && !errors.Is(err, ErrNotFound) {
		t.Fatalf("%s: identity lookup: %v", why, err)
	} else if ok {
		t.Errorf("%s: a password identity exists for %q (user %q)", why, email, u.ID)
	}
}

// assertNoLiteralAccount is the narrower form used for the LOSER of a canonical
// collision: its canonical form is legitimately reserved by the winner, so only
// the loser's own literal address must be absent.
func assertNoLiteralAccount(t *testing.T, st *SQLiteStore, email, why string) {
	t.Helper()
	ctx := context.Background()
	var rows int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE email = ?`, email).Scan(&rows); err != nil {
		t.Fatalf("%s: count users: %v", why, err)
	}
	if rows != 0 {
		t.Errorf("%s: %d users row(s) exist for %q", why, rows, email)
	}
	if _, _, ok, err := st.GetCredentials(ctx, email); err != nil {
		t.Fatalf("%s: credentials lookup: %v", why, err)
	} else if ok {
		t.Errorf("%s: a credential row exists for %q", why, email)
	}
	if _, ok, err := st.GetUserByIdentity(ctx, "password", email); err != nil && !errors.Is(err, ErrNotFound) {
		t.Fatalf("%s: identity lookup: %v", why, err)
	} else if ok {
		t.Errorf("%s: a password identity exists for %q", why, email)
	}
}

// registerVerifyLogin drives the whole normal flow for email/pw and returns the
// user, proving the password that was stored is the one the caller chose.
func registerVerifyLogin(t *testing.T, svc *Service, m *captureMailer, email, pw string) User {
	t.Helper()
	ctx := context.Background()
	u, err := svc.Register(ctx, email, pw, "")
	if err != nil {
		t.Fatalf("register %q: %v", email, err)
	}
	if m.verify == "" {
		t.Fatalf("register %q sent no verification mail", email)
	}
	if _, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), pw); err != nil {
		t.Fatalf("verify %q: %v", email, err)
	}
	if _, err := svc.Login(ctx, email, pw); err != nil {
		t.Fatalf("login %q: %v", email, err)
	}
	return u
}

// ── The defect: an unhashable password must not take the address ────────────

func TestRegisterOversizedPasswordLeavesNoAccountAndRetryWorks(t *testing.T) {
	svc, st, m := newRegistrationFixture(t)
	ctx := context.Background()
	const email = "boundary@example.com"

	long := strings.Repeat("a", 73) // one byte past bcrypt's limit
	if _, err := svc.Register(ctx, email, long, "Over"); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("73-byte password: want ErrPasswordTooLong, got %v", err)
	}
	assertNoAccount(t, st, email, "rejected 73-byte registration")
	if m.verify != "" {
		t.Error("a rejected registration must not send verification mail")
	}

	// The whole point of the fix: the same person retries with a usable
	// password and gets their account.
	registerVerifyLogin(t, svc, m, email, "longenough1")
}

func TestRegisterMultibyteOversizedPasswordLeavesNoAccountAndRetryWorks(t *testing.T) {
	svc, st, m := newRegistrationFixture(t)
	ctx := context.Background()
	const email = "multibyte@example.com"

	long := strings.Repeat("密", 25) // 25 runes, 75 bytes
	if n := len(long); n != 75 {
		t.Fatalf("fixture is %d bytes, want 75", n)
	}
	if _, err := svc.Register(ctx, email, long, "Over"); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("%d-byte multibyte password: want ErrPasswordTooLong, got %v", len(long), err)
	}
	assertNoAccount(t, st, email, "rejected multibyte registration")

	registerVerifyLogin(t, svc, m, email, strings.Repeat("密", 10))
}

// The limit is bcrypt's, so exactly 72 bytes must still be accepted — in ASCII
// and in a multibyte passphrase that lands exactly on the boundary.
func TestRegisterAcceptsPasswordAtSeventyTwoByteBoundary(t *testing.T) {
	svc, _, m := newRegistrationFixture(t)

	ascii := strings.Repeat("a", 72)
	registerVerifyLogin(t, svc, m, "ascii72@example.com", ascii)

	multibyte := strings.Repeat("密", 24) // 24 runes, 72 bytes
	if n := len(multibyte); n != 72 {
		t.Fatalf("fixture is %d bytes, want 72", n)
	}
	registerVerifyLogin(t, svc, m, "wide72@example.com", multibyte)
}

// ── Atomicity: a mid-write failure must not leave half an account ───────────

// TestRegisterIdentityWriteFailureLeavesNoAccount injects a real failure at the
// LAST of the three registration writes by taking the identities table away, so
// the users row and the credential are already written when it fails. Nothing
// may survive, and the address must still be registerable afterwards.
func TestRegisterIdentityWriteFailureLeavesNoAccount(t *testing.T) {
	svc, st, m := newRegistrationFixture(t)
	ctx := context.Background()
	const email = "rollback@example.com"

	if _, err := st.db.ExecContext(ctx, `ALTER TABLE identities RENAME TO identities_hidden`); err != nil {
		t.Fatalf("hide identities: %v", err)
	}
	if _, err := svc.Register(ctx, email, "longenough1", "Roll"); err == nil {
		t.Fatal("register must fail when the identity write cannot succeed")
	}
	// Both earlier writes of the same transaction must be gone: the users row
	// itself, and the password hash that was written onto it. Asserted straight
	// against the table so a rolled-back row cannot hide behind a lookup helper.
	var users, hashed int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if users != 0 {
		t.Errorf("users rows = %d, want 0 after the rolled-back registration", users)
	}
	if err := st.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL AND password_hash != ''`).Scan(&hashed); err != nil {
		t.Fatalf("count hashes: %v", err)
	}
	if hashed != 0 {
		t.Errorf("password hashes = %d, want 0 after the rolled-back registration", hashed)
	}
	if _, err := st.db.ExecContext(ctx, `ALTER TABLE identities_hidden RENAME TO identities`); err != nil {
		t.Fatalf("restore identities: %v", err)
	}
	assertNoAccount(t, st, email, "failed identity write")
	var identities int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM identities`).Scan(&identities); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if identities != 0 {
		t.Errorf("identities rows = %d, want 0", identities)
	}

	registerVerifyLogin(t, svc, m, email, "longenough1")
}

// ── Guards on the protections the new ordering sits next to ────────────────

// TestRegisterStillRefusesPendingDeletionAddress pins that moving validation
// and hashing in front of the durable write did not move the frozen-account
// refusal: a pending-deletion account keeps its address and its canonical
// siblings reserved through the grace window, and no second account may be
// created on either. Input validation runs before that refusal, exactly as the
// minimum-length check always has.
func TestRegisterStillRefusesPendingDeletionAddress(t *testing.T) {
	svc, st, _ := newRegistrationFixture(t)
	ctx := context.Background()

	u, err := svc.Register(ctx, "frozen@gmail.com", "longenough1", "")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := st.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("freeze: %v", err)
	}

	// The exact address, and a canonical sibling of it, both stay refused.
	for _, email := range []string{"frozen@gmail.com", "frozen+new@gmail.com", "fro.zen@gmail.com"} {
		if _, err := svc.Register(ctx, email, "longenough2", ""); !errors.Is(err, ErrPendingDeletion) {
			t.Errorf("register %q: want ErrPendingDeletion, got %v", email, err)
		}
	}
	var users int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if users != 1 {
		t.Fatalf("users rows = %d, want 1 (no second account on a frozen address)", users)
	}
	// An unusable password is still answered as such — the frozen account is not
	// disclosed differently, and nothing is created either way.
	if _, err := svc.Register(ctx, "frozen@gmail.com", strings.Repeat("a", 73), ""); !errors.Is(err, ErrPasswordTooLong) {
		t.Errorf("oversized password on a frozen address: want ErrPasswordTooLong, got %v", err)
	}
}

// TestRegisterInsertRecordsCanonicalEmail covers the dedupe column on the NEW
// transactional insert path: the folded form is what later registrations are
// matched against, so an insert that skipped it would silently reopen the
// Sybil mint.
func TestRegisterInsertRecordsCanonicalEmail(t *testing.T) {
	svc, st, _ := newRegistrationFixture(t)
	ctx := context.Background()

	u, err := svc.Register(ctx, "Dots.And+Tag@Gmail.com", "longenough1", "")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	var stored, canon string
	if err := st.db.QueryRowContext(ctx,
		`SELECT email, canonical_email FROM users WHERE id = ?`, u.ID).Scan(&stored, &canon); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if stored != "dots.and+tag@gmail.com" {
		t.Errorf("stored email = %q, want the normalized exact address", stored)
	}
	if want := canonicalEmail(stored); canon != want {
		t.Errorf("canonical_email = %q, want %q", canon, want)
	}
	// And it is the column the next registration is matched against.
	if _, err := svc.Register(ctx, "dotsand@gmail.com", "longenough2", ""); !errors.Is(err, ErrEmailTaken) {
		t.Errorf("canonical sibling: want ErrEmailTaken, got %v", err)
	}
}

// ── Canonical dedupe under concurrency ─────────────────────────────────────

// TestRegisterConcurrentCanonicalDuplicatesLeaveOneUsableAccount is the
// anti-Sybil race with the AUD-07 requirement added: exactly one registration
// wins AND the winner is a COMPLETE account (credential + identity), not a
// reserved address with no way in.
func TestRegisterConcurrentCanonicalDuplicatesLeaveOneUsableAccount(t *testing.T) {
	svc, st, _ := newRegistrationFixture(t)
	ctx := context.Background()

	const n = 12
	emails := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		emails[i] = fmt.Sprintf("race+tag%d@gmail.com", i)
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = svc.Register(ctx, emails[i], "longenough1", "")
		}(i)
	}
	close(start)
	wg.Wait()

	winners := 0
	for i, err := range errs {
		switch {
		case err == nil:
			winners++
			if _, _, ok, cerr := st.GetCredentials(ctx, emails[i]); cerr != nil {
				t.Fatalf("credentials: %v", cerr)
			} else if !ok {
				t.Errorf("winner %q has no credential", emails[i])
			}
			if _, ok, ierr := st.GetUserByIdentity(ctx, "password", emails[i]); ierr != nil && !errors.Is(ierr, ErrNotFound) {
				t.Fatalf("identity: %v", ierr)
			} else if !ok {
				t.Errorf("winner %q has no password identity", emails[i])
			}
		case errors.Is(err, ErrEmailTaken):
			assertNoLiteralAccount(t, st, emails[i], "losing concurrent registration")
		default:
			t.Errorf("%q: unexpected error: %v", emails[i], err)
		}
	}
	if winners != 1 {
		t.Fatalf("winners = %d, want exactly 1", winners)
	}
	var rows int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&rows); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if rows != 1 {
		t.Fatalf("users rows = %d, want 1", rows)
	}
}

// ── Mail is outside the transaction ────────────────────────────────────────

type verifyMailFailure struct {
	captureMailer
	fail bool
}

func (m *verifyMailFailure) SendVerifyEmail(ctx context.Context, to, link string) error {
	if m.fail {
		return errors.New("mailer unavailable")
	}
	return m.captureMailer.SendVerifyEmail(ctx, to, link)
}

// TestRegisterMailFailureKeepsTheAccountForResend pins the deliberate asymmetry:
// a DB failure rolls the account back, but a MAIL failure does not — the account
// is committed and real, so the user recovers through resend rather than by
// having their new account deleted underneath them.
func TestRegisterMailFailureKeepsTheAccountForResend(t *testing.T) {
	st := newTestStore(t)
	m := &verifyMailFailure{fail: true}
	svc := NewService(st, m, Config{
		BaseURL: "https://relayium.com", SessionTTL: time.Hour, VerifyTTL: 24 * time.Hour,
	})
	ctx := context.Background()
	const email = "mailfail@example.com"

	if _, err := svc.Register(ctx, email, "longenough1", "Mail"); err == nil {
		t.Fatal("register must report the mail failure")
	}
	uid, _, ok, err := st.GetCredentials(ctx, email)
	if err != nil {
		t.Fatalf("credentials: %v", err)
	}
	if !ok {
		t.Fatal("a mail failure must not roll back the committed account")
	}
	if verified, err := st.EmailVerified(ctx, uid); err != nil {
		t.Fatalf("verified: %v", err)
	} else if verified {
		t.Fatal("account must still be unverified")
	}
	// Recovery is a resend, and it now reaches the user.
	m.fail = false
	u, err := st.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if err := svc.SendVerifyEmail(ctx, u); err != nil {
		t.Fatalf("resend: %v", err)
	}
	if _, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), "longenough1"); err != nil {
		t.Fatalf("verify after resend: %v", err)
	}
	if _, err := svc.Login(ctx, email, "longenough1"); err != nil {
		t.Fatalf("login after resend: %v", err)
	}
}

// ── Other login methods stay a way in ─────────────────────────────────────

// A rejected oversized registration must leave the address in the state it was
// in before — including for the magic-link path, which must create the account
// normally rather than adopt a leftover credential-less row.
func TestMagicLinkStillWorksAfterRejectedOversizedRegistration(t *testing.T) {
	svc, st, m := newRegistrationFixture(t)
	ctx := context.Background()
	const email = "magic@example.com"

	if _, err := svc.Register(ctx, email, strings.Repeat("a", 80), ""); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("oversized password: want ErrPasswordTooLong, got %v", err)
	}
	assertNoAccount(t, st, email, "rejected registration before magic link")

	if err := svc.RequestMagicLink(ctx, email); err != nil {
		t.Fatalf("magic request: %v", err)
	}
	sess, err := svc.VerifyMagicLink(ctx, tokenFromLink(t, m.magic))
	if err != nil {
		t.Fatalf("magic verify: %v", err)
	}
	u, err := st.GetUserByID(ctx, sess.UserID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if u.Email != email {
		t.Fatalf("magic link produced %q, want %q", u.Email, email)
	}
	if !u.EmailVerified {
		t.Fatal("magic-link sign-in must verify the email")
	}
	if has, err := st.HasPassword(ctx, u.ID); err != nil {
		t.Fatalf("has password: %v", err)
	} else if has {
		t.Fatal("no password may exist on the magic-link account")
	}
}

// ── Adjacent case: the same oversized input on the reset path ──────────────

// TestResetPasswordOversizedInputDoesNotSpendTheToken covers the same ordering
// mistake on the recovery path: the token was consumed BEFORE the password was
// hashed, so one oversized submission burned the only reset token the user had
// and the emailed link stopped working.
func TestResetPasswordOversizedInputDoesNotSpendTheToken(t *testing.T) {
	svc, _, m := newRegistrationFixture(t)
	ctx := context.Background()
	const email = "reset@example.com"

	registerVerifyLogin(t, svc, m, email, "oldpassword")
	if err := svc.RequestPasswordReset(ctx, email); err != nil {
		t.Fatalf("request reset: %v", err)
	}
	token := tokenFromLink(t, m.reset)

	if _, err := svc.ResetPassword(ctx, token, strings.Repeat("a", 73)); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("oversized reset password: want ErrPasswordTooLong, got %v", err)
	}
	// The token must survive a rejected attempt.
	if _, err := svc.ResetPassword(ctx, token, "brandnewpass"); err != nil {
		t.Fatalf("reset with the same token after a rejected attempt: %v", err)
	}
	if _, err := svc.Login(ctx, email, "brandnewpass"); err != nil {
		t.Fatalf("login with the reset password: %v", err)
	}
}

// TestChangePasswordRejectsOversizedWithoutChangingAnything is the third caller
// of the same bcrypt limit: it has no durable-write ordering bug, but it must
// reject the input rather than fail opaquely, and must leave the old password
// working.
func TestChangePasswordRejectsOversizedWithoutChangingAnything(t *testing.T) {
	svc, _, m := newRegistrationFixture(t)
	ctx := context.Background()
	const email = "change@example.com"

	u := registerVerifyLogin(t, svc, m, email, "oldpassword")
	if err := svc.ChangePassword(ctx, u, "", "oldpassword", strings.Repeat("a", 73)); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("oversized new password: want ErrPasswordTooLong, got %v", err)
	}
	if _, err := svc.Login(ctx, email, "oldpassword"); err != nil {
		t.Fatalf("old password must still work: %v", err)
	}
}

// The two ends of the range must not collapse into one answer: a client that
// mapped an oversized password onto the short-password message would tell the
// user to do the opposite of what would help.
func TestPasswordRangeErrorsAreDistinct(t *testing.T) {
	if errors.Is(ErrPasswordTooLong, ErrWeakPassword) || errors.Is(ErrWeakPassword, ErrPasswordTooLong) {
		t.Fatal("too-long and too-short must be distinct errors")
	}
	for _, tc := range []struct {
		name string
		pw   string
		want error
	}{
		{"empty", "", ErrWeakPassword},
		{"one below minimum", strings.Repeat("a", minPasswordLen-1), ErrWeakPassword},
		{"at minimum", strings.Repeat("a", minPasswordLen), nil},
		{"at maximum", strings.Repeat("a", maxPasswordBytes), nil},
		{"one past maximum", strings.Repeat("a", maxPasswordBytes+1), ErrPasswordTooLong},
		{"multibyte at maximum", strings.Repeat("密", maxPasswordBytes/3), nil},
		{"multibyte past maximum", strings.Repeat("密", maxPasswordBytes/3+1), ErrPasswordTooLong},
	} {
		if got := validateNewPassword(tc.pw); !errors.Is(got, tc.want) {
			t.Errorf("%s (%d bytes): got %v, want %v", tc.name, len(tc.pw), got, tc.want)
		}
	}
	// maxPasswordBytes must track the hasher rather than drift from it.
	if _, err := bcrypt.GenerateFromPassword([]byte(strings.Repeat("a", maxPasswordBytes)), bcrypt.MinCost); err != nil {
		t.Fatalf("bcrypt rejects %d bytes: %v", maxPasswordBytes, err)
	}
	if _, err := bcrypt.GenerateFromPassword([]byte(strings.Repeat("a", maxPasswordBytes+1)), bcrypt.MinCost); err == nil {
		t.Fatalf("bcrypt accepts %d bytes, so maxPasswordBytes is stale", maxPasswordBytes+1)
	}
}

// ── The HTTP contract ──────────────────────────────────────────────────────

// TestHandleRegisterOversizedPasswordAnswers400NotTooShort pins what the API
// actually says. 400 with a code of its own, NOT the short-password code (a
// client that reused that wording would send the user in the wrong direction),
// and no account left behind for the address.
func TestHandleRegisterOversizedPasswordAnswers400NotTooShort(t *testing.T) {
	svc, st, m := newRegistrationFixture(t)
	const email = "api@example.com"

	body, err := json.Marshal(map[string]string{"email": email, "password": strings.Repeat("a", 73)})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	svc.handleRegister(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	if out["error"] != "password_too_long" {
		t.Fatalf("error=%q, want password_too_long", out["error"])
	}
	if strings.Contains(out["error"], "short") || strings.Contains(out["hint"], "short") {
		t.Fatalf("an oversized password must not be reported as too short: %v", out)
	}
	if m.verify != "" {
		t.Error("a rejected registration must not send verification mail")
	}
	assertNoAccount(t, st, email, "rejected registration over HTTP")

	// And the address is still registerable through the same endpoint.
	body, err = json.Marshal(map[string]string{"email": email, "password": "longenough1"})
	if err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	svc.handleRegister(rec, httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(string(body))))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "verification_sent") {
		t.Fatalf("retry: code=%d body=%s", rec.Code, rec.Body.String())
	}
}
