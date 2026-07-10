package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func nodeService(t *testing.T, token string) *Service {
	t.Helper()
	st := newTestStore(t)
	s := &Service{store: st, cfg: Config{NodeToken: token}, now: func() time.Time { return time.Unix(5000, 0) }}
	return s
}

func TestNodeRegisterAuth(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	body, _ := json.Marshal(nodeRegisterReq{TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Region: "asia", Version: "0.3.0", Capabilities: []string{"relay"}})

	// Missing token -> 401.
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", w.Code)
	}

	// Correct token -> 200 + assigned id.
	r = httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register: got %d", w.Code)
	}
	var resp nodeRegisterResp
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.NodeID == "" || resp.HeartbeatInterval != 30 {
		t.Fatalf("resp %+v", resp)
	}
}

func TestNodeRegisterStorageFields(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	body, _ := json.Marshal(nodeRegisterReq{
		TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Capabilities: []string{"relay", "storage"},
		StorageURL: "http://1.2.3.4:8081", StorageSecret: "ss", StorageTotal: 20 << 30, StorageFree: 10 << 30,
	})
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register: %d", w.Code)
	}
	var resp nodeRegisterResp
	json.Unmarshal(w.Body.Bytes(), &resp)
	got, ok, _ := s.store.GetNode(context.Background(), resp.NodeID)
	if !ok || !got.StorageEnabled || got.StorageURL != "http://1.2.3.4:8081" || got.StorageFree != 10<<30 {
		t.Fatalf("persisted node = %+v ok=%v", got, ok)
	}
}

func TestNodeHeartbeatRecordsUsage(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	// register first
	n, _ := s.store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	hb := nodeHeartbeatReq{
		NodeID: n.ID, Status: "ok", RelayedTotal: 900, StoredBytes: 0,
		Usage: []nodeUsage{{AllocID: "a1", Username: "6000:userX.123456", RelayedBytes: 900}},
	}
	body, _ := json.Marshal(hb)
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: got %d body=%s", w.Code, w.Body)
	}
	// RecordUsage attributed 900 bytes to userX.
	got, err := s.store.UserRelayedSince(context.Background(), "userX", 0)
	if err != nil {
		t.Fatalf("relayed: %v", err)
	}
	if got != 900 {
		t.Fatalf("attributed %d want 900", got)
	}
	// Unknown node -> 410.
	hb.NodeID = "nope"
	body, _ = json.Marshal(hb)
	r = httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusGone {
		t.Fatalf("unknown node: got %d", w.Code)
	}
}

func TestNodeOwnerFleetAndUser(t *testing.T) {
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(context.Background(), "own@x.com", "o")
	// user token "usertok" -> hash stored
	st.CreateNodeToken(context.Background(), NodeToken{ID: "t1", TokenHash: hashToken("usertok"), UserID: u.ID, Name: "n", CreatedAt: 1})
	s := &Service{store: st, cfg: Config{NodeToken: "fleetsecret", EnableUserNodes: true}, now: func() time.Time { return time.Unix(5, 0) }}

	req := func(bearer string) *http.Request {
		r := httptest.NewRequest("POST", "/", nil)
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		return r
	}
	if ot, _, ok := s.nodeOwner(req("fleetsecret")); !ok || ot != "fleet" {
		t.Fatalf("fleet: %q ok=%v", ot, ok)
	}
	ot, uid, ok := s.nodeOwner(req("usertok"))
	if !ok || ot != "user" || uid != u.ID {
		t.Fatalf("user: %q %q ok=%v", ot, uid, ok)
	}
	if _, _, ok := s.nodeOwner(req("garbage")); ok {
		t.Fatal("unknown token must not resolve")
	}
}

func TestRegisterUserNodeSetsOwner(t *testing.T) {
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(context.Background(), "reg@x.com", "r")
	st.CreateNodeToken(context.Background(), NodeToken{ID: "t1", TokenHash: hashToken("usertok"), UserID: u.ID, Name: "n", CreatedAt: 1})
	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(5, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	body, _ := json.Marshal(nodeRegisterReq{TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}})
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer usertok")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register: %d", w.Code)
	}
	var resp nodeRegisterResp
	json.Unmarshal(w.Body.Bytes(), &resp)
	n, _, _ := st.GetNode(context.Background(), resp.NodeID)
	if n.OwnerType != "user" || n.OwnerUserID != u.ID {
		t.Fatalf("node owner = %q/%q", n.OwnerType, n.OwnerUserID)
	}
	// token bound to the node
	list, _ := st.ListNodeTokensByUser(context.Background(), u.ID)
	if len(list) != 1 || list[0].NodeID != resp.NodeID {
		t.Fatalf("token not bound: %+v", list)
	}
}
