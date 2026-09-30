package account

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// A-M3/A-M4 round 2: the admission rules must hold under concurrency. Every
// test here parks a request in the window a check-then-write implementation is
// racy in, lets a competing write land, and only then lets the parked request
// continue.

// setRegisterHook installs nodeRegisterBeforeWriteHook for one test.
func setRegisterHook(t *testing.T, fn func(nodeID string)) {
	t.Helper()
	nodeRegisterBeforeWriteHook = fn
	t.Cleanup(func() { nodeRegisterBeforeWriteHook = nil })
}

// parkRegister starts a register of nodeID with bearer in the background and
// returns once it is parked at the hook; release() lets it continue and
// returns its result. Registers of OTHER ids pass the hook untouched.
func parkRegister(t *testing.T, s *Service, bearer, nodeID string) (release func() am3RegisterResult) {
	t.Helper()
	arrived, gate := make(chan struct{}), make(chan struct{})
	var once sync.Once
	setRegisterHook(t, func(id string) {
		if id != nodeID {
			return
		}
		parked := false
		once.Do(func() { parked = true })
		if !parked {
			return
		}
		close(arrived)
		<-gate
	})
	done := make(chan am3RegisterResult, 1)
	go func() { done <- am3Register(t, s, bearer, nodeID) }()
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the register never reached the hook")
	}
	return func() am3RegisterResult {
		close(gate)
		select {
		case r := <-done:
			return r
		case <-time.After(5 * time.Second):
			t.Fatal("the parked register never finished")
			return am3RegisterResult{}
		}
	}
}

// A registration parked after its request was parsed must not overwrite a node
// another owner registered under the same id in the meantime: judged inside
// the write's transaction, it sees the row and is refused.
func TestA_M3_ParkedRegisterCannotOverwriteAnotherOwnersNode(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	id := authx.NewID()
	release := parkRegister(t, s, "attacker-token", id)

	if got := am3Register(t, s, "owner-token", id); got.Code != http.StatusOK {
		t.Fatalf("owner's register while the attacker is parked: %d %q", got.Code, got.Error)
	}
	got := release()
	if got.Code != http.StatusForbidden {
		t.Fatalf("parked attacker register: got %d (%q), want 403", got.Code, got.Error)
	}
	row, ok, _ := st.GetNode(ctx, id)
	if !ok || row.OwnerType != "user" || row.OwnerUserID != u1.ID {
		t.Fatalf("node row after the race: ok=%v %+v, want still owned by %s", ok, row, u1.ID)
	}
}

// Same window, but the other owner registers AND deletes the id while the
// attacker is parked: the tombstone is seen inside the write's transaction.
func TestA_M3_ParkedRegisterSeesATombstoneWrittenMeanwhile(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	id := authx.NewID()
	release := parkRegister(t, s, "attacker-token", id)

	if got := am3Register(t, s, "owner-token", id); got.Code != http.StatusOK {
		t.Fatalf("owner's register: %d %q", got.Code, got.Error)
	}
	if err := st.DeleteNode(ctx, id, u1.ID); err != nil {
		t.Fatalf("owner's delete: %v", err)
	}
	got := release()
	if got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeRetired {
		t.Fatalf("parked attacker register after delete: got %d code=%q (%q), want 403 %q", got.Code, got.Reason, got.Error, nodeRegisterCodeRetired)
	}
	if _, ok, _ := st.GetNode(ctx, id); ok {
		t.Fatal("the parked register recreated a deleted node for another owner")
	}
}

// A fleet re-register parked while a USER registers a colliding id cannot flip
// the owner either (the row's owner is never rewritten by a register).
func TestA_M3_ParkedFleetRegisterCannotAdoptAUserNode(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	id := authx.NewID()
	release := parkRegister(t, s, "fleet-secret", id)
	if got := am3Register(t, s, "owner-token", id); got.Code != http.StatusOK {
		t.Fatalf("owner's register: %d %q", got.Code, got.Error)
	}
	if got := release(); got.Code != http.StatusForbidden {
		t.Fatalf("parked fleet register: got %d, want 403", got.Code)
	}
	if row, _, _ := st.GetNode(ctx, id); row.OwnerType != "user" || row.OwnerUserID != u1.ID {
		t.Fatalf("owner flipped: %+v", row)
	}
}

// Cap race: at nine live nodes, five new ids registered at once — all parked
// past the hook together, then released — land exactly one. A re-register of
// an existing node is still allowed afterwards, at the cap.
func TestA_M4_ConcurrentNewIDsAtNineLandExactlyOne(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	var existing string
	for i := 0; i < maxLiveNodesPerUser-1; i++ {
		got := am3Register(t, s, "owner-token", authx.NewID())
		if got.Code != http.StatusOK {
			t.Fatalf("node %d: %d %q", i, got.Code, got.Error)
		}
		existing = got.NodeID
	}
	const racers = 5
	var arrived sync.WaitGroup
	arrived.Add(racers)
	gate := make(chan struct{})
	ids := map[string]bool{}
	for len(ids) < racers {
		ids[authx.NewID()] = true
	}
	setRegisterHook(t, func(id string) {
		if !ids[id] { // only this test's racers
			return
		}
		arrived.Done()
		<-gate
	})
	results := make(chan am3RegisterResult, racers)
	for id := range ids {
		go func(id string) { results <- am3Register(t, s, "owner-token", id) }(id)
	}
	arrived.Wait() // every racer has passed everything before the write
	close(gate)
	ok, limited := 0, 0
	for i := 0; i < racers; i++ {
		r := <-results
		switch {
		case r.Code == http.StatusOK:
			ok++
		case r.Code == http.StatusForbidden && r.Reason == nodeRegisterCodeLimit:
			limited++
		default:
			t.Errorf("unexpected result %d code=%q (%q)", r.Code, r.Reason, r.Error)
		}
	}
	if ok != 1 || limited != racers-1 {
		t.Fatalf("concurrent new ids at %d live: %d succeeded, %d limited; want exactly 1 and %d", maxLiveNodesPerUser-1, ok, limited, racers-1)
	}
	if n, _ := st.CountLiveUserNodes(ctx, u1.ID); n != maxLiveNodesPerUser {
		t.Fatalf("live nodes = %d, want %d", n, maxLiveNodesPerUser)
	}
	nodeRegisterBeforeWriteHook = nil
	if got := am3Register(t, s, "owner-token", existing); got.Code != http.StatusOK {
		t.Fatalf("re-register of an existing node at the cap: %d %q", got.Code, got.Error)
	}
}

// Admin delete is refused while an upload session names the node, not only a
// stored file.
func TestA_M3_AdminDeleteRefusedWhileUploadSessionNamesNode(t *testing.T) {
	_, st, u1, _ := am3Service(t)
	ctx := context.Background()
	n := am3FleetNode(t, st)
	if _, err := st.db.ExecContext(ctx,
		`INSERT INTO upload_sessions (id, user_id, blob_key, node_id, created_at) VALUES ('am3r-us', ?, 'am3r-b', ?, 1)`,
		u1.ID, n.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteFleetNode(ctx, n.ID); !errors.Is(err, ErrNodeHasStoredFiles) {
		t.Fatalf("delete with an upload session: want ErrNodeHasStoredFiles, got %v", err)
	}
	if blockers, err := st.NodeDeleteBlockers(ctx); err != nil || blockers[n.ID] != 1 {
		t.Fatalf("NodeDeleteBlockers = %v, %v; want 1 for the node", blockers, err)
	}
}

// The insert's node fence at the store: a node-backed object whose node row is
// gone is refused with ErrStoredFileNodeGone, and its quota debit — riding the
// same transaction — is not written.
func TestA_M3_StoredFileInsertFencedOnDeletedNode(t *testing.T) {
	_, st, u1, _ := am3Service(t)
	ctx := context.Background()
	n := am3FleetNode(t, st)
	if err := st.DeleteFleetNode(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	f := StoredFile{ID: "am3r-f", UserID: u1.ID, BlobKey: "am3r-bk", EncManifest: []byte("m"), Size: 100,
		CreatedAt: tNow, ExpiresAt: tNow + 3600, NodeID: n.ID,
		QuotaCharge: &UploadQuotaCharge{Event: UploadEvent{ID: "am3r-ev", UserID: u1.ID, Bytes: 100, UploadedAt: tNow},
			Since: tNow - 86400, Quota: 1 << 30}}
	if _, err := st.CreateStoredFileWithinStorageCaps(ctx, f, tNow, 1<<30, 1<<40); !errors.Is(err, ErrStoredFileNodeGone) {
		t.Fatalf("capped insert on a deleted node: want ErrStoredFileNodeGone, got %v", err)
	}
	g := f
	g.QuotaCharge = nil
	if err := st.CreateStoredFile(ctx, g); !errors.Is(err, ErrStoredFileNodeGone) {
		t.Fatalf("plain insert on a deleted node: want ErrStoredFileNodeGone, got %v", err)
	}
	var files, events int
	_ = st.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE user_id = ?`, u1.ID).Scan(&files)
	_ = st.db.QueryRow(`SELECT COUNT(*) FROM upload_events WHERE user_id = ?`, u1.ID).Scan(&events)
	if files != 0 || events != 0 {
		t.Fatalf("a fenced insert left files=%d quota events=%d, want 0/0", files, events)
	}
	// Positive control: central (no node) and a live node still insert.
	c := g
	c.ID, c.BlobKey, c.NodeID = "am3r-c", "am3r-cb", ""
	if err := st.CreateStoredFile(ctx, c); err != nil {
		t.Fatalf("central insert: %v", err)
	}
	live := am3FleetNode(t, st)
	l := g
	l.ID, l.BlobKey, l.NodeID = "am3r-l", "am3r-lb", live.ID
	if err := st.CreateStoredFile(ctx, l); err != nil {
		t.Fatalf("live-node insert: %v", err)
	}
}

// deletingNode is a loopback storage node that, while it is receiving an
// upload's PUT — after central placed the upload on it and before central
// persists the object — has the node deleted by onPut. That is the interleave
// the node fence exists for.
func deletingNode(t *testing.T, onPut func()) (*countingNode, *httptest.Server) {
	t.Helper()
	n := &countingNode{objects: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		switch r.Method {
		case http.MethodPut:
			b, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "write failed", http.StatusInternalServerError)
				return
			}
			n.mu.Lock()
			n.objects[key] = len(b)
			n.mu.Unlock()
			onPut()
			io.WriteString(w, `{"size":`+strconv.Itoa(len(b))+`}`)
		case http.MethodDelete:
			n.mu.Lock()
			delete(n.objects, key)
			n.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)
	return n, srv
}

// End to end through POST /api/files: the node is deleted between placement
// and persist. The upload fails through the existing persist-error path — no
// object, no daily-quota debit, the blob dropped from the node — and the bytes
// that moved are metered exactly once, like every other post-Put refusal
// (TestSingleShotPostPutRefusalsMeterConsumedBytesOnce). An own node deleted
// by its owner mid-upload fails the same way and, as own-node traffic always
// is, is not metered.
func TestA_M3_UploadFailsWhenItsNodeIsDeletedBeforePersist(t *testing.T) {
	for _, ownerType := range []string{"fleet", "user"} {
		t.Run(ownerType, func(t *testing.T) {
			h := newMeterHarness(t, "am3r-"+ownerType+"@example.com")
			nodeID := "wn35-" + ownerType
			var delErr error
			var deleted bool
			node, srv := deletingNode(t, func() {
				if deleted {
					return
				}
				deleted = true
				if ownerType == "fleet" {
					delErr = h.store.DeleteFleetNode(context.Background(), nodeID)
				} else {
					delErr = h.store.DeleteNode(context.Background(), nodeID, h.userID)
				}
			})
			h.addNode(t, ownerType, srv)
			code := h.serve(t, meterReq{body: wn35Body(900)})
			if !deleted || delErr != nil {
				t.Fatalf("the node was not deleted mid-upload: deleted=%v err=%v", deleted, delErr)
			}
			st := h.state(t)
			objects, _ := node.count()
			want := meterState{meter: 900}
			if ownerType == "user" {
				want = meterState{}
			}
			if code != http.StatusInternalServerError || st != want || objects != 0 {
				t.Fatalf("code=%d state=%+v nodeObjects=%d, want 500 %+v 0", code, st, objects, want)
			}
			if ownerType == "fleet" {
				assertMeteredOnce(t, h, 900)
			} else {
				assertNotMetered(t, h)
			}
		})
	}
}

// Account purges tombstone the account's nodes in the same transaction that
// deletes them.
func TestA_M3_AccountPurgeTombstonesUserNodes(t *testing.T) {
	s, st, u1, u2 := am3Service(t)
	ctx := context.Background()
	reg := am3Register(t, s, "owner-token", authx.NewID())
	if reg.Code != http.StatusOK {
		t.Fatalf("register: %d %q", reg.Code, reg.Error)
	}
	tx, err := st.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := purgeTransientUserDataTx(ctx, tx, u1.ID); err != nil {
		_ = tx.Rollback()
		t.Fatalf("purge: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.GetNode(ctx, reg.NodeID); ok {
		t.Fatal("purge left the node row")
	}
	if state, _ := st.NodeIDReuseState(ctx, reg.NodeID, "user", u2.ID); state != NodeIDTombstoned {
		t.Fatalf("after purge, another user: state=%v, want tombstoned", state)
	}
	// The hard purge's own statement tombstones too (a node that survived to it).
	n2, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u2.ID,
		URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetAccountDeletion(ctx, u2.ID, 1, 100); err != nil {
		t.Fatalf("schedule deletion: %v", err)
	}
	if err := st.ArchiveAndPurgeUser(ctx, u2.ID, 200); err != nil {
		t.Fatalf("ArchiveAndPurgeUser: %v", err)
	}
	if _, ok, _ := st.GetNode(ctx, n2.ID); ok {
		t.Fatal("the hard purge left the node row")
	}
	if state, _ := st.NodeIDReuseState(ctx, n2.ID, "user", u1.ID); state != NodeIDTombstoned {
		t.Fatalf("after hard purge, another user: state=%v, want tombstoned", state)
	}
}

// The admin fleet table shows the delete blockers (expired-uncollected files
// included) instead of a delete button that would answer 409.
func TestA_M3_AdminPanelShowsDeleteBlockers(t *testing.T) {
	ts, _, st := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "am3r-panel@example.com", "p")
	blocked := am3FleetNode(t, st)
	free := am3FleetNode(t, st)
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "am3r-exp", UserID: u.ID, BlobKey: "am3r-expb",
		EncManifest: []byte("m"), Size: 1, CreatedAt: 1, ExpiresAt: 2, NodeID: blocked.ID}); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/admin/fleet", nil)
	req.AddCookie(cookie)
	req.Header.Set("Accept-Language", "zh-CN")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	page := string(body)
	if strings.Contains(page, `/admin/nodes/`+blocked.ID+`/delete`) {
		t.Fatal("a node with an expired-but-uncollected file still offers a delete button")
	}
	if !strings.Contains(page, "条记录待清理") {
		t.Fatal("the blocked node's remaining records are not shown")
	}
	if !strings.Contains(page, `/admin/nodes/`+free.ID+`/delete`) {
		t.Fatal("an empty node lost its delete button")
	}
}
