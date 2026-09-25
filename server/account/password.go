package account

import (
	"context"
	"errors"
	"net/mail"

	"github.com/relayium/relayium/authx"
	"golang.org/x/crypto/bcrypt"
)

const (
	minPasswordLen = 8
	// maxPasswordBytes is bcrypt's hard input limit, not a product choice:
	// GenerateFromPassword refuses anything longer, so a password over this size
	// can never be stored. The limit is in BYTES, so a 25-character multibyte
	// passphrase (75 bytes) also exceeds it.
	maxPasswordBytes = 72
)

var (
	// ErrEmailTaken 表示该邮箱已设置过密码。
	ErrEmailTaken = errors.New("account: email already registered")
	// ErrBadCredentials 同时覆盖"邮箱不存在"与"密码错误"，避免账号枚举。
	ErrBadCredentials = errors.New("account: invalid credentials")
	// ErrWeakPassword 表示密码短于 minPasswordLen。
	ErrWeakPassword = errors.New("account: password too short")
	// ErrPasswordTooLong 表示密码超过 bcrypt 的 72 字节上限（按字节计，多字节口令
	// 也会触发）。Must stay distinct from ErrWeakPassword: they are opposite
	// problems, and reporting one as the other misdirects the user.
	ErrPasswordTooLong = errors.New("account: password too long")
	// ErrEmailUnverified 表示账密正确但邮箱尚未验证，禁止登录。
	ErrEmailUnverified = errors.New("account: email not verified")
	// ErrInvalidToken 表示验证/重置 token 无效或已过期。
	ErrInvalidToken = errors.New("account: invalid or expired token")
	// ErrVerifyPasswordMismatch means a non-empty password presented while
	// verifying an email does not match the registration password. Nothing was
	// changed and the verify link was NOT spent.
	ErrVerifyPasswordMismatch = errors.New("account: password does not match the registration password")
	// ErrInvalidEmail 表示邮箱地址格式不合法。
	ErrInvalidEmail = errors.New("account: invalid email address")
)

// dummyBcryptHash is a valid bcrypt hash at DefaultCost. Login compares against
// it when the account doesn't exist so the response time matches the
// account-exists path and doesn't leak account existence. No password matches it.
var dummyBcryptHash, _ = bcrypt.GenerateFromPassword([]byte("relayium-login-timing-equalizer"), bcrypt.DefaultCost)

// validateNewPassword checks a password against both ends of the storable
// range: our minimum and bcrypt's 72-byte maximum.
//
// Invariant: every caller that sets a password runs this BEFORE any durable or
// irreversible step. bcrypt reports the upper bound only at hashing time, which
// is too late for a caller that has already inserted a row or spent a token.
func validateNewPassword(password string) error {
	if len(password) < minPasswordLen {
		return ErrWeakPassword
	}
	if len(password) > maxPasswordBytes {
		return ErrPasswordTooLong
	}
	return nil
}

// Register 创建密码账号（初始未验证）并发送验证邮件。不发 session：用户须先验证。
func (s *Service) Register(ctx context.Context, email, password, displayName string) (User, error) {
	email = normEmail(email)
	if _, err := mail.ParseAddress(email); err != nil {
		return User{}, ErrInvalidEmail
	}
	// Invariant: a password that cannot be stored never reaches a durable write.
	// An unhashable input must leave the address, its canonical form and every
	// credential/identity row exactly as they were.
	if err := validateNewPassword(password); err != nil {
		return User{}, err
	}
	// Task 4: a pending-deletion account (DeletedAt>0) keeps its email/canonical
	// slot reserved through the grace window — re-registering it would let a
	// second live account exist under the same address the original owner might
	// still reactivate into. Checked first (against the canonical form, so this
	// also catches a "a+1@gmail" registration attempt against a pending-deletion
	// "a@gmail" account) and ahead of the exact-match GetCredentials check right
	// below, since a pending-deletion password account still has a credentials
	// row and would otherwise be misreported as a plain ErrEmailTaken.
	canon := canonicalEmail(email)
	if existing, ok, err := s.store.UserByCanonicalEmail(ctx, canon); err != nil {
		return User{}, err
	} else if ok && existing.DeletedAt > 0 {
		return User{}, ErrPendingDeletion
	}
	if _, _, ok, err := s.store.GetCredentials(ctx, email); err != nil {
		return User{}, err
	} else if ok {
		return User{}, ErrEmailTaken
	}
	// H2b: reject a new registration whose canonical form (strip +tag; gmail dot-fold)
	// already belongs to an account, defeating "a+1@gmail / a.b@gmail" Sybil mint.
	// The check and the insert happen atomically inside one transaction (see
	// InsertPasswordUserDedupedByCanonical) — a separate check-then-insert pair
	// here would leave a TOCTOU race letting N concurrent registrations for the
	// same canonical form all pass. Same ErrEmailTaken → identical 409 response
	// as an exact-duplicate, so existence is not leaked any differently.
	//
	// Hash after the read-only checks and before the insert: a hash failure
	// leaves nothing durable. An exact duplicate or a frozen address is still
	// answered above without hashing; only a canonical sibling now pays one
	// hash before the transaction reports it taken.
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, err
	}
	// The users row, the password and the "password" identity are one fact and
	// commit together. A users row without its credential owns the address
	// without being usable or recoverable by whoever registered it.
	u, taken, err := s.store.InsertPasswordUserDedupedByCanonical(ctx, email, displayName, canon, string(hash))
	if err != nil {
		return User{}, err
	}
	if taken {
		return User{}, ErrEmailTaken
	}
	// Mail stays outside that transaction: the account is committed and real, so
	// a send failure is reported but never rolls it back. Recovery is resending
	// verification (POST /api/auth/email/resend), which works because the
	// credential committed with the user.
	if err := s.SendVerifyEmail(ctx, u); err != nil {
		return User{}, err
	}
	return u, nil
}

// dropUnverifiedPassword removes any password credential on an account that is
// about to be email-verified through an external identity provider (Google,
// Apple, magic link) rather than through the password flow's own email
// verification.
//
// This closes an account pre-hijacking hole. Register (above) lets anyone set a
// password on an *unverified* email they do not own; login is blocked only by
// the unverified flag. Without this, the first time the real owner signs in via
// an IdP the account is flipped to verified while that planted password stays
// live — so the attacker can then log in with the password they chose and take
// the account over. A password set before the email was ever proven is
// therefore untrusted: when a different channel proves ownership we drop it (and
// the "password" identity), and the legitimate owner re-establishes one via
// password reset. An already-verified account keeps its password — the owner
// proved that email themselves, so the credential is trusted.
//
// Verification state is re-read from the store (not taken from a possibly-stale
// User struct) so the decision is authoritative, and this MUST be called before
// SetEmailVerified — once verified, it correctly becomes a no-op.
func (s *Service) dropUnverifiedPassword(ctx context.Context, userID string) error {
	verified, err := s.store.EmailVerified(ctx, userID)
	if err != nil {
		return err
	}
	if verified {
		return nil
	}
	has, err := s.store.HasPassword(ctx, userID)
	if err != nil {
		return err
	}
	if !has {
		return nil
	}
	if err := s.store.ClearPassword(ctx, userID); err != nil {
		return err
	}
	// Also drop the "password" identity so ListIdentityProviders / the
	// last-login-method guard stay consistent with HasPassword. The IdP that
	// triggered this has already been linked, so the account keeps a login method.
	if err := s.store.UnlinkIdentity(ctx, "password", userID); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

// verifyDropsPassword decides the fate of a password that was set at
// registration (before the email was ever proven) at the moment the email is
// verified via its emailed link. It only DECIDES; VerifyEmailWithToken applies
// the decision in the same transaction that spends the link, so an interruption
// can never leave the password dropped while the link is spent and the account
// still unverified.
//
// A registration password is only trustworthy if the person completing
// verification KNOWS it — i.e. is the same person who set it:
//   - the matching password → keep it (the legitimate owner just confirmed it);
//   - no password at all ("continue without a password") → drop it, leaving a
//     verified, passwordless account whose owner sets a password later. This
//     closes the pre-hijack variant where an attacker registers victim@email
//     with a known password and the VICTIM, by clicking the link, would
//     otherwise activate the attacker's password;
//   - a NON-EMPTY password that does not match → ErrVerifyPasswordMismatch.
//     A typo must not silently discard the password the user chose; nothing is
//     changed and the link stays usable. Only the explicit empty-password
//     choice drops it.
//
// An already-verified account keeps its password whatever is presented (the
// owner proved the address earlier), and a passwordless account has nothing
// to reconcile.
func (s *Service) verifyDropsPassword(ctx context.Context, u User, password string) (bool, error) {
	if u.EmailVerified {
		return false, nil
	}
	_, hash, hasPass, err := s.store.GetCredentials(ctx, u.Email)
	if err != nil {
		return false, err
	}
	if !hasPass {
		return false, nil // passwordless (magic/OAuth) — nothing to reconcile
	}
	if password == "" {
		return true, nil // explicit "continue without a password"
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil {
		return false, nil // the verifier proved they set it → trusted, keep it
	}
	return false, ErrVerifyPasswordMismatch
}

// Login 校验邮箱+密码并签发会话。任何失败都返回 ErrBadCredentials。
// authenticate validates email+password and the login preconditions — verified
// email, not a frozen (pending-deletion) account — returning the user id. Shared
// by the cookie-session Login and the native bearer-token login so both enforce
// byte-for-byte identical credential/verification/frozen guards.
func (s *Service) authenticate(ctx context.Context, email, password string) (string, error) {
	email = normEmail(email)
	uid, hash, ok, err := s.store.GetCredentials(ctx, email)
	if err != nil {
		return "", err
	}
	if !ok {
		// Equalize timing against the account-exists path: run a comparable bcrypt
		// against a dummy hash so response time doesn't leak account existence.
		_ = bcrypt.CompareHashAndPassword(dummyBcryptHash, []byte(password))
		return "", ErrBadCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return "", ErrBadCredentials
	}
	if verified, err := s.store.EmailVerified(ctx, uid); err != nil {
		return "", err
	} else if !verified {
		return "", ErrEmailUnverified
	}
	// Frozen-login guard (Task 4): load the full user row so DeletedAt is
	// visible, and refuse to authenticate a pending-deletion account — checked
	// after credentials/verification pass but strictly before any session or
	// bearer token is issued, so a frozen account can never get live access.
	u, err := s.store.GetUserByID(ctx, uid)
	if err != nil {
		return "", err
	}
	if u.DeletedAt > 0 {
		raw, terr := s.issueReactivateToken(ctx, u.ID, u.Email)
		if terr != nil {
			return "", terr
		}
		return "", &PendingDeletionError{PurgeAfter: u.PurgeAfter, ReactivateToken: raw}
	}
	return uid, nil
}

// Login checks email+password and issues a browser session. The account's
// credential_epoch is read BEFORE the password is checked and the session is
// inserted only while it is unchanged: a password reset/change that commits in
// between revokes every session, and a session minted from the password it just
// replaced must not appear after it (it could then approve a device-code login
// and obtain a fresh bearer). Such a login fails as bad credentials.
func (s *Service) Login(ctx context.Context, email, password string) (Session, error) {
	epoch, err := s.store.CredentialEpochByEmail(ctx, email)
	if err != nil {
		return Session{}, err
	}
	uid, err := s.authenticate(ctx, email, password)
	if err != nil {
		return Session{}, err
	}
	now := s.now()
	sess := Session{
		ID:        authx.RandToken(),
		UserID:    uid,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.SessionTTL).Unix(),
	}
	ok, err := s.store.CreateSessionAtEpoch(ctx, sess, epoch)
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrBadCredentials
	}
	return sess, nil
}

// ChangePassword sets or changes the authenticated user's password, then revokes
// the user's other sessions. For a user who already has a password, currentPassword
// must verify; for a passwordless user (Google/magic) it is a first-time set that
// also links a "password" identity so they can subsequently log in by email+password.
func (s *Service) ChangePassword(ctx context.Context, u User, currentSessionID, currentPassword, newPassword string) error {
	// Read before the current password is checked; the change is written only
	// while it is unchanged (see ChangePasswordAndRevokeSessions).
	epoch, err := s.store.CredentialEpoch(ctx, u.ID)
	if err != nil {
		return err
	}
	_, hash, hasPass, err := s.store.GetCredentials(ctx, u.Email)
	if err != nil {
		return err
	}
	if hasPass {
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(currentPassword)) != nil {
			return ErrBadCredentials
		}
	}
	// Same storable-range check as registration and reset, so an unhashable
	// input gets a usable answer rather than an opaque server error.
	if err := validateNewPassword(newPassword); err != nil {
		return err
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	// One transaction: a change that fails part-way must not leave the new
	// password live with the other sessions still valid.
	linkSubject := ""
	if !hasPass {
		linkSubject = normEmail(u.Email)
	}
	return s.store.ChangePasswordAndRevokeSessions(ctx, u.ID, string(newHash), linkSubject, currentSessionID, epoch)
}
