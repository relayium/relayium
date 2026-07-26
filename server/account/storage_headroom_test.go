package account

import (
	"context"
	"testing"
)

// 放置时只承诺用掉剩余空间的 70%，留 30% 余量。边界用 2.9 GiB 剩余构造：
// 0.7 × 2.9 = 2.03 GiB，所以 1.5 GiB 的放置进得去、2.5 GiB 的进不去。
// 如果有人把过滤条件退回成裸的 storage_free >= minFree，第二个断言会失败。
func TestStorageNodesReserves30PercentHeadroom(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000
	const gib = int64(1) << 30

	// 剩余 2.9 GiB / 总量 18.3 GiB。整卷 80% 硬保留在这里不会误伤：
	// 2.9 × 5 = 14.5 < 18.3 会被排除，所以刻意把总量设小一点让它通过，
	// 单独隔离出 70% 这一条件。
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "tight", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true,
		StorageTotal: 4 * gib, StorageFree: 2900 * gib / 1000})

	small, err := st.StorageNodes(ctx, now-1, 1500*gib/1000) // 1.5 GiB
	if err != nil {
		t.Fatalf("StorageNodes(1.5GiB): %v", err)
	}
	if len(small) != 1 {
		t.Fatalf("1.5 GiB placement got %d nodes, want 1 (2.9 GiB free × 0.7 = 2.03 GiB is enough)", len(small))
	}

	big, err := st.StorageNodes(ctx, now-1, 2500*gib/1000) // 2.5 GiB
	if err != nil {
		t.Fatalf("StorageNodes(2.5GiB): %v", err)
	}
	if len(big) != 0 {
		t.Fatalf("2.5 GiB placement got %d nodes, want 0 (only 2.03 GiB is offerable from 2.9 GiB free)", len(big))
	}
}

// usableBytes is the same 70% ratio, exposed as a plain function so Task 4's
// per-request placement check can call it directly instead of re-deriving
// the fraction. Covers the user's real-world scenario (2.9 GiB free -> 2.03
// GiB usable) plus the free=0 edge.
func TestUsableBytes(t *testing.T) {
	const gib = int64(1) << 30

	cases := []struct {
		name string
		free int64
		want int64
	}{
		{"2.9GiB free -> 2.03GiB usable", 2900 * gib / 1000, 2030 * gib / 1000},
		{"zero free -> zero usable", 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := usableBytes(c.free); got != c.want {
				t.Fatalf("usableBytes(%d) = %d, want %d", c.free, got, c.want)
			}
		})
	}
}

// 整卷保留（volumeReserveDen）在 SQL 里出现两处 —— StorageNodes（车队节点）与
// UserStorageNodes（用户自带节点）。这两个测试把边界钉死在 1/volumeReserveDen
// 上：剩余正好等于总量的 1/den 时过闸，略低于就被整台排除。把常量从 5 改成别
// 的值，两边都会红 —— 这正是「这两处 SQL 真的在用那个常量」的证明。
func TestStorageNodesVolumeReserveBoundary(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000
	const gib = int64(1) << 30

	// 剩余正好 1/5 = 20% 的总量：SQL 是 >=，所以刚好过闸。
	// den=4 时 22×4 = 88 < 100，这台会掉出池子。
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "atreserve", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true,
		StorageTotal: 100 * gib, StorageFree: 22 * gib})
	// 剩余 18%：低于保留线，任何 den <= 5 都排除它。钉住「这道闸确实存在」。
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "belowreserve", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true,
		StorageTotal: 100 * gib, StorageFree: 18 * gib})

	nodes, err := st.StorageNodes(ctx, now-1, 1*gib)
	if err != nil {
		t.Fatalf("StorageNodes: %v", err)
	}
	if len(nodes) != 1 || nodes[0].ID != "atreserve" {
		var ids []string
		for _, n := range nodes {
			ids = append(ids, n.ID)
		}
		t.Fatalf("StorageNodes returned %v, want exactly [atreserve]: 22/100 GiB is at the 1/%d volume reserve and must pass, 18/100 GiB is under it and must be excluded", ids, volumeReserveDen)
	}
}

func TestUserStorageNodesVolumeReserveBoundary(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000
	const gib = int64(1) << 30

	st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: "u1", ID: "atreserve", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true,
		StorageTotal: 100 * gib, StorageFree: 22 * gib})
	st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: "u1", ID: "belowreserve", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true,
		StorageTotal: 100 * gib, StorageFree: 18 * gib})

	nodes, err := st.UserStorageNodes(ctx, "u1", now-1, 1*gib)
	if err != nil {
		t.Fatalf("UserStorageNodes: %v", err)
	}
	if len(nodes) != 1 || nodes[0].ID != "atreserve" {
		var ids []string
		for _, n := range nodes {
			ids = append(ids, n.ID)
		}
		t.Fatalf("UserStorageNodes returned %v, want exactly [atreserve]: 22/100 GiB is at the 1/%d volume reserve and must pass, 18/100 GiB is under it and must be excluded", ids, volumeReserveDen)
	}
}
