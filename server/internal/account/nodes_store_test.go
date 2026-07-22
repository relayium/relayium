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

// The node's blob-endpoint TLS fingerprint must round-trip through the store so
// central can pin it on every blob call.
func TestNodeStorageFPRoundTrips(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const fp = "abc123def456"
	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:1.2.3.4:3478"}, TURNSecret: "s",
		StorageURL: "https://1.2.3.4:8081", StorageSecret: "ss", StorageFP: fp,
		StorageEnabled: true, CreatedAt: 1, LastSeenAt: 1,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, ok, err := st.GetNode(ctx, n.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.StorageFP != fp {
		t.Fatalf("StorageFP: want %q, got %q", fp, got.StorageFP)
	}
	// Re-register updates the fingerprint (a node that regenerated its cert).
	n.StorageFP = "newfp999"
	if _, err := st.UpsertNode(ctx, n); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.GetNode(ctx, n.ID); got.StorageFP != "newfp999" {
		t.Fatalf("re-register fingerprint: want newfp999, got %q", got.StorageFP)
	}
}

// The per-node self-update bookkeeping columns (Part 2: automatic rollout)
// must round-trip through UpsertNode/GetNode, and must NOT be clobbered by a
// later re-register (heartbeat/register calls never populate them — only the
// rollout state machine does — so they must survive like `label` does).
func TestNodeUpdateColumnsRoundTripAndSurviveReregister(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:1.2.3.4:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: 1,
		UpdateStartedAt: 1000, UpdateFromVersion: "v0.8.0", UpdateResult: "ok",
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, ok, err := st.GetNode(ctx, n.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.UpdateStartedAt != 1000 || got.UpdateFromVersion != "v0.8.0" || got.UpdateResult != "ok" {
		t.Fatalf("update columns: got %+v", got)
	}
	// A re-register (e.g. from handleNodeRegister, which never sets these
	// fields) must not reset them to zero.
	n.LastSeenAt = 2
	n.UpdateStartedAt, n.UpdateFromVersion, n.UpdateResult = 0, "", ""
	if _, err := st.UpsertNode(ctx, n); err != nil {
		t.Fatalf("re-register: %v", err)
	}
	if got, _, _ := st.GetNode(ctx, n.ID); got.UpdateStartedAt != 1000 || got.UpdateFromVersion != "v0.8.0" || got.UpdateResult != "ok" {
		t.Fatalf("update columns clobbered by re-register: got %+v", got)
	}
}

func TestTouchNodeKeepMaxAndOnline(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err := st.TouchNode(ctx, n.ID, 500, 0, 0, 0, 2000, 0); err != nil {
		t.Fatalf("touch: %v", err)
	}
	// keep-max: a lower relayed value must not decrease the stored counter.
	if err := st.TouchNode(ctx, n.ID, 300, 0, 0, 0, 2500, 0); err != nil {
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
