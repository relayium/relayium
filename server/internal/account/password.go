package account

import (
	"context"
	"errors"
	"net/mail"

	"golang.org/x/crypto/bcrypt"
)

const minPasswordLen = 8

var (
	// ErrEmailTaken 表示该邮箱已设置过密码。
	ErrEmailTaken = errors.New("account: email already registered")
	// ErrBadCredentials 同时覆盖"邮箱不存在"与"密码错误"，避免账号枚举。
	ErrBadCredentials = errors.New("account: invalid credentials")
	// ErrWeakPassword 表示密码短于 minPasswordLen。
	ErrWeakPassword = errors.New("account: password too short")
	// ErrEmailUnverified 表示账密正确但邮箱尚未验证，禁止登录。
	ErrEmailUnverified = errors.New("account: email not verified")
	// ErrInvalidToken 表示验证/重置 token 无效或已过期。
	ErrInvalidToken = errors.New("account: invalid or expired token")
	// ErrInvalidEmail 表示邮箱地址格式不合法。
	ErrInvalidEmail = errors.New("account: invalid email address")
)

// dummyBcryptHash is a valid bcrypt hash at DefaultCost. Login compares against
// it when the account doesn't exist so the response time matches the
// account-exists path and doesn't leak account existence. No password matches it.
var dummyBcryptHash, _ = bcrypt.GenerateFromPassword([]byte("relayium-login-timing-equalizer"), bcrypt.DefaultCost)

// Register 创建密码账号（初始未验证）并发送验证邮件。不发 session：用户须先验证。
func (s *Service) Register(ctx context.Context, email, password, displayName string) (User, error) {
	email = normEmail(email)
	if _, err := mail.ParseAddress(email); err != nil {
		return User{}, ErrInvalidEmail
	}
	if len(password) < minPasswordLen {
		return User{}, ErrWeakPassword
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
	// InsertUserDedupedByCanonical) — a separate check-then-insert pair here would
	// leave a TOCTOU race letting N concurrent registrations for the same canonical
	// form all pass. Same ErrEmailTaken → identical 409 response as an
	// exact-duplicate, so existence is not leaked any differently.
	u, taken, err := s.store.InsertUserDedupedByCanonical(ctx, email, displayName, canon)
	if err != nil {
		return User{}, err
	}
	if taken {
		return User{}, ErrEmailTaken
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, err
	}
	if err := s.store.SetPassword(ctx, u.ID, string(hash)); err != nil {
		return User{}, err
	}
	if err := s.store.LinkIdentity(ctx, "password", email, u.ID); err != nil {
		return User{}, err
	}
	if err := s.SendVerifyEmail(ctx, u); err != nil {
		return User{}, err
	}
	return u, nil
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

func (s *Service) Login(ctx context.Context, email, password string) (Session, error) {
	uid, err := s.authenticate(ctx, email, password)
	if err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, uid)
}

// ChangePassword sets or changes the authenticated user's password, then revokes
// the user's other sessions. For a user who already has a password, currentPassword
// must verify; for a passwordless user (Google/magic) it is a first-time set that
// also links a "password" identity so they can subsequently log in by email+password.
func (s *Service) ChangePassword(ctx context.Context, u User, currentSessionID, currentPassword, newPassword string) error {
	_, hash, hasPass, err := s.store.GetCredentials(ctx, u.Email)
	if err != nil {
		return err
	}
	if hasPass {
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(currentPassword)) != nil {
			return ErrBadCredentials
		}
	}
	if len(newPassword) < minPasswordLen {
		return ErrWeakPassword
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if err := s.store.SetPassword(ctx, u.ID, string(newHash)); err != nil {
		return err
	}
	if !hasPass {
		if err := s.store.LinkIdentity(ctx, "password", normEmail(u.Email), u.ID); err != nil {
			return err
		}
	}
	return s.store.RevokeUserSessions(ctx, u.ID, currentSessionID)
}
