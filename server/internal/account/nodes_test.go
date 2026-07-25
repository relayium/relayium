package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/authx"
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

	user, _ := s.store.UpsertUserByEmail(context.Background(), "userx@example.com", "X")
	hb := nodeHeartbeatReq{
		NodeID: n.ID, Status: "ok", RelayedTotal: 900, StoredBytes: 0,
		Usage: []nodeUsage{{AllocID: "a1", Username: "6000:" + user.ID + ".123456", RelayedBytes: 900}},
	}
	body, _ := json.Marshal(hb)
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: got %d body=%s", w.Code, w.Body)
	}
	// RecordUsage attributed 900 bytes to the user.
	got, err := s.store.UserRelayedSince(context.Background(), user.ID, 0)
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
	st.CreateNodeToken(context.Background(), NodeToken{ID: "t1", TokenHash: authx.HashToken("usertok"), UserID: u.ID, Name: "n", CreatedAt: 1})
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
	st.CreateNodeToken(context.Background(), NodeToken{ID: "t1", TokenHash: authx.HashToken("usertok"), UserID: u.ID, Name: "n", CreatedAt: 1})
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

func TestHeartbeatBillableAndCrossUserReject(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	owner, _ := st.UpsertUserByEmail(ctx, "hbo@x.com", "o")
	// a user-owned node
	n, _ := st.UpsertNode(ctx, Node{ID: "un", OwnerType: "user", OwnerUserID: owner.ID, URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	st.CreateNodeToken(ctx, NodeToken{ID: "t1", TokenHash: authx.HashToken("utok"), UserID: owner.ID, NodeID: "un", Name: "n", CreatedAt: 1})
	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(50, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	// own-user usage -> recorded non-billable; a DIFFERENT user's attribution -> dropped
	hb := nodeHeartbeatReq{NodeID: n.ID, Status: "ok", Usage: []nodeUsage{
		{AllocID: "a1", Username: "9999:" + owner.ID + ".code", RelayedBytes: 4000},
		{AllocID: "a2", Username: "9999:victim.code", RelayedBytes: 7000},
	}}
	body, _ := json.Marshal(hb)
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer utok")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d", w.Code)
	}
	// owner's own usage recorded but non-billable -> quota sum stays 0
	if q, _ := st.UserRelayedSince(ctx, owner.ID, 0); q != 0 {
		t.Fatalf("own-node relay must be non-billable, quota=%d", q)
	}
	// victim got nothing (cross-user attribution dropped)
	if q, _ := st.UserRelayedSince(ctx, "victim", 0); q != 0 {
		t.Fatalf("cross-user attribution must be dropped, victim quota=%d", q)
	}
}

// A user token must not be able to heartbeat a node it does not own (403).
func TestHeartbeatUserTokenForeignNode(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	owner, _ := st.UpsertUserByEmail(ctx, "own2@x.com", "o")
	attacker, _ := st.UpsertUserByEmail(ctx, "atk@x.com", "a")
	// node owned by `owner`; token belongs to `attacker`.
	n, _ := st.UpsertNode(ctx, Node{ID: "victimnode", OwnerType: "user", OwnerUserID: owner.ID, URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	st.CreateNodeToken(ctx, NodeToken{ID: "ta", TokenHash: authx.HashToken("atktok"), UserID: attacker.ID, Name: "n", CreatedAt: 1})
	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(50, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: n.ID, Status: "ok"})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer atktok")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("foreign-node heartbeat: want 403, got %d", w.Code)
	}
}

func TestRegisterRejectsNodeIDTakeover(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	victim, _ := st.UpsertUserByEmail(ctx, "v@x.com", "v")
	attacker, _ := st.UpsertUserByEmail(ctx, "a@x.com", "a")
	// An existing FLEET node with a known id.
	st.UpsertNode(ctx, Node{ID: "fleet-1", OwnerType: "fleet", URLs: []string{"turn:f:3478"}, TURNSecret: "fs", CreatedAt: 1, LastSeenAt: 1})
	// An existing USER node owned by victim.
	st.UpsertNode(ctx, Node{ID: "victim-node", OwnerType: "user", OwnerUserID: victim.ID, URLs: []string{"turn:v:3478"}, TURNSecret: "vs", CreatedAt: 1, LastSeenAt: 1})
	st.CreateNodeToken(ctx, NodeToken{ID: "at", TokenHash: authx.HashToken("atktok"), UserID: attacker.ID, Name: "n", CreatedAt: 1})

	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(5, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	reg := func(nodeID string) int {
		body, _ := json.Marshal(nodeRegisterReq{NodeID: nodeID, TURNSecret: "x", URLs: []string{"turn:x:3478"}})
		r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer atktok")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w.Code
	}
	// Attacker (user token) cannot take over a fleet node id...
	if code := reg("fleet-1"); code != http.StatusForbidden {
		t.Fatalf("fleet takeover: want 403, got %d", code)
	}
	// ...nor another user's node id.
	if code := reg("victim-node"); code != http.StatusForbidden {
		t.Fatalf("cross-user takeover: want 403, got %d", code)
	}
	// The fleet node's owner is untouched.
	if n, _, _ := st.GetNode(ctx, "fleet-1"); n.OwnerType != "fleet" || n.OwnerUserID != "" {
		t.Fatalf("fleet node owner was mutated: %q/%q", n.OwnerType, n.OwnerUserID)
	}
	// A brand-new id matching central's own charset/length registers fine
	// (owned by attacker).
	validNew := strings.Repeat("ab", 16) // 32 lowercase hex chars, like authx.NewID()
	if code := reg(validNew); code != http.StatusOK {
		t.Fatalf("new-id register: want 200, got %d", code)
	}
}

// A brand-new registration naming an id central would never generate itself
// (wrong charset/length) must be rejected outright — otherwise a client can
// pick an arbitrary string (e.g. "admin") that becomes this node's audited
// actor string ("node:admin") for the rest of its life.
func TestRegisterRejectsInvalidNewNodeID(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	attacker, _ := st.UpsertUserByEmail(ctx, "a2@x.com", "a2")
	st.CreateNodeToken(ctx, NodeToken{ID: "at2", TokenHash: authx.HashToken("atktok2"), UserID: attacker.ID, Name: "n", CreatedAt: 1})

	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(5, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	for _, bad := range []string{"admin", "node:admin", strings.Repeat("A", 32), strings.Repeat("a", 31), strings.Repeat("a", 33)} {
		body, _ := json.Marshal(nodeRegisterReq{NodeID: bad, TURNSecret: "x", URLs: []string{"turn:x:3478"}})
		r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer atktok2")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("register with id %q: want 400, got %d", bad, w.Code)
		}
		if n, known, _ := st.GetNode(ctx, bad); known {
			t.Fatalf("invalid id %q was still stored as a node: %+v", bad, n)
		}
	}
}
