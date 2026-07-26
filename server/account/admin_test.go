package account

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newAdminServer(t *testing.T, user, pass string) (*httptest.Server, *Service) {
	t.Helper()
	store := newTestStore(t)
	// 种一个用户，列表里能看到。
	_, _ = store.UpsertUserByEmail(context.Background(), "seen@example.com", "Seen")
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: user, AdminPassword: pass,
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, svc
}

func TestAdminDisabledWhenNoPassword(t *testing.T) {
	ts, _ := newAdminServer(t, "admin", "")
	resp, _ := ts.Client().Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("admin off => /admin should 404, got %d", resp.StatusCode)
	}
}

func TestAdminUserDefaultsToAdminWhenUnset(t *testing.T) {
	// 不配账号时默认为 "admin"（向后兼容只设密码的部署）。
	ts, _ := newAdminServer(t, "", "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, _ := client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"admin"}, "password": {"s3cret"}})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("default username 'admin' should log in, got %d", resp.StatusCode)
	}
}

func newAdminSettingsServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", AdminUser: "boss", AdminPassword: "s3cret",
		MaxFileSize: 50 << 20, DailyQuota: 200 << 20, DefaultTTL: 86400, MaxTTL: 604800,
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, svc, store
}

// callAdminHandler invokes a high-risk admin handler DIRECTLY (bypassing
// RegisterAdmin's mux and, with it, RequireStepUp), for tests whose purpose
// is the handler's own business logic/validation rather than the step-up
// gate in front of it — that gate is exercised separately by
// stepup_test.go. Mirrors the existing pattern of calling handlers straight
// (see TestAdminLoginTOTP calling s.handleAdminLogin above), extended with
// SetPathValue since some of these handlers read r.PathValue("id").
func callAdminHandler(h http.HandlerFunc, cookie *http.Cookie, form url.Values, pathValues map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	for k, v := range pathValues {
		r.SetPathValue(k, v)
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func adminLogin(t *testing.T, ts *httptest.Server) *http.Cookie {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, _ := client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"boss"}, "password": {"s3cret"}})
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			return c
		}
	}
	t.Fatal("no admin cookie")
	return nil
}

// These settings tests call handleAdminSettings directly rather than through
// POST /admin/settings: that route now sits behind RequireStepUp (Task 7),
// which renders a confirmation page instead of applying anything — the
// point of these tests is handleAdminSettings' OWN validation/persistence
// logic, which is unchanged and still worth testing on its own. The route's
// step-up gating is covered separately by stepup_test.go.
func TestAdminSettingsUpdateValid(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	// 10 MiB file, 100 MiB quota, 12h default, 48h max, 5 MiB relay cap, 50 GB node traffic default.
	form, _ := url.ParseQuery(
		"max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48" +
			"&default_retention=0&default_max_downloads=5&max_max_downloads=100&storage_disk_cap_mb=0" +
			"&node_traffic_default_gb=50")
	w := callAdminHandler(svc.handleAdminSettings, cookie, form, nil)
	if w.Code != http.StatusFound {
		t.Fatalf("valid settings POST: want 302, got %d", w.Code)
	}
	v, _, _ := store.GetSetting(context.Background(), SettingMaxFileSize)
	if v != 10*1024*1024 {
		t.Fatalf("max_file_size = %d, want 10 MiB", v)
	}
	if d, _, _ := store.GetSetting(context.Background(), SettingDefaultTTL); d != 12*3600 {
		t.Fatalf("default_ttl = %d, want 43200", d)
	}
	if nt, _, _ := store.GetSetting(context.Background(), SettingNodeTrafficDefault); nt != 50*1024*1024*1024 {
		t.Fatalf("node_traffic_default = %d, want 50 GiB", nt)
	}
}

// node_traffic_default_gb=0 means "unlimited" and must be accepted, not
// rejected — this is the same 0-is-valid contract as default_retention and
// storage_disk_cap_mb. A naive switch from enumi (n >= 0) to atoi (n > 0)
// for this field would silently start rejecting 0 and, because the whole
// settings POST is all-or-nothing, block saving every other field too.
func TestAdminSettingsNodeTrafficDefaultZeroAllowed(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	form, _ := url.ParseQuery(
		"max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48" +
			"&default_retention=0&default_max_downloads=5&max_max_downloads=100&storage_disk_cap_mb=0" +
			"&node_traffic_default_gb=0")
	w := callAdminHandler(svc.handleAdminSettings, cookie, form, nil)
	if w.Code != http.StatusFound {
		t.Fatalf("node_traffic_default_gb=0 (unlimited): want 302, got %d", w.Code)
	}
	if nt, ok, _ := store.GetSetting(context.Background(), SettingNodeTrafficDefault); !ok || nt != 0 {
		t.Fatalf("node_traffic_default = %d (ok=%v), want 0 (unlimited)", nt, ok)
	}
}

func TestAdminSettingsRejectsInvalid(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	post := func(formStr string) int {
		form, _ := url.ParseQuery(formStr)
		return callAdminHandler(svc.handleAdminSettings, cookie, form, nil).Code
	}
	const okRetention = "&default_retention=0&default_max_downloads=5&max_max_downloads=100&storage_disk_cap_mb=0&node_traffic_default_gb=0"
	// default_ttl (48h) > max_ttl (24h) → rejected.
	if code := post("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=48&max_ttl_hours=24" + okRetention); code != http.StatusBadRequest {
		t.Fatalf("default>max: want 400, got %d", code)
	}
	// Negative value → rejected.
	if code := post("max_file_size_mb=-1&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48" + okRetention); code != http.StatusBadRequest {
		t.Fatalf("negative: want 400, got %d", code)
	}
	// default_retention out of range (0..2) → rejected.
	if code := post("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48" +
		"&default_retention=3&default_max_downloads=5&max_max_downloads=100&storage_disk_cap_mb=0&node_traffic_default_gb=0"); code != http.StatusBadRequest {
		t.Fatalf("default_retention=3: want 400, got %d", code)
	}
	// default_max_downloads > max_max_downloads → rejected.
	if code := post("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48" +
		"&default_retention=2&default_max_downloads=999&max_max_downloads=100&storage_disk_cap_mb=0&node_traffic_default_gb=0"); code != http.StatusBadRequest {
		t.Fatalf("default_max_downloads>max: want 400, got %d", code)
	}
	// node_traffic_default_gb negative → rejected (enumi requires n >= 0, same as storage_disk_cap_mb).
	if code := post("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48" +
		"&default_retention=0&default_max_downloads=5&max_max_downloads=100&storage_disk_cap_mb=0&node_traffic_default_gb=-1"); code != http.StatusBadRequest {
		t.Fatalf("node_traffic_default_gb=-1: want 400, got %d", code)
	}
	// Nothing persisted by the rejected posts.
	if _, ok, _ := store.GetSetting(context.Background(), SettingMaxFileSize); ok {
		t.Fatalf("invalid POST must not write settings")
	}
}

// Through the real route, an unauthenticated POST /admin/settings never
// reaches handleAdminSettings at all — RequireStepUp's own isAdminReq gate
// intercepts it first and redirects to /admin (302), which is what an
// operator's browser needs. handleAdminSettings keeps its own isAdminReq
// check regardless (defense in depth, and the contract any direct caller —
// including HandleAdminConfirm once Task 8 lands — relies on), so that's
// what this test targets directly.
func TestAdminSettingsRequiresAdmin(t *testing.T) {
	_, svc, _ := newAdminSettingsServer(t)
	form, _ := url.ParseQuery("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48")
	w := callAdminHandler(svc.handleAdminSettings, nil, form, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauth settings POST: want 401, got %d", w.Code)
	}
}

func TestAdminLoginGate(t *testing.T) {
	ts, _ := newAdminServer(t, "boss", "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// 未登录 GET /admin => 登录表单（含账号与密码字段）。
	resp, _ := client.Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusOK || !bodyContains(resp, "username") {
		t.Fatalf("unauth admin should show login form with a username field")
	}

	hasCookie := func(resp *http.Response) bool {
		for _, c := range resp.Cookies() {
			if c.Name == adminCookie {
				return true
			}
		}
		return false
	}

	// 错误密码（账号对）=> 不设 cookie。
	resp, _ = client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"boss"}, "password": {"wrong"}})
	if hasCookie(resp) {
		t.Fatalf("wrong password must not set admin cookie")
	}

	// 错误账号（密码对）=> 不设 cookie。
	resp, _ = client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"nobody"}, "password": {"s3cret"}})
	if hasCookie(resp) {
		t.Fatalf("wrong username must not set admin cookie")
	}

	// 账号+密码都对 => 设 cookie + 重定向。
	resp, _ = client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"boss"}, "password": {"s3cret"}})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("good login should redirect, got %d", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("good login set no admin cookie")
	}

	// 带 cookie GET /admin => 用户列表含 seeded 邮箱。
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if !bodyContains(resp, "seen@example.com") {
		t.Fatalf("authed admin should list users")
	}
}

func TestAdminLoginTOTP(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := NewService(newTestStore(t), nil, Config{AdminUser: "admin", AdminPassword: "pw", AdminTOTPSecret: testSecret})
	s.now = func() time.Time { return base }

	post := func(user, pass, code string) *httptest.ResponseRecorder {
		form := url.Values{"username": {user}, "password": {pass}, "totp": {code}}
		r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = "7.7.7.7:1111"
		w := httptest.NewRecorder()
		s.handleAdminLogin(w, r)
		return w
	}

	// good creds + good code -> 302 redirect with cookie
	w := post("admin", "pw", codeAt(t, base))
	if w.Code != http.StatusFound {
		t.Fatalf("valid login: want 302, got %d", w.Code)
	}
	if len(w.Result().Cookies()) == 0 {
		t.Fatal("valid login should set admin cookie")
	}

	// good creds + wrong code -> 401
	if w := post("admin", "pw", "000000"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code: want 401, got %d", w.Code)
	}
}

// TestAdminLoginTOTPNotBurnedByWrongCreds is a regression test for the
// replay-guard bug: a valid TOTP code submitted alongside a WRONG password
// must not advance adminTOTPLastStep. The legitimate admin must still be
// able to use that same code with the CORRECT password afterward.
func TestAdminLoginTOTPNotBurnedByWrongCreds(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := NewService(newTestStore(t), nil, Config{AdminUser: "admin", AdminPassword: "pw", AdminTOTPSecret: testSecret})
	s.now = func() time.Time { return base }

	post := func(user, pass, code string) *httptest.ResponseRecorder {
		form := url.Values{"username": {user}, "password": {pass}, "totp": {code}}
		r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = "9.9.9.9:3333"
		w := httptest.NewRecorder()
		s.handleAdminLogin(w, r)
		return w
	}

	code := codeAt(t, base)

	// Wrong password + correct current code -> 401, and must NOT consume the step.
	if w := post("admin", "wrong", code); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password + right code: want 401, got %d", w.Code)
	}

	// Correct password + the SAME code -> must still succeed (302 + cookie).
	w := post("admin", "pw", code)
	if w.Code != http.StatusFound {
		t.Fatalf("right creds + same code after failed attempt: want 302, got %d", w.Code)
	}
	if len(w.Result().Cookies()) == 0 {
		t.Fatal("successful login should set admin cookie")
	}
}

func TestAdminHomeDashboardAndPaging(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		email := fmt.Sprintf("user%d@example.com", i)
		if _, err := store.UpsertUserByEmail(ctx, email, fmt.Sprintf("User %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	s := NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	s.now = func() time.Time { return time.Unix(1_700_000_000, 0) }

	get := func(query string) *httptest.ResponseRecorder {
		tok, _ := s.newAdminSession(context.Background(), "password")
		r := httptest.NewRequest("GET", "/admin"+query, nil)
		r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
		w := httptest.NewRecorder()
		s.handleAdminHome(w, r)
		return w
	}

	// dashboard: metric card labels + a user present
	w := get("")
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{"总用户数", "未过期暂存文件", "占用存储", "用量月份", "上传", "user0@example.com"} {
		if !strings.Contains(body, want) {
			t.Fatalf("home body missing %q", want)
		}
	}

	// search filters to one user
	w = get("?q=user1")
	body = w.Body.String()
	if !strings.Contains(body, "user1@example.com") || strings.Contains(body, "user0@example.com") || strings.Contains(body, "user2@example.com") {
		t.Fatal("search did not filter to user1 only")
	}

	// page clamp: absurd page still 200, clamped to last page with real content
	w = get("?page=999")
	body = w.Body.String()
	if w.Code != http.StatusOK {
		t.Fatalf("out-of-range page: want 200, got %d", w.Code)
	}
	if !strings.Contains(body, "第 1 / 1 页") || !strings.Contains(body, "user0@example.com") {
		t.Fatal("out-of-range page did not clamp to a rendered last page")
	}

	// page overflowing int64 range must fall back to page 1, not a negative offset
	w = get("?page=99999999999999999999")
	body = w.Body.String()
	if w.Code != http.StatusOK {
		t.Fatalf("overflow page: want 200, got %d", w.Code)
	}
	if !strings.Contains(body, "第 1 / 1 页") {
		t.Fatal("overflow page did not fall back to page 1")
	}
}

func TestAdminLoginLockout(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	s.now = func() time.Time { return base }

	fail := func() *httptest.ResponseRecorder {
		form := url.Values{"username": {"admin"}, "password": {"wrong"}}
		r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = "8.8.8.8:2222"
		w := httptest.NewRecorder()
		s.handleAdminLogin(w, r)
		return w
	}
	for i := 0; i < adminLoginMaxFails; i++ {
		if w := fail(); w.Code != http.StatusUnauthorized {
			t.Fatalf("fail %d: want 401, got %d", i, w.Code)
		}
	}
	if w := fail(); w.Code != http.StatusTooManyRequests {
		t.Fatalf("after threshold: want 429, got %d", w.Code)
	}
}
