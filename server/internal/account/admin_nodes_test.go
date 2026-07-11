package account

import (
	"testing"
	"time"
)

func TestNodeViewsOnlineFlag(t *testing.T) {
	now := time.Unix(10000, 0)
	nodes := []Node{
		{ID: "fresh", LastSeenAt: now.Unix() - 10, RelayedBytes: 100},
		{ID: "stale", LastSeenAt: now.Unix() - 1000},
	}
	views := nodeViews(nodes, nil, now)
	if len(views) != 2 {
		t.Fatalf("want 2 views")
	}
	if !views[0].Online {
		t.Fatal("fresh node should be online")
	}
	if views[1].Online {
		t.Fatal("stale node should be offline")
	}
}

func TestNodeViewsStorage(t *testing.T) {
	now := time.Unix(10000, 0)
	views := nodeViews([]Node{{ID: "n", LastSeenAt: now.Unix(), StorageEnabled: true, StorageTotal: 20 << 30, StorageFree: 5 << 30, StoredBytes: 3 << 30}}, nil, now)
	if !views[0].StorageEnabled || views[0].StorageFree != 5<<30 || views[0].StoredBytes != 3<<30 {
		t.Fatalf("view=%+v", views[0])
	}
}
