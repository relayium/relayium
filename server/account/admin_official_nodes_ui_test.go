package account

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/relayium/relayium/authx"
)

func TestAdminDashboardShowsOfficialNodesSection(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	// A fleet node with limits set, plus an active token. Storage is enabled
	// with concrete free/total so the 剩余/总量 and 可存储 cells render their
	// {{if .StorageEnabled}} *true* branch — html/template resolves field names
	// at execution time, so a branch no test ever walks would never catch a
	// misspelled field.
	//
	// The disk limit is deliberately the binding gate here (100 GiB cap, 93 GiB
	// already stored -> 7 GiB left) while the 70% headroom term alone would say
	// 28 GiB. So this fixture pins not just the field name but the fact that the
	// cell shows the *minimum of the three placement gates*: a regression back to
	// usableBytes(StorageFree) renders 28.0 GiB and both assertions below fail.
	//
	// The numbers are picked so no other byte value on this row renders a
	// string containing the 可存储 cell's: 剩余 40.0 GiB, 总量 160.0 GiB, 已存
	// 93.0 GiB, 硬盘上限 100.0 GiB, 中继上限 500.0 GiB, 本月/累计中继 0 B, 可存储
	// 7.0 GiB. (Substring, not equality — 128.0 GiB would have *contained*
	// 28.0 GiB and let the assertion below pass on the wrong column.)
	const gib = int64(1) << 30
	storageFree, storageTotal := 40*gib, 160*gib
	diskLimit, storedBytes := 100*gib, 93*gib
	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", Region: "cn-sh", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1, TrafficLimitBytes: 500 << 30, DiskLimitBytes: diskLimit,
		StorageEnabled: true, StorageFree: storageFree, StorageTotal: storageTotal, StoredBytes: storedBytes})
	store.CreateFleetToken(context.Background(), FleetToken{ID: "ft1", TokenHash: authx.HashToken("x"), Name: "cn-sh-1", CreatedAt: 1})
	// A user-owned BYO node should not inflate the official-nodes heading count.
	store.UpsertNode(context.Background(), Node{OwnerType: "user", OwnerUserID: "u1", URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	client := ts.Client()
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	// Formatted with the same helpers the template uses (humanBytes is the
	// `bytes` func; storableBytes owns the three-gate minimum) rather than a
	// hand-written literal, so the assertion can't drift from the renderer.
	wantStorable := humanBytes(storableBytes(Node{StorageEnabled: true,
		StorageFree: storageFree, StorageTotal: storageTotal, DiskLimitBytes: diskLimit, StoredBytes: storedBytes}))
	headroomOnly := humanBytes(usableBytes(storageFree)) // the old, misleading value

	for _, want := range []string{
		"官方节点（1）",                          // section heading, counts only the fleet node (not the user node too)
		"生成节点 Token",                       // mint button
		"/admin/nodes/" + n.ID + "/limits", // edit-limits form action
		"/admin/nodes/" + n.ID + "/delete", // delete form action
		"cn-sh-1",                          // token name in the tokens list
		"可存储",                              // the storable-capacity column header
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("dashboard missing %q", want)
		}
	}
	// The old header texts must be gone entirely, not just replaced somewhere
	// else on the page — this is what a misspelled/reverted rename would fail.
	// The (70%) suffix was a lie once the column started reflecting all three
	// placement gates rather than the headroom term alone.
	for _, stale := range []string{"可用(70%)", "可存储(70%)"} {
		if strings.Contains(html, stale) {
			t.Fatalf("dashboard still contains the stale %q header; want 可存储", stale)
		}
	}

	// The storable cell itself. Asserting on the count, not just presence, is
	// what makes this a real check: if the value ever collided with another
	// byte column on the row, the count would be >1 and the test would say so
	// instead of passing on the other column's output. A misspelled field name
	// in the template aborts execution mid-row, so the cell never renders and
	// this count comes back 0.
	if got := strings.Count(html, wantStorable); got != 1 {
		t.Fatalf("dashboard rendered the 可存储 value %q %d times, want exactly 1 (free=%d total=%d limit=%d stored=%d)",
			wantStorable, got, storageFree, storageTotal, diskLimit, storedBytes)
	}
	// And the headroom-only value must not appear at all: that is what this
	// column used to show, and showing it here would mean the disk-limit gate
	// never made it into the rendered number.
	if strings.Contains(html, headroomOnly) {
		t.Fatalf("dashboard rendered the headroom-only value %q; the 可存储 cell must be the three-gate minimum %q", headroomOnly, wantStorable)
	}
	// Sanity: no other byte value on this row renders a string that contains
	// the 可存储 cell's, so the check above is really pinned to the 可存储 cell.
	for _, other := range []int64{storageFree, storageTotal, diskLimit, storedBytes, 500 << 30, 0} {
		if strings.Contains(humanBytes(other), wantStorable) {
			t.Fatalf("test setup is degenerate: %d renders %q, which contains the 可存储 cell's %q", other, humanBytes(other), wantStorable)
		}
	}
}

// The relay-traffic column must show the *resolved* effective limit
// (resolveNodeTrafficLimit), not the raw TrafficLimitBytes column: a node
// left at 0 inherits Settings.NodeTrafficDefault instead of rendering ∞. If
// the template ever regresses to {{.TrafficLimitBytes}}, the inheriting
// node's cell would show ∞ instead of the global default's rendered value,
// and the count-based assertions below would fail.
func TestAdminDashboardShowsEffectiveNodeTrafficLimit(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	const gib = int64(1) << 30
	globalDefault := 200 * gib
	override := 500 * gib
	if err := store.SetSetting(ctx, SettingNodeTrafficDefault, globalDefault, 1); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	// "inherit" leaves TrafficLimitBytes at 0 -> must render the global default.
	store.UpsertNode(ctx, Node{OwnerType: "fleet", Region: "cn-bj", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	// "override" sets its own TrafficLimitBytes -> must render that value, not the default.
	store.UpsertNode(ctx, Node{OwnerType: "fleet", Region: "cn-sh", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1, TrafficLimitBytes: override})

	client := ts.Client()
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	wantInherit := humanBytes(globalDefault) // "200.0 GiB"
	wantOverride := humanBytes(override)     // "500.0 GiB"
	zero := humanBytes(0)                    // "0 B" — both nodes' relayed/month/disk-limit cells

	// Sanity: none of these three rendered strings may be a substring of
	// another, or the count assertions below could pass on the wrong cell.
	for _, pair := range [][2]string{
		{wantInherit, wantOverride}, {wantOverride, wantInherit},
		{wantInherit, zero}, {wantOverride, zero},
	} {
		if strings.Contains(pair[0], pair[1]) {
			t.Fatalf("test setup is degenerate: %q contains %q", pair[0], pair[1])
		}
	}

	if got := strings.Count(html, wantInherit); got != 1 {
		t.Fatalf("inherited effective limit %q rendered %d times, want 1 (html:\n%s)", wantInherit, got, html)
	}
	if got := strings.Count(html, wantOverride); got != 1 {
		t.Fatalf("overridden effective limit %q rendered %d times, want 1 (html:\n%s)", wantOverride, got, html)
	}
}

// TestAdminMintShowsTokenOnce calls handleAdminMintToken directly: through
// the real route it now sits behind RequireStepUp (Task 7). See the comment
// on TestAdminMintFleetToken in admin_official_nodes_test.go.
func TestAdminMintShowsTokenOnce(t *testing.T) {
	ts, svc, _ := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)

	w := callAdminHandler(svc.handleAdminMintToken, cookie, url.Values{"name": {"n1"}}, nil)
	html := w.Body.String()
	if !strings.Contains(html, "install-node.sh") || !strings.Contains(html, "RELAYIUM_NODE_TOKEN=") {
		t.Fatalf("mint response should show the install command once, got:\n%s", html)
	}
}
