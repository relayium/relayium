package account

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fetchAdminLogin GETs /admin with no session, which renders the login page.
func fetchAdminLogin(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + "/admin")
	if err != nil {
		t.Fatalf("get /admin: %v", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(b)
}

// fetchAdminHome GETs /admin with a session, which renders the dashboard.
func fetchAdminHome(t *testing.T, srv *httptest.Server, session *http.Cookie) string {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/admin", nil)
	req.AddCookie(session)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("get /admin: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get /admin: status=%d want 200", resp.StatusCode)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(b)
}

// 登录页在任何存储状态下都必须渲染得出来；没有存储可问时不提供 passkey 按钮，
// 也绝不退回任何密码表单。
func TestLoginPageRendersWithoutStore(t *testing.T) {
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminEnabled: true})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/admin", nil)
	s.renderAdminLogin(w, r, http.StatusOK, "", s.AdminPasskeyCount(r.Context()) > 0)

	body := w.Body.String()
	if strings.Contains(body, `name="password"`) || strings.Contains(body, `action="/admin/login"`) {
		t.Fatalf("a password form came back when the store is unavailable")
	}
	if strings.Contains(body, "passkey-login") {
		t.Fatalf("passkey button offered with no store to confirm credentials exist")
	}
	if !strings.Contains(body, "relayium-server admin enroll start") {
		t.Fatalf("login page does not tell the operator how to enroll a passkey")
	}
}

// 没有注册任何 passkey 时不得渲染 passkey 按钮（点了只会失败），而是说明如何在
// 服务器上注册；也没有任何密码后备。
func TestLoginPageHidesPasskeyButtonWhenNoneRegistered(t *testing.T) {
	srv, _ := newAdminServer(t, "admin", "on")
	html := fetchAdminLogin(t, srv)
	if strings.Contains(html, "passkey-login") {
		t.Fatalf("passkey button rendered with zero credentials registered")
	}
	if strings.Contains(html, `name="password"`) {
		t.Fatalf("password form rendered on the Passkey-only login page")
	}
	if !strings.Contains(html, "relayium-server admin enroll start") {
		t.Fatalf("zero-passkey login page does not explain enrollment")
	}
}

// 有凭据时登录页只有 passkey 按钮：没有账号/密码/验证码字段。
func TestLoginPageIsPasskeyOnly(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "on")
	adminTestPasskey(t, s)

	html := fetchAdminLogin(t, srv)
	if !strings.Contains(html, "passkey-login") {
		t.Fatalf("passkey button missing with a registered credential")
	}
	for _, gone := range []string{`name="password"`, `name="username"`, `name="totp"`, `action="/admin/login"`} {
		if strings.Contains(html, gone) {
			t.Fatalf("login page still renders %s", gone)
		}
	}
	// 取消平台弹窗是正常操作，不该报红：这条分支必须存在。
	if !strings.Contains(html, "NotAllowedError") {
		t.Fatalf("cancel (NotAllowedError) branch missing from login script")
	}
	assertPasskeyB64(t, html, "login page")
}

// assertPasskeyB64 checks the shared base64url helpers actually landed in the
// page. They live in one {{define}} block associated with both templates; a
// page that lost the association would render a script that calls dec/enc
// without ever defining them, and every other assertion here would still pass.
func assertPasskeyB64(t *testing.T, html, where string) {
	t.Helper()
	for _, fn := range []string{"function dec(", "function enc("} {
		if !strings.Contains(html, fn) {
			t.Fatalf("%s: shared passkey helper %q missing from rendered script", where, fn)
		}
	}
}

// 后台列出已注册凭据（名称、ID、指纹），但只读：没有删除或添加控件。
func TestAdminHomeListsPasskeysReadOnly(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "on")
	k := adminTestPasskey(t, s)
	session := adminSessionCookie(t, s)
	// A second, never-used credential with a distinctive name.
	other := newRealAdminCredential(t, s, newTestAuthenticator(t), k.handle, "我的-MacBook")
	seedAdminCredentialRow(t, s.store, other)

	html := fetchAdminHome(t, srv, session)
	if !strings.Contains(html, "我的-MacBook") || !strings.Contains(html, other.ID) {
		t.Fatalf("registered passkey not listed on admin home")
	}
	if !strings.Contains(html, AdminCredentialFingerprint(other)) {
		t.Fatalf("passkey fingerprint not shown")
	}
	// 尚未用过的凭据必须显眼地标为「从未使用」——被植入的后门凭据正是靠这一列现形的。
	if !strings.Contains(html, `<span class="never">从未使用</span>`) {
		t.Fatalf("never-used credential not visually marked (class=never) as such")
	}
	for _, gone := range []string{"/admin/passkey/delete", "/admin/passkey/register", `id="passkey-add"`} {
		if strings.Contains(html, gone) {
			t.Fatalf("admin home still renders browser credential management (%s)", gone)
		}
	}
	if !strings.Contains(html, "relayium-server admin credentials revoke") {
		t.Fatalf("admin home does not point at the terminal for credential management")
	}
}

// passkeyListFailStore 只让凭据查询失败，其余照常，用来模拟局部 DB 故障。
type passkeyListFailStore struct {
	Store
}

func (passkeyListFailStore) ListAdminCredentials(context.Context) ([]AdminCredential, error) {
	return nil, errors.New("simulated passkey read failure")
}

// 凭据读失败时：整页不能 500（用户列表/节点/套餐正是此刻要用的），
// 但也绝不能拿一张空表冒充「零凭据」——那会把被植入的凭据藏起来。
func TestAdminHomeShowsPasskeyReadFailureInsteadOfEmptyList(t *testing.T) {
	store := newTestStore(t)
	_, _ = store.UpsertUserByEmail(context.Background(), "seen@example.com", "Seen")
	svc := NewService(passkeyListFailStore{store}, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: "admin", AdminEnabled: true,
	})
	srv := serveAdminForTest(t, svc)

	// The wrapper store fails only the credential LIST; seed through the real
	// store underneath so the session itself is valid.
	session := adminSessionCookie(t, NewService(store, nil, Config{BaseURL: "http://example.test", AdminUser: "admin", AdminEnabled: true}))
	// fetchAdminHome 对非 200 直接 fatal：读失败不得把整个后台打挂。
	html := fetchAdminHome(t, srv, session)
	if !strings.Contains(html, "凭据列表读取失败") {
		t.Fatalf("failed credential read did not render an explicit error state")
	}
	if strings.Contains(html, "尚未添加 passkey") {
		t.Fatalf("failed read rendered the empty state — indistinguishable from zero credentials")
	}
	// 页面其余部分必须完好，否则就退回成了变相的 500。
	if !strings.Contains(html, "总用户数") {
		t.Fatalf("overview metrics lost — passkey read failure should degrade only its own section")
	}
}

// 凭据表为空的后台页（会话来自另一实例刚撤销前的瞬间不可能出现，这里直接渲染模板）
// 给出空态提示。
func TestAdminHomeShowsEmptyPasskeyState(t *testing.T) {
	var sb strings.Builder
	if err := adminUsersTmpl.Execute(&sb, adminHomeData{Section: adminSectionOverview}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sb.String(), "尚未添加 passkey") {
		t.Fatalf("empty passkey state missing from admin home")
	}
}
