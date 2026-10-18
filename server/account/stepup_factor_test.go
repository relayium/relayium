package account

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// newStepUpServer starts an /admin-enabled service (user "admin") with a
// test-controlled clock. Mutate *clk to move time.
func newStepUpServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *time.Time) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: "admin", AdminEnabled: true,
	})
	now := time.Unix(1_700_000_000, 0)
	clk := &now
	svc.now = func() time.Time { return *clk }
	ts := serveAdminForTest(t, svc)
	return ts, svc, store, clk
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
	markStepUpForTest(t, svc, cookie.Value) // 开启宽限期

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
	markStepUpForTest(t, svc, cookie.Value)

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
	markStepUpForTest(t, svc, cookie.Value)

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

// A real passkey assertion confirms a high-risk action, audited as passkey.
func TestConfirmAppliesWithValidPasskey(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)

	tok := pendingSettingsConfirm(t, ts, svc, cookie, "555")
	resp := confirmWithPasskey(t, ts, svc, cookie, tok)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("valid passkey confirm should apply (302), got %d", resp.StatusCode)
	}
	if got := svc.ResolveSettings(t.Context()).DailyQuota; got != 555*1024*1024 {
		t.Fatalf("valid passkey confirm did not apply; daily_quota=%d", got)
	}
	entries, _ := store.ListAudit(context.Background(), 10, 0, AuditSettings)
	if len(entries) != 1 || entries[0].StepUp != StepUpPasskey || entries[0].Auth != "passkey" {
		t.Fatalf("want one settings entry audited as passkey/passkey, got %+v", entries)
	}
}

// The old text factors are gone: a password or a 6-digit code in factor_code
// is ignored and the action is refused — there is no fallback to anything
// weaker than a passkey.
func TestConfirmIgnoresPasswordAndTOTPFields(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	before := svc.ResolveSettings(t.Context())
	for _, code := range []string{"secret123", "123456", ""} {
		tok := pendingSettingsConfirm(t, ts, svc, cookie, "321")
		resp := postAdminForm(t, ts, cookie, "/admin/confirm",
			url.Values{"confirm_token": {tok}, "factor_code": {code}})
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("factor_code %q: status %d, want 401", code, resp.StatusCode)
		}
	}
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: a non-passkey factor applied the setting")
	}
}

// An assertion signed by a key that is not registered (or by the right key
// over the wrong challenge) is refused.
func TestConfirmRejectsForeignOrStaleAssertion(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	before := svc.ResolveSettings(t.Context())
	k := adminTestPasskey(t, svc)
	rp, _ := svc.adminRP()

	for name, forge := range map[string]func(challenge string) string{
		"unregistered key": func(c string) string {
			return newTestAuthenticator(t).assertBody(t, rp.Config.RPID, svc.selfOrigin(), c, k.handle)
		},
		"wrong challenge": func(string) string {
			return k.auth.assertBody(t, rp.Config.RPID, svc.selfOrigin(), "d3JvbmctY2hhbGxlbmdl", k.handle)
		},
		"foreign origin": func(c string) string {
			return k.auth.assertBody(t, rp.Config.RPID, "https://evil.example", c, k.handle)
		},
	} {
		tok := pendingSettingsConfirm(t, ts, svc, cookie, "321")
		cer, good := passkeyStepUp(t, ts, svc, cookie)
		var parsed struct {
			Response struct {
				ClientDataJSON string `json:"clientDataJSON"`
			} `json:"response"`
		}
		_ = json.Unmarshal([]byte(good), &parsed)
		cd, _ := base64.RawURLEncoding.DecodeString(parsed.Response.ClientDataJSON)
		var cdj struct {
			Challenge string `json:"challenge"`
		}
		_ = json.Unmarshal(cd, &cdj)
		form := url.Values{"confirm_token": {tok}, "factor_assertion": {forge(cdj.Challenge)}}
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/confirm", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", "http://example.test")
		req.AddCookie(cookie)
		req.AddCookie(cer)
		client := ts.Client()
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s: status %d, want 401", name, resp.StatusCode)
		}
	}
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: a forged assertion applied the setting")
	}
}

// Zero registered passkeys: nothing can confirm a high-risk action, and the
// factor selector says so instead of falling back to anything.
func TestHighRiskWithZeroPasskeysHasNoFallback(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	tok := pendingSettingsConfirm(t, ts, svc, cookie, "432")
	before := svc.ResolveSettings(t.Context())
	if _, err := store.db.Exec(`DELETE FROM admin_credentials`); err != nil {
		t.Fatal(err)
	}
	if got := svc.availableStepUpFactor(context.Background()); got != StepUpNone {
		t.Fatalf("factor with zero passkeys = %q, want none", got)
	}
	// verifyStepUpFactor itself refuses every text factor.
	for _, code := range []string{"secret123", "123456"} {
		r := httptest.NewRequest("POST", "/admin/confirm", strings.NewReader(url.Values{"factor_code": {code}}.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if f, _, ok := svc.verifyStepUpFactor(r, pendingAction{sessionTok: cookie.Value}); ok {
			t.Fatalf("zero-passkey step-up accepted %q as %q", code, f)
		}
	}
	// And over HTTP the session is gone with its credential, so nothing applies.
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatalf("zero-passkey confirm: status %d, quota changed=%v", resp.StatusCode,
			svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota)
	}
}

// A revoked passkey takes its session's grace window with it: no cached
// step-up survives the revocation, even mid-confirmation.
func TestRevokedPasskeyLeavesNoCachedStepUp(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	markStepUpForTest(t, svc, cookie.Value)
	tok := pendingSettingsConfirm(t, ts, svc, cookie, "654")
	before := svc.ResolveSettings(t.Context())
	k := adminTestPasskey(t, svc)
	if _, err := store.AdminAuth().RevokeCredential(context.Background(), k.credID, true, svc.now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	resp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	resp.Body.Close()
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: a confirmation applied after its passkey was revoked")
	}
	if _, _, _, _, _, ok, _ := store.TakePendingAction(context.Background(), tok); ok {
		t.Fatal("revocation left the session's pending confirmation behind")
	}
}

// kind 混用：一个 login ceremony（login/begin 无需认证即可铸造）绝不能被拿来
// 满足 step-up 的 passkey 校验 —— 否则拿着会话 cookie 的人可以绕过第二因子。
func TestLoginCeremonyCannotSatisfyStepUp(t *testing.T) {
	ts, svc, _, _ := newStepUpServer(t)
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
	markStepUpForTest(t, svc, cookie.Value) // 用宽限期免因子，专注验证明文不入审计

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
	ts, svc, _, _ := newStepUpServer(t)
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

// No confirmation page ever renders a text factor input any more.
func TestConfirmPageNeverRendersTextFactor(t *testing.T) {
	ts, svc, _, _ := newStepUpServer(t)
	cookie := adminLoginCookie(t, ts)
	if err := svc.SeedSettings(t.Context()); err != nil {
		t.Fatal(err)
	}
	resp := postAdminForm(t, ts, cookie, "/admin/settings", validSettingsForm("123"))
	body := readAll(t, resp)
	resp.Body.Close()
	for _, gone := range []string{`name="factor_code"`, `type="password"`, "TOTP"} {
		if strings.Contains(body, gone) {
			t.Fatalf("confirm page still renders %s", gone)
		}
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
