package account

import (
	"net/url"
	"testing"
	"time"
)

// **最关键的一条测试。** pending token 若不绑定发起它的会话，任何拿到 token 的人
// 都能在自己的会话里兑现它 —— 步进认证被整个绕过。
func TestTakePendingRejectsADifferentSession(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok, ok := svc.putPending("session-A", "settings.update", url.Values{"a": {"1"}})
	if !ok {
		t.Fatal("putPending failed")
	}
	if _, ok := svc.takePending(tok, "session-B"); ok {
		t.Fatal("SECURITY: a pending action was redeemed from a different session")
	}
}

func TestTakePendingAcceptsTheOriginatingSession(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok, _ := svc.putPending("session-A", "settings.update", url.Values{"a": {"1"}})
	got, ok := svc.takePending(tok, "session-A")
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
	tok, _ := svc.putPending("s", "settings.update", url.Values{})
	if _, ok := svc.takePending(tok, "s"); !ok {
		t.Fatal("first redeem should succeed")
	}
	if _, ok := svc.takePending(tok, "s"); ok {
		t.Fatal("SECURITY: a pending action was redeemed twice")
	}
}

// 会话不匹配的尝试也必须烧掉 token —— 否则攻击者可以反复试探而不消耗它。
func TestWrongSessionBurnsThePendingToken(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok, _ := svc.putPending("s", "settings.update", url.Values{})
	_, _ = svc.takePending(tok, "attacker")
	if _, ok := svc.takePending(tok, "s"); ok {
		t.Fatal("a wrong-session attempt must burn the token, like takeCeremony does")
	}
}

func TestTakePendingRejectsExpired(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok, _ := svc.putPending("s", "settings.update", url.Values{})
	svc.pendingMu.Lock()
	p := svc.pendingActions[tok]
	p.expires = svc.now().Add(-time.Second)
	svc.pendingActions[tok] = p
	svc.pendingMu.Unlock()
	if _, ok := svc.takePending(tok, "s"); ok {
		t.Fatal("an expired pending action must not be redeemable")
	}
}

// 容量上限：拒绝而非驱逐。驱逐会让攻击者用洪泛把管理员正在进行的操作挤掉。
func TestPutPendingRejectsAtCap(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	for i := 0; i < pendingActionCap; i++ {
		if _, ok := svc.putPending("s", "settings.update", url.Values{}); !ok {
			t.Fatalf("unexpected rejection at i=%d", i)
		}
	}
	if _, ok := svc.putPending("s", "settings.update", url.Values{}); ok {
		t.Fatal("want rejection once the cap is reached")
	}
}
