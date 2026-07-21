package account

import (
	"context"
	"testing"
)

func TestAdminSessionRecordsAuthMethod(t *testing.T) {
	_, svc, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok, err := svc.newAdminSession(ctx, "passkey")
	if err != nil {
		t.Fatal(err)
	}
	auth, _, ok, err := store.AdminSession(ctx, tok, svc.now().Unix())
	if err != nil || !ok {
		t.Fatalf("session lookup: ok=%v err=%v", ok, err)
	}
	if auth != "passkey" {
		t.Fatalf("want auth=passkey, got %q", auth)
	}
}

// 宽限期：刚验过 → 新鲜；从未验过 → 不新鲜。
func TestStepUpFreshness(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok, _ := svc.newAdminSession(ctx, "password")
	if svc.stepUpFresh(ctx, tok) {
		t.Fatal("a brand-new session must NOT be step-up fresh")
	}
	svc.markStepUp(ctx, tok)
	if !svc.stepUpFresh(ctx, tok) {
		t.Fatal("want fresh right after markStepUp")
	}
}

// 宽限期必须真的会过期，否则一次验证就永久免验，等于没有步进。
func TestStepUpGraceExpires(t *testing.T) {
	_, svc, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok, _ := svc.newAdminSession(ctx, "password")
	// Push the last step-up beyond the grace window.
	if err := store.MarkAdminStepUp(ctx, tok, svc.now().Unix()-int64(stepUpGraceSecs)-1); err != nil {
		t.Fatal(err)
	}
	if svc.stepUpFresh(ctx, tok) {
		t.Fatal("a step-up older than the grace window must not count as fresh")
	}
}

// 会话过期仍必须照常生效（原有行为不能被结构改造破坏）。
func TestAdminSessionStillExpires(t *testing.T) {
	_, svc, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	if err := store.CreateAdminSession(ctx, "expired-tok", "password", svc.now().Unix()-1); err != nil {
		t.Fatal(err)
	}
	if svc.validAdmin(ctx, "expired-tok") {
		t.Fatal("an expired session must not validate")
	}
}

// Two Service values sharing ONE store: a session created on instance A is
// recognized on instance B (the whole point of externalizing admin sessions).
func TestAdminSessionSharedAcrossInstances(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	mk := func() *Service {
		return NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	}
	svcA, svcB := mk(), mk()
	tok, err := svcA.newAdminSession(ctx, "password")
	if err != nil {
		t.Fatal(err)
	}
	if !svcB.validAdmin(ctx, tok) {
		t.Fatal("a session minted on instance A must validate on instance B")
	}
	svcA.markStepUp(ctx, tok)
	if !svcB.stepUpFresh(ctx, tok) {
		t.Fatal("a step-up on instance A must be visible on instance B")
	}
}
