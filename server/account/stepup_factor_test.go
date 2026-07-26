package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// newStepUpServer starts an /admin-enabled service (user "admin", password
// "secret123") with the given TOTP secret ("" = TOTP off) and a test-controlled
// clock. Mutate *clk to move time — both login and step-up read s.now, so the
// same code cannot be replayed unless the clock is held still on purpose.
func newStepUpServer(t *testing.T, totpSecret string) (*httptest.Server, *Service, *SQLiteStore, *time.Time) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: "admin", AdminPassword: "secret123", AdminTOTPSecret: totpSecret,
	})
	now := time.Unix(1_700_000_000, 0)
	clk := &now
	svc.now = func() time.Time { return *clk }
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, svc, store, clk
}

// adminLoginCookieTOTP logs in with a TOTP code and returns the session cookie.
func adminLoginCookieTOTP(t *testing.T, ts *httptest.Server, code string) *http.Cookie {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.PostForm(ts.URL+"/admin/login",
		url.Values{"username": {"admin"}, "password": {"secret123"}, "totp": {code}})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			return c
		}
	}
	t.Fatalf("no admin cookie after TOTP login (status %d)", resp.StatusCode)
	return nil
}

// validSettingsForm is a fully populated settings form that passes
// handleAdminSettings's own bounds check (every field > 0 where required,
// default <= max). The test service starts with all-zero config defaults, so a
// form built from ResolveSettings would fail that check at apply time — this
// gives the apply path something it will actually accept.
func validSettingsForm(quotaMB string) url.Values {
	return url.Values{
		"max_file_size_mb":        {"100"},
		"daily_quota_mb":          {quotaMB},
		"default_ttl_hours":       {"24"},
		"max_ttl_hours":           {"168"},
		"default_retention":       {"1"},
		"default_max_downloads":   {"10"},
		"max_max_downloads":       {"100"},
		"storage_disk_cap_mb":     {"1000"},
		"node_traffic_default_gb": {"50"},
	}
}

// pendingSettingsConfirm submits a settings change (daily quota -> quotaMB),
// which is high-risk and so gets intercepted into a confirmation page, and
// returns the pending-action token from that page.
func pendingSettingsConfirm(t *testing.T, ts *httptest.Server, svc *Service, cookie *http.Cookie, quotaMB string) string {
	t.Helper()
	if err := svc.SeedSettings(t.Context()); err != nil {
		t.Fatal(err)
	}
	resp := postAdminForm(t, ts, cookie, "/admin/settings", validSettingsForm(quotaMB))
	body := readAll(t, resp)
	resp.Body.Close()
	return extractConfirmToken(t, body)
}

// 宽限期内确认高危操作无需再交第二因子 —— 确认页照样显示了 diff，但提交时不必带因子。
func TestConfirmWithinGraceNeedsNoFactor(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	svc.markStepUp(context.Background(), cookie.Value) // 开启宽限期

	tok := pendingSettingsConfirm(t, ts, svc, cookie, "999")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("grace-window confirm should apply (302), got %d", resp.StatusCode)
	}
	if got := svc.ResolveSettings(t.Context()).DailyQuota; got != 999*1024*1024 {
		t.Fatalf("grace confirm did not apply the setting; daily_quota=%d", got)
	}
}

// 宽限期内确认的审计记录，step_up 必须记成 "grace"，不能伪装成验过了真因子。
func TestGraceConfirmIsAuditedAsGrace(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	svc.markStepUp(context.Background(), cookie.Value)

	tok := pendingSettingsConfirm(t, ts, svc, cookie, "777")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	resp.Body.Close()

	entries, err := store.ListAudit(context.Background(), 10, 0, AuditSettings)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 settings.update audit entry, got %d", len(entries))
	}
	if entries[0].StepUp != StepUpGrace {
		t.Fatalf("grace confirm must be audited as %q, got %q", StepUpGrace, entries[0].StepUp)
	}
}

// 审计记录的 diff 必须是"改动前 -> 改动后"，而不能因为在写库之后才算 diff 而变成空。
// 这盯住 HandleAdminConfirm 的 before-image 取值时机。
func TestConfirmAuditRecordsTheDiff(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	svc.markStepUp(context.Background(), cookie.Value)

	tok := pendingSettingsConfirm(t, ts, svc, cookie, "333")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	resp.Body.Close()

	entries, err := store.ListAudit(context.Background(), 10, 0, AuditSettings)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 settings.update audit entry, got %d", len(entries))
	}
	// 改动前非 333MB、改动后为 333MB，diff 里必须同时含字段名和新值（存储层字节）。
	newBytes := int64(333) * 1024 * 1024
	if !strings.Contains(entries[0].Changes, SettingDailyQuota) ||
		!strings.Contains(entries[0].Changes, itoa64(newBytes)) {
		t.Fatalf("audit diff must record the field change; changes=%q", entries[0].Changes)
	}
}

// 正确密码可确认高危操作，且审计里 step_up=password。
func TestConfirmAppliesWithValidPassword(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t) // 无 TOTP、无 passkey => 因子是密码
	cookie := adminLoginCookie(t, ts)

	tok := pendingSettingsConfirm(t, ts, svc, cookie, "555")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("valid password confirm should apply (302), got %d", resp.StatusCode)
	}
	if got := svc.ResolveSettings(t.Context()).DailyQuota; got != 555*1024*1024 {
		t.Fatalf("valid password confirm did not apply; daily_quota=%d", got)
	}
	entries, _ := store.ListAudit(context.Background(), 10, 0, AuditSettings)
	if len(entries) != 1 || entries[0].StepUp != StepUpPassword {
		t.Fatalf("want one settings entry audited as password, got %+v", entries)
	}
}

// 错误密码必须拒绝，且操作不得生效。
func TestConfirmRejectsWrongPassword(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	before := svc.ResolveSettings(t.Context())

	tok := pendingSettingsConfirm(t, ts, svc, cookie, "321")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"wrong-password"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password must be rejected with 401, got %d", resp.StatusCode)
	}
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: wrong password still applied the setting")
	}
}

// 正确 TOTP 可确认，且审计里 step_up=totp。用一个比登录晚两步的时间片，
// 避免撞上登录已消费掉的那一步。
func TestConfirmAppliesWithValidTOTP(t *testing.T) {
	ts, svc, store, clk := newStepUpServer(t, testSecret)
	cookie := adminLoginCookieTOTP(t, ts, codeAt(t, *clk))

	*clk = clk.Add(60 * time.Second) // 前进两步，得到未消费的验证码
	tok := pendingSettingsConfirm(t, ts, svc, cookie, "222")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {codeAt(t, *clk)}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("valid TOTP confirm should apply (302), got %d", resp.StatusCode)
	}
	if got := svc.ResolveSettings(t.Context()).DailyQuota; got != 222*1024*1024 {
		t.Fatalf("valid TOTP confirm did not apply; daily_quota=%d", got)
	}
	entries, _ := store.ListAudit(context.Background(), 10, 0, AuditSettings)
	if len(entries) != 1 || entries[0].StepUp != StepUpTOTP {
		t.Fatalf("want one settings entry audited as totp, got %+v", entries)
	}
}

// 错误 TOTP 必须拒绝，操作不得生效。
func TestConfirmRejectsWrongTOTP(t *testing.T) {
	ts, svc, _, clk := newStepUpServer(t, testSecret)
	cookie := adminLoginCookieTOTP(t, ts, codeAt(t, *clk))
	before := svc.ResolveSettings(t.Context())

	tok := pendingSettingsConfirm(t, ts, svc, cookie, "111")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"000000"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong TOTP must be rejected with 401, got %d", resp.StatusCode)
	}
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: wrong TOTP still applied the setting")
	}
}

// TOTP 重放：登录时用掉的那一步在步进里再用一次必须失败（单调计数器语义不能被绕过）。
func TestStepUpTOTPCannotBeReplayed(t *testing.T) {
	ts, svc, _, clk := newStepUpServer(t, testSecret)
	loginCode := codeAt(t, *clk)
	cookie := adminLoginCookieTOTP(t, ts, loginCode) // 登录消费了这一步
	before := svc.ResolveSettings(t.Context())

	// 时钟保持不动：同一个码映射到同一步，步进校验必须判定为重放而拒绝。
	tok := pendingSettingsConfirm(t, ts, svc, cookie, "444")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {loginCode}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed TOTP must be rejected with 401, got %d", resp.StatusCode)
	}
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: a replayed TOTP code still applied the setting")
	}
}

// kind 混用：一个 login ceremony（login/begin 无需认证即可铸造）绝不能被拿来
// 满足 step-up 的 passkey 校验 —— 否则拿着会话 cookie 的人可以绕过第二因子。
func TestLoginCeremonyCannotSatisfyStepUp(t *testing.T) {
	ts, svc, store, _ := newStepUpServer(t, "") // 无 TOTP
	// 插一条 passkey 凭据，让 availableStepUpFactor 选中 passkey。
	if err := store.InsertAdminCredential(context.Background(), AdminCredential{
		ID: "c1", UserHandle: []byte("handle"), CredJSON: []byte("{}"),
		Name: "dev", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	cookie := adminLoginCookie(t, ts)
	before := svc.ResolveSettings(t.Context())
	tok := pendingSettingsConfirm(t, ts, svc, cookie, "666")

	// 铸一个 login 类型的 ceremony，把它的 cookie 混进 /admin/confirm。
	rec := httptest.NewRecorder()
	if !svc.putCeremony(context.Background(), rec, ceremonyLogin, webauthn.SessionData{}, "") {
		t.Fatal("putCeremony failed")
	}
	var ceremonyCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == passkeyCeremonyCookie {
			ceremonyCookie = c
		}
	}
	if ceremonyCookie == nil {
		t.Fatal("no ceremony cookie minted")
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/confirm",
		strings.NewReader(url.Values{"confirm_token": {tok}, "factor_assertion": {"{}"}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://example.test")
	req.AddCookie(cookie)
	req.AddCookie(ceremonyCookie)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: a login-kind ceremony satisfied a step-up passkey check")
	}
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: wrong-kind ceremony still applied the setting")
	}
}

// 红线（正向断言）：走完整确认流程铸一个 fleet token，其明文绝不能出现在
// admin_audit 的任何一列里 —— 审计存的是 diff，token.mint 没有字段级 diff。
func TestMintedTokenPlaintextNeverEntersAudit(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	svc.markStepUp(context.Background(), cookie.Value) // 用宽限期免因子，专注验证明文不入审计

	// 高危：铸 token 先出确认页，取出 token。
	resp := postAdminForm(t, ts, cookie, "/admin/nodes/token", url.Values{"name": {"n1"}})
	tok := extractConfirmToken(t, readAll(t, resp))
	resp.Body.Close()

	// 确认执行，铸出的明文 token 只在这一次响应里出现。
	confirmResp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	body := readAll(t, confirmResp)
	confirmResp.Body.Close()
	if confirmResp.StatusCode != http.StatusOK {
		t.Fatalf("mint confirm should render the token page (200), got %d", confirmResp.StatusCode)
	}
	plaintext := extractMintedToken(t, body)

	entries, err := store.ListAudit(context.Background(), 100, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		for _, col := range []string{e.Actor, e.IP, e.Auth, e.Action, e.Target, e.Changes, e.StepUp} {
			if strings.Contains(col, plaintext) {
				t.Fatalf("SECURITY: minted token plaintext leaked into audit column %q", col)
			}
		}
	}
	// 且这次高危铸造确实被审计了（否则上面的循环空转也会通过）。
	mints, _ := store.ListAudit(context.Background(), 10, 0, AuditTokenMint)
	if len(mints) != 1 {
		t.Fatalf("want 1 token.mint audit entry, got %d", len(mints))
	}
}

// passkey 是可用因子时，确认页必须给出 passkey ceremony（按钮 + 隐藏断言字段），
// 而不是一个填不了断言的文本框。
func TestConfirmPageOffersPasskeyCeremony(t *testing.T) {
	ts, svc, store, _ := newStepUpServer(t, "")
	if err := store.InsertAdminCredential(context.Background(), AdminCredential{
		ID: "c1", UserHandle: []byte("handle"), CredJSON: []byte("{}"), Name: "dev", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	cookie := adminLoginCookie(t, ts)
	if err := svc.SeedSettings(t.Context()); err != nil {
		t.Fatal(err)
	}
	resp := postAdminForm(t, ts, cookie, "/admin/settings", validSettingsForm("123"))
	body := readAll(t, resp)
	resp.Body.Close()

	if !strings.Contains(body, `id="passkey-confirm"`) || !strings.Contains(body, `name="factor_assertion"`) {
		t.Fatalf("passkey-factor confirm page must offer a ceremony button + assertion field; body=%s", body)
	}
	if strings.Contains(body, `name="factor_code"`) {
		t.Fatal("passkey-factor confirm page must not render the text factor input")
	}
}

// TOTP 是可用因子时，确认页给出文本验证码输入框。
func TestConfirmPagePromptsTextFactorForTOTP(t *testing.T) {
	ts, svc, _, clk := newStepUpServer(t, testSecret)
	cookie := adminLoginCookieTOTP(t, ts, codeAt(t, *clk))
	if err := svc.SeedSettings(t.Context()); err != nil {
		t.Fatal(err)
	}
	resp := postAdminForm(t, ts, cookie, "/admin/settings", validSettingsForm("123"))
	body := readAll(t, resp)
	resp.Body.Close()

	if !strings.Contains(body, `name="factor_code"`) {
		t.Fatalf("TOTP-factor confirm page must render a text factor input; body=%s", body)
	}
	if strings.Contains(body, `id="passkey-confirm"`) {
		t.Fatal("TOTP-factor confirm page must not render a passkey ceremony button")
	}
}

// extractMintedToken pulls the one-time plaintext token out of the minted-token
// panel (<pre>{{.MintedToken}}</pre>, the first <pre> after class="minted").
func extractMintedToken(t *testing.T, body string) string {
	t.Helper()
	m := strings.Index(body, `class="minted"`)
	if m < 0 {
		t.Fatalf("no minted-token panel in body: %s", body)
	}
	rest := body[m:]
	open := strings.Index(rest, "<pre>")
	if open < 0 {
		t.Fatalf("no <pre> in minted panel: %s", rest)
	}
	rest = rest[open+len("<pre>"):]
	close := strings.Index(rest, "</pre>")
	if close < 0 {
		t.Fatalf("malformed minted <pre>: %s", rest)
	}
	tok := strings.TrimSpace(rest[:close])
	if tok == "" {
		t.Fatal("minted token was empty")
	}
	return tok
}
