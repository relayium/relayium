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
	// A fleet node with limits set, plus an active token. Storage is enabled
	// with concrete free/total so the 剩余/总量 and 可用(70%) cells render their
	// {{if .StorageEnabled}} *true* branch — html/template resolves field names
	// at execution time, so a branch no test ever walks would never catch a
	// misspelled field.
	//
	// The numbers are picked so no other byte value on this row renders a
	// string containing the 可用 cell's: 剩余 40.0 GiB, 总量 160.0 GiB, 可用
	// 28.0 GiB, 硬盘上限 100.0 GiB, 中继上限 500.0 GiB, and 本月/累计中继 + 存储 all
	// 0 B. (Substring, not equality — 128.0 GiB would have *contained*
	// 28.0 GiB and let the assertion below pass on the wrong column.)
	const gib = int64(1) << 30
	storageFree, storageTotal := 40*gib, 160*gib
	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", Region: "cn-sh", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1, TrafficLimitBytes: 500 << 30, DiskLimitBytes: 100 << 30,
		StorageEnabled: true, StorageFree: storageFree, StorageTotal: storageTotal})
	store.CreateFleetToken(context.Background(), FleetToken{ID: "ft1", TokenHash: hashToken("x"), Name: "cn-sh-1", CreatedAt: 1})
	// A user-owned BYO node should not inflate the official-nodes heading count.
	store.UpsertNode(context.Background(), Node{OwnerType: "user", OwnerUserID: "u1", URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	client := ts.Client()
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	// Formatted with the same helpers the template uses (humanBytes is the
	// `bytes` func; usableBytes owns the 70% ratio) rather than a hand-written
	// literal, so the assertion can't drift from the renderer.
	wantUsable := humanBytes(usableBytes(storageFree))

	for _, want := range []string{
		"官方节点（1）",                          // section heading, counts only the fleet node (not the user node too)
		"生成节点 Token",                       // mint button
		"/admin/nodes/" + n.ID + "/limits", // edit-limits form action
		"/admin/nodes/" + n.ID + "/delete", // delete form action
		"cn-sh-1",                          // token name in the tokens list
		"可用(70%)",                          // the usable-capacity column header
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("dashboard missing %q", want)
		}
	}

	// The usable cell itself. Asserting on the count, not just presence, is
	// what makes this a real check: if the value ever collided with another
	// byte column on the row, the count would be >1 and the test would say so
	// instead of passing on the other column's output.
	if got := strings.Count(html, wantUsable); got != 1 {
		t.Fatalf("dashboard rendered 可用(70%%) value %q %d times, want exactly 1 (free=%d)", wantUsable, got, storageFree)
	}
	// Sanity: no other byte value on this row renders a string that contains
	// the 可用 cell's, so the check above is really pinned to the 可用 cell.
	for _, other := range []int64{storageFree, storageTotal, 100 << 30, 500 << 30, 0} {
		if strings.Contains(humanBytes(other), wantUsable) {
			t.Fatalf("test setup is degenerate: %d renders %q, which contains the 可用 cell's %q", other, humanBytes(other), wantUsable)
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
