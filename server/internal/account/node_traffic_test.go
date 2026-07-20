package account

import "testing"

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
