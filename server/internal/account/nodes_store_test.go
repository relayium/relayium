package account

import (
	"context"
	"testing"
)

// NOTE: `newTestStore(t) *SQLiteStore` already exists in sqlite_test.go
// (OpenSQLite(":memory:") + cleanup). Reuse it — do NOT redefine it here, or the
// package won't compile.

func TestUpsertAndListNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", Region: "asia", URLs: []string{"turn:1.2.3.4:3478"},
		TURNSecret: "sek", Version: "0.3.0", CreatedAt: 1000, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if n.ID == "" {
		t.Fatal("expected assigned id")
	}
	// Update by id: change region, keep row count at 1.
	n.Region = "eu"
	if _, err := st.UpsertNode(ctx, n); err != nil {
		t.Fatalf("upsert update: %v", err)
	}
	all, err := st.ListNodes(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 1 || all[0].Region != "eu" || len(all[0].URLs) != 1 {
		t.Fatalf("got %+v", all)
	}
}

func TestTouchNodeKeepMaxAndOnline(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err := st.TouchNode(ctx, n.ID, 500, 0, 2000); err != nil {
		t.Fatalf("touch: %v", err)
	}
	// keep-max: a lower relayed value must not decrease the stored counter.
	if err := st.TouchNode(ctx, n.ID, 300, 0, 2500); err != nil {
		t.Fatalf("touch2: %v", err)
	}
	online, err := st.OnlineNodes(ctx, 2400) // since 2400 -> last_seen 2500 qualifies
	if err != nil {
		t.Fatalf("online: %v", err)
	}
	if len(online) != 1 || online[0].RelayedBytes != 500 {
		t.Fatalf("got %+v", online)
	}
	if got, _ := st.OnlineNodes(ctx, 3000); len(got) != 0 {
		t.Fatal("node should be offline for since=3000")
	}
}
