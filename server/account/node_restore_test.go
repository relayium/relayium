package account

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The pair MarkNodeRemoved/ClearNodeRemoved must be a door that opens both ways:
// nothing else in the codebase ever writes removed_at back to 0, and the only
// other way out used to be deleting the row (which takes the node's history and
// file bookkeeping with it).
func TestClearNodeRemovedRestoresNodeToService(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "https://x", StorageSecret: "ss",
		StorageFree: 100 << 30, Label: "keep-me", CreatedAt: 1, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MarkNodeRemoved(ctx, n.ID, 5000); err != nil {
		t.Fatal(err)
	}
	if err := st.ClearNodeRemoved(ctx, n.ID); err != nil {
		t.Fatalf("ClearNodeRemoved: %v", err)
	}
	got, found, err := st.GetNode(ctx, n.ID)
	if err != nil || !found {
		t.Fatalf("GetNode: %v found=%v", err, found)
	}
	if got.RemovedAt != 0 {
		t.Errorf("RemovedAt = %d after restore, want 0", got.RemovedAt)
	}
	// The whole point of restore-over-delete: everything else survives.
	if got.Label != "keep-me" || got.StorageSecret != "ss" {
		t.Errorf("restore altered the row: %+v", got)
	}
	// Idempotent, so the admin panel never has to explain a double click.
	if err := st.ClearNodeRemoved(ctx, n.ID); err != nil {
		t.Errorf("second ClearNodeRemoved: %v, want nil", err)
	}
	if err := st.ClearNodeRemoved(ctx, "nosuchnode"); err != ErrNotFound {
		t.Errorf("ClearNodeRemoved(unknown) = %v, want ErrNotFound", err)
	}
}

// The admin route is the operator-facing half of the same door, and it must sit
// behind the same CSRF guard as its neighbours.
func TestAdminRestoreNodeRoute(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	n, _ := store.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"},
		TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err := store.MarkNodeRemoved(ctx, n.ID, 5000); err != nil {
		t.Fatal(err)
	}

	// No cookie: the guard rejects it and the node stays removed.
	noAuth, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/restore", nil)
	respNo, err := client.Do(noAuth)
	if err != nil {
		t.Fatal(err)
	}
	respNo.Body.Close()
	if respNo.StatusCode == http.StatusFound {
		t.Fatalf("unauthenticated restore was accepted (%d)", respNo.StatusCode)
	}
	if got, _, _ := store.GetNode(ctx, n.ID); got.RemovedAt == 0 {
		t.Fatal("unauthenticated restore actually restored the node")
	}

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/restore", nil)
	req.AddCookie(cookie)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("restore: want 302, got %d", resp.StatusCode)
	}
	if got, _, _ := store.GetNode(ctx, n.ID); got.RemovedAt != 0 {
		t.Errorf("RemovedAt = %d after admin restore, want 0", got.RemovedAt)
	}
}

// A deregistered node that re-registers stays removed, and central logs it
// loudly. It must NOT be refused: register runs once at startup, so a refusal
// kills the process and systemd's Restart=always crash-loops it — one bad
// fleet-wide deregistration would take every node DOWN instead of merely making
// it invisible. Registration succeeds; removed_at survives so the node stays out
// of every pool until an admin restores it.
func TestRegisterAcceptsButDoesNotReviveDeregisteredNode(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(1000, 0) },
		nodeHTTP: http.DefaultClient, cfg: Config{MaxFileSize: 1 << 20, NodeToken: "fleet-secret"}}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	register := func(id string) *httptest.ResponseRecorder {
		body := `{"nodeID":"` + id + `","turnSecret":"t","urls":["turn:x:3478"]}`
		r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader([]byte(body)))
		r.Header.Set("Authorization", "Bearer fleet-secret")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}

	n, err := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"},
		TURNSecret: "t", CreatedAt: 1, LastSeenAt: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if w := register(n.ID); w.Code != http.StatusOK {
		t.Fatalf("sanity: re-register of a live node got %d, want 200", w.Code)
	}
	if err := st.MarkNodeRemoved(ctx, n.ID, 5000); err != nil {
		t.Fatal(err)
	}
	if w := register(n.ID); w.Code != http.StatusOK {
		t.Fatalf("re-register of a deregistered node got %d, want 200 (a refusal crash-loops the node)", w.Code)
	}
	// Accepted, but still dead to the fleet: only an admin restore revives it.
	if got, _, _ := st.GetNode(ctx, n.ID); got.RemovedAt != 5000 {
		t.Fatalf("RemovedAt = %d after re-register, want it preserved at 5000", got.RemovedAt)
	}
	// And after an admin restore it registers normally again.
	if err := st.ClearNodeRemoved(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if w := register(n.ID); w.Code != http.StatusOK {
		t.Errorf("register after restore got %d, want 200", w.Code)
	}
}

// The rollout state machines run off NodesByOwnerType. A node deregistered
// moments ago still looks online (its last heartbeat stays fresh for ~90s), and
// decideFleet's candidate filter is only "online and not on target" — so an
// unfiltered listing lets the fleet track command an update to a machine that is
// being uninstalled, then halt the whole track on "silent since update started".
func TestNodesByOwnerTypeExcludesRemoved(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	live, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:a:3478"},
		TURNSecret: "t", CreatedAt: 1, LastSeenAt: 1000})
	gone, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:b:3478"},
		TURNSecret: "t", CreatedAt: 1, LastSeenAt: 1000})
	if err := st.MarkNodeRemoved(ctx, gone.ID, 5000); err != nil {
		t.Fatal(err)
	}
	nodes, err := st.NodesByOwnerType(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].ID != live.ID {
		t.Fatalf("NodesByOwnerType = %d node(s) %v, want only the live one %q",
			len(nodes), nodeIDsOf(nodes), live.ID)
	}
}

// The manual recovery for a lost deregistration: the uninstaller's
// /api/nodes/deregister call is best-effort, and once state.json is gone there
// is nothing left on the machine to retry it with. The admin route reuses
// MarkNodeRemoved — the exact store method the deregister endpoint calls — so
// the outcome must be indistinguishable from a self-reported deregistration:
// the node leaves the storage placement pool, and /restore still reverses it.
func TestAdminMarkNodeRemovedRoute(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	n, err := store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		StorageEnabled: true, StorageURL: "https://x", StorageSecret: "ss",
		StorageFree: 100 << 30, StorageTotal: 100 << 30, CreatedAt: 1, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Sanity: before marking removed, the node is a placement candidate.
	if nodes, err := store.StorageNodes(ctx, 0, 1); err != nil || len(nodes) != 1 {
		t.Fatalf("sanity StorageNodes before remove = %d node(s), err %v, want 1", len(nodes), err)
	}

	// Unauthenticated: rejected, and the node stays exactly as it was.
	noAuth, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/remove", nil)
	respNo, err := client.Do(noAuth)
	if err != nil {
		t.Fatal(err)
	}
	respNo.Body.Close()
	if respNo.StatusCode == http.StatusFound {
		t.Fatalf("unauthenticated remove was accepted (%d)", respNo.StatusCode)
	}
	if got, _, _ := store.GetNode(ctx, n.ID); got.RemovedAt != 0 {
		t.Fatal("unauthenticated remove actually marked the node removed")
	}

	// Authenticated: marks the node removed.
	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/remove", nil)
	req.AddCookie(cookie)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("remove: want 302, got %d", resp.StatusCode)
	}
	got, _, err := store.GetNode(ctx, n.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.RemovedAt == 0 {
		t.Fatal("RemovedAt still 0 after admin remove")
	}

	// It then leaves the placement pool.
	if nodes, err := store.StorageNodes(ctx, 0, 1); err != nil || len(nodes) != 0 {
		t.Fatalf("StorageNodes after remove = %d node(s), err %v, want 0", len(nodes), err)
	}

	// Restore still reverses it.
	restoreReq, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/restore", nil)
	restoreReq.AddCookie(cookie)
	restoreResp, err := client.Do(restoreReq)
	if err != nil {
		t.Fatal(err)
	}
	restoreResp.Body.Close()
	if restoreResp.StatusCode != http.StatusFound {
		t.Fatalf("restore: want 302, got %d", restoreResp.StatusCode)
	}
	if got, _, _ := store.GetNode(ctx, n.ID); got.RemovedAt != 0 {
		t.Errorf("RemovedAt = %d after restore, want 0", got.RemovedAt)
	}
	if nodes, err := store.StorageNodes(ctx, 0, 1); err != nil || len(nodes) != 1 {
		t.Fatalf("StorageNodes after restore = %d node(s), err %v, want 1", len(nodes), err)
	}
}

func nodeIDsOf(nodes []Node) []string {
	ids := make([]string, 0, len(nodes))
	for _, n := range nodes {
		ids = append(ids, n.ID)
	}
	return ids
}
