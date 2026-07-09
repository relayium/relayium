package account

import (
	"context"
	"errors"

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
)

// Register 创建密码账号（初始未验证）并发送验证邮件。不发 session：用户须先验证。
func (s *Service) Register(ctx context.Context, email, password, displayName string) (User, error) {
	email = normEmail(email)
	if len(password) < minPasswordLen {
		return User{}, ErrWeakPassword
	}
	if _, _, ok, err := s.store.GetCredentials(ctx, email); err != nil {
		return User{}, err
	} else if ok {
		return User{}, ErrEmailTaken
	}
	u, err := s.store.UpsertUserByEmail(ctx, email, displayName)
	if err != nil {
		return User{}, err
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
func (s *Service) Login(ctx context.Context, email, password string) (Session, error) {
	email = normEmail(email)
	uid, hash, ok, err := s.store.GetCredentials(ctx, email)
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrBadCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return Session{}, ErrBadCredentials
	}
	if verified, err := s.store.EmailVerified(ctx, uid); err != nil {
		return Session{}, err
	} else if !verified {
		return Session{}, ErrEmailUnverified
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
