package account

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 跨用户伪造的既有防线对**过期/未知**的码是"无法反驳即接受"，所以持有节点凭据的人
// 仍然能给别人记账，而且整个过程完全无声。真正的修复要动计费链路（报告 M1）；在那
// 之前，这条告警是"被记了 20 TB"和"有人在记 20 TB"之间的唯一区别。
func TestWarnImplausibleAttribution(t *testing.T) {
	capture := func(fn func()) string {
		var buf bytes.Buffer
		old := log.Writer()
		log.SetOutput(&buf)
		defer log.SetOutput(old)
		fn()
		return buf.String()
	}

	t.Run("正常量级不喊", func(t *testing.T) {
		out := capture(func() {
			// 30 秒里给一个用户记 2 GiB —— 一次很大但完全真实的传输。
			warnImplausibleAttribution("n1", 3, map[string]int64{"u1": 2 << 30})
		})
		if out != "" {
			t.Fatalf("正常心跳不该告警，却输出了 %q", out)
		}
	})

	t.Run("单用户量级离谱要喊，并且点名是谁", func(t *testing.T) {
		out := capture(func() {
			warnImplausibleAttribution("n1", 2, map[string]int64{"victim": 20 << 40}) // 20 TiB
		})
		if !strings.Contains(out, "WARNING") || !strings.Contains(out, "victim") || !strings.Contains(out, "n1") {
			t.Fatalf("告警里必须同时有节点和被记账的用户，得到 %q", out)
		}
	})

	t.Run("条数离谱也要喊 —— 它比字节数更早暴露", func(t *testing.T) {
		out := capture(func() {
			warnImplausibleAttribution("n1", 7000, map[string]int64{"u1": 1})
		})
		if !strings.Contains(out, "7000") {
			t.Fatalf("条数异常没有被报出来：%q", out)
		}
	})

	t.Run("多个受害者各喊一条", func(t *testing.T) {
		out := capture(func() {
			warnImplausibleAttribution("n1", 4, map[string]int64{"a": 200 << 30, "b": 200 << 30})
		})
		if strings.Count(out, "WARNING") != 2 {
			t.Fatalf("每个被超额记账的用户都该有一条，得到 %q", out)
		}
	})
}

// 限幅（方案 C）。攻击者靠"每条 usage 换一个新 allocID"绕开单条约 3.25 GiB 的钳制：
// 一个 1 MiB 的心跳体能塞约 7000 条，一次就给受害者记上约 20 TB，把他的月配额打满
// （后果是那个用户的中继/上传/下载被拒——对他的拒绝服务）。
func TestHeartbeatClampsPerUserAllocations(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	node, _ := s.store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:f:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1,
	})
	victim, _ := s.store.UpsertUserByEmail(ctx, "victim@example.com", "V")

	// 伪造：200 条各带新 allocID，每条 1 GiB —— 想记 200 GiB。
	const forged = 200
	const per = int64(1) << 30
	usage := make([]nodeUsage, 0, forged)
	for i := 0; i < forged; i++ {
		usage = append(usage, nodeUsage{
			AllocID:      fmt.Sprintf("forged-%d", i),
			Username:     "6000:" + victim.ID + ".A2C4E6",
			RelayedBytes: per,
		})
	}
	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: node.ID, Status: "ok", Usage: usage})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d %s", w.Code, w.Body)
	}

	got, err := s.store.UserRelayedSince(ctx, victim.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := int64(maxAllocsPerUser) * per
	if got != want {
		t.Fatalf("attributed %d bytes, want %d (clamped at %d allocations)", got, want, maxAllocsPerUser)
	}
}

// 正常心跳（个位数分配）必须一条不少地记进去——限幅只能咬伪造，不能咬真实用量。
func TestHeartbeatDoesNotClampNormalTraffic(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	node, _ := s.store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:f:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1,
	})
	u, _ := s.store.UpsertUserByEmail(ctx, "real@example.com", "R")

	var usage []nodeUsage
	var want int64
	for i := 0; i < 6; i++ { // 六条并发分配，很正常
		b := int64(500) << 20
		usage = append(usage, nodeUsage{
			AllocID: fmt.Sprintf("real-%d", i), Username: "6000:" + u.ID + ".A2C4E6", RelayedBytes: b,
		})
		want += b
	}
	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: node.ID, Status: "ok", Usage: usage})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	got, _ := s.store.UserRelayedSince(ctx, u.ID, 0)
	if got != want {
		t.Fatalf("正常流量被削掉了：记了 %d，应为 %d", got, want)
	}
}

// 限幅是**按用户**算的：一个用户触顶不该影响同一次心跳里的其他用户。
func TestClampIsPerUser(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	node, _ := s.store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:f:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1,
	})
	a, _ := s.store.UpsertUserByEmail(ctx, "a@example.com", "A")
	b, _ := s.store.UpsertUserByEmail(ctx, "b@example.com", "B")

	var usage []nodeUsage
	for i := 0; i < maxAllocsPerUser+50; i++ { // a 触顶
		usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("a-%d", i), Username: "6000:" + a.ID + ".A2C4E6", RelayedBytes: 1 << 20})
	}
	usage = append(usage, nodeUsage{AllocID: "b-1", Username: "6000:" + b.ID + ".A2C4E6", RelayedBytes: 7 << 20})

	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: node.ID, Status: "ok", Usage: usage})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	mux.ServeHTTP(httptest.NewRecorder(), r)

	gotB, _ := s.store.UserRelayedSince(ctx, b.ID, 0)
	if gotB != 7<<20 {
		t.Fatalf("另一个用户被牵连了：记了 %d，应为 %d", gotB, 7<<20)
	}
}
