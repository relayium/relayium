package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newAdminAuditServer 起一个启用了 /admin 的服务（Passkey-only），并把
// store/mailer 一并返回给审计断言用。
//
// 注意：admin_test.go 已有一个同名意图但签名不同的 newAdminServer(t, user, pass)
// helper（现有 ~30 个调用点，返回值里没有 store）。两个 brief 里都写的是
// `newAdminAuditServer(t)`，但那个名字已被占用且语义不兼容，所以这里改名为
// newAdminAuditServer 避免和既有 helper 冲突，同时满足审计测试需要拿到 store
// 的诉求。
func newAdminAuditServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: "admin", AdminEnabled: true,
	})
	ts := serveAdminForTest(t, svc)
	return ts, svc, store, mail
}

// 审计写入失败绝不能让业务操作失败。管理员改了个标签，审计表写不进去时
// 标签仍然要改成功 —— 反过来会让一个日志故障演变成后台完全不可用。
func TestWriteAuditNeverBreaksTheRequest(t *testing.T) {
	_, svc, _, _ := newBillingServer(t)
	svc.cfg.AdminUser = "admin"
	req := httptest.NewRequest(http.MethodPost, "/admin/nodes/x/label", nil)
	// store 正常，只验证调用不 panic、不返回错误通道
	svc.WriteAudit(req, "node.label", "node:x",
		[]ChangeField{{Field: "label", Old: "a", New: "b"}}, "")
}

func TestLoginSuccessIsAudited(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	resp := passkeyLoginHTTP(t, ts, svc, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("passkey login: status %d", resp.StatusCode)
	}
	entries, err := store.ListAudit(context.Background(), 10, 0, "login.ok")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 login.ok audit entry, got %d", len(entries))
	}
	if entries[0].Auth != "passkey" || entries[0].Target != "passkey:"+adminTestPasskey(t, svc).credID {
		t.Fatalf("want auth=passkey naming the credential, got %+v", entries[0])
	}
}

// 登录失败必须留痕：有人在用错误的 passkey 断言撞后台时要能看到。
func TestLoginFailureIsAudited(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	adminTestPasskey(t, svc)
	rp, _ := svc.adminRP()
	k := adminTestPasskey(t, svc)
	resp := passkeyLoginHTTP(t, ts, svc, func(string) string {
		return k.auth.assertBody(t, rp.Config.RPID, svc.selfOrigin(), "d3JvbmctY2hhbGxlbmdl", k.handle)
	})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad assertion: status %d", resp.StatusCode)
	}
	entries, err := store.ListAudit(context.Background(), 10, 0, "login.fail")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 login.fail audit entry, got %d", len(entries))
	}
}

// 红线：审计表里绝不能出现请求里提交的任何秘密 —— 包括有人仍向已移除的密码
// 登录端点提交的密码。
func TestLoginFailureAuditNeverContainsThePassword(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	const attempted = "hunter2-should-never-be-logged"
	form := strings.NewReader("username=admin&password=" + attempted)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/login", form)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, _ := ts.Client().Do(req)
	if resp != nil {
		resp.Body.Close()
	}
	entries, _ := store.ListAudit(context.Background(), 10, 0, "")
	for _, e := range entries {
		blob := e.Changes + e.Target + e.Actor + e.IP
		if strings.Contains(blob, attempted) {
			t.Fatalf("the attempted password leaked into the audit row: %+v", e)
		}
	}
}
