package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// A-M3 round 3: a user may not delete their own node while an upload session
// names it. A session's blob is reachable only through the node row (the
// finalize-refusal reclaim, the reaper and GC all resolve storage by node id),
// so deleting the row under it would strand the ciphertext on the machine; and
// the stored-file fence would refuse the session's finalize. Session creation
// is fenced on the node row too, so no session can appear for a deleted node.

func am3rSessionRow(t *testing.T, st *SQLiteStore, id, userID, nodeID, purpose string, finalizedFileID string) {
	t.Helper()
	if _, err := st.db.ExecContext(context.Background(),
		`INSERT INTO upload_sessions (id, user_id, blob_key, node_id, created_at, purpose, finalized_file_id)
		 VALUES (?, ?, ?, ?, 1, ?, ?)`, id, userID, id+"-blob", nodeID, purpose, finalizedFileID); err != nil {
		t.Fatal(err)
	}
}

// The store refusal, for every kind of session (open share, finalized device
// task tombstone, pair-room): refused while any names the node, allowed after.
// A non-owner still gets ErrNotFound — the refusal leaks nothing.
func TestA_M3_UserDeleteRefusedWhileUploadSessionNamesNode(t *testing.T) {
	for _, purpose := range []string{StoredPurposeShare, StoredPurposeDeviceTask, StoredPurposePairRoom} {
		t.Run(purpose, func(t *testing.T) {
			_, st, u1, u2 := am3Service(t)
			ctx := context.Background()
			n, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u1.ID,
				URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
			if err != nil {
				t.Fatal(err)
			}
			am3rSessionRow(t, st, "am3s-"+purpose, u1.ID, n.ID, purpose, "")
			if err := st.DeleteNode(ctx, n.ID, u2.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("non-owner delete: want ErrNotFound, got %v", err)
			}
			if err := st.DeleteNode(ctx, n.ID, u1.ID); !errors.Is(err, ErrNodeHasUploadSessions) {
				t.Fatalf("owner delete with a session: want ErrNodeHasUploadSessions, got %v", err)
			}
			if _, ok, _ := st.GetNode(ctx, n.ID); !ok {
				t.Fatal("a refused delete removed the node")
			}
			if state, _ := st.NodeIDReuseState(ctx, n.ID, "user", u2.ID); state == NodeIDTombstoned {
				t.Fatal("a refused delete tombstoned the id")
			}
			if _, err := st.db.ExecContext(ctx, `DELETE FROM upload_sessions WHERE node_id = ?`, n.ID); err != nil {
				t.Fatal(err)
			}
			if err := st.DeleteNode(ctx, n.ID, u1.ID); err != nil {
				t.Fatalf("owner delete after the session is gone: %v", err)
			}
			if state, _ := st.NodeIDReuseState(ctx, n.ID, "user", u2.ID); state != NodeIDTombstoned {
				t.Fatalf("after delete: state=%v, want tombstoned", state)
			}
		})
	}
}

// Session creation is fenced on the node row: a node deleted between placement
// and CreateUploadSession gets no session, so no finalize (resumable or
// pair-room) can ever run against a node that is gone.
func TestA_M3_UploadSessionCreationFencedOnDeletedNode(t *testing.T) {
	_, st, u1, _ := am3Service(t)
	ctx := context.Background()
	n, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u1.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNode(ctx, n.ID, u1.ID); err != nil {
		t.Fatal(err)
	}
	row := UploadSessionRow{ID: "am3s-late", UserID: u1.ID, BlobKey: authx.RandToken(), NodeID: n.ID,
		EncManifest: []byte("m"), TTL: 3600, MaxSize: 1 << 20, CreatedAt: tNow}
	if ok, err := st.CreateUploadSession(ctx, row, 10); ok || !errors.Is(err, ErrStoredFileNodeGone) {
		t.Fatalf("session on a deleted node: ok=%v err=%v, want refused with ErrStoredFileNodeGone", ok, err)
	}
	var c int
	_ = st.db.QueryRow(`SELECT COUNT(*) FROM upload_sessions WHERE node_id = ?`, n.ID).Scan(&c)
	if c != 0 {
		t.Fatalf("%d session row(s) created for a deleted node", c)
	}
	// Positive control: a live node and a central (no-node) session still work.
	live, _ := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u1.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	row.ID, row.BlobKey, row.NodeID = "am3s-live", authx.RandToken(), live.ID
	if ok, err := st.CreateUploadSession(ctx, row, 10); !ok || err != nil {
		t.Fatalf("session on a live node: ok=%v err=%v", ok, err)
	}
	row.ID, row.BlobKey, row.NodeID = "am3s-central", authx.RandToken(), ""
	if ok, err := st.CreateUploadSession(ctx, row, 10); !ok || err != nil {
		t.Fatalf("central session: ok=%v err=%v", ok, err)
	}
}

// End to end: a resumable upload to the user's own node. While it is in
// flight (and after it finalized, until its session row is purged) DELETE
// /api/nodes/{id} answers 409 node_has_uploads and the node stays; the upload
// finalizes normally with its blob on the node. Once the session row is gone
// the delete goes through.
func TestA_M3_ResumableUploadBlocksOwnNodeDelete(t *testing.T) {
	ts, svc, st, mail := newFileServer(t)
	svc.cfg.EnableUserNodes = true
	cookie := loginCookie(t, ts, mail, "am3s-e2e@example.com")
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "am3s-e2e@example.com", "")
	objects := map[string][]byte{}
	srv := fakeNode(t, objects) // speaks PUT/PATCH(append)/GET/DELETE like a real node
	t.Cleanup(srv.Close)
	own, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u.ID,
		URLs: []string{"turn:x:3478"}, TURNSecret: "t", StorageEnabled: true, StorageURL: srv.URL,
		StorageSecret: "ss", StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix()})
	if err != nil {
		t.Fatal(err)
	}
	deleteNode := func() (int, string) {
		req, _ := http.NewRequest("DELETE", ts.URL+"/api/nodes/"+own.ID, nil)
		req.AddCookie(cookie)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var out struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(b, &out)
		return resp.StatusCode, out.Code
	}

	blob := bytes.Repeat([]byte("Q"), 600)
	id := initUpload(t, ts, cookie, []byte("M"), len(blob), 0)
	var sessNode string
	_ = st.db.QueryRow(`SELECT node_id FROM upload_sessions WHERE id = ?`, id).Scan(&sessNode)
	if sessNode != own.ID {
		t.Fatalf("session placed on %q, want the own node %q", sessNode, own.ID)
	}
	if code, _ := patchChunk(t, ts, cookie, id, blob, 0, 300, len(blob)); code != 200 {
		t.Fatalf("chunk: %d", code)
	}
	if code, c := deleteNode(); code != http.StatusConflict || c != "node_has_uploads" {
		t.Fatalf("delete mid-upload: %d %q, want 409 node_has_uploads", code, c)
	}
	if code, _ := patchChunk(t, ts, cookie, id, blob, 300, 600, len(blob)); code != 200 {
		t.Fatalf("chunk: %d", code)
	}
	freq, _ := http.NewRequest("POST", ts.URL+"/api/uploads/"+id+"/finalize", nil)
	freq.AddCookie(cookie)
	fresp, err := ts.Client().Do(freq)
	if err != nil {
		t.Fatal(err)
	}
	fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finalize after the refused delete: %d, want 200", fresp.StatusCode)
	}
	if len(objects) != 1 {
		t.Fatalf("node holds %d objects, want the finalized blob", len(objects))
	}
	for _, b := range objects {
		if !bytes.Equal(b, blob) {
			t.Fatalf("node blob is %d bytes, want the %d-byte upload", len(b), len(blob))
		}
	}
	if code, c := deleteNode(); code != http.StatusConflict || c != "node_has_uploads" {
		t.Fatalf("delete while the finished session row remains: %d %q, want 409", code, c)
	}
	if _, err := st.db.ExecContext(ctx, `DELETE FROM upload_sessions WHERE id = ?`, id); err != nil {
		t.Fatal(err) // stands in for PurgeDoneUploadSessions
	}
	if code, _ := deleteNode(); code != http.StatusOK {
		t.Fatalf("delete after the session was purged: %d, want 200", code)
	}
}

// UpsertNode never rewrites an existing row's owner (Fable minor, round 2).
func TestA_M3_UpsertNodeRefusesOwnerChange(t *testing.T) {
	_, st, u1, u2 := am3Service(t)
	ctx := context.Background()
	n, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u1.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, other := range []Node{
		{ID: n.ID, OwnerType: "user", OwnerUserID: u2.ID},
		{ID: n.ID, OwnerType: "fleet"},
	} {
		other.URLs, other.TURNSecret, other.CreatedAt, other.LastSeenAt = []string{"turn:6.6.6.6:3478"}, "evil", 2, 2
		if _, err := st.UpsertNode(ctx, other); !errors.Is(err, ErrNodeOwnerMismatch) {
			t.Fatalf("upsert as %s/%s: want ErrNodeOwnerMismatch, got %v", other.OwnerType, other.OwnerUserID, err)
		}
	}
	got, _, _ := st.GetNode(ctx, n.ID)
	if got.OwnerType != "user" || got.OwnerUserID != u1.ID || got.TURNSecret != "s" {
		t.Fatalf("row changed by a refused upsert: %+v", got)
	}
	// Same owner still updates.
	if _, err := st.UpsertNode(ctx, Node{ID: n.ID, OwnerType: "user", OwnerUserID: u1.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: 3}); err != nil {
		t.Fatalf("same-owner upsert: %v", err)
	}
	if got, _, _ := st.GetNode(ctx, n.ID); got.TURNSecret != "s2" {
		t.Fatalf("same-owner upsert did not update: %+v", got)
	}
}

// Admin panel: when the blocker count cannot be read, no delete button is
// offered as if the node were empty.
type blockersFailStore struct{ Store }

func (blockersFailStore) NodeDeleteBlockers(context.Context) (map[string]int, error) {
	return nil, errors.New("injected blockers failure")
}

func TestA_M3_AdminPanelBlockersUnknownOffersNoDelete(t *testing.T) {
	ts, svc, st := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	n := am3FleetNode(t, st)
	svc.store = blockersFailStore{st}
	req, _ := http.NewRequest("GET", ts.URL+"/admin/fleet", nil)
	req.AddCookie(cookie)
	req.Header.Set("Accept-Language", "zh-CN")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	page, _ := io.ReadAll(resp.Body)
	if bytes.Contains(page, []byte(`/admin/nodes/`+n.ID+`/delete`)) {
		t.Fatal("a delete button was offered although the blocker count could not be read")
	}
	if !bytes.Contains(page, []byte("无法读取剩余记录数")) {
		t.Fatal("the unknown-blockers state is not shown")
	}
}
