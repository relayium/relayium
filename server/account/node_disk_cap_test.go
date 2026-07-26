package account

import (
	"context"
	"testing"
)

func TestStorageNodesRespectsDiskLimit(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000
	minFree := int64(1 << 30) // require 1 GiB headroom for a placement

	// physically fine, but disk cap leaves < minFree headroom -> excluded.
	// (disk_limit 5 GiB, stored 4.5 GiB -> 0.5 GiB cap headroom < 1 GiB)
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "capfull", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true, StorageTotal: 100 << 30, StorageFree: 50 << 30,
		StoredBytes: 9 << 29 /*4.5GiB*/, DiskLimitBytes: 5 << 30})
	// disk cap has room ( cap 100 GiB, stored 1 GiB -> 99 GiB headroom ) -> included.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "caproom", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true, StorageTotal: 200 << 30, StorageFree: 150 << 30,
		StoredBytes: 1 << 30, DiskLimitBytes: 100 << 30})
	// unlimited (0) -> included on physical free alone.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "nolimit", URLs: []string{"turn:3.3.3.3:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true, StorageTotal: 200 << 30, StorageFree: 150 << 30,
		StoredBytes: 1 << 30})

	nodes, err := st.StorageNodes(ctx, now-1, minFree)
	if err != nil {
		t.Fatalf("StorageNodes: %v", err)
	}
	got := map[string]bool{}
	for _, n := range nodes {
		got[n.ID] = true
	}
	if got["capfull"] {
		t.Fatal("node at/over disk cap must be excluded from placement")
	}
	if !got["caproom"] || !got["nolimit"] {
		t.Fatalf("nodes with cap headroom / unlimited must be included, got %+v", got)
	}
}
