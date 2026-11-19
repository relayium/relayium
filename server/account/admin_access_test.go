package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestAdminIPPolicyValidationAndProxyBoundary(t *testing.T) {
	for _, c := range [][2]string{{"bad", ""}, {",", ""}, {"192.0.2.1,", ""}, {"192.0.2.0/24", ""}, {"fe80::1%en0", ""}, {"192.0.2.1", "0.0.0.0/0"}, {"192.0.2.1", "::/0"}, {"192.0.2.1", "bad"}} {
		if _, e := ParseAdminAccessPolicy(c[0], c[1]); e == nil {
			t.Errorf("accepted %q", c)
		}
	}
	p, e := ParseAdminAccessPolicy("192.0.2.10,2001:db8::1", "127.0.0.1/32,10.0.0.0/8")
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range []struct {
		peer, xff, want string
		bad             bool
	}{
		{"198.51.100.1:123", "192.0.2.10", "198.51.100.1", false},
		{"127.0.0.1:123", "192.0.2.10", "192.0.2.10", false},
		{"127.0.0.1:123", "192.0.2.10,198.51.100.1", "198.51.100.1", false},
		{"127.0.0.1:123", "192.0.2.10,10.1.2.3", "192.0.2.10", false},
		{"127.0.0.1:123", "", "", true}, {"127.0.0.1:123", "garbage", "", true},
		{"127.0.0.1:123", "192.0.2.10,garbage", "", true},
		{"[::ffff:192.0.2.10]:123", "198.51.100.1", "192.0.2.10", false},
		{"[2001:db8::1]:123", "192.0.2.10", "2001:db8::1", false},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.peer
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		ip, e := p.clientIP(r)
		if (e != nil) != c.bad || (!c.bad && ip.String() != c.want) {
			t.Errorf("%+v => %s %v", c, ip, e)
		}
	}
}
func TestAdminIPAccessFourthAttemptPersistenceAndUnblock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "acl.db")
	st, e := OpenSQLite(path)
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	ip := "198.51.100.7"
	for i := 1; i <= 4; i++ {
		ok, e := st.AdminAccessAttempt(ctx, ip, false)
		if e != nil || ok {
			t.Fatal(ok, e)
		}
		rows, e := st.AdminAuth().ListIPAccess(ctx)
		if e != nil || len(rows) != 1 || rows[0].Attempts != i {
			t.Fatalf("attempt%d: %+v %v", i, rows, e)
		}
		ok, e = st.AdminAccessAttempt(ctx, ip, true)
		if e != nil || ok != (i < 4) {
			t.Fatalf("allowlist after %d: %v %v", i, ok, e)
		}
	}
	if e := st.Close(); e != nil {
		t.Fatal(e)
	}
	st, e = OpenSQLite(path)
	if e != nil {
		t.Fatal(e)
	}
	defer st.Close()
	ok, e := st.AdminAccessAttempt(ctx, ip, true)
	if e != nil || ok {
		t.Fatal("ban lost after restart", ok, e)
	}
	if e := st.AdminAuth().UnblockIP(ctx, ip); e != nil {
		t.Fatal(e)
	}
	ok, e = st.AdminAccessAttempt(ctx, ip, true)
	if e != nil || !ok {
		t.Fatal(ok, e)
	}
	rows, e := st.AdminAuth().ListIPAccess(ctx)
	if e != nil || len(rows) != 0 {
		t.Fatal("allowed IP counted", rows, e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := st.AdminAccessAttempt(ctx, ip, false); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	rows, e = st.AdminAuth().ListIPAccess(ctx)
	if e != nil || len(rows) != 1 || rows[0].Attempts != 4 {
		t.Fatal(rows, e)
	}
}
func TestAdminIPGateEveryRouteAndExistingSession(t *testing.T) {
	st := newTestStore(t)
	svc := NewService(st, nil, Config{BaseURL: "http://example.test", AdminEnabled: true, AdminPath: "/console_7-Z", AdminAllowedIPs: "192.0.2.10"})
	session := adminSessionCookie(t, svc)
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	mux.HandleFunc("/public", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	for _, method := range []string{"GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"} {
		for _, suffix := range []string{"", "/users", "/passkey/login/begin", "/enroll", "/settings", "/confirm", "/nodes/x/delete", "/unknown"} {
			r := httptest.NewRequest(method, svc.AdminPath()+suffix, strings.NewReader("{}"))
			r.RemoteAddr = "198.51.100.7:123"
			r.Header.Set("X-Forwarded-For", "192.0.2.10")
			r.AddCookie(session)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatalf("bypass %s%s: %d", method, suffix, w.Code)
			}
		}
	}
	r := httptest.NewRequest("GET", svc.AdminPath(), nil)
	r.RemoteAddr = "192.0.2.10:123"
	r.AddCookie(session)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("allowed blocked", w.Code)
	}
	rows, e := st.AdminAuth().ListIPAccess(context.Background())
	if e != nil || len(rows) != 1 || rows[0].Attempts != 4 {
		t.Fatal(rows, e)
	}
	r = httptest.NewRequest("GET", "/public", nil)
	r.RemoteAddr = "198.51.100.7:123"
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Error("public route blocked")
	}
}

func TestAdminIPStoreFailureAndCapacityFailClosed(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if _, e := st.db.ExecContext(ctx, `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO admin_ip_access SELECT 'fixture-'||x,4 FROM n`); e != nil {
		t.Fatal(e)
	}
	if ok, e := st.AdminAccessAttempt(ctx, "198.51.100.9", false); e != nil || ok {
		t.Fatal("capacity did not deny", ok, e)
	}
	var count int
	if e := st.db.QueryRow(`SELECT count(*) FROM admin_ip_access`).Scan(&count); e != nil || count != adminAccessCapacity {
		t.Fatal(count, e)
	}
	if ok, e := st.AdminAccessAttempt(ctx, "192.0.2.10", true); e != nil || !ok {
		t.Fatal("capacity blocked allowed IP", ok, e)
	}
	svc := NewService(st, nil, Config{AdminEnabled: true, AdminAllowedIPs: "192.0.2.10"})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	if _, e := st.db.Exec(`DROP TABLE admin_ip_access`); e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("GET", "/admin", nil)
	r.RemoteAddr = "192.0.2.10:123"
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatalf("store failure bypassed policy: %d", w.Code)
	}
}
