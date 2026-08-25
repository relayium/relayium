package account

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func adminRouteBody(t *testing.T, tsURL string, client *http.Client, cookie *http.Cookie, path string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, tsURL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200", path, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestAdminRoutesSeparateDomainsAndKeepNavigation(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	if _, err := store.UpsertUserByEmail(context.Background(), "route-user@example.com", "Route User"); err != nil {
		t.Fatal(err)
	}

	pages := map[string]struct {
		title string
		want  []string
		gone  []string
	}{
		"/admin": {
			title: "Relayium Admin · 后台概览",
			want:  []string{"总用户数", "Passkey 登录", `href="/admin/users"`, `href="/admin/fleet"`},
			gone:  []string{"route-user@example.com", "官方节点（", "App Store 商品目录"},
		},
		"/admin/users": {
			title: "Relayium Admin · 用户",
			want:  []string{"route-user@example.com", "用量月份", "App Store 商品目录", `href="/admin/users" aria-current="page"`},
			gone:  []string{"官方节点（", "Passkey 登录", "节点版本发布"},
		},
		"/admin/fleet": {
			title: "Relayium Admin · 机队",
			want:  []string{"官方节点（", "节点版本发布", "暂存传输设置", `href="/admin/fleet" aria-current="page"`},
			gone:  []string{"route-user@example.com", "Passkey 登录", "App Store 商品目录"},
		},
	}
	for path, assertions := range pages {
		body := adminRouteBody(t, ts.URL, ts.Client(), cookie, path)
		if !strings.Contains(body, "<title>"+assertions.title+"</title>") {
			t.Errorf("%s missing page title %q", path, assertions.title)
		}
		for _, want := range assertions.want {
			if !strings.Contains(body, want) {
				t.Errorf("%s missing %q", path, want)
			}
		}
		for _, gone := range assertions.gone {
			if strings.Contains(body, gone) {
				t.Errorf("%s leaked unrelated section %q", path, gone)
			}
		}
	}
}

func TestAdminDomainRoutesRedirectUnauthenticatedRequests(t *testing.T) {
	ts, _, _ := newAdminSettingsServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, path := range []string{"/admin/users", "/admin/fleet"} {
		resp, err := client.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/admin" {
			t.Errorf("GET %s = %d Location %q, want 302 /admin", path, resp.StatusCode, resp.Header.Get("Location"))
		}
		if strings.Contains(string(body), "route-user@example.com") {
			t.Errorf("GET %s leaked protected data", path)
		}
	}
}
