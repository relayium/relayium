package account

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAdminBrowserGrantStorageAdversarial(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	a := st.AdminAuth()
	now := int64(1800000000)
	origin := "https://example.test"
	path := "/console-test"
	start := func() AdminBrowserGrant {
		t.Helper()
		g, e := a.StartBrowserGrant(ctx, "Browser", origin, path, time.Minute, now, "test")
		if e != nil {
			t.Fatal(e)
		}
		return g
	}
	for _, c := range []struct {
		name, origin, path string
		ttl                time.Duration
	}{{"", origin, path, time.Minute}, {"bad\nlabel", origin, path, time.Minute}, {"ok", "https://example.test/path", path, time.Minute}, {"ok", origin, "/api", time.Minute}, {"ok", origin, path, time.Second}, {"ok", origin, path, 2 * time.Hour}} {
		if _, e := a.StartBrowserGrant(ctx, c.name, c.origin, c.path, c.ttl, now, "test"); e == nil {
			t.Fatalf("invalid grant accepted %+v", c)
		}
	}
	g := start()
	for _, c := range []struct {
		token, origin, path string
		now                 int64
	}{{g.Token, "https://other.test", path, now}, {g.Token, origin, "/different", now}, {g.Token, origin, path, g.ExpiresAt}, {"bad", origin, path, now}} {
		if _, e := st.RedeemAdminBrowserGrant(ctx, c.token, c.origin, c.path, c.now); !errors.Is(e, ErrAdminBrowserGrant) {
			t.Fatal("grant binding/expiry/shape", e)
		}
	}
	var rawHash string
	if e := st.db.QueryRow(`SELECT token_hash FROM admin_browser_grants WHERE id=?`, g.ID).Scan(&rawHash); e != nil || rawHash == g.Token || strings.Contains(rawHash, g.Token) {
		t.Fatal("raw grant persisted", e)
	}
	if e := a.ChangeBrowserAuthorization(ctx, g.ID, true, now, "test"); e != nil {
		t.Fatal(e)
	}
	if _, e := st.RedeemAdminBrowserGrant(ctx, g.Token, origin, path, now); !errors.Is(e, ErrAdminBrowserGrant) {
		t.Fatal("cancelled grant accepted", e)
	}
	g = start()
	cookie, e := st.RedeemAdminBrowserGrant(ctx, g.Token, origin, path, now)
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range []struct {
		token, origin, path string
		now                 int64
		want                bool
	}{{cookie, origin, path, now, true}, {g.Token, origin, path, now, false}, {cookie, "https://other.test", path, now, false}, {cookie, origin, "/admin", now, false}, {cookie, origin, path, now + int64(adminBrowserLifetime/time.Second), false}, {strings.Repeat("0", 64), origin, path, now, false}} {
		ok, e := st.AdminBrowserAuthorized(ctx, c.token, c.origin, c.path, c.now)
		if e != nil || ok != c.want {
			t.Fatal("cookie validity", c.want, ok, e)
		}
	}
	if e := st.db.QueryRow(`SELECT token_hash FROM admin_browsers LIMIT 1`).Scan(&rawHash); e != nil || rawHash == cookie {
		t.Fatal("raw cookie persisted", e)
	}
	if _, e := st.RedeemAdminBrowserGrant(ctx, cookie, origin, path, now); !errors.Is(e, ErrAdminBrowserGrant) {
		t.Fatal("cookie spent as grant", e)
	}
}

func TestAdminBrowserSingleConsumeAcrossInstances(t *testing.T) {
	ctx := context.Background()
	file := filepath.Join(t.TempDir(), "browser.db")
	a, e := OpenSQLite(file)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, e := OpenSQLite(file)
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	now := int64(1800000000)
	g, e := a.AdminAuth().StartBrowserGrant(ctx, "Browser", "https://example.test", "/console-test", time.Minute, now, "test")
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	success := 0
	var cookie string
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			st := a
			if i%2 == 1 {
				st = b
			}
			raw, err := st.RedeemAdminBrowserGrant(ctx, g.Token, "https://example.test", "/console-test", now)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				success++
				cookie = raw
			} else if !errors.Is(err, ErrAdminBrowserGrant) {
				t.Errorf("unexpected writer error: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if success != 1 {
		t.Fatalf("one grant minted %d browsers", success)
	}
	list, e := a.AdminAuth().ListBrowsers(ctx)
	if e != nil || len(list) != 1 {
		t.Fatal(list, e)
	}
	if e := b.AdminAuth().ChangeBrowserAuthorization(ctx, list[0].ID, false, now, "test"); e != nil {
		t.Fatal(e)
	}
	if ok, e := a.AdminBrowserAuthorized(ctx, cookie, "https://example.test", "/console-test", now); e != nil || ok {
		t.Fatal("cross-instance revocation failed", ok, e)
	}
}

func TestAdminBrowserGrantCapacityAndExpiry(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	now := int64(1800000000)
	for i := 0; i < 16; i++ {
		if _, e := st.AdminAuth().StartBrowserGrant(ctx, "Browser", "https://example.test", "/console-test", time.Minute, now, "test"); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := st.AdminAuth().StartBrowserGrant(ctx, "Browser", "https://example.test", "/console-test", time.Minute, now, "test"); e == nil {
		t.Fatal("open grant cap ignored")
	}
	if _, e := st.AdminAuth().StartBrowserGrant(ctx, "Browser", "https://example.test", "/console-test", time.Minute, now+60, "test"); e != nil {
		t.Fatal("expired grant pruning", e)
	}
}

func TestAdminBrowserCapacityFailureDoesNotConsumeGrant(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	now := int64(1800000000)
	g, err := st.AdminAuth().StartBrowserGrant(ctx, "Browser", "https://example.test", "/console-test", time.Minute, now, "test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.db.Exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1024)
 INSERT INTO admin_browsers(id,token_hash,name,origin,admin_path,created_at,expires_at)
 SELECT 'capacity-'||x,'hash-'||x,'capacity','https://example.test','/console-test',?,? FROM n`, now, now+3600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.RedeemAdminBrowserGrant(ctx, g.Token, "https://example.test", "/console-test", now); err == nil {
		t.Fatal("browser cap ignored")
	}
	if _, err = st.db.Exec(`DELETE FROM admin_browsers`); err != nil {
		t.Fatal(err)
	}
	if _, err = st.RedeemAdminBrowserGrant(ctx, g.Token, "https://example.test", "/console-test", now); err != nil {
		t.Fatal("failed transaction consumed grant", err)
	}
}
