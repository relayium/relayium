package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// N-0930-6: a single-shot upload racing a node delete whose immediate blob
// DELETE fails must leave a queued delete GC can still resolve and finish.

// n0930FlakyDeleteNode stores PUT bodies, runs onPut after the body is stored
// (the node delete lands there, between placement and persist), and refuses
// every DELETE while failDelete is set — the node is unreachable for deletes
// at the moment the upload tries to drop its blob.
type n0930FlakyDeleteNode struct {
	mu         sync.Mutex
	objects    map[string]int
	failDelete bool
	deletes    int
}

func newN0930FlakyDeleteNode(t *testing.T, onPut func()) (*n0930FlakyDeleteNode, *httptest.Server) {
	t.Helper()
	n := &n0930FlakyDeleteNode{objects: map[string]int{}, failDelete: true}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		switch r.Method {
		case http.MethodPut:
			b, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "write failed", http.StatusInternalServerError)
				return
			}
			n.mu.Lock()
			n.objects[key] = len(b)
			n.mu.Unlock()
			onPut()
			io.WriteString(w, `{"size":`+strconv.Itoa(len(b))+`}`)
		case http.MethodDelete:
			n.mu.Lock()
			defer n.mu.Unlock()
			n.deletes++
			if n.failDelete {
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
				return
			}
			delete(n.objects, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)
	return n, srv
}

func (n *n0930FlakyDeleteNode) objectCount() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.objects)
}

func (n *n0930FlakyDeleteNode) setFailDelete(v bool) {
	n.mu.Lock()
	n.failDelete = v
	n.mu.Unlock()
}

func TestN0930_6_SingleShotRacingNodeDeleteWithFailedDropStaysResolvable(t *testing.T) {
	for _, ownerType := range []string{"fleet", "user"} {
		t.Run(ownerType, func(t *testing.T) {
			h := newMeterHarness(t, "n0930-6-"+ownerType+"@example.com")
			ctx := context.Background()
			nodeID := "wn35-" + ownerType
			var delErr error
			var deleted bool
			node, srv := newN0930FlakyDeleteNode(t, func() {
				if deleted {
					return
				}
				deleted = true
				if ownerType == "fleet" {
					delErr = h.store.DeleteFleetNode(ctx, nodeID)
				} else {
					delErr = h.store.DeleteNode(ctx, nodeID, h.userID)
				}
			})
			h.addNode(t, ownerType, srv)

			code := h.serve(t, meterReq{body: wn35Body(900)})
			if !deleted || delErr != nil {
				t.Fatalf("the node was not deleted mid-upload: deleted=%v err=%v", deleted, delErr)
			}
			// The upload failed exactly as before this change: no object, no
			// daily-quota debit, traffic metered once for billable bytes only.
			want := meterState{meter: 900}
			if ownerType == "user" {
				want = meterState{}
			}
			if st := h.state(t); code != http.StatusInternalServerError || st != want {
				t.Fatalf("code=%d state=%+v, want 500 %+v", code, st, want)
			}
			if ownerType == "fleet" {
				assertMeteredOnce(t, h, 900)
			} else {
				assertNotMetered(t, h)
			}
			if node.objectCount() != 1 {
				t.Fatalf("setup: the blob should still be on the node after the failed drop (%d objects)", node.objectCount())
			}

			// The failed drop was queued, and the queued id still resolves.
			var queued int
			if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM pending_node_deletes WHERE node_id = ?`, nodeID).Scan(&queued); err != nil {
				t.Fatal(err)
			}
			if queued != 1 {
				t.Fatalf("pending deletes for the node = %d, want 1", queued)
			}
			exists, deletedAt, removedAt := am4rDeletedAt(t, h.store, nodeID)
			if !exists || deletedAt == 0 || removedAt == 0 {
				t.Fatalf("node row after the race: exists=%v deleted_at=%d removed_at=%d, want a retired row GC can resolve",
					exists, deletedAt, removedAt)
			}
			if _, err := h.svc.blobFor(ctx, nodeID); err != nil {
				t.Fatalf("the queued delete's node does not resolve: %v", err)
			}

			// Retired means out of every pool, and the id stays refused to others.
			if pool, _ := h.store.StorageNodes(ctx, 0, 0); len(pool) != 0 {
				t.Fatalf("restored node is in the fleet storage pool: %+v", pool)
			}
			if pool, _ := h.store.UserStorageNodes(ctx, h.userID, 0, 0); len(pool) != 0 {
				t.Fatalf("restored node is in the owner's storage pool: %+v", pool)
			}
			if pool, _ := h.store.UserNodesAll(ctx, h.userID); len(pool) != 0 {
				t.Fatalf("restored node is listed to its owner: %+v", pool)
			}
			if state, _ := h.store.NodeIDReuseState(ctx, nodeID, "user", "someone-else"); state != NodeIDTombstoned {
				t.Fatalf("another user may take the id: state=%v", state)
			}

			// The node comes back for deletes: GC finishes the job, then the row goes.
			node.setFailDelete(false)
			am4rGC(h.store, h.svc, time.Now().Unix()).drainPending(ctx)
			if node.objectCount() != 0 {
				t.Fatalf("GC did not delete the orphaned blob (%d objects left)", node.objectCount())
			}
			if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM pending_node_deletes WHERE node_id = ?`, nodeID).Scan(&queued); err != nil {
				t.Fatal(err)
			}
			if queued != 0 {
				t.Fatalf("pending deletes after a successful drain = %d, want 0", queued)
			}
			if purged, err := h.store.PurgeRetiredNodes(ctx); err != nil || purged != 1 {
				t.Fatalf("PurgeRetiredNodes = %d (err %v), want the restored row removed", purged, err)
			}
			if state, _ := h.store.NodeIDReuseState(ctx, nodeID, "user", "someone-else"); state != NodeIDTombstoned {
				t.Fatalf("after purge another user may take the id: state=%v", state)
			}
			// Nothing else was billed along the way.
			if ownerType == "fleet" {
				assertMeteredOnce(t, h, 900)
			} else {
				assertNotMetered(t, h)
			}
		})
	}
}

// A node deleted between placement and the upload's own snapshot is refused
// before any body byte moves: nothing to meter, nothing to drop.
func TestN0930_6_NodeGoneBeforeSnapshotIsRefusedUpFront(t *testing.T) {
	h := newMeterHarness(t, "n0930-6-gone@example.com")
	node, srv := newN0930FlakyDeleteNode(t, func() {})
	h.addNode(t, "fleet", srv)
	h.svc.store = &n0930GetNodeHook{Store: h.svc.store, before: func(id string) {
		_ = h.store.DeleteFleetNode(context.Background(), id)
	}}
	code := h.serve(t, meterReq{body: wn35Body(900)})
	if code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d, want 503", code)
	}
	if st := h.state(t); st != (meterState{}) {
		t.Fatalf("state=%+v, want nothing recorded", st)
	}
	assertNotMetered(t, h)
	if node.objectCount() != 0 {
		t.Fatal("the body reached the node")
	}
}

// n0930GetNodeHook runs before on every GetNode: the upload's snapshot read is
// the first GetNode after placement on the single-shot path.
type n0930GetNodeHook struct {
	Store
	before func(id string)
}

func (h *n0930GetNodeHook) GetNode(ctx context.Context, id string) (Node, bool, error) {
	h.before(id)
	return h.Store.GetNode(ctx, id)
}

// Store-level guards on what may be restored.
func TestN0930_6_RestoreOnlyTheSameOwnersTombstonedNode(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	owner, err := st.UpsertUserByEmail(ctx, "n0930-6-owner@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := st.UpsertUserByEmail(ctx, "n0930-6-other@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	mk := func(id, ownerType, ownerUserID string) Node {
		return Node{ID: id, OwnerType: ownerType, OwnerUserID: ownerUserID, StorageEnabled: true,
			StorageURL: "https://" + id + ".example", StorageSecret: "sec-" + id, StorageFP: "fp"}
	}
	tomb := func(id, ownerType, ownerUserID string) {
		if _, err := st.db.ExecContext(ctx,
			`INSERT INTO node_tombstones (id, owner_type, owner_user_id, deleted_at) VALUES (?,?,?,?)`,
			id, ownerType, ownerUserID, 1234); err != nil {
			t.Fatal(err)
		}
	}
	rowExists := func(id string) bool {
		var n int
		_ = st.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id = ?`, id).Scan(&n)
		return n == 1
	}
	queued := func(id string) int {
		var n int
		_ = st.db.QueryRow(`SELECT COUNT(*) FROM pending_node_deletes WHERE node_id = ?`, id).Scan(&n)
		return n
	}

	// Positive: same owner, tombstoned, account alive -> retired row restored
	// with the tombstone's deletion time and the snapshot's endpoint.
	tomb("n6-ok", "user", owner.ID)
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-ok", mk("n6-ok", "user", owner.ID), 5000); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.GetNode(ctx, "n6-ok")
	if err != nil || !ok {
		t.Fatalf("same-owner tombstoned node not restored: ok=%v err=%v", ok, err)
	}
	if got.StorageURL != "https://n6-ok.example" || got.StorageSecret != "sec-n6-ok" || got.OwnerUserID != owner.ID ||
		got.LastSeenAt != 0 || got.TURNSecret != "" || len(got.URLs) != 0 {
		t.Fatalf("restored row carries more than the endpoint: %+v", got)
	}
	if _, d, r := am4rDeletedAt(t, st, "n6-ok"); d != 1234 || r != 1234 {
		t.Fatalf("restored row deleted_at=%d removed_at=%d, want the tombstone's 1234", d, r)
	}
	if queued("n6-ok") != 1 {
		t.Fatal("the delete was not queued")
	}

	// A tombstone of another owner: queue only, no row.
	tomb("n6-foreign", "user", other.ID)
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-f", mk("n6-foreign", "user", owner.ID), 5000); err != nil {
		t.Fatal(err)
	}
	if rowExists("n6-foreign") {
		t.Fatal("restored a node row under a tombstone that names another owner")
	}
	if queued("n6-foreign") != 1 {
		t.Fatal("the delete itself must still be queued")
	}

	// Not tombstoned at all (never deleted): no row is invented.
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-n", mk("n6-never", "fleet", ""), 5000); err != nil {
		t.Fatal(err)
	}
	if rowExists("n6-never") {
		t.Fatal("invented a node row for an id that was never deleted")
	}

	// Purged account: the owner row is gone, its node is not brought back.
	tomb("n6-purged", "user", "no-such-user")
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-p", mk("n6-purged", "user", "no-such-user"), 5000); err != nil {
		t.Fatal(err)
	}
	if rowExists("n6-purged") {
		t.Fatal("restored a purged account's node")
	}

	// An account scheduled for deletion (soft-deleted, row still present) is
	// treated like a purged one.
	dying, err := st.UpsertUserByEmail(ctx, "n0930-6-dying@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.ExecContext(ctx, `UPDATE users SET deleted_at = 1 WHERE id = ?`, dying.ID); err != nil {
		t.Fatal(err)
	}
	tomb("n6-dying", "user", dying.ID)
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-d", mk("n6-dying", "user", dying.ID), 5000); err != nil {
		t.Fatal(err)
	}
	if rowExists("n6-dying") {
		t.Fatal("restored the node of an account being deleted")
	}

	// Fleet: restored with a NULL owner.
	tomb("n6-fleet", "fleet", "")
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-fl", mk("n6-fleet", "fleet", ""), 5000); err != nil {
		t.Fatal(err)
	}
	if !rowExists("n6-fleet") {
		t.Fatal("fleet node not restored")
	}

	// An existing row (here: re-registered live by its owner) is never touched.
	live, err := st.UpsertNode(ctx, Node{ID: "n6-live", OwnerType: "user", OwnerUserID: owner.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "t", StorageEnabled: true, StorageURL: "https://new.example",
		StorageSecret: "new", CreatedAt: 1, LastSeenAt: 99})
	if err != nil {
		t.Fatal(err)
	}
	tomb("n6-live", "user", owner.ID)
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-l", mk("n6-live", "user", owner.ID), 5000); err != nil {
		t.Fatal(err)
	}
	after, _, _ := st.GetNode(ctx, live.ID)
	if after.StorageURL != "https://new.example" || after.LastSeenAt != 99 {
		t.Fatalf("an existing row was rewritten: %+v", after)
	}
	if _, d, _ := am4rDeletedAt(t, st, live.ID); d != 0 {
		t.Fatal("an existing live row was retired")
	}

	// No storage endpoint in the snapshot: nothing to restore.
	tomb("n6-noep", "fleet", "")
	noep := mk("n6-noep", "fleet", "")
	noep.StorageURL = ""
	if err := st.EnqueueNodeDeleteRetainingNode(ctx, "bk-e", noep, 5000); err != nil {
		t.Fatal(err)
	}
	if rowExists("n6-noep") {
		t.Fatal("restored a node without a storage endpoint")
	}
}
