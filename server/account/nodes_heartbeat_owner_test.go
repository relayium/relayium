package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fleet token 不绑定任何 node id，所以「谁能心跳谁」只能靠这个检查。deregister 和
// update-check 两个兄弟端点一直是双向查的，heartbeat 只查了 user→fleet 一半。
//
// 缺的那一半不是理论问题：心跳写的是 LastSeenAt（一台已经死掉的节点可以被一直保持
// 「在线」）、StorageFree（左右上传落到哪台机器）、ActiveTransfers（左右金丝雀发布
// 先发给谁）。持有 fleet 凭证的人可以拿这三样去操纵**别人自有的 BYO 节点**。
func TestFleetTokenCannotHeartbeatSomeoneElsesNode(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	victim, _ := s.store.UpsertUserByEmail(ctx, "byo@example.com", "V")
	node, err := s.store.UpsertNode(ctx, Node{
		OwnerType: "user", OwnerUserID: victim.ID, URLs: []string{"turn:v:3478"},
		TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1000, StorageFree: 5 << 30,
	})
	if err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(nodeHeartbeatReq{
		NodeID: node.ID, Status: "ok", StorageFree: 900 << 30, RelayedTotal: 0,
	})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret") // 车队凭证，不是这台机器的主人
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("fleet token heartbeating a user-owned node: got %d, want 403 (body=%s)", w.Code, w.Body)
	}
	// 而且必须什么都没写进去——403 之后还落了库等于没拦住。
	after, ok, _ := s.store.GetNode(ctx, node.ID)
	if !ok {
		t.Fatal("node vanished")
	}
	if after.StorageFree != 5<<30 {
		t.Errorf("StorageFree was overwritten to %d — the forged heartbeat still landed", after.StorageFree)
	}
	if after.LastSeenAt != 1000 {
		t.Errorf("LastSeenAt was refreshed to %d — a dead node could be kept 'online' by a stranger", after.LastSeenAt)
	}
}

// 反向仍然要通：车队凭证心跳车队节点是正常路径，别把它一起拦了。
func TestFleetTokenStillHeartbeatsFleetNodes(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	ctx := context.Background()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	node, _ := s.store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:f:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1,
	})
	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: node.ID, Status: "ok"})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("fleet token on a fleet node: got %d, want 200 (body=%s)", w.Code, w.Body)
	}
}
