package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/authx"
)

// newUserNodesServer mirrors newFileServer's harness but without a blob store
// (not needed by the node-management endpoints under test).
func newUserNodesServer(t *testing.T) (*httptest.Server, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true, EnableUserNodes: true,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, store, mail
}

func doJSON(t *testing.T, ts *httptest.Server, method, path string, cookie *http.Cookie, body any) *http.Response {
	t.Helper()
	var reader *strings.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = strings.NewReader(string(b))
	} else {
		reader = strings.NewReader("")
	}
	req, err := http.NewRequest(method, ts.URL+path, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return resp
}

func TestUserNodesAPIProvision(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "provision@example.com")

	resp := doJSON(t, ts, "POST", "/api/nodes/provision", cookie, provisionReq{Name: "home-nas"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("provision: got %d", resp.StatusCode)
	}
	var out struct {
		ID    string `json:"id"`
		Token string `json:"token"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Token == "" {
		t.Fatal("expected non-empty plaintext token")
	}
	if out.Name != "home-nas" {
		t.Fatalf("name = %q", out.Name)
	}

	// The plaintext token resolves via its hash to the logged-in user.
	nt, ok, err := store.NodeTokenByHash(context.Background(), authx.HashToken(out.Token))
	if err != nil || !ok {
		t.Fatalf("NodeTokenByHash: ok=%v err=%v", ok, err)
	}
	u, err := store.GetUserByID(context.Background(), nt.UserID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.Email != "provision@example.com" {
		t.Fatalf("token owner = %q", u.Email)
	}
	if nt.ID != out.ID {
		t.Fatalf("token id mismatch: %q vs %q", nt.ID, out.ID)
	}
}

func TestUserNodesAPIProvisionCapsAtMax(t *testing.T) {
	ts, _, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "capped@example.com")

	for i := 0; i < maxNodeTokensPerUser; i++ {
		resp := doJSON(t, ts, "POST", "/api/nodes/provision", cookie, provisionReq{Name: "n"})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("provision #%d: got %d", i, resp.StatusCode)
		}
	}
	resp := doJSON(t, ts, "POST", "/api/nodes/provision", cookie, provisionReq{Name: "n"})
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("over cap: got %d, want 429", resp.StatusCode)
	}
}

func TestUserNodesAPIMine(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "mine@example.com")

	u, ok, err := store.GetUserByIdentity(context.Background(), "email", "mine@example.com")
	if err != nil || !ok {
		t.Fatalf("lookup user: ok=%v err=%v", ok, err)
	}
	// One own node, online (recent last_seen); another user's node must not
	// leak into this list.
	other, _ := store.UpsertUserByEmail(context.Background(), "other@example.com", "o")
	now := time.Now().Unix()
	if _, err := store.UpsertNode(context.Background(), Node{
		ID: "mynode", OwnerType: "user", OwnerUserID: u.ID, Region: "eu",
		URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: now, LastSeenAt: now,
		RelayedBytes: 111, StoredBytes: 222,
	}); err != nil {
		t.Fatalf("upsert own node: %v", err)
	}
	if _, err := store.UpsertNode(context.Background(), Node{
		ID: "othernode", OwnerType: "user", OwnerUserID: other.ID,
		URLs: []string{"turn:y:3478"}, TURNSecret: "s", CreatedAt: now, LastSeenAt: now,
	}); err != nil {
		t.Fatalf("upsert other node: %v", err)
	}

	resp := doJSON(t, ts, "GET", "/api/nodes/mine", cookie, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mine: got %d", resp.StatusCode)
	}
	var out struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Nodes) != 1 {
		t.Fatalf("nodes = %+v, want exactly 1 (own only)", out.Nodes)
	}
	n := out.Nodes[0]
	if n["id"] != "mynode" {
		t.Fatalf("id = %v", n["id"])
	}
	if n["online"] != true {
		t.Fatalf("online = %v, want true", n["online"])
	}
	if n["region"] != "eu" {
		t.Fatalf("region = %v", n["region"])
	}
}

func TestUserNodesAPIDeleteOwnerScoped(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	ownerCookie := loginCookie(t, ts, mail, "owner@example.com")
	attackerCookie := loginCookie(t, ts, mail, "attacker@example.com")

	owner, ok, err := store.GetUserByIdentity(context.Background(), "email", "owner@example.com")
	if err != nil || !ok {
		t.Fatalf("lookup owner: ok=%v err=%v", ok, err)
	}
	now := time.Now().Unix()
	if _, err := store.UpsertNode(context.Background(), Node{
		ID: "delnode", OwnerType: "user", OwnerUserID: owner.ID,
		URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: now, LastSeenAt: now,
	}); err != nil {
		t.Fatalf("upsert node: %v", err)
	}
	// Bind a token to the node so we can assert it gets revoked on delete.
	if err := store.CreateNodeToken(context.Background(), NodeToken{
		ID: "tok1", TokenHash: authx.HashToken("rawtoken"), UserID: owner.ID, NodeID: "delnode",
		Name: "n", CreatedAt: now,
	}); err != nil {
		t.Fatalf("create token: %v", err)
	}

	// The attacker cannot delete the owner's node: 404, node still exists.
	resp := doJSON(t, ts, "DELETE", "/api/nodes/delnode", attackerCookie, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("attacker delete: got %d, want 404", resp.StatusCode)
	}
	if _, ok, _ := store.GetNode(context.Background(), "delnode"); !ok {
		t.Fatal("node deleted by non-owner request")
	}

	// The owner can delete it: 200, node gone, bound token revoked (no
	// longer resolves via its hash).
	resp = doJSON(t, ts, "DELETE", "/api/nodes/delnode", ownerCookie, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner delete: got %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetNode(context.Background(), "delnode"); ok {
		t.Fatal("node still exists after owner delete")
	}
	if _, ok, _ := store.NodeTokenByHash(context.Background(), authx.HashToken("rawtoken")); ok {
		t.Fatal("bound token still resolves after node delete")
	}

	// Deleting again (already gone) is still a 404.
	resp = doJSON(t, ts, "DELETE", "/api/nodes/delnode", ownerCookie, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("re-delete: got %d, want 404", resp.StatusCode)
	}
}

func TestUserNodesAPIStrictToggle(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "strict@example.com")
	u, ok, err := store.GetUserByIdentity(context.Background(), "email", "strict@example.com")
	if err != nil || !ok {
		t.Fatalf("lookup user: ok=%v err=%v", ok, err)
	}
	if u.OnlyOwnNodes {
		t.Fatal("expected OnlyOwnNodes false by default")
	}

	// Strict mode requires at least one registered own node (see the guard in
	// handleStrictNodes); seed one so this test exercises the happy path.
	if _, err := store.UpsertNode(context.Background(), Node{OwnerType: "user", OwnerUserID: u.ID, Label: "n"}); err != nil {
		t.Fatalf("seed node: %v", err)
	}

	resp := doJSON(t, ts, "PUT", "/api/me/strict-nodes", cookie, strictReq{OnlyOwnNodes: true})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("strict on: got %d", resp.StatusCode)
	}
	u, _, _ = store.GetUserByIdentity(context.Background(), "email", "strict@example.com")
	if !u.OnlyOwnNodes {
		t.Fatal("expected OnlyOwnNodes true after PUT")
	}

	// /api/me reflects the flag.
	meResp := doJSON(t, ts, "GET", "/api/me", cookie, nil)
	var meOut struct {
		User struct {
			OnlyOwnNodes bool `json:"onlyOwnNodes"`
		} `json:"user"`
	}
	if err := json.NewDecoder(meResp.Body).Decode(&meOut); err != nil {
		t.Fatalf("decode /api/me: %v", err)
	}
	if !meOut.User.OnlyOwnNodes {
		t.Fatal("/api/me did not reflect onlyOwnNodes=true")
	}

	resp = doJSON(t, ts, "PUT", "/api/me/strict-nodes", cookie, strictReq{OnlyOwnNodes: false})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("strict off: got %d", resp.StatusCode)
	}
	u, _, _ = store.GetUserByIdentity(context.Background(), "email", "strict@example.com")
	if u.OnlyOwnNodes {
		t.Fatal("expected OnlyOwnNodes false after toggling off")
	}
}

// Enabling "only my nodes" with zero registered nodes would strand every
// transfer (uploads have no node to land on; realtime has no relay to offer),
// so the server must refuse it. Disabling is always allowed (the recovery path).
func TestStrictNodesRejectedWithoutNode(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "nonode@example.com")

	resp := doJSON(t, ts, "PUT", "/api/me/strict-nodes", cookie, strictReq{OnlyOwnNodes: true})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("strict on with no node: got %d, want 409", resp.StatusCode)
	}
	u, _, _ := store.GetUserByIdentity(context.Background(), "email", "nonode@example.com")
	if u.OnlyOwnNodes {
		t.Fatal("OnlyOwnNodes must stay false when the enable is rejected")
	}

	off := doJSON(t, ts, "PUT", "/api/me/strict-nodes", cookie, strictReq{OnlyOwnNodes: false})
	if off.StatusCode != http.StatusOK {
		t.Fatalf("strict off with no node: got %d, want 200", off.StatusCode)
	}
}

// Invariant "strict ⟹ ≥1 node": deleting the LAST node while "only my nodes" is
// on must clear the restriction, otherwise every future transfer would strand.
func TestDeletingLastNodeClearsStrict(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "lastnode@example.com")
	u, _, _ := store.GetUserByIdentity(context.Background(), "email", "lastnode@example.com")

	n, err := store.UpsertNode(context.Background(), Node{OwnerType: "user", OwnerUserID: u.ID, Label: "only"})
	if err != nil {
		t.Fatalf("seed node: %v", err)
	}
	if r := doJSON(t, ts, "PUT", "/api/me/strict-nodes", cookie, strictReq{OnlyOwnNodes: true}); r.StatusCode != http.StatusOK {
		t.Fatalf("enable strict: got %d", r.StatusCode)
	}
	if r := doJSON(t, ts, "DELETE", "/api/nodes/"+n.ID, cookie, nil); r.StatusCode != http.StatusOK {
		t.Fatalf("delete node: got %d", r.StatusCode)
	}
	u, _, _ = store.GetUserByIdentity(context.Background(), "email", "lastnode@example.com")
	if u.OnlyOwnNodes {
		t.Fatal("deleting the last node must clear OnlyOwnNodes")
	}
}

// Deleting a node while another remains must NOT touch the strict setting.
func TestDeletingNonLastNodeKeepsStrict(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "twonode@example.com")
	u, _, _ := store.GetUserByIdentity(context.Background(), "email", "twonode@example.com")

	n1, err := store.UpsertNode(context.Background(), Node{OwnerType: "user", OwnerUserID: u.ID, Label: "a"})
	if err != nil {
		t.Fatalf("seed node a: %v", err)
	}
	if _, err := store.UpsertNode(context.Background(), Node{OwnerType: "user", OwnerUserID: u.ID, Label: "b"}); err != nil {
		t.Fatalf("seed node b: %v", err)
	}
	if r := doJSON(t, ts, "PUT", "/api/me/strict-nodes", cookie, strictReq{OnlyOwnNodes: true}); r.StatusCode != http.StatusOK {
		t.Fatalf("enable strict: got %d", r.StatusCode)
	}
	if r := doJSON(t, ts, "DELETE", "/api/nodes/"+n1.ID, cookie, nil); r.StatusCode != http.StatusOK {
		t.Fatalf("delete node: got %d", r.StatusCode)
	}
	u, _, _ = store.GetUserByIdentity(context.Background(), "email", "twonode@example.com")
	if !u.OnlyOwnNodes {
		t.Fatal("deleting a non-last node must keep OnlyOwnNodes")
	}
}
