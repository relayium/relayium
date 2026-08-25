package account

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAdminDashboardShowsPerUserColumns(t *testing.T) {
	// newAdminServer (admin_test.go) already seeds one user and sets admin creds.
	ts, _ := newAdminServer(t, "admin", "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	resp, _ := client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"admin"}, "password": {"s3cret"}})
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("login did not set admin cookie")
	}

	req, _ := http.NewRequest("GET", ts.URL+"/admin/users", nil)
	req.AddCookie(cookie)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("get /admin: %v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	body := string(b)

	for _, want := range []string{"上传", "下载", "存储占用", "用量月份", `name="period"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("dashboard missing %q", want)
		}
	}
}
