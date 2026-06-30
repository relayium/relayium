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
)

// Register 创建（或为已有无密码账号补设）密码并登录。同一邮箱已设密码时拒绝。
func (s *Service) Register(ctx context.Context, email, password, displayName string) (Session, error) {
	email = normEmail(email)
	if len(password) < minPasswordLen {
		return Session{}, ErrWeakPassword
	}
	if _, _, ok, err := s.store.GetCredentials(ctx, email); err != nil {
		return Session{}, err
	} else if ok {
		return Session{}, ErrEmailTaken
	}
	u, err := s.store.UpsertUserByEmail(ctx, email, displayName)
	if err != nil {
		return Session{}, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return Session{}, err
	}
	if err := s.store.SetPassword(ctx, u.ID, string(hash)); err != nil {
		return Session{}, err
	}
	if err := s.store.LinkIdentity(ctx, "password", email, u.ID); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, u.ID)
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
	return s.IssueSession(ctx, uid)
}
