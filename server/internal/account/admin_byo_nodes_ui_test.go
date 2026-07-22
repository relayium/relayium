package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// getAdminHTML fetches the dashboard as a logged-in admin.
func getAdminHTML(t *testing.T, ts interface{ Client() *http.Client }, url string, cookie *http.Cookie) string {
	t.Helper()
	req, _ := http.NewRequest("GET", url+"/admin", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

// An operator faced with a misbehaving user-contributed node could not take it
// out of its owner's placement pool from the console: SetNodeDraining and
// MarkNodeRemoved are unscoped, but the dashboard rendered controls only under
// {{if eq .OwnerType "fleet"}}, so BYO nodes had no table at all.
func TestAdminDashboardShowsByoNodesWithControls(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	// One fleet node (so the two tables must be told apart) and one BYO node
	// that still holds a live file.
	store.UpsertNode(ctx, Node{ID: "fleet1", OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"},
		TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	byo, err := store.UpsertNode(ctx, Node{ID: "byo1", OwnerType: "user", OwnerUserID: "u1",
		URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}

	html := getAdminHTML(t, ts, ts.URL, cookie)

	for _, want := range []string{
		"自带节点",                                 // the BYO section heading
		"/admin/nodes/" + byo.ID + "/draining", // drain / undrain
		"/admin/nodes/" + byo.ID + "/remove",   // mark removed
		"剩余文件",                                 // stored-file count column
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("BYO section missing %q", want)
		}
	}
	// The restore control must be reachable for a REMOVED byo node.
	if err := store.MarkNodeRemoved(ctx, byo.ID, 5); err != nil {
		t.Fatal(err)
	}
	html = getAdminHTML(t, ts, ts.URL, cookie)
	if !strings.Contains(html, "/admin/nodes/"+byo.ID+"/restore") {
		t.Fatalf("a removed BYO node has no 恢复 control")
	}
	// The two tables must stay visually distinct: acting on the wrong one has
	// very different consequences (our machine vs a user's).
	if !strings.Contains(html, "byo-nodes") {
		t.Fatalf("BYO table carries no distinguishing marker; an operator could confuse it with the fleet table")
	}
}

// BYO node count is unbounded (anyone can contribute one), so the table must
// show a count and the most relevant N rows, never every row.
func TestAdminDashboardCapsByoNodeRows(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	total := adminByoNodesShown + 5
	for i := 0; i < total; i++ {
		// last_seen ascending: the LOWEST-numbered nodes are the stalest, and
		// are the ones that must fall off the end of the list.
		store.UpsertNode(ctx, Node{ID: fmt.Sprintf("byo-%02d", i), OwnerType: "user",
			OwnerUserID: "u1", URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s",
			CreatedAt: 1, LastSeenAt: int64(1000 + i)})
	}

	html := getAdminHTML(t, ts, ts.URL, cookie)

	if !strings.Contains(html, fmt.Sprintf("%d", total)) {
		t.Fatalf("BYO section does not state the full count %d", total)
	}
	// Assert on the ROW's own drain control, not on the bare node id: the
	// rollout panels list node ids too (capped separately, at
	// rolloutPanelMaxRows), and a bare-id assertion would be answered by those.
	newest := "/admin/nodes/" + fmt.Sprintf("byo-%02d", total-1) + "/draining"
	if !strings.Contains(html, newest) {
		t.Fatalf("the most recently seen BYO node has no row in the table (%s missing)", newest)
	}
	if strings.Contains(html, "/admin/nodes/byo-00/draining") {
		t.Fatalf("the stalest node byo-00 has a row: the table is not capped at %d rows", adminByoNodesShown)
	}
	if rows := strings.Count(html, "/draining"); rows != adminByoNodesShown {
		t.Fatalf("%d drain controls rendered, want exactly %d", rows, adminByoNodesShown)
	}
}
