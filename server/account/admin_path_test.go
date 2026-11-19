package account

import (
	"bytes"
	"encoding/json"
	"html/template"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConfigurableAdminPathValidation(t *testing.T) {
	for _, v := range []string{"", "/admin", "/console_7-Z", "/a"} {
		if _, e := ResolveAdminPath(v); e != nil {
			t.Error(e)
		}
	}
	for _, v := range []string{"/", "admin", "//a", "/a/b", "/a/", "/a?x", "/a#x", "/a%2fb", "/a.b", "/..", "/a b", "/后台", "/api", "/ws", "/readyz", "/" + strings.Repeat("x", 65)} {
		if _, e := ResolveAdminPath(v); e == nil {
			t.Errorf("accepted %q", v)
		}
	}
}
func TestConfigurableAdminRoutesAndPasskey(t *testing.T) {
	st := newTestStore(t)
	svc := NewService(st, nil, Config{BaseURL: "https://example.test", AdminEnabled: true, AdminPath: "/console_7-Z"})
	ts := serveAdminForTest(t, svc)
	auth, handle := registerTestPasskey(t, svc)
	for _, path := range []string{"/admin", "/admin/users", "/admin/passkey/login/begin", "/console_7-Z-sibling"} {
		resp, e := ts.Client().Get(ts.URL + path)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("old route %s: %d", path, resp.StatusCode)
		}
	}
	r, _ := http.NewRequest("POST", ts.URL+svc.AdminPath()+"/passkey/login/begin", nil)
	r.Header.Set("Origin", svc.selfOrigin())
	resp, e := ts.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if e := json.NewDecoder(resp.Body).Decode(&opts); e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || opts.PublicKey.Challenge == "" {
		t.Fatalf("begin %d", resp.StatusCode)
	}
	body := auth.assertBody(t, "example.test", svc.selfOrigin(), opts.PublicKey.Challenge, handle)
	r, _ = http.NewRequest("POST", ts.URL+svc.AdminPath()+"/passkey/login/finish", strings.NewReader(body))
	r.Header.Set("Origin", svc.selfOrigin())
	r.Header.Set("Content-Type", "application/json")
	for _, c := range resp.Cookies() {
		if c.Path != svc.AdminPath() {
			t.Error("bad ceremony scope")
		}
		r.AddCookie(c)
	}
	resp, e = ts.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("signed login %d", resp.StatusCode)
	}
	var session *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			session = c
			if c.Path != svc.AdminPath() || !c.HttpOnly || !c.Secure {
				t.Error("bad session security")
			}
		}
	}
	if session == nil {
		t.Fatal("missing session")
	}
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	for _, suffix := range []string{"", "/users", "/fleet", "/audit", "/version-policy", "/enroll"} {
		r := httptest.NewRequest("GET", svc.AdminPath()+suffix, nil)
		r.AddCookie(session)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Errorf("page %s: %d", suffix, w.Code)
		}
		if strings.Contains(w.Body.String(), "/admin") || strings.Contains(w.Body.String(), "ZgotmplZ") {
			t.Errorf("page %s leaks default/broken URL", suffix)
		}
	}
	for _, suffix := range []string{"/lang", "/settings", "/logout", "/passkey/login/begin", "/enroll/begin"} {
		r := httptest.NewRequest("POST", svc.AdminPath()+suffix, nil)
		r.Header.Set("Origin", svc.selfOrigin())
		r.Header.Set("Sec-Fetch-Site", "cross-site")
		r.AddCookie(session)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Errorf("cross-site %s: %d", suffix, w.Code)
		}
	}
	r = httptest.NewRequest("POST", svc.AdminPath()+"/logout", nil)
	r.AddCookie(session)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 302 || w.Header().Get("Location") != svc.AdminPath() {
		t.Errorf("logout %d %s", w.Code, w.Header().Get("Location"))
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == adminCookie && c.Path != svc.AdminPath() {
			t.Error("bad logout scope")
		}
	}
}
func TestConfigurableAdminTemplatesAndLinks(t *testing.T) {
	route := adminRouteData{BasePath: "/console_7-Z"}
	for _, tc := range []struct {
		tmpl *template.Template
		data any
	}{
		{adminLoginTmpl, adminLoginData{adminRouteData: route, Passkey: true}},
		{adminEnrollTmpl, adminEnrollData{adminRouteData: route}},
		{adminConfirmTmpl, confirmPageData{adminRouteData: route, NeedFactor: true, Factor: StepUpPasskey}},
		{adminUsersTmpl, adminHomeData{adminRouteData: route, Section: adminSectionFleet, RolloutByo: rolloutPanelView{adminRouteData: route, Track: "byo"}, RolloutFleet: rolloutPanelView{adminRouteData: route, Track: "fleet", Configured: true, Status: "rolling"}}},
		{adminAuditTmpl, adminAuditData{adminRouteData: route}},
		{adminVersionPolicyTmpl, adminVersionPolicyData{adminRouteData: route}},
	} {
		var b bytes.Buffer
		if e := tc.tmpl.Execute(&b, tc.data); e != nil {
			t.Fatal(e)
		}
		if strings.Contains(b.String(), "/admin") || strings.Contains(b.String(), "ZgotmplZ") {
			t.Errorf("%s old/broken path", tc.tmpl.Name())
		}
		if !strings.Contains(b.String(), route.BasePath) {
			t.Errorf("%s missing path", tc.tmpl.Name())
		}
	}
	for _, link := range []string{adminListHref("a", "email", "asc", "", 2, route.BasePath), adminByoHref(nil, "a", "bp", 2, route.BasePath), adminAuditHref("a", 2, route.BasePath), adminByoClearHref(nil, route.BasePath)} {
		if !strings.HasPrefix(link, route.BasePath+"/") {
			t.Error(link)
		}
	}
	for _, ref := range []string{"https://evil.test//evil.test", "https://example.test/admin", "https://example.test/console_7-Z-sibling"} {
		if v := adminReturnPath(ref, route.BasePath); v != route.BasePath {
			t.Error(v)
		}
	}
}

func TestConfigurableAdminReturnPathRejectsTraversal(t *testing.T) {
	for _, base := range []string{"/admin", "/console_7-Z"} {
		for _, suffix := range []string{"/../outside", "/%2e%2e/outside", "//outside", "/%2f%2fevil.example", "/a/../../outside"} {
			if got := adminReturnPath("https://example.test"+base+suffix, base); got != base {
				t.Errorf("unsafe return path %q escaped console %q", got, base)
			}
		}
	}
}
