package account

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

// 登录页在任何存储状态下都必须渲染得出来：密码+TOTP 是兜底通道，
// 查 passkey 数量这一步绝不能把它打挂。
func TestLoginPageRendersWithoutStore(t *testing.T) {
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/admin", nil)
	s.renderAdminLogin(w, http.StatusOK, "", s.adminPasskeyCount(r.Context()) > 0)

	body := w.Body.String()
	if !strings.Contains(body, `name="password"`) {
		t.Fatalf("password form missing when store is unavailable")
	}
	if strings.Contains(body, "passkey-login") {
		t.Fatalf("passkey button offered with no store to confirm credentials exist")
	}
}

// 没有注册任何 passkey 时不得渲染 passkey 按钮：点了只会得到
// 「无可用凭据」，等于给一条死路。
func TestLoginPageHidesPasskeyButtonWhenNoneRegistered(t *testing.T) {
	srv, _ := newAdminServer(t, "admin", "pw")
	html := fetchAdminLogin(t, srv)
	if strings.Contains(html, "passkey-login") {
		t.Fatalf("passkey button rendered with zero credentials registered")
	}
	// 密码表单必须在
	if !strings.Contains(html, `name="password"`) {
		t.Fatalf("password form missing")
	}
}

// 注册后按钮出现，但密码表单必须原样保留（渐进增强，绝不砸旧路径）。
func TestLoginPageShowsPasskeyButtonAndKeepsPasswordForm(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")

	html := fetchAdminLogin(t, srv)
	if !strings.Contains(html, "passkey-login") {
		t.Fatalf("passkey button missing after registration")
	}
	if !strings.Contains(html, `name="password"`) {
		t.Fatalf("password form disappeared — progressive enhancement broken")
	}
	if !strings.Contains(html, `name="username"`) {
		t.Fatalf("username field disappeared")
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

// 设置页必须列出已注册凭据及其名字。
func TestAdminHomeListsPasskeys(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "我的-MacBook")

	html := fetchAdminHome(t, srv, session)
	if !strings.Contains(html, "我的-MacBook") {
		t.Fatalf("registered passkey not listed on admin home")
	}
	// 刚注册、尚未用过的凭据必须显眼地标为「从未使用」——被植入的
	// 后门凭据正是靠这一列现形的。
	if !strings.Contains(html, "从未使用") {
		t.Fatalf("never-used credential not marked as such")
	}
}

// 后台页没有凭据时也必须能打开，并给出空态提示。
func TestAdminHomeShowsEmptyPasskeyState(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)

	html := fetchAdminHome(t, srv, session)
	if !strings.Contains(html, "尚未添加 passkey") {
		t.Fatalf("empty passkey state missing from admin home")
	}
	// 添加表单默认 hidden，只有 JS 确认浏览器支持 WebAuthn 后才揭开——
	// 否则等于摆一个按了必然失败的控件。
	if !strings.Contains(html, `id="passkey-add" class="mint" hidden`) {
		t.Fatalf("add-passkey form should ship hidden and be revealed by JS")
	}
	assertPasskeyB64(t, html, "admin home")
}
