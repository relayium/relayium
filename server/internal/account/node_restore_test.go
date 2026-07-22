package account

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
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

// A deregistered node that re-registers used to come back SILENTLY DEAD: upsert
// preserves removed_at, so it ran, heartbeated and was invisible to placement,
// ICE and downloads forever, with a 200 and nothing in the logs. Refusing makes
// that state discoverable at both ends.
func TestRegisterRefusesDeregisteredNode(t *testing.T) {
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
	w := register(n.ID)
	if w.Code != http.StatusConflict {
		t.Fatalf("re-register of a deregistered node got %d, want 409", w.Code)
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "deregistered") {
		t.Errorf("refusal body does not say why: %s", w.Body.String())
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

func nodeIDsOf(nodes []Node) []string {
	ids := make([]string, 0, len(nodes))
	for _, n := range nodes {
		ids = append(ids, n.ID)
	}
	return ids
}
