package account

import (
	"testing"
	"time"
)

// 后台的「可存储」列必须是放置过滤三道闸取最小值，也就是这台节点现在真正还能
// 接收多少字节；任一道闸把它整台排除时是 0。逐条对着 SQLiteStore.StorageNodes
// 的 WHERE 来。
func TestStorableBytesMirrorsPlacementGates(t *testing.T) {
	const gib = int64(1) << 30
	const gb = int64(1000 * 1000 * 1000)

	cases := []struct {
		name string
		node Node
		want int64
	}{
		{
			// 三道闸都宽松：结果就是 70% 余量那道算出来的值（旧行为）。
			// 40 GiB 剩余 / 160 GiB 总量（25% 剩余，过得了 20% 卷保留），
			// 硬盘上限 100 GiB、已存 0（还剩 100 GiB，比 28 GiB 宽）。
			name: "all gates loose -> headroom term",
			node: Node{StorageEnabled: true, StorageFree: 40 * gib, StorageTotal: 160 * gib,
				DiskLimitBytes: 100 * gib, StoredBytes: 0},
			want: 28 * gib, // usableBytes(40 GiB)
		},
		{
			// 终审给的真实场景：100 GB 盘用了 92 GB、剩 8 GB。8% 剩余已低于
			// 总量的 20%，卷保留那道闸把整台排除，一个字节都放不进去。
			// 这一列以前显示 5.6 GB（8×0.7），是纯粹的谎话。
			name: "past the 80% volume reserve -> zero, not the headroom term",
			node: Node{StorageEnabled: true, StorageFree: 8 * gb, StorageTotal: 100 * gb},
			want: 0,
		},
		{
			// 卷保留的边界：剩余正好等于总量的 1/volumeReserveDen 时仍然过闸
			// （SQL 是 >=）。20 GiB / 100 GiB。
			name: "exactly at the volume reserve boundary -> still in the pool",
			node: Node{StorageEnabled: true, StorageFree: 20 * gib, StorageTotal: 100 * gib},
			want: 14 * gib, // usableBytes(20 GiB)
		},
		{
			// 管理员限额是最紧的一道：盘上还很空，但 disk_limit - stored 只剩
			// 3 GiB，放置也只放得下 3 GiB。
			name: "disk limit is the tightest gate -> limit minus stored",
			node: Node{StorageEnabled: true, StorageFree: 40 * gib, StorageTotal: 160 * gib,
				DiskLimitBytes: 50 * gib, StoredBytes: 47 * gib},
			want: 3 * gib,
		},
		{
			// 管理员把限额调到低于已存量：余量是负的，SQL 那边 >= minFree 必然
			// 不成立（节点被排除）。这一列显示 0，绝不能显示负数。
			name: "disk limit below stored bytes -> zero, never negative",
			node: Node{StorageEnabled: true, StorageFree: 40 * gib, StorageTotal: 160 * gib,
				DiskLimitBytes: 10 * gib, StoredBytes: 47 * gib},
			want: 0,
		},
		{
			// disk_limit_bytes = 0 是「无限」，不是「一个字节都不许存」——
			// SQL 里是 `disk_limit_bytes = 0 OR ...`。
			name: "disk limit zero means unlimited, not zero capacity",
			node: Node{StorageEnabled: true, StorageFree: 40 * gib, StorageTotal: 160 * gib,
				DiskLimitBytes: 0, StoredBytes: 47 * gib},
			want: 28 * gib,
		},
		{
			// 节点从未上报存储信息：SQL 里 storage_total = 0 是**豁免**卷保留
			// 那道闸的，所以这里也要豁免，剩下的两道照算。这里刻意给一个非零
			// 的 storage_free，把「豁免」和「结果恰好是 0」区分开。
			name: "never reported total exempts the volume reserve, other gates still apply",
			node: Node{StorageEnabled: true, StorageFree: 10 * gib, StorageTotal: 0},
			want: 7 * gib,
		},
		{
			// 真正的「什么都没上报」：free 也是 0，于是 70% 那道闸自己就算出 0。
			// 这一列显示 0 是诚实的——放置确实一个字节都放不上去。
			name: "nothing reported at all -> zero",
			node: Node{StorageEnabled: true, StorageFree: 0, StorageTotal: 0},
			want: 0,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := storableBytes(c.node); got != c.want {
				t.Fatalf("storableBytes = %d, want %d (free=%d total=%d limit=%d stored=%d)",
					got, c.want, c.node.StorageFree, c.node.StorageTotal, c.node.DiskLimitBytes, c.node.StoredBytes)
			}
		})
	}
}

// adminNodeView 必须把 storableBytes 的结果搬进 StorableBytes，而不是退回成
// usableBytes(剩余)。用用户报的那组真实数字：剩余 2.9 GB、总量 18.3 GB —— 那
// 台节点已经过了卷保留（2.9×5 = 14.5 < 18.3），一个字节都放不进去。
func TestNodeViewDerivesStorableBytes(t *testing.T) {
	const gb = int64(1000 * 1000 * 1000)
	free := 29 * gb / 10   // 2.9 GB
	total := 183 * gb / 10 // 18.3 GB

	views := nodeViews([]Node{{
		ID: "n1", OwnerType: "fleet", StorageEnabled: true,
		StorageFree: free, StorageTotal: total,
	}}, map[string]int64{}, time.Unix(10000, 0), Settings{})

	if len(views) != 1 {
		t.Fatalf("nodeViews returned %d views, want 1", len(views))
	}
	if views[0].StorableBytes != 0 {
		t.Fatalf("StorableBytes = %d, want 0: this node is past the volume reserve and StorageNodes excludes it entirely. %d would be the 70%% headroom term alone (the old, misleading value) and %d would be bytes already used.",
			views[0].StorableBytes, usableBytes(free), total-free)
	}
}

// EffectiveTrafficLimitBytes must be the *resolved* limit (resolveNodeTrafficLimit),
// not the raw node column: a node with TrafficLimitBytes=0 inherits the global
// default rather than being unlimited (see nodes.go's 2026-07 semantics change).
func TestNodeViewsEffectiveTrafficLimitInheritsGlobalDefault(t *testing.T) {
	const gib = int64(1) << 30
	now := time.Unix(10000, 0)
	st := Settings{NodeTrafficDefault: 1024 * gib} // 1 TiB

	views := nodeViews([]Node{{ID: "n1", TrafficLimitBytes: 0}}, map[string]int64{}, now, st)
	if len(views) != 1 {
		t.Fatalf("nodeViews returned %d views, want 1", len(views))
	}
	if views[0].EffectiveTrafficLimitBytes != st.NodeTrafficDefault {
		t.Fatalf("EffectiveTrafficLimitBytes = %d, want global default %d", views[0].EffectiveTrafficLimitBytes, st.NodeTrafficDefault)
	}
}

// A node with its own TrafficLimitBytes set must show that override, not the
// global default, even when the default is larger.
func TestNodeViewsEffectiveTrafficLimitUsesNodeOverride(t *testing.T) {
	const gib = int64(1) << 30
	now := time.Unix(10000, 0)
	st := Settings{NodeTrafficDefault: 1024 * gib} // 1 TiB
	override := 500 * gib

	views := nodeViews([]Node{{ID: "n1", TrafficLimitBytes: override}}, map[string]int64{}, now, st)
	if len(views) != 1 {
		t.Fatalf("nodeViews returned %d views, want 1", len(views))
	}
	if views[0].EffectiveTrafficLimitBytes != override {
		t.Fatalf("EffectiveTrafficLimitBytes = %d, want node override %d", views[0].EffectiveTrafficLimitBytes, override)
	}
}
