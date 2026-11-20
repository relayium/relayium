package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminBrowserRequiredBeforeLogin(t *testing.T) {
	st := newTestStore(t)
	svc := NewService(st, nil, Config{BaseURL: "https://example.test", AdminEnabled: true, AdminPath: "/console-test", AdminAllowedIPs: "192.0.2.10", AdminBrowserRequired: true})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	r := httptest.NewRequest("GET", "https://example.test/console-test", nil)
	r.RemoteAddr = "192.0.2.10:123"
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("unapproved browser reached login: %d", w.Code)
	}
	rows, err := st.AdminAuth().ListIPAccess(context.Background())
	if err != nil || len(rows) != 0 {
		t.Fatalf("browser refusal must not ban allowlisted IP: %+v %v", rows, err)
	}
}

func TestAdminLegacyTrapImmediatelyBansWhitelistedIP(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	svc := NewService(st, nil, Config{BaseURL: "https://example.test", AdminEnabled: true, AdminPath: "/console-test", AdminAllowedIPs: "192.0.2.10", AdminLegacyTrap: true})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	r := httptest.NewRequest("POST", "https://example.test/admin/unknown", nil)
	r.RemoteAddr = "192.0.2.10:123"
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("trap status: %d", w.Code)
	}
	ok, err := st.AdminAccessAttempt(ctx, "192.0.2.10", true)
	if err != nil || ok {
		t.Fatal("trap ban did not override whitelist", ok, err)
	}
	rows, err := st.AdminAuth().ListIPAccess(ctx)
	if err != nil || len(rows) != 1 || rows[0].Attempts != 4 {
		t.Fatalf("not instant permanent ban: %+v %v", rows, err)
	}
}

func browserFixture(t *testing.T) (*SQLiteStore, *Service, http.Handler) {
	t.Helper()
	st := newTestStore(t)
	svc := NewService(st, nil, Config{BaseURL: "https://example.test", AdminEnabled: true, AdminPath: "/console-test", AdminAllowedIPs: "192.0.2.10", AdminBrowserRequired: true})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	return st, svc, mux
}
func browserRequest(h http.Handler, method, path, body, origin string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://example.test"+path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.10:123"
	r.Header.Set("Content-Type", "application/json")
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	for _, cookie := range cookies {
		if cookie != nil {
			r.AddCookie(cookie)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestAdminBrowserGrantHTTPAndRevocation(t *testing.T) {
	ctx := context.Background()
	st, svc, h := browserFixture(t)
	g, err := st.AdminAuth().StartBrowserGrant(ctx, "test browser", svc.selfOrigin(), svc.AdminPath(), 15*time.Minute, svc.now().Unix(), "test")
	if err != nil {
		t.Fatal(err)
	}
	page := browserRequest(h, "GET", svc.AdminPath()+adminBrowserAuthorizePath, "", "", nil)
	if page.Code != 200 || !strings.Contains(page.Body.String(), "history.replaceState") || strings.Contains(page.Body.String(), g.Token) {
		t.Fatal("unsafe bootstrap page", page.Code)
	}
	payload := `{"token":"` + g.Token + `"}`
	for _, origin := range []string{"", "https://evil.test"} {
		w := browserRequest(h, "POST", svc.AdminPath()+adminBrowserAuthorizePath, payload, origin, nil)
		if w.Code != 403 {
			t.Fatal("CSRF grant redemption", origin, w.Code)
		}
	}
	w := browserRequest(h, "POST", svc.AdminPath()+adminBrowserAuthorizePath, payload, svc.selfOrigin(), nil)
	if w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatal("redemption", w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	if cookie.Path != svc.AdminPath() || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != int(adminBrowserLifetime/time.Second) {
		t.Fatalf("bad browser cookie %+v", cookie)
	}
	if browserRequest(h, "POST", svc.AdminPath()+adminBrowserAuthorizePath, payload, svc.selfOrigin(), nil).Code != 403 {
		t.Fatal("grant replay accepted")
	}
	for _, path := range []string{svc.AdminPath(), svc.AdminPath() + "/users", svc.AdminPath() + "/passkey/login/begin", svc.AdminPath() + "/unknown"} {
		if browserRequest(h, "GET", path, "", "", nil).Code != 403 {
			t.Fatal("browser gate omitted", path)
		}
	}
	session := adminSessionCookie(t, svc)
	if browserRequest(h, "GET", svc.AdminPath(), "", "", session).Code != 403 {
		t.Fatal("valid Passkey session bypassed browser authorization")
	}
	if browserRequest(h, "GET", svc.AdminPath(), "", "", session, cookie).Code != 200 {
		t.Fatal("authorized browser and Passkey session denied")
	}
	second, err := st.AdminAuth().StartBrowserGrant(ctx, "second browser", svc.selfOrigin(), svc.AdminPath(), time.Minute, svc.now().Unix(), "test")
	if err != nil {
		t.Fatal(err)
	}
	secondToken, err := st.RedeemAdminBrowserGrant(ctx, second.Token, svc.selfOrigin(), svc.AdminPath(), svc.now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	secondCookie := *cookie
	secondCookie.Value = secondToken
	if browserRequest(h, "GET", svc.AdminPath(), "", "", cookie).Code != 200 {
		t.Fatal("authorized browser denied")
	}
	forged := *cookie
	forged.Value = strings.Repeat("0", 64)
	if browserRequest(h, "GET", svc.AdminPath(), "", "", &forged).Code != 403 {
		t.Fatal("forged cookie admitted")
	}
	browsers, err := st.AdminAuth().ListBrowsers(ctx)
	if err != nil || len(browsers) != 2 {
		t.Fatal(browsers, err)
	}
	var firstID string
	for _, b := range browsers {
		if b.Name == "test browser" {
			firstID = b.ID
		}
	}
	if err = st.AdminAuth().ChangeBrowserAuthorization(ctx, firstID, false, svc.now().Unix(), "test"); err != nil {
		t.Fatal(err)
	}
	if browserRequest(h, "GET", svc.AdminPath(), "", "", cookie).Code != 403 {
		t.Fatal("revoked browser admitted")
	}
	if browserRequest(h, "GET", svc.AdminPath(), "", "", &secondCookie).Code != 200 {
		t.Fatal("revocation leaked to another approved browser on same IP")
	}
	rows, err := st.AdminAuth().ListIPAccess(ctx)
	if err != nil || len(rows) != 0 {
		t.Fatal("browser refusals banned shared IP", rows, err)
	}
}

func TestAdminLegacyTrapCanonicalizationAndPublicIsolation(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"} {
		for _, path := range []string{"/admin", "/admin/unknown", "/admin//unknown", "/admin/../api/config", "//admin", "/a/../admin", "/a%64min"} {
			t.Run(method+path, func(t *testing.T) {
				st := newTestStore(t)
				ctx := context.Background()
				svc := NewService(st, nil, Config{BaseURL: "https://example.test", AdminEnabled: true, AdminPath: "/console-test", AdminAllowedIPs: "192.0.2.10", AdminTrustedProxies: "127.0.0.1/32", AdminLegacyTrap: true})
				mux := http.NewServeMux()
				svc.RegisterAdmin(mux)
				mux.Handle("/api/", svc.Routes())
				h := svc.AdminLegacyTrapGuard(mux)
				r := httptest.NewRequest(method, "https://example.test"+path, nil)
				r.RemoteAddr = "127.0.0.1:123"
				r.Header.Set("X-Forwarded-For", "192.0.2.10")
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != 403 || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("legacy trap bypass", w.Code)
				}
				ok, err := st.AdminAccessAttempt(ctx, "192.0.2.10", true)
				if err != nil || ok {
					t.Fatal("allowlisted IP not banned", ok, err)
				}
				r = httptest.NewRequest("GET", "https://example.test/api/config", nil)
				r.RemoteAddr = "127.0.0.1:123"
				r.Header.Set("X-Forwarded-For", "192.0.2.10")
				w = httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != 200 {
					t.Fatal("ban affected public API", w.Code)
				}
				if err = st.AdminAuth().UnblockIP(ctx, "192.0.2.10"); err != nil {
					t.Fatal(err)
				}
				ok, err = st.AdminAccessAttempt(ctx, "192.0.2.10", true)
				if err != nil || !ok {
					t.Fatal("local unblock failed", ok, err)
				}
			})
		}
	}
}

func TestAdminLegacyTrapRejectsUnverifiedProxyAndIgnoresSpoofedXFF(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	svc := NewService(st, nil, Config{BaseURL: "https://example.test", AdminEnabled: true, AdminPath: "/console-test", AdminAllowedIPs: "192.0.2.10", AdminTrustedProxies: "127.0.0.1/32", AdminLegacyTrap: true})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	h := svc.AdminLegacyTrapGuard(mux)
	r := httptest.NewRequest("GET", "https://example.test/admin", nil)
	r.RemoteAddr = "127.0.0.1:123"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	rows, err := st.AdminAuth().ListIPAccess(ctx)
	if err != nil || len(rows) != 0 || w.Code != 403 {
		t.Fatal("missing proxy identity poisoned ban records", rows, err, w.Code)
	}
	r = httptest.NewRequest("GET", "https://example.test/admin", nil)
	r.RemoteAddr = "198.51.100.7:123"
	r.Header.Set("X-Forwarded-For", "192.0.2.10")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	rows, err = st.AdminAuth().ListIPAccess(ctx)
	if err != nil || len(rows) != 1 || rows[0].IP != "198.51.100.7" || rows[0].Attempts != 4 {
		t.Fatal("spoofed trap identity", rows, err)
	}
}

func TestAdminBrowserPolicyValidation(t *testing.T) {
	for _, c := range []struct {
		path, ips string
		trap, bad bool
	}{{"/admin", "192.0.2.10", true, true}, {"/console-test", "", true, true}, {"/console-test", "192.0.2.10", true, false}, {"/admin", "", false, false}} {
		if err := ValidateAdminBrowserPolicy(c.path, c.ips, c.trap); (err != nil) != c.bad {
			t.Fatal(c, err)
		}
	}
}

func TestAdminBrowserStoreUnavailableFailsClosed(t *testing.T) {
	st, svc, h := browserFixture(t)
	ctx := context.Background()
	g, err := st.AdminAuth().StartBrowserGrant(ctx, "Browser", svc.selfOrigin(), svc.AdminPath(), time.Minute, svc.now().Unix(), "test")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := st.RedeemAdminBrowserGrant(ctx, g.Token, svc.selfOrigin(), svc.AdminPath(), svc.now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	if err = st.Close(); err != nil {
		t.Fatal(err)
	}
	w := browserRequest(h, "GET", svc.AdminPath(), "", "", &http.Cookie{Name: adminBrowserCookie, Value: raw})
	if w.Code != 503 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("database error did not fail closed", w.Code)
	}
}
