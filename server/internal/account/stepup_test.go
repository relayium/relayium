package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// adminLoginCookie logs into the admin dashboard seeded by newAdminAuditServer
// (user "admin", password "secret123") and returns the resulting session
// cookie. No Origin header is sent, matching admin_test.go's adminLogin
// helper: csrfGuard lets Origin-less requests through (top-level form post),
// so login itself doesn't need one.
func adminLoginCookie(t *testing.T, ts *httptest.Server) *http.Cookie {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.PostForm(ts.URL+"/admin/login",
		url.Values{"username": {"admin"}, "password": {"secret123"}})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			return c
		}
	}
	t.Fatal("no admin cookie in login response")
	return nil
}

// postAdminForm POSTs form to path with cookie attached AND an Origin header
// matching the test server's configured BaseURL (http://example.test) —
// csrfGuard lets Origin-less requests through unconditionally, so a test that
// wants to actually exercise the Origin-match branch has to set one that
// matches. Redirects are not followed, so callers can assert on 302 vs 200.
func postAdminForm(t *testing.T, ts *httptest.Server, cookie *http.Cookie, path string, form url.Values) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://example.test")
	req.AddCookie(cookie)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// seedNode inserts a minimal fleet node row (the fields UpsertNode/queryNodes
// require) with the given id/label and returns its id.
func seedNode(t *testing.T, store *SQLiteStore, id, label string) string {
	t.Helper()
	n, err := store.UpsertNode(context.Background(), Node{
		ID: id, OwnerType: "fleet", Label: label,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	return n.ID
}

// 高危 POST 不能直接生效：必须先回一个确认页。
func TestHighRiskWriteRendersConfirmInsteadOfApplying(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := t.Context()
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatal(err)
	}
	before := svc.resolveSettings(ctx)

	form := settingsFormFrom(before)
	form.Set("daily_quota_mb", "999")
	resp := postAdminForm(t, ts, cookie, "/admin/settings", form)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 confirm page, got %d", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, "confirm_token") {
		t.Fatal("the confirm page must carry a pending-action token")
	}

	after := svc.resolveSettings(ctx)
	if after.DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: the setting was applied without confirmation")
	}
	_ = store
}

// 确认页必须展示 diff —— 这才是防误点击的机制本身。
func TestConfirmPageShowsTheDiff(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	_ = svc.SeedSettings(t.Context())
	cur := svc.resolveSettings(t.Context())
	form := settingsFormFrom(cur)
	form.Set("daily_quota_mb", "999")
	resp := postAdminForm(t, ts, cookie, "/admin/settings", form)
	defer resp.Body.Close()
	body := readAll(t, resp)
	if !strings.Contains(body, SettingDailyQuota) {
		t.Fatalf("confirm page must name the changed field; body=%s", body)
	}
}

// 低危操作不走确认页，直接生效。
func TestLowRiskWriteAppliesDirectly(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	id := seedNode(t, store, "n1", "old-label")
	form := url.Values{"label": {"new-label"}}
	resp := postAdminForm(t, ts, cookie, "/admin/nodes/"+id+"/label", form)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("want a redirect (applied), got %d", resp.StatusCode)
	}
	n, _, _ := store.GetNode(t.Context(), id)
	if n.Label != "new-label" {
		t.Fatalf("low-risk write should apply without confirmation, label=%q", n.Label)
	}
}

// 宽限期内仍然要看到确认页 —— 免的只是掉码，不是免确认。
func TestGracePeriodStillShowsConfirmPage(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	svc.markStepUp(cookie.Value)
	_ = svc.SeedSettings(t.Context())
	cur := svc.resolveSettings(t.Context())
	form := settingsFormFrom(cur)
	form.Set("daily_quota_mb", "888")
	resp := postAdminForm(t, ts, cookie, "/admin/settings", form)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the grace window must NOT skip the confirm page, got %d", resp.StatusCode)
	}
}

// 提交确认页时不带任何第二因子，/admin/confirm 绝不能执行待确认操作 —— 否则
// 拿着会话 cookie 的人（比如 XSS 窃取）能跳过第二因子直接兑现高危写操作，
// confirm 页存在的意义就没了。这条直接盯住 handleAdminConfirm 本身，而不是
// 只测 requireStepUp 拦下了原始 POST。测试服务未配 TOTP/passkey，因子即密码，
// 空密码必被拒。
func TestConfirmWithoutFactorDoesNotApply(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := t.Context()
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatal(err)
	}
	before := svc.resolveSettings(ctx)
	form := settingsFormFrom(before)
	form.Set("daily_quota_mb", "999")
	resp := postAdminForm(t, ts, cookie, "/admin/settings", form)
	body := readAll(t, resp)
	resp.Body.Close()

	tok := extractConfirmToken(t, body)
	confirmResp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	defer confirmResp.Body.Close()
	if confirmResp.StatusCode == http.StatusFound {
		t.Fatalf("SECURITY: /admin/confirm applied the write without a factor check (got a redirect)")
	}

	after := svc.resolveSettings(ctx)
	if after.DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: /admin/confirm applied the setting without factor verification")
	}
}

// extractConfirmToken pulls the confirm_token hidden-input value out of a
// rendered confirm page body.
func extractConfirmToken(t *testing.T, body string) string {
	t.Helper()
	const marker = `name="confirm_token" value="`
	i := strings.Index(body, marker)
	if i < 0 {
		t.Fatalf("no confirm_token field in body: %s", body)
	}
	rest := body[i+len(marker):]
	j := strings.Index(rest, `"`)
	if j < 0 {
		t.Fatalf("malformed confirm_token field in body: %s", body)
	}
	return rest[:j]
}
