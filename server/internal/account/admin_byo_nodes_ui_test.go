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

// byoTableHTML isolates the BYO table's own markup (the <section class="nodes
// byo-nodes">...</section> block) from the rest of the dashboard. Assertions
// that count rows or controls must run against THIS, not the whole page: the
// fleet table right above it renders the same "/draining" form action for
// every fleet row, and any stray occurrence of a count elsewhere on the page
// (e.g. in the rollout panels) would silently satisfy a bare strings.Contains.
func byoTableHTML(t *testing.T, html string) string {
	t.Helper()
	start := strings.Index(html, `class="nodes byo-nodes"`)
	if start < 0 {
		t.Fatal("byo-nodes section not found in admin HTML")
	}
	end := strings.Index(html[start:], "</section>")
	if end < 0 {
		t.Fatal("byo-nodes section has no closing </section>")
	}
	return html[start : start+end]
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
	byoHTML := byoTableHTML(t, html)

	// Scoped to the BYO table's own heading text, not the whole page: a bare
	// "%d" anywhere on the page (a byte count, a percentage, another table's
	// row count) would satisfy an unscoped Contains without proving the BYO
	// section itself states the count.
	if !strings.Contains(byoHTML, fmt.Sprintf("%d", total)) {
		t.Fatalf("BYO section does not state the full count %d", total)
	}
	// Assert on the ROW's own drain control, not on the bare node id: the
	// rollout panels list node ids too (capped separately, at
	// rolloutPanelMaxRows), and a bare-id assertion would be answered by those.
	newest := "/admin/nodes/" + fmt.Sprintf("byo-%02d", total-1) + "/draining"
	if !strings.Contains(byoHTML, newest) {
		t.Fatalf("the most recently seen BYO node has no row in the table (%s missing)", newest)
	}
	if strings.Contains(byoHTML, "/admin/nodes/byo-00/draining") {
		t.Fatalf("the stalest node byo-00 has a row: the table is not capped at %d rows", adminByoNodesShown)
	}
	// Counted within the BYO table ONLY: the fleet table (rendered just above
	// it on the same page) carries its own "/draining" form per row, and an
	// unscoped count only happens to pass here because this fixture has no
	// fleet nodes — it would mis-fail the moment one is added.
	if rows := strings.Count(byoHTML, "/draining"); rows != adminByoNodesShown {
		t.Fatalf("%d drain controls rendered in the BYO table, want exactly %d", rows, adminByoNodesShown)
	}
}

// The 所属用户 column exists so an operator can tell whose machine they are
// about to drain or remove; a raw generated user id answers that only after a
// separate lookup. It must show something actionable — here, the owner's
// email — sourced from a single batched query, not a per-row one.
func TestAdminDashboardByoTableShowsOwnerEmail(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	owner, err := store.UpsertUserByEmail(ctx, "byo-owner@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	store.UpsertNode(ctx, Node{ID: "byo-owned", OwnerType: "user", OwnerUserID: owner.ID,
		URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	html := getAdminHTML(t, ts, ts.URL, cookie)
	byoHTML := byoTableHTML(t, html)

	if !strings.Contains(byoHTML, "byo-owner@example.com") {
		t.Fatalf("BYO table does not show the owner's email; operator has no way to tell whose node this is")
	}
	if strings.Contains(byoHTML, owner.ID) {
		t.Fatalf("BYO table still shows the raw opaque user id %q alongside/instead of the email", owner.ID)
	}
}

// removed_at is sticky forever (only an admin "restore" clears it, and rows
// are never deleted), while BYO population is unbounded — uninstalls
// accumulate monotonically. Once at least adminByoNodesShown nodes have EVER
// deregistered, ranking them alongside "draining" at the top of the list
// crowds out everything else: the table becomes 100% dead rows and a live,
// currently-misbehaving node — the one an operator actually came to act on —
// gets no row at all.
func TestAdminDashboardByoTableSurvivesManyRemovedNodes(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	// More removed nodes than the display cap.
	removedTotal := adminByoNodesShown + 5
	for i := 0; i < removedTotal; i++ {
		id := fmt.Sprintf("dead-%02d", i)
		store.UpsertNode(ctx, Node{ID: id, OwnerType: "user", OwnerUserID: "u1",
			URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: int64(1000 + i)})
		if err := store.MarkNodeRemoved(ctx, id, int64(2000+i)); err != nil {
			t.Fatal(err)
		}
	}
	// One live, online, non-removed node, seen more recently than any of the
	// removed ones.
	store.UpsertNode(ctx, Node{ID: "live1", OwnerType: "user", OwnerUserID: "u1",
		URLs: []string{"turn:9.9.9.9:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: int64(9000)})

	html := getAdminHTML(t, ts, ts.URL, cookie)

	if !strings.Contains(html, "/admin/nodes/live1/draining") {
		t.Fatalf("the only live BYO node has no row in the table: removed nodes crowd it out")
	}
	if strings.Contains(html, "/admin/nodes/dead-00/draining") {
		t.Fatalf("a removed node still has a row: removed nodes must rank last, not tie with draining")
	}
}
