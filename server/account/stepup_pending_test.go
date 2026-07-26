package account

import (
	"context"
	"net/url"
	"testing"
)

// **最关键的一条测试。** pending token 若不绑定发起它的会话，任何拿到 token 的人
// 都能在自己的会话里兑现它 —— 步进认证被整个绕过。
func TestTakePendingRejectsADifferentSession(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok, ok := svc.putPending(ctx, "session-A", "settings.update", "", url.Values{"a": {"1"}})
	if !ok {
		t.Fatal("putPending failed")
	}
	if _, ok := svc.takePending(ctx, tok, "session-B"); ok {
		t.Fatal("SECURITY: a pending action was redeemed from a different session")
	}
}

func TestTakePendingAcceptsTheOriginatingSession(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok, _ := svc.putPending(ctx, "session-A", "settings.update", "", url.Values{"a": {"1"}})
	got, ok := svc.takePending(ctx, tok, "session-A")
	if !ok {
		t.Fatal("the originating session must be able to redeem")
	}
	if got.action != "settings.update" || got.form.Get("a") != "1" {
		t.Fatalf("form did not survive: %+v", got)
	}
}

// 一次性消费：重放同一个 token 必须失败，否则一次验证能执行任意多次操作。
func TestTakePendingIsOneShot(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok, _ := svc.putPending(ctx, "s", "settings.update", "", url.Values{})
	if _, ok := svc.takePending(ctx, tok, "s"); !ok {
		t.Fatal("first redeem should succeed")
	}
	if _, ok := svc.takePending(ctx, tok, "s"); ok {
		t.Fatal("SECURITY: a pending action was redeemed twice")
	}
}

// 会话不匹配的尝试也必须烧掉 token —— 否则攻击者可以反复试探而不消耗它。
func TestWrongSessionBurnsThePendingToken(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	ctx := context.Background()
	tok, _ := svc.putPending(ctx, "s", "settings.update", "", url.Values{})
	_, _ = svc.takePending(ctx, tok, "attacker")
	if _, ok := svc.takePending(ctx, tok, "s"); ok {
		t.Fatal("a wrong-session attempt must burn the token, like takeCeremony does")
	}
}

func TestTakePendingRejectsExpired(t *testing.T) {
	_, svc, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	now := svc.now().Unix()
	// Insert a row whose expiry is already in the past.
	if ok, err := store.PutPendingAction(ctx, "tok", "s", "settings.update", "", "", now-10, now-1, pendingActionCap); err != nil || !ok {
		t.Fatalf("seed: ok=%v err=%v", ok, err)
	}
	if _, ok := svc.takePending(ctx, "tok", "s"); ok {
		t.Fatal("an expired pending action must not be redeemable")
	}
}

// 容量上限：拒绝而非驱逐。驱逐会让攻击者用洪泛把管理员正在进行的操作挤掉。
func TestPutPendingRejectsAtCap(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	ctx := context.Background()
	for i := 0; i < pendingActionCap; i++ {
		if _, ok := svc.putPending(ctx, "s", "settings.update", "", url.Values{}); !ok {
			t.Fatalf("unexpected rejection at i=%d", i)
		}
	}
	if _, ok := svc.putPending(ctx, "s", "settings.update", "", url.Values{}); ok {
		t.Fatal("want rejection once the cap is reached")
	}
}

// Two Service values sharing ONE store: a pending action minted on instance A is
// redeemable on instance B, and only once (the second attempt on A fails).
func TestPendingActionSharedAndOneShotAcrossInstances(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	mk := func() *Service { return NewService(store, nil, Config{}) }
	svcA, svcB := mk(), mk()

	tok, ok := svcA.putPending(ctx, "sess", "settings.update", "", url.Values{"a": {"1"}})
	if !ok {
		t.Fatal("A: putPending failed")
	}
	if got, ok := svcB.takePending(ctx, tok, "sess"); !ok || got.action != "settings.update" {
		t.Fatalf("B must redeem the action A minted: ok=%v got=%+v", ok, got)
	}
	if _, ok := svcA.takePending(ctx, tok, "sess"); ok {
		t.Fatal("SECURITY: the action was claimable a second time on instance A")
	}
}
