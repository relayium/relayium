package account

import (
	"context"
	"testing"
)

func TestNodeStorageFieldsAndStorageNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	// Storage-enabled node with 10 GiB free.
	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		StorageEnabled: true, StorageURL: "http://1.2.3.4:8081", StorageSecret: "ss",
		StorageTotal: 20 << 30, StorageFree: 10 << 30, CreatedAt: 1, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, ok, err := st.GetNode(ctx, n.ID)
	if err != nil || !ok || got.StorageURL != "http://1.2.3.4:8081" || got.StorageSecret != "ss" || !got.StorageEnabled {
		t.Fatalf("getnode: %+v ok=%v err=%v", got, ok, err)
	}
	// TouchNode updates free/total/stored_bytes (all live, not monotonic).
	if err := st.TouchNode(ctx, n.ID, 0, 500, 20<<30, 8<<30, 2000); err != nil {
		t.Fatalf("touch: %v", err)
	}
	// Eligible: online since 1500, needs >= 4 GiB free (has 8).
	nodes, err := st.StorageNodes(ctx, 1500, 4<<30)
	if err != nil || len(nodes) != 1 || nodes[0].StorageFree != 8<<30 {
		t.Fatalf("storagenodes: %+v err=%v", nodes, err)
	}
	// Excluded when minFree too high.
	if got, _ := st.StorageNodes(ctx, 1500, 9<<30); len(got) != 0 {
		t.Fatal("node with 8GiB free must be excluded for minFree=9GiB")
	}
	// Excluded when offline.
	if got, _ := st.StorageNodes(ctx, 3000, 0); len(got) != 0 {
		t.Fatal("stale node must be excluded")
	}
}

func TestStoredFileNodeIDRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "u@x.com", "u")
	f := StoredFile{ID: "f1", UserID: u.ID, BlobKey: "bk", EncManifest: []byte("m"),
		Size: 10, CreatedAt: 1, ExpiresAt: 9999999999, NodeID: "node-7"}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := st.GetStoredFile(ctx, "f1")
	if err != nil || got.NodeID != "node-7" {
		t.Fatalf("got NodeID=%q err=%v", got.NodeID, err)
	}
	// A row created without NodeID reads back as "" (central-local).
	f2 := StoredFile{ID: "f2", UserID: u.ID, BlobKey: "bk2", EncManifest: []byte("m"), Size: 1, CreatedAt: 1, ExpiresAt: 9999999999}
	st.CreateStoredFile(ctx, f2)
	g2, _ := st.GetStoredFile(ctx, "f2")
	if g2.NodeID != "" {
		t.Fatalf("want empty NodeID, got %q", g2.NodeID)
	}
}

func TestTouchNodeStoredBytesIsGauge(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	st.TouchNode(ctx, n.ID, 100, 900, 20<<30, 10<<30, 1000)
	st.TouchNode(ctx, n.ID, 50, 300, 20<<30, 15<<30, 2000) // stored drops 900->300, relayed keep-max 100
	got, _, _ := st.GetNode(ctx, n.ID)
	if got.StoredBytes != 300 {
		t.Fatalf("stored_bytes should track live value (gauge), got %d want 300", got.StoredBytes)
	}
	if got.RelayedBytes != 100 {
		t.Fatalf("relayed_bytes should keep-max, got %d want 100", got.RelayedBytes)
	}
	if got.StorageFree != 15<<30 {
		t.Fatalf("storage_free got %d", got.StorageFree)
	}
}

func TestPendingNodeDeletes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if err := st.EnqueueNodeDelete(ctx, "bk1", "node-7", 100); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	st.EnqueueNodeDelete(ctx, "bk2", "node-7", 101)
	list, err := st.ListPendingNodeDeletes(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %+v err=%v", list, err)
	}
	if err := st.DeletePendingNodeDelete(ctx, "bk1", "node-7"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if list, _ := st.ListPendingNodeDeletes(ctx); len(list) != 1 || list[0].BlobKey != "bk2" {
		t.Fatalf("after delete: %+v", list)
	}
}
