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
		return storage.NewRemoteBlobStore(nodeURL, "ss", http.DefaultClient), nil
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
