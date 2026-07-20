package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// Reuse newAdminSettingsServer + adminLogin from admin_test.go.

// TestAdminMintFleetToken calls handleAdminMintToken directly: through the
// real route it now sits behind requireStepUp (Task 7), which renders a
// confirmation page instead of minting anything. This test targets the
// handler's own persistence logic; the route's gating is covered by
// stepup_test.go.
func TestAdminMintFleetToken(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)

	w := callAdminHandler(svc.handleAdminMintToken, cookie, url.Values{"name": {"shanghai-1"}}, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("mint token: want 200, got %d", w.Code)
	}
	toks, _ := store.ListActiveFleetTokens(context.Background())
	if len(toks) != 1 || toks[0].Name != "shanghai-1" {
		t.Fatalf("token not persisted: %+v", toks)
	}
}

func TestAdminSetNodeLimits(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
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

// TestAdminDeleteFleetNode calls handleAdminDeleteNode directly: through the
// real route it now sits behind requireStepUp (Task 7). See the comment on
// TestAdminMintFleetToken above.
func TestAdminDeleteFleetNode(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)

	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	w := callAdminHandler(svc.handleAdminDeleteNode, cookie, nil, map[string]string{"id": n.ID})
	if w.Code != http.StatusFound {
		t.Fatalf("delete node: want 302, got %d", w.Code)
	}
	if _, ok, _ := store.GetNode(context.Background(), n.ID); ok {
		t.Fatal("node still present after delete")
	}
}

func TestAdminRevokeFleetToken(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
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
	ts, _, store := newAdminSettingsServer(t)
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

// Through the real route, an unauthed POST /admin/nodes/token is caught by
// requireStepUp's own isAdminReq gate (302 to /admin) before it ever reaches
// handleAdminMintToken. This test targets handleAdminMintToken's own
// isAdminReq check directly — see the comment on TestAdminSettingsRequiresAdmin.
func TestAdminNodeRoutesRequireAdmin(t *testing.T) {
	_, svc, _ := newAdminSettingsServer(t)
	w := callAdminHandler(svc.handleAdminMintToken, nil, nil, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthed mint: want 401, got %d", w.Code)
	}
}
