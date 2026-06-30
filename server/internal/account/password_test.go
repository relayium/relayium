package account

import (
	"context"
	"errors"
	"testing"
	"time"
)

func newPwService(t *testing.T) *Service {
	t.Helper()
	return NewService(newTestStore(t), &capturingMailer{}, Config{
		BaseURL: "https://relayium.com", SessionTTL: time.Hour,
	})
}

func TestRegisterThenLoginRoundTrip(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	sess, err := svc.Register(ctx, "New@Example.com", "hunter2hunter", "New User")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	u, ok, err := svc.ValidateSession(ctx, sess.ID)
	if err != nil || !ok {
		t.Fatalf("session invalid after register: ok=%v err=%v", ok, err)
	}
	if u.Email != "new@example.com" {
		t.Fatalf("email not normalized: %q", u.Email)
	}

	// 正确密码登录成功。
	if _, err := svc.Login(ctx, "new@example.com", "hunter2hunter"); err != nil {
		t.Fatalf("login: %v", err)
	}
	// 错误密码返回 ErrBadCredentials。
	if _, err := svc.Login(ctx, "new@example.com", "wrongpass1"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("wrong password: want ErrBadCredentials, got %v", err)
	}
	// 不存在的邮箱同样 ErrBadCredentials（不泄露枚举）。
	if _, err := svc.Login(ctx, "ghost@example.com", "hunter2hunter"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("unknown email: want ErrBadCredentials, got %v", err)
	}
}

func TestRegisterRejectsWeakAndDuplicate(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	if _, err := svc.Register(ctx, "a@example.com", "short", ""); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("short password: want ErrWeakPassword, got %v", err)
	}
	if _, err := svc.Register(ctx, "dup@example.com", "longenough1", ""); err != nil {
		t.Fatalf("first register: %v", err)
	}
	if _, err := svc.Register(ctx, "Dup@Example.com", "longenough2", ""); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("duplicate email: want ErrEmailTaken, got %v", err)
	}
}
