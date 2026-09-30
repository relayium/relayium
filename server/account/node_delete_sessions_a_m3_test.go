package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// A-M3 round 4: a node delete RETIRES the row while cleanup still needs its
// storage endpoint (queued node deletes, upload sessions, stored objects) and
// removes it only when nothing does. The owner is never refused; GC, the
// reaper, refused-finalize reclaim and pair-room voids keep resolving the node
// through blobFor and finish reclaiming its ciphertext, with billing settled
// exactly as for a node that was never deleted.

func am4rOwnNode(t *testing.T, st *SQLiteStore, userID, storageURL string, lastSeen int64) Node {
	t.Helper()
	n, err := st.UpsertNode(context.Background(), Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: userID,
		URLs: []string{"turn:x:3478"}, TURNSecret: "t", StorageEnabled: true, StorageURL: storageURL,
		StorageSecret: "ss", StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: lastSeen})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func am3rSessionRow(t *testing.T, st *SQLiteStore, id, userID, nodeID, purpose string, finalizedFileID string) {
	t.Helper()
	if _, err := st.db.ExecContext(context.Background(),
		`INSERT INTO upload_sessions (id, user_id, blob_key, node_id, created_at, purpose, finalized_file_id)
		 VALUES (?, ?, ?, ?, 1, ?, ?)`, id, userID, id+"-blob", nodeID, purpose, finalizedFileID); err != nil {
		t.Fatal(err)
	}
}

func am4rDeletedAt(t *testing.T, st *SQLiteStore, id string) (exists bool, deletedAt, removedAt int64) {
	t.Helper()
	err := st.db.QueryRow(`SELECT deleted_at, removed_at FROM nodes WHERE id = ?`, id).Scan(&deletedAt, &removedAt)
	if err != nil {
		return false, 0, 0
	}
	return true, deletedAt, removedAt
}

func am4rGC(st *SQLiteStore, svc *Service, now int64) *GC {
	return &GC{Store: st, BlobFor: svc.blobFor, Now: func() int64 { return now }, Log: log.New(io.Discard, "", 0)}
}

// Every kind of remaining reference retires the row instead of removing it;
// with none, the row is removed. Either way the owner is never refused, the
// node disappears from every listing, and only its owner can bring it back.
func TestA_M3_DeleteRetiresWhileCleanupNeedsTheNode(t *testing.T) {
	refs := map[string]func(t *testing.T, st *SQLiteStore, userID, nodeID string){
		"none": func(*testing.T, *SQLiteStore, string, string) {},
		"open share session": func(t *testing.T, st *SQLiteStore, userID, nodeID string) {
			am3rSessionRow(t, st, "am4r-s", userID, nodeID, StoredPurposeShare, "")
		},
		"finalized device-task session": func(t *testing.T, st *SQLiteStore, userID, nodeID string) {
			am3rSessionRow(t, st, "am4r-d", userID, nodeID, StoredPurposeDeviceTask, "some-file")
		},
		"pair-room session": func(t *testing.T, st *SQLiteStore, userID, nodeID string) {
			am3rSessionRow(t, st, "am4r-p", userID, nodeID, StoredPurposePairRoom, "")
		},
		"queued node delete": func(t *testing.T, st *SQLiteStore, _, nodeID string) {
			if err := st.EnqueueNodeDelete(context.Background(), "am4r-q", nodeID, 1); err != nil {
				t.Fatal(err)
			}
		},
		"stored object": func(t *testing.T, st *SQLiteStore, userID, nodeID string) {
			if err := st.CreateStoredFile(context.Background(), StoredFile{ID: "am4r-f", UserID: userID, BlobKey: "am4r-fb",
				EncManifest: []byte("m"), Size: 1, CreatedAt: 1, ExpiresAt: 1 << 40, NodeID: nodeID}); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, ref := range refs {
		t.Run(name, func(t *testing.T) {
			s, st, u1, u2 := am3Service(t)
			ctx := context.Background()
			n := am4rOwnNode(t, st, u1.ID, "https://node.example", 1)
			ref(t, st, u1.ID, n.ID)
			var pendingBefore int
			_ = st.db.QueryRow(`SELECT COUNT(*) FROM pending_node_deletes WHERE node_id = ?`, n.ID).Scan(&pendingBefore)

			if err := st.DeleteNode(ctx, n.ID, u2.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("non-owner delete: want ErrNotFound, got %v", err)
			}
			if err := st.DeleteNode(ctx, n.ID, u1.ID); err != nil {
				t.Fatalf("owner delete: %v", err)
			}
			exists, deletedAt, removedAt := am4rDeletedAt(t, st, n.ID)
			if name == "none" {
				if exists {
					t.Fatal("a node nothing references was retired instead of removed")
				}
			} else {
				if !exists || deletedAt == 0 || removedAt == 0 {
					t.Fatalf("referenced node: exists=%v deleted_at=%d removed_at=%d, want a retired row", exists, deletedAt, removedAt)
				}
				// Still resolvable for cleanup...
				if _, err := s.blobFor(ctx, n.ID); err != nil {
					t.Fatalf("a retired node no longer resolves for cleanup: %v", err)
				}
			}
			var pendingAfter int
			_ = st.db.QueryRow(`SELECT COUNT(*) FROM pending_node_deletes WHERE node_id = ?`, n.ID).Scan(&pendingAfter)
			if pendingAfter != pendingBefore {
				t.Fatalf("queued node deletes %d -> %d: a delete must not drop cleanup intents", pendingBefore, pendingAfter)
			}
			// ...but gone from every listing and from placement.
			if all, _ := st.UserNodesAll(ctx, u1.ID); len(all) != 0 {
				t.Fatalf("the deleted node is still listed for its owner: %+v", all)
			}
			if all, _ := st.ListNodes(ctx); len(all) != 0 {
				t.Fatalf("the deleted node is still in the admin listing: %d", len(all))
			}
			if page, total, _ := st.ListByoNodes(ctx, AdminByoNodeQuery{Removed: true, Limit: 20}); total != 0 || len(page) != 0 {
				t.Fatalf("the deleted node is in the BYO removed section: %d", total)
			}
			if live, _ := st.UserStorageNodes(ctx, u1.ID, 0, 0); len(live) != 0 {
				t.Fatal("the deleted node is still a placement candidate")
			}
			// The admin "restore" control cannot bring a deleted node back.
			if err := st.ClearNodeRemoved(ctx, n.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("restore of a deleted node: want ErrNotFound, got %v", err)
			}
			if err := st.DeleteNode(ctx, n.ID, u1.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("second delete: want ErrNotFound, got %v", err)
			}
			// Another owner is refused as retired; the owner brings it back live.
			if got := am3Register(t, s, "attacker-token", n.ID); got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeRetired {
				t.Fatalf("another user registering the deleted id: %d code=%q, want 403 %q", got.Code, got.Reason, nodeRegisterCodeRetired)
			}
			if got := am3Register(t, s, "owner-token", n.ID); got.Code != http.StatusOK {
				t.Fatalf("owner re-registering the deleted id: %d %q", got.Code, got.Error)
			}
			if exists, d, r := am4rDeletedAt(t, st, n.ID); !exists || d != 0 || r != 0 {
				t.Fatalf("revived node: exists=%v deleted_at=%d removed_at=%d, want a live row", exists, d, r)
			}
			if all, _ := st.UserNodesAll(ctx, u1.ID); len(all) != 1 {
				t.Fatalf("the revived node is not listed: %d", len(all))
			}
		})
	}
}

// Pair-room close hands the room's blob to the queue and deletes its session;
// the owner deletes the node before GC drains. The retired row lets the drain
// reach the machine and reclaim the blob. Own-node traffic is never metered.
func TestA_M3_RoomCloseThenOwnerDeleteStillReclaims(t *testing.T) {
	_, svc, st, _ := newFileServer(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "am4r-room@example.com", "")
	objects := map[string][]byte{}
	srv := fakeNode(t, objects)
	t.Cleanup(srv.Close)
	now := time.Now().Unix()
	n := am4rOwnNode(t, st, u.ID, srv.URL, now)
	room := PairRoom{ID: "am4r-room", Code: "515151", UserID: u.ID, CreatedAt: now, ExpiresAt: now + pairRoomJoinWindow}
	if _, created, err := st.CreatePairRoomIfAbsent(ctx, room); err != nil || !created {
		t.Fatalf("room: %v %v", created, err)
	}
	if ok, err := st.CreateUploadSession(ctx, UploadSessionRow{ID: "am4r-rs", UserID: u.ID, BlobKey: "am4r-rb",
		NodeID: n.ID, PairRoomID: room.ID, Purpose: StoredPurposePairRoom, MaxSize: 1 << 20, Received: 400,
		CreatedAt: now}, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("session: %v %v", ok, err)
	}
	objects["am4r-rb"] = bytes.Repeat([]byte("r"), 400)
	meterBefore := uploadedThisMonth(t, st, u.ID)

	if _, err := st.ClosePairRoom(ctx, room.ID, now, now+pairRoomBlobHold); err != nil {
		t.Fatalf("close room: %v", err)
	}
	if err := st.DeleteNode(ctx, n.ID, u.ID); err != nil {
		t.Fatalf("owner delete after the room closed: %v", err)
	}
	am4rGC(st, svc, now).drainPending(ctx)
	if _, still := objects["am4r-rb"]; still {
		t.Fatal("the closed room's blob was not reclaimed after its node was deleted")
	}
	if m := uploadedThisMonth(t, st, u.ID); m != meterBefore {
		t.Fatalf("own-node room cleanup metered %d bytes, want none", m-meterBefore)
	}
}

// The reaper's hand-off (ClaimUploadSessionCleanup) queues a billable session's
// blob with its billing obligation and deletes the session; an admin then
// deletes the fleet node before GC drains. The retired row lets GC settle the
// obligation and reclaim the blob — billing exactly what the same drain bills
// when the node was NOT deleted, once, however often GC runs.
func TestA_M3_ReaperHandoffThenFleetDeleteStillSettlesAndReclaims(t *testing.T) {
	run := func(t *testing.T, deleteNode bool) (meter int64, blobLeft bool) {
		_, svc, st, _ := newFileServer(t)
		ctx := context.Background()
		u, _ := st.UpsertUserByEmail(ctx, "am4r-reap@example.com", "")
		objects := map[string][]byte{}
		srv := fakeNode(t, objects)
		t.Cleanup(srv.Close)
		now := time.Now().Unix()
		fleet, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "fleet", URLs: []string{"turn:x:3478"},
			TURNSecret: "t", StorageEnabled: true, StorageURL: srv.URL, StorageSecret: "ss", StorageFree: 100 << 30,
			CreatedAt: 1, LastSeenAt: now})
		if err != nil {
			t.Fatal(err)
		}
		// A refused/abandoned billable upload: 300 bytes received and metered,
		// but a late append left 500 on the node (the residual the queue owns).
		if ok, err := st.CreateUploadSession(ctx, UploadSessionRow{ID: "am4r-us", UserID: u.ID, BlobKey: "am4r-ub",
			NodeID: fleet.ID, Billable: true, MaxSize: 1000, Received: 300, Metered: 300, Done: true,
			CreatedAt: now - 7200}, maxSessionsPerUser); err != nil || !ok {
			t.Fatalf("session: %v %v", ok, err)
		}
		objects["am4r-ub"] = bytes.Repeat([]byte("u"), 500)
		if _, _, ok, err := st.ClaimUploadSessionCleanup(ctx, "am4r-us", now, now); err != nil || !ok {
			t.Fatalf("reaper claim: ok=%v err=%v", ok, err)
		}
		if deleteNode {
			if err := st.DeleteFleetNode(ctx, fleet.ID); err != nil {
				t.Fatalf("admin delete after the hand-off: %v", err)
			}
			if exists, d, _ := am4rDeletedAt(t, st, fleet.ID); !exists || d == 0 {
				t.Fatal("the fleet node was removed although its queued delete still needs it")
			}
		}
		g := am4rGC(st, svc, now)
		g.drainPending(ctx)
		g.drainPending(ctx) // a second sweep must not bill again
		_, blobLeft = objects["am4r-ub"]
		return uploadedThisMonth(t, st, u.ID), blobLeft
	}
	controlMeter, controlLeft := run(t, false)
	meter, left := run(t, true)
	if controlLeft || left {
		t.Fatalf("blob left on the node: control=%v deleted=%v, want reclaimed in both", controlLeft, left)
	}
	if meter != controlMeter {
		t.Fatalf("metered %d after the node was deleted, %d when it was not: deletion changed billing", meter, controlMeter)
	}
	t.Logf("residual billed once in both runs: %d bytes", meter)
}

// A user whose machine is dead — offline for good, with an upload stuck in the
// recovery state that nothing will ever finish — can still delete the node,
// immediately, through the real endpoint; it vanishes from their list.
func TestA_M3_DeadOwnNodeCanBeDeleted(t *testing.T) {
	ts, svc, st, mail := newFileServer(t)
	svc.cfg.EnableUserNodes = true
	cookie := loginCookie(t, ts, mail, "am4r-dead@example.com")
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "am4r-dead@example.com", "")
	n := am4rOwnNode(t, st, u.ID, "https://gone.example", 1) // last seen at t=1
	am3rSessionRow(t, st, "am4r-stuck", u.ID, n.ID, StoredPurposeShare, "")
	if _, err := st.db.ExecContext(ctx, `UPDATE upload_sessions SET done = 1, unresolved_at = 5 WHERE id = 'am4r-stuck'`); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/nodes/"+n.ID, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("deleting a dead own node with a stuck upload: %d, want 200", resp.StatusCode)
	}
	lreq, _ := http.NewRequest("GET", ts.URL+"/api/nodes/mine", nil)
	lreq.AddCookie(cookie)
	lresp, err := ts.Client().Do(lreq)
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Nodes []map[string]any `json:"nodes"`
	}
	_ = json.NewDecoder(lresp.Body).Decode(&list)
	lresp.Body.Close()
	if len(list.Nodes) != 0 {
		t.Fatalf("the deleted node is still in the user's list: %+v", list.Nodes)
	}
}

// End to end: the owner deletes their node in the middle of a resumable
// upload. The delete succeeds; the finalize is then refused by the insert's
// node fence and its refused-upload reclaim reaches the retired node and
// removes the partial blob. No object, and own-node traffic is not metered.
func TestA_M3_OwnNodeDeletedMidUploadReclaimsTheBlob(t *testing.T) {
	ts, svc, st, mail := newFileServer(t)
	svc.cfg.EnableUserNodes = true
	cookie := loginCookie(t, ts, mail, "am4r-mid@example.com")
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "am4r-mid@example.com", "")
	objects := map[string][]byte{}
	srv := fakeNode(t, objects)
	t.Cleanup(srv.Close)
	own := am4rOwnNode(t, st, u.ID, srv.URL, time.Now().Unix())

	blob := bytes.Repeat([]byte("Q"), 600)
	id := initUpload(t, ts, cookie, []byte("M"), len(blob), 0)
	if code, _ := patchChunk(t, ts, cookie, id, blob, 0, 600, len(blob)); code != 200 {
		t.Fatalf("chunk: %d", code)
	}
	if len(objects) != 1 {
		t.Fatalf("partial blob not on the own node: %d objects", len(objects))
	}
	dreq, _ := http.NewRequest("DELETE", ts.URL+"/api/nodes/"+own.ID, nil)
	dreq.AddCookie(cookie)
	dresp, err := ts.Client().Do(dreq)
	if err != nil {
		t.Fatal(err)
	}
	dresp.Body.Close()
	if dresp.StatusCode != http.StatusOK {
		t.Fatalf("delete mid-upload: %d, want 200", dresp.StatusCode)
	}
	freq, _ := http.NewRequest("POST", ts.URL+"/api/uploads/"+id+"/finalize", nil)
	freq.AddCookie(cookie)
	fresp, err := ts.Client().Do(freq)
	if err != nil {
		t.Fatal(err)
	}
	fresp.Body.Close()
	if fresp.StatusCode == http.StatusOK {
		t.Fatal("a finalize onto a deleted node was accepted")
	}
	var files int
	_ = st.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE user_id = ?`, u.ID).Scan(&files)
	if files != 0 {
		t.Fatalf("%d object(s) stored on a deleted node", files)
	}
	// The refused-upload reclaim deletes directly or queues; drain the queue.
	am4rGC(st, svc, time.Now().Unix()).drainPending(ctx)
	if len(objects) != 0 {
		t.Fatalf("the partial blob was stranded on the deleted node: %d objects", len(objects))
	}
	if m := uploadedThisMonth(t, st, u.ID); m != 0 {
		t.Fatalf("own-node upload metered %d bytes", m)
	}
}

// Session creation is fenced on a live (not deleted) node row: nothing is
// written, and the init endpoint answers 503 with the node-offline wording.
func TestA_M3_UploadSessionCreationFencedOnDeletedNode(t *testing.T) {
	_, st, u1, _ := am3Service(t)
	ctx := context.Background()
	gone := am4rOwnNode(t, st, u1.ID, "https://x.example", 1)
	if err := st.DeleteNode(ctx, gone.ID, u1.ID); err != nil {
		t.Fatal(err)
	}
	retired := am4rOwnNode(t, st, u1.ID, "https://y.example", 1)
	if err := st.EnqueueNodeDelete(ctx, "am4r-keep", retired.ID, 1); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNode(ctx, retired.ID, u1.ID); err != nil {
		t.Fatal(err)
	}
	for _, nodeID := range []string{gone.ID, retired.ID} {
		row := UploadSessionRow{ID: "am4r-late-" + nodeID[:6], UserID: u1.ID, BlobKey: authx.RandToken(), NodeID: nodeID,
			EncManifest: []byte("m"), TTL: 3600, MaxSize: 1 << 20, CreatedAt: tNow}
		if ok, err := st.CreateUploadSession(ctx, row, 10); ok || !errors.Is(err, ErrStoredFileNodeGone) {
			t.Fatalf("session on a deleted node: ok=%v err=%v, want ErrStoredFileNodeGone", ok, err)
		}
	}
	var c int
	_ = st.db.QueryRow(`SELECT COUNT(*) FROM upload_sessions WHERE user_id = ?`, u1.ID).Scan(&c)
	if c != 0 {
		t.Fatalf("%d session row(s) created for deleted nodes", c)
	}
	live := am4rOwnNode(t, st, u1.ID, "https://z.example", 1)
	row := UploadSessionRow{ID: "am4r-live", UserID: u1.ID, BlobKey: authx.RandToken(), NodeID: live.ID,
		EncManifest: []byte("m"), TTL: 3600, MaxSize: 1 << 20, CreatedAt: tNow}
	if ok, err := st.CreateUploadSession(ctx, row, 10); !ok || err != nil {
		t.Fatalf("session on a live node: ok=%v err=%v", ok, err)
	}
}

type sessionGoneStore struct{ Store }

func (sessionGoneStore) CreateUploadSession(context.Context, UploadSessionRow, int) (bool, error) {
	return false, ErrStoredFileNodeGone
}

func TestA_M3_UploadInitAnswers503WhenItsNodeWasDeleted(t *testing.T) {
	ts, svc, st, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "am4r-503@example.com")
	svc.store = sessionGoneStore{st}
	var body bytes.Buffer
	body.Write([]byte{0, 0, 0, 1, 'M'})
	req, _ := http.NewRequest("POST", ts.URL+"/api/uploads?ttl=0&size=10", &body)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	msg, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("init onto a just-deleted node: %d %q, want 503", resp.StatusCode, msg)
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

// Bringing a RETIRED node back is a new live node: it counts against the cap.
func TestA_M3_ReviveOfRetiredNodeIsCapped(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	reg := am3Register(t, s, "owner-token", authx.NewID())
	if reg.Code != http.StatusOK {
		t.Fatalf("register: %d %q", reg.Code, reg.Error)
	}
	if err := st.EnqueueNodeDelete(ctx, "am4r-cap", reg.NodeID, 1); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNode(ctx, reg.NodeID, u1.ID); err != nil {
		t.Fatal(err)
	}
	if exists, d, _ := am4rDeletedAt(t, st, reg.NodeID); !exists || d == 0 {
		t.Fatal("setup: the node was not retired")
	}
	for i := 0; i < maxLiveNodesPerUser; i++ {
		if got := am3Register(t, s, "owner-token", authx.NewID()); got.Code != http.StatusOK {
			t.Fatalf("node %d: %d %q", i, got.Code, got.Error)
		}
	}
	got := am3Register(t, s, "owner-token", reg.NodeID)
	if got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeLimit {
		t.Fatalf("reviving a retired node at the cap: %d code=%q, want 403 %q", got.Code, got.Reason, nodeRegisterCodeLimit)
	}
	if _, d, _ := am4rDeletedAt(t, st, reg.NodeID); d == 0 {
		t.Fatal("a refused revive still revived the node")
	}
}
