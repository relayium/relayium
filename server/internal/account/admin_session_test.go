package account

import "testing"

func TestAdminSessionRecordsAuthMethod(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok := svc.newAdminSession("passkey")
	svc.adminMu.Lock()
	sess := svc.adminSessions[tok]
	svc.adminMu.Unlock()
	if sess.auth != "passkey" {
		t.Fatalf("want auth=passkey, got %q", sess.auth)
	}
}

// 宽限期：刚验过 → 新鲜；从未验过 → 不新鲜。
func TestStepUpFreshness(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok := svc.newAdminSession("password")
	if svc.stepUpFresh(tok) {
		t.Fatal("a brand-new session must NOT be step-up fresh")
	}
	svc.markStepUp(tok)
	if !svc.stepUpFresh(tok) {
		t.Fatal("want fresh right after markStepUp")
	}
}

// 宽限期必须真的会过期，否则一次验证就永久免验，等于没有步进。
func TestStepUpGraceExpires(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok := svc.newAdminSession("password")
	svc.markStepUp(tok)
	svc.adminMu.Lock()
	sess := svc.adminSessions[tok]
	sess.lastStepUpAt = svc.now().Unix() - int64(stepUpGraceSecs) - 1
	svc.adminSessions[tok] = sess
	svc.adminMu.Unlock()
	if svc.stepUpFresh(tok) {
		t.Fatal("a step-up older than the grace window must not count as fresh")
	}
}

// 会话过期仍必须照常生效（原有行为不能被结构改造破坏）。
func TestAdminSessionStillExpires(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	tok := svc.newAdminSession("password")
	svc.adminMu.Lock()
	sess := svc.adminSessions[tok]
	sess.expires = svc.now().Unix() - 1
	svc.adminSessions[tok] = sess
	svc.adminMu.Unlock()
	if svc.validAdmin(tok) {
		t.Fatal("an expired session must not validate")
	}
}
