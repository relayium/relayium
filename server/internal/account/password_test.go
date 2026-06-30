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

func TestChangePasswordExistingUser(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	sess, err := svc.Register(ctx, "c@example.com", "oldpassword1", "C")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	u, _, _ := svc.ValidateSession(ctx, sess.ID)

	// 旧密码错 => ErrBadCredentials。
	if err := svc.ChangePassword(ctx, u, sess.ID, "wrongold12", "newpassword1"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("wrong current: want ErrBadCredentials, got %v", err)
	}
	// 新密码太短 => ErrWeakPassword。
	if err := svc.ChangePassword(ctx, u, sess.ID, "oldpassword1", "short"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("weak new: want ErrWeakPassword, got %v", err)
	}
	// 正确旧密码 => 成功；新密码可登录、旧密码失效。
	if err := svc.ChangePassword(ctx, u, sess.ID, "oldpassword1", "newpassword1"); err != nil {
		t.Fatalf("change: %v", err)
	}
	if _, err := svc.Login(ctx, "c@example.com", "newpassword1"); err != nil {
		t.Fatalf("login with new password: %v", err)
	}
	if _, err := svc.Login(ctx, "c@example.com", "oldpassword1"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("old password should fail: got %v", err)
	}
}

func TestChangePasswordSetsForPasswordlessUser(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	// 模拟 Google/魔法用户：有账号、无密码。
	u, err := svc.store.UpsertUserByEmail(ctx, "g@example.com", "G")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// currentPassword 被忽略；首次设密成功。
	if err := svc.ChangePassword(ctx, u, "no-session", "", "freshpass12"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, err := svc.Login(ctx, "g@example.com", "freshpass12"); err != nil {
		t.Fatalf("login after set: %v", err)
	}
}

func TestChangePasswordRevokesOtherSessions(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	sess, _ := svc.Register(ctx, "r@example.com", "oldpassword1", "R")
	u, _, _ := svc.ValidateSession(ctx, sess.ID)
	// 第二个会话（另一台设备）。
	other, err := svc.IssueSession(ctx, u.ID)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := svc.ChangePassword(ctx, u, sess.ID, "oldpassword1", "newpassword1"); err != nil {
		t.Fatalf("change: %v", err)
	}
	if _, ok, _ := svc.ValidateSession(ctx, sess.ID); !ok {
		t.Fatal("current session must survive")
	}
	if _, ok, _ := svc.ValidateSession(ctx, other.ID); ok {
		t.Fatal("other session must be revoked")
	}
}
