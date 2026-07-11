package account

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// Reuse newAdminSettingsServer + adminLogin from admin_test.go.

func TestAdminMintFleetToken(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/token", strings.NewReader("name=shanghai-1"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mint token: want 200, got %d", resp.StatusCode)
	}
	toks, _ := store.ListActiveFleetTokens(context.Background())
	if len(toks) != 1 || toks[0].Name != "shanghai-1" {
		t.Fatalf("token not persisted: %+v", toks)
	}
}

func TestAdminSetNodeLimits(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/limits",
		strings.NewReader("traffic_limit_gb=500&disk_limit_gb=100"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("set limits: want 302, got %d", resp.StatusCode)
	}
	got, _, _ := store.GetNode(context.Background(), n.ID)
	if got.TrafficLimitBytes != 500<<30 || got.DiskLimitBytes != 100<<30 {
		t.Fatalf("limits not applied: %+v", got)
	}
}

func TestAdminDeleteFleetNode(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/delete", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("delete node: want 302, got %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetNode(context.Background(), n.ID); ok {
		t.Fatal("node still present after delete")
	}
}

func TestAdminRevokeFleetToken(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	if err := store.CreateFleetToken(context.Background(), FleetToken{
		ID: "ft-rev", TokenHash: hashToken("x"), Name: "n", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("CreateFleetToken: %v", err)
	}

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/token/ft-rev/revoke", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("revoke token: want 302, got %d", resp.StatusCode)
	}
	toks, _ := store.ListActiveFleetTokens(context.Background())
	if len(toks) != 0 {
		t.Fatalf("token still active after revoke: %+v", toks)
	}
}

func TestAdminSetNodeLimitsUserNodeNotFound(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	n, _ := store.UpsertNode(context.Background(), Node{
		OwnerType: "user", OwnerUserID: "u1", URLs: []string{"turn:9.9.9.9:3478"},
		TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1,
	})

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/limits",
		strings.NewReader("traffic_limit_gb=5&disk_limit_gb=5"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("set limits on user node: want 404, got %d", resp.StatusCode)
	}
}

func TestAdminNodeRoutesRequireAdmin(t *testing.T) {
	ts, _ := newAdminSettingsServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// No admin cookie and no Origin header (csrfGuard allows Origin-less requests,
	// matching the other admin tests), so the handler's isAdminReq gate rejects.
	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/token", nil)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthed mint: want 401, got %d", resp.StatusCode)
	}
}
