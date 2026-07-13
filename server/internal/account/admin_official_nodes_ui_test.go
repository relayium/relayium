package account

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAdminDashboardShowsOfficialNodesSection(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	// A fleet node with limits set, plus an active token.
	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", Region: "cn-sh", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1, TrafficLimitBytes: 500 << 30, DiskLimitBytes: 100 << 30})
	store.CreateFleetToken(context.Background(), FleetToken{ID: "ft1", TokenHash: hashToken("x"), Name: "cn-sh-1", CreatedAt: 1})
	// A user-owned BYO node should not inflate the official-nodes heading count.
	store.UpsertNode(context.Background(), Node{OwnerType: "user", OwnerUserID: "u1", URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	client := ts.Client()
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	for _, want := range []string{
		"官方节点（1）",                          // section heading, counts only the fleet node (not the user node too)
		"生成节点 Token",                       // mint button
		"/admin/nodes/" + n.ID + "/limits", // edit-limits form action
		"/admin/nodes/" + n.ID + "/delete", // delete form action
		"cn-sh-1",                          // token name in the tokens list
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("dashboard missing %q", want)
		}
	}
}

func TestAdminMintShowsTokenOnce(t *testing.T) {
	ts, _ := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/token", strings.NewReader("name=n1"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	body, _ := io.ReadAll(resp.Body)
	html := string(body)
	if !strings.Contains(html, "install-node.sh") || !strings.Contains(html, "RELAYIUM_NODE_TOKEN=") {
		t.Fatalf("mint response should show the install command once, got:\n%s", html)
	}
}
