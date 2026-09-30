package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// A-M3: a hard-deleted node id must never be registrable again, by anyone —
// fleet ids are public via /api/ice, and files, upload sessions and queued GC
// deletes can still be addressed to the id after its row is gone.

// am3Service is a node-routes service with the shared fleet token and user
// nodes enabled, plus two BYO users each holding one node token.
func am3Service(t *testing.T) (*Service, *SQLiteStore, User, User) {
	t.Helper()
	st := newTestStore(t)
	ctx := context.Background()
	u1, err := st.UpsertUserByEmail(ctx, "am3-owner@example.com", "o")
	if err != nil {
		t.Fatal(err)
	}
	u2, err := st.UpsertUserByEmail(ctx, "am3-attacker@example.com", "a")
	if err != nil {
		t.Fatal(err)
	}
	for _, tk := range []NodeToken{
		{ID: "am3-t1", TokenHash: authx.HashToken("owner-token"), UserID: u1.ID, Name: "home", CreatedAt: 1},
		{ID: "am3-t2", TokenHash: authx.HashToken("attacker-token"), UserID: u2.ID, Name: "evil", CreatedAt: 1},
	} {
		if err := st.CreateNodeToken(ctx, tk); err != nil {
			t.Fatal(err)
		}
	}
	s := &Service{
		store: st,
		cfg:   Config{NodeToken: "fleet-secret", EnableUserNodes: true},
		now:   func() time.Time { return time.Unix(tNow, 0) },
	}
	return s, st, u1, u2
}

type am3RegisterResult struct {
	Code   int
	Error  string `json:"error"`
	Reason string `json:"code"`
	NodeID string `json:"nodeID"`
}

func am3Register(t *testing.T, s *Service, bearer, nodeID string) am3RegisterResult {
	t.Helper()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	body, _ := json.Marshal(nodeRegisterReq{NodeID: nodeID, TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}})
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+bearer)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	var out am3RegisterResult
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	out.Code = w.Code
	return out
}

func am3FleetNode(t *testing.T, st *SQLiteStore) Node {
	t.Helper()
	n, err := st.UpsertNode(context.Background(), Node{
		ID: authx.NewID(), OwnerType: "fleet", URLs: []string{"turn:9.9.9.9:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: tNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// The attack itself: an admin deletes a fleet node, then a BYO user registers
// the (public) id. Refused with the retired code, and no row is created. The
// fleet itself re-registering the machine is the SAME owner and comes back as
// a new node — deleting a node must not leave it crash-looping on a 403.
func TestA_M3_DeletedFleetIDCannotBeTakenOver(t *testing.T) {
	s, st, _, _ := am3Service(t)
	ctx := context.Background()
	n := am3FleetNode(t, st)
	if err := st.DeleteFleetNode(ctx, n.ID); err != nil {
		t.Fatalf("DeleteFleetNode: %v", err)
	}
	got := am3Register(t, s, "attacker-token", n.ID)
	if got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeRetired {
		t.Fatalf("user re-registering a deleted fleet id: got %d code=%q (%q), want 403 %q",
			got.Code, got.Reason, got.Error, nodeRegisterCodeRetired)
	}
	if _, ok, _ := st.GetNode(ctx, n.ID); ok {
		t.Fatal("a refused registration still created the node row")
	}
	back := am3Register(t, s, "fleet-secret", n.ID)
	if back.Code != http.StatusOK || back.NodeID != n.ID {
		t.Fatalf("fleet re-registering its own deleted node: got %d id=%q (%q), want 200 %q", back.Code, back.NodeID, back.Error, n.ID)
	}
	if row, ok, _ := st.GetNode(ctx, n.ID); !ok || row.OwnerType != "fleet" {
		t.Fatalf("re-registered fleet node: ok=%v %+v, want a fleet row", ok, row)
	}
	// Once it is live again the ordinary ownership guard keeps the user out.
	if steal := am3Register(t, s, "attacker-token", n.ID); steal.Code != http.StatusForbidden {
		t.Fatalf("user claiming the re-registered fleet node: got %d, want 403", steal.Code)
	}
}

// A user's own DeleteNode tombstones too: another user cannot take the id over,
// while the owner can bring the same machine back — even with its own files
// still pointing at the id (every such row was placed on this owner's machine,
// see SQLiteStore.NodeIDReuseState).
func TestA_M3_DeletedUserNodeIDCannotBeTakenOver(t *testing.T) {
	s, st, u1, u2 := am3Service(t)
	ctx := context.Background()
	reg := am3Register(t, s, "owner-token", authx.NewID())
	if reg.Code != http.StatusOK {
		t.Fatalf("initial register: %d %q", reg.Code, reg.Error)
	}
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "am3-own", UserID: u1.ID, BlobKey: "am3-bown",
		EncManifest: []byte("m"), Size: 10, CreatedAt: 1, ExpiresAt: tNow + 3600, NodeID: reg.NodeID}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNode(ctx, reg.NodeID, u1.ID); err != nil {
		t.Fatalf("DeleteNode: %v", err)
	}
	if state, err := st.NodeIDReuseState(ctx, reg.NodeID, "user", u2.ID); err != nil || state != NodeIDTombstoned {
		t.Fatalf("after DeleteNode, another user: state=%v err=%v, want tombstoned", state, err)
	}
	if state, err := st.NodeIDReuseState(ctx, reg.NodeID, "user", u1.ID); err != nil || state != NodeIDFresh {
		t.Fatalf("after DeleteNode, the owner: state=%v err=%v, want fresh", state, err)
	}
	got := am3Register(t, s, "attacker-token", reg.NodeID)
	if got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeRetired {
		t.Fatalf("takeover of a deleted user node id: got %d code=%q, want 403 %q", got.Code, got.Reason, nodeRegisterCodeRetired)
	}
	// The owner's file still names the node, so the row is RETIRED (kept for
	// cleanup), not gone — and the refused registration left it untouched.
	if row, ok, _ := st.GetNode(ctx, reg.NodeID); !ok || row.OwnerUserID != u1.ID || row.RemovedAt == 0 {
		t.Fatalf("retired row after a refused takeover: ok=%v %+v, want still the owner's, removed", ok, row)
	}
	if fleet := am3Register(t, s, "fleet-secret", reg.NodeID); fleet.Code != http.StatusForbidden || fleet.Reason != nodeRegisterCodeRetired {
		t.Fatalf("fleet claiming a deleted user node id: got %d code=%q, want 403 %q", fleet.Code, fleet.Reason, nodeRegisterCodeRetired)
	}
	back := am3Register(t, s, "owner-token", reg.NodeID)
	if back.Code != http.StatusOK || back.NodeID != reg.NodeID {
		t.Fatalf("owner re-registering its own deleted node: got %d (%q), want 200", back.Code, back.Error)
	}
	if row, ok, _ := st.GetNode(ctx, reg.NodeID); !ok || row.OwnerUserID != u1.ID {
		t.Fatalf("re-registered node: ok=%v %+v, want owned by the original user", ok, row)
	}
}

// The owner predicate itself, at the store: only the recorded owner matches.
func TestA_M3_TombstoneOwnerPredicate(t *testing.T) {
	_, st, u1, u2 := am3Service(t)
	ctx := context.Background()
	fleet := am3FleetNode(t, st)
	if err := st.DeleteFleetNode(ctx, fleet.ID); err != nil {
		t.Fatal(err)
	}
	user, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u1.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNode(ctx, user.ID, u1.ID); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id, ownerType, ownerUser string
		want                     NodeIDReuse
	}{
		{fleet.ID, "fleet", "", NodeIDFresh},
		{fleet.ID, "user", u1.ID, NodeIDTombstoned},
		{fleet.ID, "user", "", NodeIDTombstoned},
		{user.ID, "user", u1.ID, NodeIDFresh},
		{user.ID, "user", u2.ID, NodeIDTombstoned},
		{user.ID, "user", "", NodeIDTombstoned},
		{user.ID, "fleet", "", NodeIDTombstoned},
		{user.ID, "", u1.ID, NodeIDTombstoned},
	} {
		got, err := st.NodeIDReuseState(ctx, tc.id, tc.ownerType, tc.ownerUser)
		if err != nil || got != tc.want {
			t.Errorf("NodeIDReuseState(%s, %q, %q) = %v, %v; want %v", tc.id[:6], tc.ownerType, tc.ownerUser, got, err, tc.want)
		}
	}
}

// The A-M4 cap still applies when an owner brings a deleted node back: it is a
// new live row.
func TestA_M3_SameOwnerReRegisterStillCapped(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	gone := am3Register(t, s, "owner-token", authx.NewID())
	if gone.Code != http.StatusOK {
		t.Fatalf("register: %d %q", gone.Code, gone.Error)
	}
	if err := st.DeleteNode(ctx, gone.NodeID, u1.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxLiveNodesPerUser; i++ {
		if got := am3Register(t, s, "owner-token", authx.NewID()); got.Code != http.StatusOK {
			t.Fatalf("node %d: %d %q", i, got.Code, got.Error)
		}
	}
	got := am3Register(t, s, "owner-token", gone.NodeID)
	if got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeLimit {
		t.Fatalf("owner re-registering a deleted node at the cap: got %d code=%q, want 403 %q", got.Code, got.Reason, nodeRegisterCodeLimit)
	}
}

// A wrong-owner DeleteNode deletes nothing and therefore must tombstone nothing:
// the tombstone rides in the same transaction and rolls back with ErrNotFound.
// Same for DeleteFleetNode naming a user node.
func TestA_M3_FailedDeleteLeavesNoTombstone(t *testing.T) {
	_, st, u1, u2 := am3Service(t)
	ctx := context.Background()
	n, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u1.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNode(ctx, n.ID, u2.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong-owner DeleteNode: want ErrNotFound, got %v", err)
	}
	if err := st.DeleteFleetNode(ctx, n.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteFleetNode on a user node: want ErrNotFound, got %v", err)
	}
	var c int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM node_tombstones WHERE id = ?`, n.ID).Scan(&c); err != nil {
		t.Fatal(err)
	}
	if c != 0 {
		t.Fatalf("a delete that deleted nothing left %d tombstone(s)", c)
	}
}

// Legacy: a node deleted BEFORE tombstones existed has no tombstone, but files
// (or an upload session, or a queued GC delete) still name it. Registering the
// id must be refused with the referenced code.
func TestA_M3_LegacyDeletedIDStillReferencedIsRefused(t *testing.T) {
	cases := []struct {
		name string
		ref  func(t *testing.T, st *SQLiteStore, userID, nodeID string)
	}{
		{"stored_file", func(t *testing.T, st *SQLiteStore, userID, nodeID string) {
			if err := st.CreateStoredFile(context.Background(), StoredFile{ID: "am3-f1", UserID: userID, BlobKey: "am3-b1",
				EncManifest: []byte("m"), Size: 10, CreatedAt: 1, ExpiresAt: tNow + 3600, NodeID: nodeID}); err != nil {
				t.Fatal(err)
			}
		}},
		{"upload_session", func(t *testing.T, st *SQLiteStore, userID, nodeID string) {
			if _, err := st.db.ExecContext(context.Background(),
				`INSERT INTO upload_sessions (id, user_id, blob_key, node_id, created_at) VALUES ('am3-us', ?, 'am3-bu', ?, 1)`,
				userID, nodeID); err != nil {
				t.Fatal(err)
			}
		}},
		{"pending_node_delete", func(t *testing.T, st *SQLiteStore, _, nodeID string) {
			if err := st.EnqueueNodeDelete(context.Background(), "am3-b2", nodeID, 1); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, st, u1, _ := am3Service(t)
			ctx := context.Background()
			n := am3FleetNode(t, st)
			tc.ref(t, st, u1.ID, n.ID)
			// The pre-change delete: row gone, no tombstone written.
			if _, err := st.db.ExecContext(ctx, `DELETE FROM nodes WHERE id = ?`, n.ID); err != nil {
				t.Fatal(err)
			}
			// Without a tombstone the old owner is unknown, so EVERY registrant
			// is refused — the fleet token included.
			for _, bearer := range []string{"attacker-token", "owner-token", "fleet-secret"} {
				got := am3Register(t, s, bearer, n.ID)
				if got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeReferenced {
					t.Fatalf("%s: legacy-deleted referenced id: got %d code=%q (%q), want 403 %q",
						bearer, got.Code, got.Reason, got.Error, nodeRegisterCodeReferenced)
				}
			}
			if _, ok, _ := st.GetNode(ctx, n.ID); ok {
				t.Fatal("a refused registration still created the node row")
			}
		})
	}
}

// Positive controls: a genuinely new valid id registers, an empty id gets a
// generated one, and the owner re-registering an existing (not deleted) node
// still works.
func TestA_M3_NewIDAndSameOwnerReRegisterStillWork(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	id := authx.NewID()
	got := am3Register(t, s, "owner-token", id)
	if got.Code != http.StatusOK || got.NodeID != id {
		t.Fatalf("fresh id: got %d id=%q (%q), want 200 %q", got.Code, got.NodeID, got.Error, id)
	}
	n, ok, _ := st.GetNode(ctx, id)
	if !ok || n.OwnerUserID != u1.ID {
		t.Fatalf("fresh id not persisted for its owner: ok=%v %+v", ok, n)
	}
	if again := am3Register(t, s, "owner-token", id); again.Code != http.StatusOK {
		t.Fatalf("same-owner re-register: got %d (%q), want 200", again.Code, again.Error)
	}
	if gen := am3Register(t, s, "owner-token", ""); gen.Code != http.StatusOK || gen.NodeID == "" {
		t.Fatalf("empty id: got %d id=%q (%q), want 200 with a generated id", gen.Code, gen.NodeID, gen.Error)
	}
	fleet := am3FleetNode(t, st)
	if again := am3Register(t, s, "fleet-secret", fleet.ID); again.Code != http.StatusOK {
		t.Fatalf("fleet re-register of a live fleet node: got %d (%q), want 200", again.Code, again.Error)
	}
	// And the pre-existing guard still stands: a live node of another owner.
	if steal := am3Register(t, s, "attacker-token", id); steal.Code != http.StatusForbidden {
		t.Fatalf("live node of another owner: got %d, want 403", steal.Code)
	}
}

// Admin delete (c): refused while stored files name the node — through the
// real handler (409) and the store (ErrNodeHasStoredFiles) — with the node and
// its files untouched and no tombstone; once the files are gone the delete
// goes through and tombstones the id.
func TestA_M3_AdminDeleteRefusedWhileFilesRemain(t *testing.T) {
	ts, svc, st := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "am3-files@example.com", "f")
	if err != nil {
		t.Fatal(err)
	}
	n := am3FleetNode(t, st)
	// An EXPIRED-but-uncollected file counts: GC still sends its delete to the id.
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "am3-fx", UserID: u.ID, BlobKey: "am3-bx",
		EncManifest: []byte("m"), Size: 10, CreatedAt: 1, ExpiresAt: 2, NodeID: n.ID}); err != nil {
		t.Fatal(err)
	}

	if err := st.DeleteFleetNode(ctx, n.ID); !errors.Is(err, ErrNodeHasStoredFiles) {
		t.Fatalf("store delete with files: want ErrNodeHasStoredFiles, got %v", err)
	}
	w := callAdminHandler(svc.handleAdminDeleteNode, cookie, nil, map[string]string{"id": n.ID})
	if w.Code != http.StatusConflict {
		t.Fatalf("admin delete with files: got %d, want 409 (body %q)", w.Code, w.Body.String())
	}
	if _, ok, _ := st.GetNode(ctx, n.ID); !ok {
		t.Fatal("a refused delete removed the node")
	}
	if state, _ := st.NodeIDReuseState(ctx, n.ID, "user", u.ID); state == NodeIDTombstoned {
		t.Fatal("a refused delete tombstoned the id")
	}

	if _, err := st.db.ExecContext(ctx, `DELETE FROM stored_files WHERE id = 'am3-fx'`); err != nil {
		t.Fatal(err)
	}
	w = callAdminHandler(svc.handleAdminDeleteNode, cookie, nil, map[string]string{"id": n.ID})
	if w.Code != http.StatusFound {
		t.Fatalf("admin delete without files: got %d, want 302 (body %q)", w.Code, w.Body.String())
	}
	if _, ok, _ := st.GetNode(ctx, n.ID); ok {
		t.Fatal("node still present after an allowed delete")
	}
	if state, err := st.NodeIDReuseState(ctx, n.ID, "user", u.ID); err != nil || state != NodeIDTombstoned {
		t.Fatalf("after delete, a user: state=%v err=%v, want tombstoned", state, err)
	}
	if state, err := st.NodeIDReuseState(ctx, n.ID, "fleet", ""); err != nil || state != NodeIDFresh {
		t.Fatalf("after delete, the fleet: state=%v err=%v, want fresh", state, err)
	}
	// A missing id is still a 404, not a 409 or 500.
	w = callAdminHandler(svc.handleAdminDeleteNode, cookie, nil, map[string]string{"id": "no-such-node"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("admin delete of a missing node: got %d, want 404", w.Code)
	}
}

// am3EnsureNode gives a fixture's node id a row, so a stored file placed on it
// passes the insert's node fence (a node-backed object can only be inserted
// while its node exists).
func am3EnsureNode(t *testing.T, st *SQLiteStore, id, ownerType, ownerUserID string) {
	t.Helper()
	if _, err := st.UpsertNode(context.Background(), Node{ID: id, OwnerType: ownerType, OwnerUserID: ownerUserID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1}); err != nil {
		t.Fatal(err)
	}
}
