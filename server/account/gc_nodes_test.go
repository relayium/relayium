package account

import (
	"context"
	"io"
	"log"
	"net/http"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// TestGCOrphanQueue: an expired file lives on a node that is offline at sweep
// time. sweep must still delete the stored_files row, and since the blob
// delete fails it enqueues a pending_node_deletes row instead of losing the
// orphan. Once the node comes back, the next sweep's drain pass clears it.
func TestGCOrphanQueue(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "gcnode@example.com", "GCNode")

	n, _ := store.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://127.0.0.1:1/unreachable", StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1000})

	blobKey := "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"
	_ = store.CreateStoredFile(ctx, StoredFile{ID: "orphan", UserID: u.ID, BlobKey: blobKey,
		EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 100, NodeID: n.ID})

	// nodeURL is mutable so BlobFor can point at an unreachable address for the
	// first sweep, then a live fake node for the second.
	nodeURL := n.StorageURL
	blobFor := func(ctx context.Context, nodeID string) (storage.BlobStore, error) {
		if nodeID != n.ID {
			t.Fatalf("unexpected nodeID %q", nodeID)
		}
		return storage.NewRemoteBlobStore(nodeURL, "ss", "", http.DefaultClient), nil
	}

	g := &GC{Store: store, Now: func() int64 { return 1000000 }, Log: log.New(io.Discard, "", 0), BlobFor: blobFor}

	// First sweep: node unreachable -> stored_files row deleted, blob delete
	// fails, so an orphan-retry row is enqueued.
	g.sweep(ctx)

	if _, err := store.GetStoredFile(ctx, "orphan"); err != ErrNotFound {
		t.Fatalf("expired file not deleted: %v", err)
	}
	pend, err := store.ListPendingNodeDeletes(ctx)
	if err != nil {
		t.Fatalf("list pending: %v", err)
	}
	if len(pend) != 1 || pend[0].BlobKey != blobKey || pend[0].NodeID != n.ID {
		t.Fatalf("pending node deletes = %+v, want one row for %s@%s", pend, blobKey, n.ID)
	}

	// Bring the node online, then sweep again: the drain pass should retry the
	// pending delete, succeed, and clear the row.
	nodeStore := map[string][]byte{}
	srv := fakeNode(t, nodeStore)
	defer srv.Close()
	nodeURL = srv.URL

	g.sweep(ctx)

	pend, err = store.ListPendingNodeDeletes(ctx)
	if err != nil {
		t.Fatalf("list pending after drain: %v", err)
	}
	if len(pend) != 0 {
		t.Fatalf("pending node deletes after drain = %+v, want empty", pend)
	}
}

// pendingKeys is the set of blob keys still queued, for the retirement tests.
func pendingKeys(t *testing.T, st *SQLiteStore) map[string]PendingNodeDelete {
	t.Helper()
	list, err := st.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatalf("list pending: %v", err)
	}
	out := map[string]PendingNodeDelete{}
	for _, p := range list {
		out[p.BlobKey] = p
	}
	return out
}

// AGE IS NOT A REASON. The orphan-retry queue used to be pruned on enqueued_at
// alone, so a blob on a node that had been unreachable for a week lost the only
// row in the system that knew it existed — the stored_files/upload_sessions row
// it came from having been deleted in the same transaction that queued it. The
// prune reported a bounded table; what it had actually produced was ciphertext
// that is both permanently present and permanently invisible.
//
// Neither is the node row being absent, and neither is removed_at: an
// undischarged row survives all three. Only a discharged hold (deleted_at > 0)
// may be retired by age, and only the irreversible node-deletion transaction —
// which removes its own pending rows explicitly — ends an undischarged one.
func TestAnUndischargedDeleteIsNotRetiredMerelyForBeingOld(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = int64(9_000_000)
	before := now - pendingDeleteMaxAge

	// A node that is registered and simply not answering. This is the week-long
	// outage, and its row is the blob's only owner.
	n, err := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://127.0.0.1:1/unreachable", StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	if err := st.EnqueueNodeDelete(ctx, "bk-never", n.ID, 1000); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// A row on the same node whose delete DID land and which is only being held
	// open in case an in-flight append puts the blob back. Discharged: the bytes
	// are gone, and after the hold it owns nothing.
	if err := st.EnqueueNodeDelete(ctx, "bk-done", n.ID, 1000); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := st.MarkPendingNodeDeleteDone(ctx, "bk-done", n.ID, 2000); err != nil {
		t.Fatalf("mark done: %v", err)
	}
	// An old row naming a machine with no row in `nodes` at all. Its delete has
	// never succeeded, so it is still a blob's only owner: GC must not read the
	// missing node row as "the machine is gone forever" — that inference belongs
	// to the explicit, irreversible node deletion alone, which removes its own
	// pending rows in the same transaction.
	if err := st.EnqueueNodeDelete(ctx, "bk-gone", "no-such-node", 1000); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// ...and the same, freshly queued in this very sweep.
	if err := st.EnqueueNodeDelete(ctx, "bk-gone-fresh", "no-such-node", now); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	retired, retained, err := st.RetirePendingNodeDeletes(ctx, before)
	if err != nil {
		t.Fatalf("retire: %v", err)
	}
	if retired != 1 {
		t.Fatalf("retired %d rows, want exactly the discharged one", retired)
	}
	if retained != 2 {
		t.Fatalf("retained = %d, want both old rows whose deletes have never succeeded reported", retained)
	}
	left := pendingKeys(t, st)
	if _, ok := left["bk-never"]; !ok {
		t.Fatal("a blob whose delete has never succeeded lost its only owner to age alone")
	}
	if _, ok := left["bk-done"]; ok {
		t.Fatal("a discharged, aged hold is still on the books")
	}
	if _, ok := left["bk-gone"]; !ok {
		t.Fatal("an undischarged row was retired because its node row is absent — GC inferred a terminal state only the explicit node deletion may declare")
	}
	if _, ok := left["bk-gone-fresh"]; !ok {
		t.Fatal("a freshly queued row was retired in the same pass that could have queued it")
	}

	// DEREGISTRATION IS NOT THE END, because it is reversible: ClearNodeRemoved
	// puts the machine back with its files intact, so its blobs are suspended
	// rather than unreachable and their owners must survive.
	if err := st.MarkNodeRemoved(ctx, n.ID, now); err != nil {
		t.Fatalf("mark removed: %v", err)
	}
	if _, _, err := st.RetirePendingNodeDeletes(ctx, before); err != nil {
		t.Fatalf("retire after deregistration: %v", err)
	}
	if _, ok := pendingKeys(t, st)["bk-never"]; !ok {
		t.Fatal("deregistering a node — which can be undone — threw away its blobs' only owner")
	}

	// THE EXPLICIT END is the irreversible one: deleting the node row. That
	// transaction removes ITS OWN pending rows — and only its own. The rows
	// naming "no-such-node" were never part of any node deletion, so they stay,
	// undischarged owners that they are, however old they grow.
	if err := st.DeleteFleetNode(ctx, n.ID); err != nil {
		t.Fatalf("delete node: %v", err)
	}
	left = pendingKeys(t, st)
	if _, ok := left["bk-never"]; ok {
		t.Fatal("deleting the node — the explicit, irreversible end — left its own queued deletes behind")
	}
	if _, ok := left["bk-gone"]; !ok {
		t.Fatal("deleting one node swept away another id's undischarged row")
	}
	if _, ok := left["bk-gone-fresh"]; !ok {
		t.Fatal("deleting one node swept away another id's fresh row")
	}
}

// The same property end to end, through the sweep rather than the store: a node
// down for longer than the max age comes back, and the blob is still deleted
// because the row was still there to do it.
func TestAWeekOfflineDoesNotCostABlobItsOnlyCleanupOwner(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "aged@example.com", "Aged")
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://127.0.0.1:1/unreachable", StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1})

	blobKey := "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3"
	_ = st.CreateStoredFile(ctx, StoredFile{ID: "aged-orphan", UserID: u.ID, BlobKey: blobKey,
		EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 100, NodeID: n.ID})

	nodeURL := n.StorageURL
	now := int64(1000)
	g := &GC{Store: st, Now: func() int64 { return now }, Log: log.New(io.Discard, "", 0),
		BlobFor: func(ctx context.Context, nodeID string) (storage.BlobStore, error) {
			return storage.NewRemoteBlobStore(nodeURL, "ss", "", http.DefaultClient), nil
		}}

	// The file expires while the node is unreachable: the row goes, the blob is
	// queued, and the queue row is now the only thing that knows the blob exists.
	g.sweep(ctx)
	if len(pendingKeys(t, st)) != 1 {
		t.Fatalf("expected the orphan to be queued, got %+v", pendingKeys(t, st))
	}

	// Eight days of sweeps against a node that never answers.
	for range 8 {
		now += 24 * 3600
		g.sweep(ctx)
	}
	if _, ok := pendingKeys(t, st)[blobKey]; !ok {
		t.Fatal("eight days of failing to reach a node retired the blob's only cleanup owner")
	}

	// The node comes back on the ninth day. The ciphertext goes, which is the
	// whole point of having kept the row.
	nodeStore := map[string][]byte{blobKey: {1}}
	srv := fakeNode(t, nodeStore)
	defer srv.Close()
	nodeURL = srv.URL
	now += 24 * 3600
	g.sweep(ctx)

	if _, ok := nodeStore[blobKey]; ok {
		t.Fatal("the returning node still holds ciphertext nothing points at")
	}
	if len(pendingKeys(t, st)) != 0 {
		t.Fatalf("the row survived the delete that discharged it: %+v", pendingKeys(t, st))
	}
}
