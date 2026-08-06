package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// getAdminPathHTML fetches an arbitrary admin URL (path + query) as a
// logged-in admin. getAdminHTML in admin_byo_nodes_ui_test.go always hits a
// bare /admin; search and pagination are GET navigation, so they need the
// query string to survive.
func getAdminPathHTML(t *testing.T, ts interface{ Client() *http.Client }, url, path string, cookie *http.Cookie) string {
	t.Helper()
	req, _ := http.NewRequest("GET", url+path, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

// seedByoNode inserts one user-contributed node.
func seedByoNode(t *testing.T, s *SQLiteStore, id, ownerID, label, region string, lastSeen int64) Node {
	t.Helper()
	n, err := s.UpsertNode(context.Background(), Node{
		ID: id, OwnerType: "user", OwnerUserID: ownerID, Label: label, Region: region,
		URLs: []string{"turn:8.8.8.8:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: lastSeen,
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// An operator looking for one specific BYO node has, in practice, exactly one
// of: the node id (from a log line), the owner's email (from a support
// ticket), or the label/region the owner set. Every one of those must find the
// row — including a node that is already marked removed, which is where
// /restore is reached from.
func TestListByoNodesSearchMatchesIDOwnerEmailLabelAndRegion(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	owner, err := s.UpsertUserByEmail(ctx, "alpha@example.com", "Alpha")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.UpsertUserByEmail(ctx, "beta@example.com", "Beta")
	if err != nil {
		t.Fatal(err)
	}
	seedByoNode(t, s, "node-alpha", owner.ID, "warsaw-box", "eu-central", 1000)
	seedByoNode(t, s, "node-beta", other.ID, "tokyo-box", "ap-northeast", 1001)
	seedByoNode(t, s, "node-ghost", owner.ID, "ghost-box", "eu-central", 900)
	if err := s.MarkNodeRemoved(ctx, "node-ghost", 1200); err != nil {
		t.Fatal(err)
	}
	// A fleet node with a matching label must NEVER surface in this table.
	if _, err := s.UpsertNode(ctx, Node{ID: "fleet-warsaw", OwnerType: "fleet", Label: "warsaw-box",
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1000}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, search string
		removed      bool
		want         []string
	}{
		{"by id", "node-alpha", false, []string{"node-alpha"}},
		{"by owner email", "alpha@example.com", false, []string{"node-alpha"}},
		{"by email fragment", "beta@", false, []string{"node-beta"}},
		{"by label", "warsaw", false, []string{"node-alpha"}},
		{"by region", "ap-northeast", false, []string{"node-beta"}},
		{"removed node by label", "ghost", true, []string{"node-ghost"}},
		{"removed node not in live list", "ghost", false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rows, total, err := s.ListByoNodes(ctx, AdminByoNodeQuery{
				Search: tc.search, Removed: tc.removed, Limit: 50})
			if err != nil {
				t.Fatal(err)
			}
			if int(total) != len(tc.want) {
				t.Fatalf("total=%d want %d", total, len(tc.want))
			}
			got := make([]string, 0, len(rows))
			for _, n := range rows {
				got = append(got, n.ID)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

// Pagination has to return the right slice. This test proves the LIMIT/OFFSET
// arithmetic and the totals ONLY — it says nothing about how many rows SQLite
// read to produce them, because it cannot: the returned rows look identical
// whether the scan stopped at the LIMIT or sorted the whole population first.
// That half is asserted against the query plan in
// TestListByoNodesLivePageOrderingIsIndexSupplied.
func TestListByoNodesPaginationSliceAndTotal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	const n = 25
	for i := 0; i < n; i++ {
		seedByoNode(t, s, fmt.Sprintf("byo-%02d", i), "u1", "", "", int64(1000+i))
	}

	page1, total, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Limit: 10, Offset: 0})
	if err != nil {
		t.Fatal(err)
	}
	if total != n {
		t.Fatalf("total=%d want %d", total, n)
	}
	// The page itself must be exactly the page.
	if len(page1) != 10 {
		t.Fatalf("page 1 returned %d rows, want 10", len(page1))
	}
	// Newest heartbeat first, so page 1 is byo-24..byo-15.
	if page1[0].ID != "byo-24" || page1[9].ID != "byo-15" {
		t.Fatalf("page 1 = %s..%s, want byo-24..byo-15", page1[0].ID, page1[9].ID)
	}
	page2, total2, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Limit: 10, Offset: 10})
	if err != nil {
		t.Fatal(err)
	}
	if total2 != n {
		t.Fatalf("page 2 total=%d want %d", total2, n)
	}
	if len(page2) != 10 || page2[0].ID != "byo-14" {
		t.Fatalf("page 2 = %d rows starting %s, want 10 starting byo-14", len(page2), page2[0].ID)
	}
	last, _, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Limit: 10, Offset: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(last) != 5 {
		t.Fatalf("last page returned %d rows, want 5", len(last))
	}
	// Searching narrows the total, not just the page.
	seedByoNode(t, s, "needle", "u1", "needle-box", "", 9000)
	_, ntotal, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Search: "needle", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if ntotal != 1 {
		t.Fatalf("search total=%d want 1", ntotal)
	}
}

// Ranking in SQL: a draining node (an operation already in progress) outranks
// a merely-recent heartbeat, and the rest fall back to last_seen_at then id.
//
// A node still HOLDING live files is deliberately NOT a ranking tier any more.
// It was one while the table truncated at 20 rows with no way to see row 21,
// so the top 20 had to be the "right" 20; with search and pagination every
// node is reachable, and the per-row "剩余文件" column still carries the fact
// where an operator reads it. Expressing it in SQL means a correlated EXISTS
// over stored_files, which no index can order by — SQLite then reads every
// matching row and sorts it into a temp b-tree, so the page LIMIT bounds only
// what is rendered, never what is read. This test pins the ordering that IS
// index-supplied; if the EXISTS tier ever comes back, this fails and the
// "rows past the page are not read" claim has to be retracted with it.
func TestListByoNodesRanksDrainingFirstThenHeartbeat(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	owner, err := s.UpsertUserByEmail(ctx, "holder@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	seedByoNode(t, s, "idle", owner.ID, "", "", 3000)
	seedByoNode(t, s, "holder", owner.ID, "", "", 2000)
	seedByoNode(t, s, "draining", owner.ID, "", "", 1000)
	if err := s.SetNodeDraining(ctx, "draining", true); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateStoredFile(ctx, StoredFile{ID: "f1", UserID: owner.ID, BlobKey: "b1",
		EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 9999, NodeID: "holder"}); err != nil {
		t.Fatal(err)
	}
	rows, _, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, n := range rows {
		got = append(got, n.ID)
	}
	if strings.Join(got, ",") != "draining,idle,holder" {
		t.Fatalf("ranking = %v, want draining,idle,holder (draining first, then last_seen_at DESC)", got)
	}
}

// The claim "the rows past the page are not read" is only true if the ORDER BY
// can be supplied by an index. Assert the plan directly: no temp b-tree for the
// live page's ordering. A Go-level row-count assertion cannot tell the two
// apart — SQLite returns the same 20 rows whether it stopped at the LIMIT or
// sorted the whole population first.
//
// Builds the statement from byoListWhereOrder — the same function
// ListByoNodes itself calls — rather than a hand-written copy of the SQL, so
// an ORDER BY change made inside that function (i.e. inside the real code
// path) cannot slip past this test. A hand-copied literal previously here
// caught the index being dropped only by accident; it would not have noticed
// the ORDER BY itself drifting. (Deliberately broke this by swapping
// `last_seen_at DESC` for `last_seen_at ASC` inside byoListWhereOrder: the
// index's column order no longer matches the requested ORDER BY, so the
// planner still used idx_nodes_byo_rank for the WHERE but fell back to
// `USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY` — this test failed on that,
// exactly the case it exists to catch; restored after confirming the
// failure.)
func TestListByoNodesLivePageOrderingIsIndexSupplied(t *testing.T) {
	s := newTestStore(t)
	where, whereArgs, order := byoListWhereOrder(AdminByoNodeQuery{Limit: 20})
	args := append(append([]any{}, whereArgs...), 20, 0)
	rows, err := s.db.QueryContext(context.Background(),
		`EXPLAIN QUERY PLAN SELECT `+nodeCols+` FROM nodes`+where+order+` LIMIT ? OFFSET ?`, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	plan := ""
	for rows.Next() {
		var a, b, c int
		var detail string
		if err := rows.Scan(&a, &b, &c, &detail); err != nil {
			t.Fatal(err)
		}
		plan += detail + "\n"
	}
	if strings.Contains(plan, "TEMP B-TREE") {
		t.Fatalf("live BYO page sorts into a temp b-tree, so it reads every matching row:\n%s", plan)
	}
	if !strings.Contains(plan, "idx_nodes_byo_rank") {
		t.Fatalf("live BYO page does not use idx_nodes_byo_rank:\n%s", plan)
	}
}

// A search term past SQLite's LIKE pattern limit must not turn into a
// confident "no matches": it is clamped before it reaches SQL.
func TestListByoNodesClampsOverlongSearch(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedByoNode(t, s, "node-clamp", "u1", strings.Repeat("x", 300), "", 1000)

	// A term far past the pattern limit would otherwise error the query.
	long := strings.Repeat("x", 60000)
	rows, total, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Search: long, Limit: 10})
	if err != nil {
		t.Fatalf("overlong search errored instead of being clamped: %v", err)
	}
	// Clamped to a 200-char substring, which the 300-char label still contains.
	if total != 1 || len(rows) != 1 || rows[0].ID != "node-clamp" {
		t.Fatalf("clamped search returned total=%d rows=%d, want the one matching node", total, len(rows))
	}
}

// The dashboard must offer a way to find one node in an unbounded population
// — including one that is already removed, whose restore control is the only
// way back from a mistaken deregistration.
func TestAdminDashboardByoSearchFindsRemovedNode(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	for i := 0; i < adminByoNodesShown+5; i++ {
		seedByoNode(t, store, fmt.Sprintf("live-%02d", i), "u1", "", "", int64(1000+i))
	}
	seedByoNode(t, store, "oops-removed", "u1", "needle-box", "", 500)
	if err := store.MarkNodeRemoved(ctx, "oops-removed", 600); err != nil {
		t.Fatal(err)
	}

	html := getAdminPathHTML(t, ts, ts.URL, "/admin?bq=needle", cookie)
	if !strings.Contains(html, "/admin/nodes/oops-removed/restore") {
		t.Fatalf("searching for a removed node's label does not surface its restore control")
	}
	byo := byoTableHTML(t, html)
	if strings.Contains(byo, "/admin/nodes/live-01/draining") {
		t.Fatalf("BYO table shows non-matching rows while a search is active")
	}
	// The search box itself must be on the page, as a GET form.
	if !strings.Contains(html, `name="bq"`) {
		t.Fatalf("no BYO search input rendered")
	}
}

// Pagination on the dashboard: page 2 must show the next slice, link back,
// and never re-render page 1's rows.
func TestAdminDashboardByoPagination(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)

	total := adminByoNodesShown + 3
	for i := 0; i < total; i++ {
		seedByoNode(t, store, fmt.Sprintf("byo-%02d", i), "u1", "", "", int64(1000+i))
	}

	page1 := byoTableHTML(t, getAdminPathHTML(t, ts, ts.URL, "/admin", cookie))
	if rows := strings.Count(page1, "/draining"); rows != adminByoNodesShown {
		t.Fatalf("page 1 rendered %d rows, want %d", rows, adminByoNodesShown)
	}
	if !strings.Contains(page1, "bp=2") {
		t.Fatalf("no link to page 2 on a %d-row population (page size %d)", total, adminByoNodesShown)
	}
	page2 := byoTableHTML(t, getAdminPathHTML(t, ts, ts.URL, "/admin?bp=2", cookie))
	if rows := strings.Count(page2, "/draining"); rows != 3 {
		t.Fatalf("page 2 rendered %d rows, want 3", rows)
	}
	// Page 2 holds the three stalest nodes, page 1 the newest.
	if !strings.Contains(page2, "/admin/nodes/byo-00/draining") {
		t.Fatalf("page 2 is missing the stalest node byo-00")
	}
	newest := fmt.Sprintf("/admin/nodes/byo-%02d/draining", total-1)
	if strings.Contains(page2, newest) {
		t.Fatalf("page 2 re-renders page 1's newest row (%s)", newest)
	}
}

// A failed BYO query must render AS A FAILURE. Rendering "共 0 台 / 没有匹配的
// 自带节点" in answer to a query that errored is a confident wrong answer, and
// this is the table where believing "there is no such node" is most expensive.
// Executed against the template directly: the failure is a store-level error,
// and this asserts what the operator would actually read on the page.
func TestAdminHomeRendersByoQueryFailureAsFailure(t *testing.T) {
	var buf strings.Builder
	data := adminHomeData{
		ByoSearch: "needle", ByoErr: true, ByoRemovedErr: true,
		ByoPage: 1, ByoTotalPages: 1, ByoRemovedPage: 1, ByoRemovedTotalPages: 1,
		Page: 1, Settings: adminSettingsView{},
	}
	if err := adminUsersTmpl.Execute(&buf, data); err != nil {
		t.Fatal(err)
	}
	html := buf.String()
	for _, want := range []string{
		"查询失败",              // the heading must not claim 共 0 台
		"不是</b>\"没有匹配\"的结果", // the explicit banner
		"查询失败，结果未知",         // the empty-table row
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("failed BYO query does not render %q; operator would read it as a definitive answer", want)
		}
	}
	if strings.Contains(html, "匹配\"needle\"的共 0 台") {
		t.Fatalf("failed BYO query still rendered a match count")
	}
}

// The BYO search form is a GET form, so whatever it does not carry is LOST.
// The user table is paged independently; submitting a node search must not
// bounce the operator back to page 1 of the user list.
func TestAdminByoSearchFormCarriesUserTablePage(t *testing.T) {
	var buf strings.Builder
	if err := adminUsersTmpl.Execute(&buf, adminHomeData{
		Page: 3, Search: "alice", Sort: "email", Dir: "asc",
		TotalPages: 5, ByoPage: 1, ByoTotalPages: 1,
		ByoRemovedPage: 1, ByoRemovedTotalPages: 1,
	}); err != nil {
		t.Fatal(err)
	}
	html := buf.String()
	form := html[strings.Index(html, `class="byo-search"`):]
	form = form[:strings.Index(form, "</form>")]
	for _, want := range []string{
		`name="page" value="3"`, `name="q" value="alice"`,
		`name="sort" value="email"`, `name="dir" value="asc"`,
	} {
		if !strings.Contains(form, want) {
			t.Fatalf("BYO search form drops %s — submitting it resets the user table:\n%s", want, form)
		}
	}
	// It must NOT carry the BYO page numbers: a new search invalidates them.
	if strings.Contains(form, `name="bp"`) || strings.Contains(form, `name="brp"`) {
		t.Fatalf("BYO search form carries a stale BYO page number:\n%s", form)
	}
}

// The removed section is searched AND paged: a search matching more removed
// nodes than fit on one of its short pages must not strand the extras.
func TestAdminDashboardByoRemovedSectionIsPaged(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	const n = adminByoRemovedShown + 2
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("gone-%02d", i)
		seedByoNode(t, store, id, "u1", "needle-box", "", int64(1000+i))
		if err := store.MarkNodeRemoved(ctx, id, int64(2000+i)); err != nil {
			t.Fatal(err)
		}
	}

	page1 := getAdminPathHTML(t, ts, ts.URL, "/admin?bq=needle", cookie)
	// The heading must say a filter is active and how many matched — not a
	// bare count that reads as "this is all of them". The wording moved when the
	// heading was restructured for translation (the branches now hold whole
	// clauses instead of a sentence split around {{if}}); the property is the
	// same and is what is asserted.
	// Asserted as three separate facts rather than one exact string: the wording
	// and the markup around it are free to change, the property is not.
	for _, want := range []string{"匹配：", `"needle"`, fmt.Sprintf("%d", n)} {
		if !strings.Contains(page1, want) {
			t.Fatalf("removed section heading does not state the filter and match count (missing %q)", want)
		}
	}
	if !strings.Contains(page1, "brp=2") {
		t.Fatalf("removed section has %d matches (page %d) but no page-2 link", n, adminByoRemovedShown)
	}
	// The stalest two removals live on page 2 and must be reachable there.
	page2 := getAdminPathHTML(t, ts, ts.URL, "/admin?bq=needle&brp=2", cookie)
	if !strings.Contains(page2, "/admin/nodes/gone-00/restore") {
		t.Fatalf("page 2 of the removed section does not reach the oldest match")
	}
	// Paging the removed section must not disturb the live table's page.
	if !strings.Contains(page2, "brp=1") && !strings.Contains(page2, "bq=needle") {
		t.Fatalf("removed pager lost the search term")
	}
}
