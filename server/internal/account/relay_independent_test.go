package account

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

// 中继能力与磁盘状态无关：盘满的节点不能再接新文件，但带宽完全正常，必须继续
// 中继。这条测试存在的唯一理由是拦住"盘满了就别用这台了"这种顺手的过滤——
// 那会静默丢掉一整台机器的中继能力，而且不会有任何别的测试报警。
//
// 两个断言缺一不可，且有先后关系：先证明这台节点在 StorageNodes 里确实被
// 排除（也就是测试数据真的构造出了"盘满"这个前提），再证明它在 OnlineNodes /
// handleICE 里仍然存在。没有第一条，第二条就是空转——一台其实没满的节点出现
// 在中继池里什么也说明不了。
//
// 干扰条件排查（照 node_traffic_test.go 踩过的坑逐条核对，本测试数据下的取值）：
//   - owner 级 plan 流量配额：本测试不调用 RecordUsage，owner 当月用量为 0，
//     远低于任何默认 Free 档位，不会触发 turn.go 的 overTraffic/quota 拒绝。
//     故无需像 node_traffic_test.go 那样另外塞一个"近乎不限"的 plan。
//   - strict（只用自己节点）：User.OnlyOwnNodes 未设置，零值 false，不触发。
//   - 邮箱验证：显式 SetEmailVerified，validCode 不会因未验证被撤销。
//   - TURNSecret / URLs：节点显式给了非空值，handleICE 里 `n.TURNSecret == "" ||
//     len(n.URLs) == 0` 的跳过条件不会命中。
//   - last_seen 窗口：LastSeenAt 设为 now，且 OnlineNodes/StorageNodes 都用
//     now-1 作为 since，落在窗口内。
//   - 本分支新加的 90% 节点流量闸：节点 TrafficLimitBytes 留 0，且测试既没
//     设 SettingNodeTrafficDefault 也没建 Service.cfg.NodeTrafficDefault，
//     resolveNodeTrafficLimit 解析出的有效上限是 0（不限），usableTraffic(0)=0，
//     handleICE 里 `cap > 0 && monthlyUsed[n.ID] >= cap` 因 cap<=0 恒为
//     false，不会把这台节点当成"流量超限"withhold 掉。
func TestDiskFullNodeStaysInRelayPool(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0)

	owner, _ := st.UpsertUserByEmail(ctx, "diskfull@example.com", "diskfull")
	st.SetEmailVerified(ctx, owner.ID)

	const gib = int64(1) << 30
	// StorageTotal = 18.3 GiB, StorageFree = 2 GiB: free/total ≈ 10.9% < 20%,
	// i.e. storage_free*5 (10 GiB) < storage_total (18.3 GiB) -> the 80%-full
	// reserve in StorageNodes excludes it. StorageEnabled is true so the
	// exclusion is specifically because the disk is full, not because storage
	// is turned off for this node.
	node := Node{
		OwnerType:      "fleet",
		ID:             "diskfull",
		URLs:           []string{"turn:9.9.9.9:3478"},
		TURNSecret:     "s",
		CreatedAt:      1,
		LastSeenAt:     now.Unix(),
		StorageEnabled: true,
		StorageTotal:   183 * gib / 10, // 18.3 GiB
		StorageFree:    2 * gib,        // 2 GiB
	}
	if _, err := st.UpsertNode(ctx, node); err != nil {
		t.Fatalf("UpsertNode: %v", err)
	}

	since := now.Add(-nodeOnlineWindow).Unix()

	// 1. Storage layer: this node must NOT be a placement candidate.
	storageNodes, err := st.StorageNodes(ctx, since, 0)
	if err != nil {
		t.Fatalf("StorageNodes: %v", err)
	}
	for _, n := range storageNodes {
		if n.ID == "diskfull" {
			t.Fatalf("node with 2 GiB free of 18.3 GiB total (< 20%% headroom) must be excluded from StorageNodes, got %+v", storageNodes)
		}
	}

	// 2. Relay layer: the same node must still be an online relay candidate.
	onlineNodes, err := st.OnlineNodes(ctx, since)
	if err != nil {
		t.Fatalf("OnlineNodes: %v", err)
	}
	found := false
	for _, n := range onlineNodes {
		if n.ID == "diskfull" {
			found = true
		}
	}
	if !found {
		t.Fatalf("disk-full node must still appear in OnlineNodes (relay capacity is independent of disk state), got %+v", onlineNodes)
	}

	// 3. And it must still be handed out by /api/ice.
	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour}}
	s.pairCodeOwner = func(string) (string, bool) { return owner.ID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)

	var resp struct {
		Relays []relayEntry `json:"relays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode /api/ice response: %v", err)
	}
	relayed := false
	for _, e := range resp.Relays {
		if e.ID == "diskfull" {
			relayed = true
		}
	}
	if !relayed {
		t.Fatalf("disk-full node must still be offered as a relay by /api/ice, got %+v", resp.Relays)
	}
}
