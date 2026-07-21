package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// adminPasswordLogin logs in through the password path and returns the session cookie.
func adminPasswordLogin(t *testing.T, srv *httptest.Server, s *Service) *http.Cookie {
	t.Helper()
	// The login handler answers with a redirect to /admin; without this the
	// client would follow it and resp.Cookies() would read the dashboard's
	// (cookie-less) response instead of the login one.
	srv.Client().CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	req, _ := http.NewRequest("POST", srv.URL+"/admin/login",
		strings.NewReader("username=admin&password=pw"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("password login: %v", err)
	}
	defer resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			return c
		}
	}
	t.Fatalf("no admin session cookie")
	return nil
}

// registerViaHTTP drives a full register begin+finish through the HTTP endpoints.
func registerViaHTTP(t *testing.T, srv *httptest.Server, s *Service, session *http.Cookie, name string) {
	t.Helper()
	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name="+url.QueryEscape(name)))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("register begin: %v", err)
	}
	// Check begin before touching its body: a 503 (ceremony cap) or 401 (step-up)
	// here otherwise resurfaces as an opaque 400 from finish, pointing at the
	// wrong endpoint entirely.
	if bresp.StatusCode != http.StatusOK {
		bresp.Body.Close()
		t.Fatalf("register begin %q: status=%d want 200", name, bresp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(bresp.Body).Decode(&opts); err != nil {
		bresp.Body.Close()
		t.Fatalf("register begin %q: decode: %v", name, err)
	}
	cookies := bresp.Cookies()
	bresp.Body.Close()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("register begin %q: empty challenge", name)
	}

	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	freq.AddCookie(session)
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("register finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("register finish %q: status=%d", name, fresp.StatusCode)
	}
}

// step-up 是本功能最重要的安全边界：仅凭已登录会话不得注册新 passkey，
// 否则一次会话 cookie 泄露即可升级为永久后门。
func TestPasskeyRegisterRequiresStepUp(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")

	// 先用密码登录拿到管理员会话
	session := adminPasswordLogin(t, srv, s)

	// 有会话但不带密码 → 必须被拒
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("name=Laptop"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	req.AddCookie(session)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("register/begin succeeded with session only — step-up not enforced")
	}

	// 带正确密码 → 放行
	ok, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=Laptop"))
	ok.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	ok.Header.Set("Origin", s.selfOrigin())
	ok.AddCookie(session)
	okResp, err := srv.Client().Do(ok)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK {
		t.Fatalf("register/begin with correct creds: status=%d want 200", okResp.StatusCode)
	}
}

// step-up 是完整的密码+TOTP 复验：开了 TOTP 时，光有密码不够。
func TestPasskeyRegisterStepUpHonorsTOTP(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	s.cfg.AdminTOTPSecret = testSecret
	// A session is pinned to the credentials in force when it was minted (cred_fp),
	// so enabling TOTP invalidates the pre-TOTP session — exactly as a real admin
	// would set the secret at startup and log in after. Re-mint under the new
	// credentials so this test exercises the register/begin TOTP check, not
	// credential-rotation revocation (covered elsewhere).
	tok, err := s.newAdminSession(context.Background(), "password")
	if err != nil {
		t.Fatal(err)
	}
	session = &http.Cookie{Name: adminCookie, Value: tok}

	begin := func(form string) int {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
			strings.NewReader(form))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", s.selfOrigin())
		req.AddCookie(session)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	if code := begin("username=admin&password=pw&name=Laptop"); code == http.StatusOK {
		t.Fatalf("register/begin accepted a missing TOTP code while TOTP is on")
	}
	if code := begin("username=admin&password=pw&totp=000000&name=Laptop"); code == http.StatusOK {
		t.Fatalf("register/begin accepted a wrong TOTP code")
	}
	form := "username=admin&password=pw&name=Laptop&totp=" + codeAt(t, s.now())
	if code := begin(form); code != http.StatusOK {
		t.Fatalf("register/begin with a valid TOTP code: status=%d want 200", code)
	}
	// The step must have been consumed, so the same code cannot be replayed.
	if code := begin(form); code == http.StatusOK {
		t.Fatalf("register/begin replayed an already-used TOTP code")
	}
}

// 未登录会话根本不能碰注册端点。
func TestPasskeyRegisterRequiresSession(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=Laptop"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("register/begin succeeded without an admin session")
	}
}

// 完整注册往返：begin(step-up) → authenticator → finish → 入库。
func TestPasskeyRegisterEndToEnd(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=MacBook"))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&opts)
	bresp.Body.Close()
	cookies := bresp.Cookies()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("empty challenge")
	}

	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	body := auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(body))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	freq.AddCookie(session)
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finish status=%d want 200", fresp.StatusCode)
	}

	rows, err := s.store.ListAdminCredentials(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("stored %d credentials err=%v, want 1", len(rows), err)
	}
	if rows[0].Name != "MacBook" {
		t.Fatalf("name=%q want MacBook", rows[0].Name)
	}
	if len(rows[0].UserHandle) != 32 {
		t.Fatalf("user handle len=%d want 32", len(rows[0].UserHandle))
	}
}

// 第二枚凭据必须复用同一 user handle。
func TestPasskeyRegisterReusesUserHandle(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "第一台")
	registerViaHTTP(t, srv, s, session, "第二台")

	rows, _ := s.store.ListAdminCredentials(context.Background())
	if len(rows) != 2 {
		t.Fatalf("got %d credentials, want 2", len(rows))
	}
	if string(rows[0].UserHandle) != string(rows[1].UserHandle) {
		t.Fatalf("user handle differs between credentials")
	}
}

// 改掉管理员用户名后，已注册的 passkey 必须仍然可用。
func TestPasskeySurvivesAdminUsernameChange(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")

	before, _, _ := s.store.AdminUserHandle(context.Background())
	s.cfg.AdminUser = "someone-else"
	user, err := s.loadAdminPasskeyUser(context.Background())
	if err != nil {
		t.Fatalf("load after rename: %v", err)
	}
	if string(user.handle) != string(before) {
		t.Fatalf("user handle changed with admin username")
	}
	if len(user.creds) != 1 {
		t.Fatalf("credentials lost after rename: %d", len(user.creds))
	}
}

// ceremonyErr 读出 JSON 错误体里的 error 字段。跨 kind 的断言必须落到具体消息上：
// register/finish 对"ceremony 取不到/kind 不对"和"attestation 验签失败"都返回 400，
// 单看状态码无法区分二者，而这两者的差别正是本组测试存在的理由。
func ceremonyErr(t *testing.T, resp *http.Response) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return body.Error
}

// 本功能最重要的安全边界：仅凭一枚被盗的管理员会话不得注册新 passkey。
// login/begin 完全不需要认证，所以攻击者可以在那里免费铸一枚 ceremony，再拿去
// register/finish 兑换 —— 若 ceremony 不区分种类，这条路径就绕开了 step-up，
// 一次会话泄露即升级为永久后门。
//
// 断言必须精确到"注册已过期，请重试"（kind/takeCeremony 拒绝路径的唯一消息），
// 不能用宽松的 != 200：登录 ceremony 的 SessionData.CredParams 是空的，
// attestation 会顺带以"algorithm not supported"失败，同样返回 400。那是
// go-webauthn 的实现细节而非我们的检查，换个默认填充 CredParams 的版本就会
// 悄悄失效。拿掉 kind 检查后，这条断言必须变红。
func TestPasskeyLoginCeremonyCannotBeSpentAtRegisterFinish(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)

	// 无需任何认证即可拿到一枚登录 ceremony
	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", s.selfOrigin())
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("login begin: %v", err)
	}
	if bresp.StatusCode != http.StatusOK {
		bresp.Body.Close()
		t.Fatalf("login begin status=%d want 200", bresp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(bresp.Body).Decode(&opts); err != nil {
		bresp.Body.Close()
		t.Fatalf("login begin decode: %v", err)
	}
	cookies := bresp.Cookies()
	bresp.Body.Close()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("empty challenge")
	}

	// 用被盗会话 + 登录 ceremony 去兑换注册
	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	freq.AddCookie(session)
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("register finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusBadRequest {
		t.Fatalf("cross-kind register/finish status=%d want 400", fresp.StatusCode)
	}
	if msg := ceremonyErr(t, fresp); msg != "注册已过期，请重试" {
		t.Fatalf("cross-kind register/finish error=%q, want %q — a different message means the "+
			"ceremony kind check did not reject this; attestation (or something else) did, which is "+
			"exactly the incidental defense this test exists to replace",
			msg, "注册已过期，请重试")
	}

	// 绝不能有凭据落库
	rows, _ := s.store.ListAdminCredentials(context.Background())
	if len(rows) != 0 {
		t.Fatalf("a credential was registered via a login ceremony: %d rows", len(rows))
	}
}

// 反方向同样必须关死：注册 ceremony 不得在 login/finish 兑换成管理员会话。
// （这一向另有 ValidatePasskeyLogin 对非空 UserID 的拒绝兜底，但那同样是库的
// 实现细节，这里断言的是我们自己的 kind 检查。）
func TestPasskeyRegisterCeremonyCannotBeSpentAtLoginFinish(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	// 先注册一枚真实凭据，好让 login/finish 在 kind 检查之外本可以走通
	auth, handle := registerTestPasskey(t, s)
	session := adminPasswordLogin(t, srv, s)

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=Laptop"))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("register begin: %v", err)
	}
	if bresp.StatusCode != http.StatusOK {
		bresp.Body.Close()
		t.Fatalf("register begin status=%d want 200", bresp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(bresp.Body).Decode(&opts); err != nil {
		bresp.Body.Close()
		t.Fatalf("register begin decode: %v", err)
	}
	cookies := bresp.Cookies()
	bresp.Body.Close()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("empty challenge")
	}

	rp, _ := s.adminRP()
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
		strings.NewReader(auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge, handle)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("login finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusBadRequest {
		t.Fatalf("cross-kind login/finish status=%d want 400", fresp.StatusCode)
	}
	for _, c := range fresp.Cookies() {
		if c.Name == adminCookie && c.Value != "" {
			t.Fatalf("a register ceremony minted an admin session at login/finish")
		}
	}
	if msg := ceremonyErr(t, fresp); msg != "验证已过期，请重试" {
		t.Fatalf("cross-kind login/finish error=%q, want %q — a different message means something "+
			"other than the ceremony kind check rejected this", msg, "验证已过期，请重试")
	}
}

// 跨 kind 的尝试必须同样消费掉 ceremony：错一次就作废，不得换个端点重试。
func TestPasskeyCrossKindAttemptConsumesCeremony(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", s.selfOrigin())
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("login begin: %v", err)
	}
	// begin 必须真的成功过。若它返回 429/503，压根就不会有 ceremony 被建出来，
	// 末尾那句 len(...)==0 会因为完全无关的理由通过——这个测试守的是安全边界，
	// 不能允许它空转。
	if bresp.StatusCode != http.StatusOK {
		bresp.Body.Close()
		t.Fatalf("login begin: status=%d want 200", bresp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&opts)
	cookies := bresp.Cookies()
	bresp.Body.Close()

	// 用错之前先确认确实有且只有这一枚 ceremony 在飞：这样末尾的 0 才代表
	// "被吃掉了"，而不是"从来没有过"。
	if before := ceremonyCount(t, s); before != 1 {
		t.Fatalf("before cross-kind attempt: %d ceremonies alive, want exactly 1", before)
	}

	// 先拿去 register/finish 用错（被拒），ceremony 应当已被吃掉
	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	wrong, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)))
	wrong.Header.Set("Content-Type", "application/json")
	wrong.Header.Set("Origin", s.selfOrigin())
	wrong.AddCookie(session)
	for _, c := range cookies {
		wrong.AddCookie(c)
	}
	wresp, err := srv.Client().Do(wrong)
	if err != nil {
		t.Fatalf("register finish: %v", err)
	}
	// 必须是 kind 判别器那条 400（"注册已过期，请重试"）。只断言"非 200"是不够的：
	// 401（未登录）、400（真的验签失败）都能让宽松断言过关，而那两条都说明请求
	// 死在了别处，根本没触到跨 kind 这道门。
	var werr struct {
		Error string `json:"error"`
	}
	json.NewDecoder(wresp.Body).Decode(&werr)
	wresp.Body.Close()
	if wresp.StatusCode != http.StatusBadRequest {
		t.Fatalf("cross-kind register/finish: status=%d want 400", wresp.StatusCode)
	}
	if werr.Error != "注册已过期，请重试" {
		t.Fatalf("cross-kind register/finish: error=%q want %q (a different message means the "+
			"request was rejected somewhere other than the ceremony-kind check)",
			werr.Error, "注册已过期，请重试")
	}

	// 同一枚 ceremony 现在连它本来的用途也不该再能用
	if n := ceremonyCount(t, s); n != 0 {
		t.Fatalf("cross-kind attempt left %d ceremonies alive; it must consume like any other finish", n)
	}
}

// 第二次注册必须把已有凭据放进 excludeCredentials 下发。
//
// 平台认证器在同一个 (rpID, user.id) 下再造一枚 resident 凭据时，是「替换」而不是
// 「新增」：旧凭据在设备上没了，返回的却是一个新 credential ID，于是库里那行旧记录
// 永远留着且 last_used_at = 0。而「从未使用」正是本功能识别被植入凭据的唯一信号，
// 所以一次无心的重复注册就会在唯一的入侵探测器上制造出永久误报。
// go-webauthn 的 BeginRegistration 不会自己填 CredentialExcludeList，
// 只有 webauthn.WithExclusions 会——这个测试盯的就是那一个选项。
func TestPasskeyRegisterExcludesExistingCredentials(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")

	rows, err := s.store.ListAdminCredentials(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("setup: rows=%d err=%v want exactly 1 credential", len(rows), err)
	}
	existingID := rows[0].ID

	// 再发起一次注册，只看 begin 下发的创建参数，不必走完 finish。
	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name="+url.QueryEscape("第二台")))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("second register begin: %v", err)
	}
	defer bresp.Body.Close()
	if bresp.StatusCode != http.StatusOK {
		t.Fatalf("second register begin: status=%d want 200", bresp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			ExcludeCredentials []struct {
				ID string `json:"id"`
			} `json:"excludeCredentials"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(bresp.Body).Decode(&opts); err != nil {
		t.Fatalf("decode creation options: %v", err)
	}

	if len(opts.PublicKey.ExcludeCredentials) == 0 {
		t.Fatalf("second registration sent no excludeCredentials; the authenticator would " +
			"silently replace the existing resident credential and strand its DB row at " +
			"last_used_at = 0 (a permanent false positive on the planted-credential signal)")
	}
	var found bool
	for _, c := range opts.PublicKey.ExcludeCredentials {
		if c.ID == existingID {
			found = true
		}
	}
	if !found {
		t.Fatalf("excludeCredentials %v does not carry the registered credential %q",
			opts.PublicKey.ExcludeCredentials, existingID)
	}
}

// 删除必须要求已登录会话，且成功后凭据消失。
func TestPasskeyDelete(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")
	rows, _ := s.store.ListAdminCredentials(context.Background())
	id := rows[0].ID

	// 无会话 → 拒绝
	noAuth, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/delete",
		strings.NewReader("id="+url.QueryEscape(id)))
	noAuth.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	noAuth.Header.Set("Origin", s.selfOrigin())
	nresp, _ := srv.Client().Do(noAuth)
	nresp.Body.Close()
	rows, _ = s.store.ListAdminCredentials(context.Background())
	if len(rows) != 1 {
		t.Fatalf("credential deleted without a session")
	}

	// 有会话 → 删除。
	//
	// Calls handleAdminPasskeyDelete directly rather than through the real
	// POST /admin/passkey/delete route: that route now sits behind
	// requireStepUp (Task 7 gates passkey deletion as high-risk — see the
	// doc comment on handleAdminPasskeyDelete), which renders a confirmation
	// page instead of deleting anything. This asserts the handler's own
	// deletion logic; the route's step-up gating is covered by
	// stepup_test.go.
	req, _ := http.NewRequest("POST", "/admin/passkey/delete",
		strings.NewReader("id="+url.QueryEscape(id)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(session)
	w := httptest.NewRecorder()
	s.handleAdminPasskeyDelete(w, req)
	rows, _ = s.store.ListAdminCredentials(context.Background())
	if len(rows) != 0 {
		t.Fatalf("credential still present after delete: %d", len(rows))
	}
}
