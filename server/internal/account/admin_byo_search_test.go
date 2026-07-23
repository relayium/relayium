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
				Search: tc.search, Removed: tc.removed, Now: 1000, Limit: 50})
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

// Pagination has to return the right slice AND, crucially, must not read the
// rows outside it: the whole point is that an unbounded table is no longer
// fully loaded on every dashboard render.
func TestListByoNodesPaginationSliceAndTotal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	const n = 25
	for i := 0; i < n; i++ {
		seedByoNode(t, s, fmt.Sprintf("byo-%02d", i), "u1", "", "", int64(1000+i))
	}

	page1, total, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Now: 2000, Limit: 10, Offset: 0})
	if err != nil {
		t.Fatal(err)
	}
	if total != n {
		t.Fatalf("total=%d want %d", total, n)
	}
	// The page itself must be exactly the page: proof the LIMIT is in SQL, not
	// a Go-side truncation after every row was already read.
	if len(page1) != 10 {
		t.Fatalf("page 1 returned %d rows, want 10 (LIMIT not pushed to SQL?)", len(page1))
	}
	// Newest heartbeat first, so page 1 is byo-24..byo-15.
	if page1[0].ID != "byo-24" || page1[9].ID != "byo-15" {
		t.Fatalf("page 1 = %s..%s, want byo-24..byo-15", page1[0].ID, page1[9].ID)
	}
	page2, total2, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Now: 2000, Limit: 10, Offset: 10})
	if err != nil {
		t.Fatal(err)
	}
	if total2 != n {
		t.Fatalf("page 2 total=%d want %d", total2, n)
	}
	if len(page2) != 10 || page2[0].ID != "byo-14" {
		t.Fatalf("page 2 = %d rows starting %s, want 10 starting byo-14", len(page2), page2[0].ID)
	}
	last, _, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Now: 2000, Limit: 10, Offset: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(last) != 5 {
		t.Fatalf("last page returned %d rows, want 5", len(last))
	}
	// Searching narrows the total, not just the page.
	seedByoNode(t, s, "needle", "u1", "needle-box", "", 9000)
	_, ntotal, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Search: "needle", Now: 2000, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if ntotal != 1 {
		t.Fatalf("search total=%d want 1", ntotal)
	}
}

// Ranking must survive the move into SQL: a draining node, then one still
// holding live files, outrank a merely-recent heartbeat.
func TestListByoNodesRanksDrainingAndFileHoldersFirst(t *testing.T) {
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
	rows, _, err := s.ListByoNodes(ctx, AdminByoNodeQuery{Now: 5000, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, n := range rows {
		got = append(got, n.ID)
	}
	if strings.Join(got, ",") != "draining,holder,idle" {
		t.Fatalf("ranking = %v, want draining,holder,idle", got)
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
