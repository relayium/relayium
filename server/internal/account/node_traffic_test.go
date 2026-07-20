package account

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

// 节点行里的 traffic_limit_bytes 语义：0 不再是"无限"，而是"继承全局默认"。
// 这条是本次的行为变更点——现存官方节点该字段大多是 0，改完后会立刻获得默认上限。
func TestResolveNodeTrafficLimit(t *testing.T) {
	const gib = int64(1) << 30
	st := Settings{NodeTrafficDefault: 1024 * gib} // 1 TiB

	cases := []struct {
		name string
		node Node
		st   Settings
		want int64
	}{
		{"节点单独配了值就用它", Node{TrafficLimitBytes: 500 * gib}, st, 500 * gib},
		{"节点配的值大于默认也用它", Node{TrafficLimitBytes: 3072 * gib}, st, 3072 * gib},
		{"节点为 0 时继承全局默认", Node{TrafficLimitBytes: 0}, st, 1024 * gib},
		// 全局默认为 0 = 整体不限流量，保留把这套机制关掉的能力。
		{"全局默认为 0 时不限", Node{TrafficLimitBytes: 0}, Settings{NodeTrafficDefault: 0}, 0},
		{"节点有值则不受全局 0 影响", Node{TrafficLimitBytes: 500 * gib}, Settings{NodeTrafficDefault: 0}, 500 * gib},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveNodeTrafficLimit(c.node, c.st); got != c.want {
				t.Fatalf("resolveNodeTrafficLimit = %d, want %d", got, c.want)
			}
		})
	}
}

// 90% 是**调度**口径：中心端在节点跑到生效上限的 90% 时就不再把它发给新连接。
// 那 10% 不是浪费掉的额度，而是留给**已经建连**的会话吐完——流量检查发生在 ICE
// 建连那一刻，字节却在整个会话期间累积。节点本地仍在 100% 才黑洞出向流量。
func TestUsableTraffic(t *testing.T) {
	const gib = int64(1) << 30
	cases := []struct {
		name  string
		limit int64
		want  int64
	}{
		// 1024 GiB = 2^40 字节 = 1099511627776；乘 9 除以 10（整数除法向零截断）
		// = 989560464998。这个字面量是脱离被测公式单独算出来再写死的（没有走
		// gib*9/10 这条与实现同构的路），这样实现把比例写错时测试才能真的抓到。
		{"1 TiB 收到约 900 GiB", 1024 * gib, 989560464998},
		{"500 GiB 收到 450 GiB", 500 * gib, 450 * gib},
		{"不限时仍是 0", 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := usableTraffic(c.limit); got != c.want {
				t.Fatalf("usableTraffic(%d) = %d, want %d", c.limit, got, c.want)
			}
		})
	}
}

// TestICEWithholdsFleetNodeAt90PercentOfInheritedDefault covers the case
// turn_node_traffic_cap_test.go doesn't: a node whose traffic_limit_bytes row
// is 0 (inherits the global default) must still be withheld once it crosses
// the 90% scheduling reserve of that *resolved* limit — not of a literal 0
// (which would mean "never withheld").
func TestICEWithholdsFleetNodeAt90PercentOfInheritedDefault(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0)

	owner, _ := st.UpsertUserByEmail(ctx, "u90@example.com", "u90")
	st.SetEmailVerified(ctx, owner.ID)
	// Same isolation as turn_node_traffic_cap_test.go: this test records
	// 950+900 GiB of usage against the same owner, which would trip the
	// separate owner-level plan traffic gate (turn.go's overTraffic, default
	// Free plan cap is far smaller) and withhold the whole relay list before
	// the per-node 90% check even runs. Give the owner an effectively
	// unlimited plan so only the per-node cap is exercised.
	// TrafficBytes: 0 means unlimited (monthlyTrafficCap's "无限档" branch) —
	// needed because this test's own 950+900 GiB of node usage would exceed
	// any finite plan cap small enough to still call "GiB" a small number.
	if err := st.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: 1 << 30,
		TrafficBytes: 0, RetentionSecs: 86400, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}

	const gib = int64(1) << 30
	if err := st.SetSetting(ctx, SettingNodeTrafficDefault, 1024*gib, now.Unix()); err != nil { // 1 TiB
		t.Fatalf("SetSetting: %v", err)
	}

	// Both nodes leave traffic_limit_bytes at 0 (inherit the 1 TiB default).
	// over90: 950 GiB used > 921.6 GiB (90% of 1 TiB) -> withheld.
	// under90: 900 GiB used < 921.6 GiB -> offered.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "over90", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "under90", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix()})

	st.RecordUsage(ctx, UsageEvent{AllocID: "a", Token: "c", UserID: owner.ID, RelayedBytes: 950 * gib, RecordedAt: now.Unix(), NodeID: "over90", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "b", Token: "c", UserID: owner.ID, RelayedBytes: 900 * gib, RecordedAt: now.Unix(), NodeID: "under90", Billable: true})

	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour}}
	s.pairCodeOwner = func(string) (string, bool) { return owner.ID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)

	var resp struct {
		Relays []relayEntry `json:"relays"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	ids := map[string]bool{}
	for _, e := range resp.Relays {
		ids[e.ID] = true
	}
	if ids["over90"] {
		t.Fatal("node at 950 GiB of an inherited 1 TiB default (>90%) must be withheld")
	}
	if !ids["under90"] {
		t.Fatalf("node at 900 GiB of an inherited 1 TiB default (<90%%) must be offered, got %+v", resp.Relays)
	}
}

// TestNodeLimitsForSendsResolvedDefault checks that nodeLimitsFor never hands a
// node its own unresolved 0 (which the node would read as "unlimited" and
// never engage its local 100% hard gate) when it inherits the global default.
func TestNodeLimitsForSendsResolvedDefault(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0)

	const gib = int64(1) << 30
	if err := st.SetSetting(ctx, SettingNodeTrafficDefault, 1024*gib, now.Unix()); err != nil { // 1 TiB
		t.Fatalf("SetSetting: %v", err)
	}

	node, err := st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "inherits-default", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix()})
	if err != nil {
		t.Fatalf("UpsertNode: %v", err)
	}

	s := &Service{store: st, now: func() time.Time { return now }}
	limits := s.nodeLimitsFor(ctx, node)
	if limits.TrafficLimitBytes != 1024*gib {
		t.Fatalf("nodeLimitsFor.TrafficLimitBytes = %d, want the resolved global default %d (not the node's raw 0)", limits.TrafficLimitBytes, 1024*gib)
	}
}
