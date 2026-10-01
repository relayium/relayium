package account

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// N-0930-7: retired nodes (deleted while something still names them) are
// hidden from every other node list; the fleet panel shows them read-only,
// with the references GC is still working through.

// n0930_7Retired builds: a retired user node with 2 queued deletes, 1 upload
// session and 1 stored object; a retired fleet node with 1 queued delete; and a
// live node that must not be listed.
func n0930_7Retired(t *testing.T, st *SQLiteStore) (userID string, userNode, fleetNode, live Node) {
	t.Helper()
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "n0930-7-owner@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	userNode = am4rOwnNode(t, st, u.ID, "https://retired-user.example", 1)
	live = am4rOwnNode(t, st, u.ID, "https://live.example", 1)
	for _, k := range []string{"q1", "q2"} {
		if err := st.EnqueueNodeDelete(ctx, k, userNode.ID, 1); err != nil {
			t.Fatal(err)
		}
	}
	am3rSessionRow(t, st, "n7-sess", u.ID, userNode.ID, StoredPurposeShare, "")
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "n7-f", UserID: u.ID, BlobKey: "n7-fb",
		EncManifest: []byte("m"), Size: 1, CreatedAt: 1, ExpiresAt: 1 << 40, NodeID: userNode.ID}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNode(ctx, userNode.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	fleetNode = am3FleetNode(t, st)
	if err := st.EnqueueNodeDelete(ctx, "fq", fleetNode.ID, 1); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteFleetNode(ctx, fleetNode.ID); err != nil {
		t.Fatal(err)
	}
	// Deterministic order: the fleet node was deleted later.
	if _, err := st.db.ExecContext(ctx, `UPDATE nodes SET deleted_at = 1000 WHERE id = ?`, userNode.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.ExecContext(ctx, `UPDATE nodes SET deleted_at = 2000 WHERE id = ?`, fleetNode.ID); err != nil {
		t.Fatal(err)
	}
	return u.ID, userNode, fleetNode, live
}

func TestN0930_7_ListRetiredNodesCountsWhatKeepsThem(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	userID, userNode, fleetNode, _ := n0930_7Retired(t, st)

	got, total, err := st.ListRetiredNodes(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	want := []RetiredNode{
		{ID: fleetNode.ID, OwnerType: "fleet", DeletedAt: 2000, QueuedDeletes: 1},
		{ID: userNode.ID, OwnerType: "user", OwnerUserID: userID, DeletedAt: 1000, QueuedDeletes: 2, Sessions: 1, Files: 1},
	}
	if total != 2 || len(got) != len(want) {
		t.Fatalf("total=%d rows=%+v, want 2 rows (the live node must not be listed)", total, got)
	}
	for i := range want {
		g := got[i]
		g.Label = "" // labels are seeded by the helpers; not under test
		if g != want[i] {
			t.Fatalf("row %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	// The limit caps rows, not the total.
	got, total, err = st.ListRetiredNodes(ctx, 1)
	if err != nil || total != 2 || len(got) != 1 || got[0].ID != fleetNode.ID {
		t.Fatalf("limit 1: rows=%+v total=%d err=%v", got, total, err)
	}
	// Once GC has taken every reference, the row is purged and drops out.
	for _, q := range []string{`DELETE FROM pending_node_deletes`, `DELETE FROM upload_sessions`, `DELETE FROM stored_files`} {
		if _, err := st.db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.PurgeRetiredNodes(ctx); err != nil {
		t.Fatal(err)
	}
	if got, total, err := st.ListRetiredNodes(ctx, 50); err != nil || total != 0 || len(got) != 0 {
		t.Fatalf("after purge: rows=%+v total=%d err=%v, want none", got, total, err)
	}
}

func n0930_7Fleet(t *testing.T, base string, cookie *http.Cookie, lang string) string {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/admin/fleet", nil)
	req.AddCookie(cookie)
	req.Header.Set("Accept-Language", lang)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /admin/fleet: %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func TestN0930_7_FleetPanelShowsRetiredNodesReadOnly(t *testing.T) {
	ts, _, st := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)

	// Nothing retired: no section at all.
	if page := n0930_7Fleet(t, ts.URL, cookie, "en"); strings.Contains(page, "retired-nodes") {
		t.Fatal("the retired section renders with no retired nodes")
	}

	_, userNode, fleetNode, live := n0930_7Retired(t, st)
	for _, tc := range []struct{ lang, heading, count string }{
		{"en", "Deleted nodes still being cleaned up", "Nodes:2 · Queued deletes 3"},
		{"zh-CN", "已删除、等待清理的节点", "节点数：2 · 排队删除 3"},
	} {
		page := n0930_7Fleet(t, ts.URL, cookie, tc.lang)
		i := strings.Index(page, `class="nodes retired-nodes"`)
		if i < 0 {
			t.Fatalf("%s: no retired section", tc.lang)
		}
		sec := page[i:]
		sec = sec[:strings.Index(sec, "</section>")]
		for _, want := range []string{tc.heading, tc.count, userNode.ID, fleetNode.ID, "n0930-7-owner@example.com"} {
			if !strings.Contains(sec, want) {
				t.Fatalf("%s: retired section lacks %q:\n%s", tc.lang, want, sec)
			}
		}
		if strings.Contains(sec, live.ID) {
			t.Fatalf("%s: a live node is listed as retired", tc.lang)
		}
		if strings.Contains(sec, "<form") || strings.Contains(sec, "<button") {
			t.Fatalf("%s: the retired section offers an action; it must be read-only", tc.lang)
		}
		if tc.lang == "en" && strings.Contains(sec, "已删除") {
			t.Fatalf("en: untranslated copy in the retired section:\n%s", sec)
		}
	}
}
