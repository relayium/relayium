package account

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/storage"
)

// stalledTLSNode accepts TCP connections and never says a word: the TLS
// ClientHello is read by nobody and the handshake never completes. It counts
// the connections it has accepted.
type stalledTLSNode struct {
	ln       net.Listener
	accepted atomic.Int32
	mu       sync.Mutex
	conns    []net.Conn
}

func newStalledTLSNode(t *testing.T) *stalledTLSNode {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	n := &stalledTLSNode{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			n.accepted.Add(1)
			n.mu.Lock()
			n.conns = append(n.conns, c)
			n.mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		n.mu.Lock()
		for _, c := range n.conns {
			c.Close()
		}
		n.mu.Unlock()
	})
	return n
}

func (n *stalledTLSNode) URL() string { return "https://" + n.ln.Addr().String() }

func shrink(t *testing.T, v *time.Duration, to time.Duration) {
	t.Helper()
	restore := *v
	*v = to
	t.Cleanup(func() { *v = restore })
}

// The root cause of B-H1: a hand-built http.Transport has no TLS handshake
// timeout, and the dial timeout is over before the handshake starts, so a node
// that accepts TCP and never finishes TLS held its caller forever. Both the
// plain transport and the fingerprint-pinned clone of it must give up on their
// own, on context.Background(), the way GC calls them.
func TestNodeTransportGivesUpOnAStalledTLSHandshake(t *testing.T) {
	h := newPairHarness(t)
	node := newStalledTLSNode(t)
	stores := map[string]storage.BlobStore{
		"ca-verified": storage.NewRemoteBlobStore(node.URL(), "ss", "", h.svc.nodeHTTP),
		"pinned":      storage.NewRemoteBlobStore(node.URL(), "ss", strings.Repeat("ab", 32), h.svc.nodeHTTP),
	}
	type result struct {
		name string
		err  error
		took time.Duration
	}
	done := make(chan result, len(stores))
	for name, bs := range stores {
		go func() {
			start := time.Now()
			err := bs.Delete(context.Background(), "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0")
			done <- result{name, err, time.Since(start)}
		}()
	}
	deadline := time.After(15 * time.Second)
	for range stores {
		select {
		case r := <-done:
			if r.err == nil || !isTimeout(r.err) {
				t.Fatalf("%s: delete against a stalled handshake returned %v, want a timeout", r.name, r.err)
			}
			t.Logf("%s: gave up after %v: %v", r.name, r.took.Round(time.Millisecond), r.err)
		case <-deadline:
			t.Fatal("a delete against a node that never completes TLS was still waiting after 15 s")
		}
	}
}

// B-H1 at the sweep level: expired files on a node that never completes TLS
// must not stop the rest of the sweep. Each delete is bounded, the node is
// asked once per sweep rather than once per blob, the blobs it holds stay
// queued, and the passes after it — here the session prune — still run.
func TestAStalledTLSNodeDoesNotFreezeTheSweep(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	shrink(t, &nodeDeleteTimeout, 300*time.Millisecond)
	node := newStalledTLSNode(t)
	nodeID := h.registerStorageNode(t, node.URL())

	stalled := []string{"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1", "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2"}
	for i, k := range stalled {
		if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "stalled-" + k[:2] + string(rune('a'+i)), UserID: h.userID,
			BlobKey: k, EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: h.now - 10, NodeID: nodeID}); err != nil {
			t.Fatal(err)
		}
	}
	central := "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3"
	if _, err := h.disk.Put(ctx, central, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "central-expired", UserID: h.userID,
		BlobKey: central, EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: h.now - 10}); err != nil {
		t.Fatal(err)
	}
	if err := h.store.CreateSession(ctx, Session{ID: "gc-expired-session", UserID: h.userID, CreatedAt: 1, ExpiresAt: h.now - 10}); err != nil {
		t.Fatal(err)
	}
	sessions := func() int {
		var n int
		if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id = ?`, authx.HashToken("gc-expired-session")).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	g := &GC{Store: h.store, Blobs: h.disk, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	done := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		g.sweep(ctx)
		done <- time.Since(start)
	}()
	select {
	case took := <-done:
		if took > 3*time.Second {
			t.Fatalf("the sweep took %v with one stalled node", took)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the sweep was still stuck on a node that never completes TLS after 20 s")
	}

	if sessions() != 0 {
		t.Fatal("the session prune after the stalled node never ran")
	}
	if n := node.accepted.Load(); n != 1 {
		t.Fatalf("the stalled node was dialled %d times in one sweep, want once", n)
	}
	for _, k := range stalled {
		if storedFilesFor(t, h, k) != 0 || len(queuedFor(t, h, k)) != 1 {
			t.Fatalf("%s: rows=%d queue=%+v, want the row gone and the blob queued", k, storedFilesFor(t, h, k), queuedFor(t, h, k))
		}
	}
	if _, err := h.disk.Get(ctx, central); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("the central blob behind the stalled node was not deleted: %v", err)
	}
	if q := queuedFor(t, h, central); len(q) != 0 {
		t.Fatalf("the central blob's delete succeeded but its intent is still queued: %+v", q)
	}
}

// A pass that runs out of its budget ends there, and the passes after it run.
// The node here answers TCP and TLS-less HTTP but never answers the DELETE, and
// the per-delete bound is left long, so only the pass deadline can stop it.
func TestAPassOutOfBudgetDoesNotStopTheNextPass(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	shrink(t, &gcPassBudget, 300*time.Millisecond)
	node := newCleanupNode(t)
	node.deleteMode.Store(2)
	nodeID := h.registerStorageNode(t, node.URL)
	key := "e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4"
	if err := enqueueNodeDeleteOn(ctx, h.store.db, key, nodeID, h.now, 0); err != nil {
		t.Fatal(err)
	}
	if err := h.store.CreateSession(ctx, Session{ID: "gc-budget-session", UserID: h.userID, CreatedAt: 1, ExpiresAt: h.now - 10}); err != nil {
		t.Fatal(err)
	}
	g := &GC{Store: h.store, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	start := time.Now()
	g.sweep(ctx)
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("a hung DELETE held the sweep for %v past its pass budget", took)
	}
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id = ?`, authx.HashToken("gc-budget-session")).Scan(&n); err != nil || n != 0 {
		t.Fatalf("the session prune after the out-of-budget drain did not run: n=%d err=%v", n, err)
	}
	if len(queuedFor(t, h, key)) != 1 {
		t.Fatal("the blob the drain could not delete is no longer queued")
	}
}

// failPendingInserts makes every write of a delete intent fail, in the store
// itself, so the transactional helpers see it as well as EnqueueNodeDelete.
func failPendingInserts(t *testing.T, st *SQLiteStore) (heal func()) {
	t.Helper()
	if _, err := st.db.Exec(`CREATE TRIGGER fail_pending_insert BEFORE INSERT ON pending_node_deletes
		BEGIN SELECT RAISE(ABORT, 'injected: queue write refused'); END`); err != nil {
		t.Fatal(err)
	}
	return func() {
		if _, err := st.db.Exec(`DROP TRIGGER IF EXISTS fail_pending_insert`); err != nil {
			t.Fatal(err)
		}
	}
}

func putOnNode(t *testing.T, dir, key string) {
	t.Helper()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ds.Put(context.Background(), key, strings.NewReader("ciphertext")); err != nil {
		t.Fatal(err)
	}
}

// ownedSomewhere is the invariant B-M1 is about: a blob that still exists is
// named by a stored_files row or by a queue row.
func ownedSomewhere(t *testing.T, h *pairHarness, key string) bool {
	t.Helper()
	return storedFilesFor(t, h, key) > 0 || len(queuedFor(t, h, key)) > 0
}

// B-M1, expiry sweep: node refusing the delete AND the queue refusing the
// write must leave the row, never a blob nothing names.
func TestExpirySweepNeverOrphansABlobWhenTheQueueWriteFails(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newCleanupNode(t)
	node.deleteMode.Store(1)
	nodeID := h.registerStorageNode(t, node.URL)
	key := "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"
	putOnNode(t, node.dir, key)
	if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "exp-q", UserID: h.userID, BlobKey: key,
		EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: h.now - 10, NodeID: nodeID}); err != nil {
		t.Fatal(err)
	}
	heal := failPendingInserts(t, h.store)
	g := &GC{Store: h.store, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	g.sweep(ctx)
	if !nodeBlobPresent(t, node.dir, key) || !ownedSomewhere(t, h, key) {
		t.Fatalf("blob=%v row=%d queue=%+v: an expired file's blob was left with no owner",
			nodeBlobPresent(t, node.dir, key), storedFilesFor(t, h, key), queuedFor(t, h, key))
	}

	heal()
	node.deleteMode.Store(0)
	g.sweep(ctx)
	if nodeBlobPresent(t, node.dir, key) || ownedSomewhere(t, h, key) {
		t.Fatalf("after healing: blob=%v row=%d queue=%+v, want all gone",
			nodeBlobPresent(t, node.dir, key), storedFilesFor(t, h, key), queuedFor(t, h, key))
	}
}

// A store without the transactional delete-intent methods is refused, not
// served by a weaker sequence: the expiry sweep, the task-object reclaim and
// the drain delete nothing, and the share-delete route answers 500 — every row
// and every blob stays where it was.
type noIntentStore struct{ Store }

func TestAStoreWithoutDeleteIntentsDeletesNothing(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newCleanupNode(t)
	nodeID := h.registerStorageNode(t, node.URL)
	expKey, taskKey, shareKey, queuedKey := "f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2", "f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7",
		"f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8f8", "f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9"
	grace := int64(taskObjectBindGrace / time.Second)
	for _, f := range []StoredFile{
		{ID: "exp-fb", BlobKey: expKey, CreatedAt: 1, ExpiresAt: h.now - 10},
		{ID: "task-fb", BlobKey: taskKey, CreatedAt: h.now - grace - 10, ExpiresAt: h.now + 3600, Purpose: StoredPurposeDeviceTask},
		{ID: "share-fb", BlobKey: shareKey, CreatedAt: h.now, ExpiresAt: h.now + 3600, Purpose: StoredPurposeShare},
	} {
		putOnNode(t, node.dir, f.BlobKey)
		f.UserID, f.EncManifest, f.Size, f.NodeID = h.userID, []byte{1}, 1, nodeID
		if err := h.store.CreateStoredFile(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	putOnNode(t, node.dir, queuedKey)
	if err := enqueueNodeDeleteOn(ctx, h.store.db, queuedKey, nodeID, h.now, 0); err != nil {
		t.Fatal(err)
	}
	g := &GC{Store: noIntentStore{h.store}, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	g.sweep(ctx)

	h.svc.store = noIntentStore{h.store}
	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodDelete, "/api/files/share-fb", nil)
	r.SetPathValue("id", "share-fb")
	w := httptest.NewRecorder()
	h.svc.handleDeleteFile(w, r, u)
	h.svc.store = h.store
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("share delete through a store without delete intents answered %d, want 500", w.Code)
	}
	for _, k := range []string{expKey, taskKey, shareKey} {
		if storedFilesFor(t, h, k) != 1 || !nodeBlobPresent(t, node.dir, k) {
			t.Fatalf("%s: row=%d blob=%v queue=%+v, want row and blob untouched", k, storedFilesFor(t, h, k), nodeBlobPresent(t, node.dir, k), queuedFor(t, h, k))
		}
	}
	if !nodeBlobPresent(t, node.dir, queuedKey) || len(queuedFor(t, h, queuedKey)) != 1 {
		t.Fatal("the drain acted through a store without delete intents")
	}
}

// B-M1, task-object reclaim: it used to delete the row first and enqueue only
// after a failed physical delete, ignoring that enqueue's error.
func TestTaskObjectReclaimNeverOrphansABlobWhenTheQueueWriteFails(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newCleanupNode(t)
	node.deleteMode.Store(1)
	nodeID := h.registerStorageNode(t, node.URL)
	key := "f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3"
	putOnNode(t, node.dir, key)
	grace := int64(taskObjectBindGrace / time.Second)
	if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "task-q", UserID: h.userID, BlobKey: key,
		EncManifest: []byte{1}, Size: 1, CreatedAt: h.now - grace - 10, ExpiresAt: h.now + 3600,
		NodeID: nodeID, Purpose: StoredPurposeDeviceTask}); err != nil {
		t.Fatal(err)
	}
	heal := failPendingInserts(t, h.store)
	g := &GC{Store: h.store, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	g.reclaimTaskObjects(ctx, h.now)
	if !nodeBlobPresent(t, node.dir, key) || !ownedSomewhere(t, h, key) {
		t.Fatalf("blob=%v row=%d queue=%+v: a reclaimed task object's blob was left with no owner",
			nodeBlobPresent(t, node.dir, key), storedFilesFor(t, h, key), queuedFor(t, h, key))
	}
	heal()
	node.deleteMode.Store(0)
	g.reclaimTaskObjects(ctx, h.now)
	if nodeBlobPresent(t, node.dir, key) || ownedSomewhere(t, h, key) {
		t.Fatalf("after healing: blob=%v row=%d queue=%+v, want all gone",
			nodeBlobPresent(t, node.dir, key), storedFilesFor(t, h, key), queuedFor(t, h, key))
	}
}

// B-M1, the share-delete route: a queue write that fails answers 500 and keeps
// the row; a node that is down after a successful queue write still answers
// 200, with the blob queued.
func TestDeleteFileRouteNeverOrphansABlob(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newCleanupNode(t)
	node.deleteMode.Store(1)
	nodeID := h.registerStorageNode(t, node.URL)
	key := "f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4"
	putOnNode(t, node.dir, key)
	if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "share-q", UserID: h.userID, BlobKey: key,
		EncManifest: []byte{1}, Size: 1, CreatedAt: h.now, ExpiresAt: h.now + 3600,
		NodeID: nodeID, Purpose: StoredPurposeShare}); err != nil {
		t.Fatal(err)
	}
	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatal(err)
	}
	del := func() int {
		r := httptest.NewRequest(http.MethodDelete, "/api/files/share-q", nil)
		r.SetPathValue("id", "share-q")
		w := httptest.NewRecorder()
		h.svc.handleDeleteFile(w, r, u)
		return w.Code
	}

	heal := failPendingInserts(t, h.store)
	if code := del(); code != http.StatusInternalServerError {
		t.Fatalf("delete with the queue refusing writes answered %d, want 500", code)
	}
	if !nodeBlobPresent(t, node.dir, key) || storedFilesFor(t, h, key) != 1 {
		t.Fatalf("blob=%v row=%d queue=%+v: want the row kept and still owning its blob",
			nodeBlobPresent(t, node.dir, key), storedFilesFor(t, h, key), queuedFor(t, h, key))
	}
	heal()
	if code := del(); code != http.StatusOK {
		t.Fatalf("delete answered %d, want 200", code)
	}
	if storedFilesFor(t, h, key) != 0 || len(queuedFor(t, h, key)) != 1 || !nodeBlobPresent(t, node.dir, key) {
		t.Fatalf("node down: row=%d queue=%+v blob=%v, want the row gone and the blob queued",
			storedFilesFor(t, h, key), queuedFor(t, h, key), nodeBlobPresent(t, node.dir, key))
	}
	node.deleteMode.Store(0)
	cleanupDrain(h, h.store, h.now)
	if nodeBlobPresent(t, node.dir, key) || len(queuedFor(t, h, key)) != 0 {
		t.Fatal("the drain did not finish the queued share delete")
	}
}

// A successful route delete clears the intent it wrote, and a held intent on
// the same key (written by something else) survives it.
func TestDeleteFileRouteClearsOnlyAnUnheldIntent(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		id, key string
		hold    int64
		want    int
	}{
		{"share-a", "f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5", 0, 0},
		{"share-b", "f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6", h.now + 600, 1},
	} {
		if _, err := h.disk.Put(ctx, c.key, strings.NewReader("x")); err != nil {
			t.Fatal(err)
		}
		if err := h.store.CreateStoredFile(ctx, StoredFile{ID: c.id, UserID: h.userID, BlobKey: c.key,
			EncManifest: []byte{1}, Size: 1, CreatedAt: h.now, ExpiresAt: h.now + 3600, Purpose: StoredPurposeShare}); err != nil {
			t.Fatal(err)
		}
		if c.hold != 0 {
			if err := enqueueNodeDeleteOn(ctx, h.store.db, c.key, "", h.now, c.hold); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(http.MethodDelete, "/api/files/"+c.id, nil)
		r.SetPathValue("id", c.id)
		w := httptest.NewRecorder()
		h.svc.handleDeleteFile(w, r, u)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d", c.id, w.Code)
		}
		if _, err := h.disk.Get(ctx, c.key); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("%s: blob not deleted: %v", c.id, err)
		}
		if q := queuedFor(t, h, c.key); len(q) != c.want {
			t.Fatalf("%s: queue=%+v, want %d row(s)", c.id, q, c.want)
		}
	}
}

// B-H2: the durable half of an account deletion is the transaction. With the
// post-commit physical loop skipped entirely — the process died right after
// commit — every blob that is not on the account's own nodes is already
// queued, the own-node ones are not (and their old queue rows went with the
// nodes), and the drain later deletes the queued ones.
func TestAccountDeletionQueuesEveryBlobInItsTransaction(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	fleet := newCleanupNode(t)
	fleetID := h.registerStorageNode(t, fleet.URL)
	own := newCleanupNode(t)
	ownID := h.registerOwnStorageNode(t, own.URL)

	centralKey := "a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7"
	fleetKey := "a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8"
	ownKey := "a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9"
	staleOwnKey := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := h.disk.Put(ctx, centralKey, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	putOnNode(t, fleet.dir, fleetKey)
	putOnNode(t, own.dir, ownKey)
	for id, f := range map[string]StoredFile{
		"acct-central": {BlobKey: centralKey},
		"acct-fleet":   {BlobKey: fleetKey, NodeID: fleetID},
		"acct-own":     {BlobKey: ownKey, NodeID: ownID},
	} {
		f.ID, f.UserID, f.EncManifest, f.Size, f.CreatedAt, f.ExpiresAt, f.Purpose = id, h.userID, []byte{1}, 1, h.now, h.now+3600, StoredPurposeShare
		if err := h.store.CreateStoredFile(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	// A queue row an earlier failure left naming the user's own node.
	if err := enqueueNodeDeleteOn(ctx, h.store.db, staleOwnKey, ownID, h.now, 0); err != nil {
		t.Fatal(err)
	}

	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatal(err)
	}
	tokenHash := authx.HashToken("delete-token")
	if err := h.store.CreateEmailToken(ctx, EmailToken{TokenHash: tokenHash, UserID: u.ID, Email: u.Email,
		Purpose: "delete", CreatedAt: h.now, ExpiresAt: h.now + 3600}); err != nil {
		t.Fatal(err)
	}
	react := EmailToken{TokenHash: authx.HashToken("react"), UserID: u.ID, Purpose: "reactivate", CreatedAt: h.now, ExpiresAt: h.now + 86400}
	blobs, committed, err := h.store.CommitAccountDeletion(ctx, tokenHash, u, h.now, h.now+86400, react)
	if err != nil || !committed {
		t.Fatalf("commit: committed=%v err=%v", committed, err)
	}
	if len(blobs) != 3 {
		t.Fatalf("returned blobs = %+v, want all three", blobs)
	}
	// "Crash" here: no physical deletes at all.
	for _, k := range []string{centralKey, fleetKey} {
		if q := queuedFor(t, h, k); len(q) != 1 {
			t.Fatalf("%s: queue=%+v after commit, want one intent written by the commit itself", k, q)
		}
	}
	for _, k := range []string{ownKey, staleOwnKey} {
		if q := queuedFor(t, h, k); len(q) != 0 {
			t.Fatalf("%s: queue=%+v, want nothing queued for a node the same commit deleted", k, q)
		}
	}

	cleanupDrain(h, h.store, h.now)
	if _, err := h.disk.Get(ctx, centralKey); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("drain left the central blob: %v", err)
	}
	if nodeBlobPresent(t, fleet.dir, fleetKey) {
		t.Fatal("drain left the fleet blob")
	}
	if p := h.pendingDeletes(t); len(p) != 0 {
		t.Fatalf("queue after the drain = %+v, want empty", p)
	}
}

// The full ConfirmAccountDeletion: the fleet node refuses deletes, so its blob
// stays queued; the central one is deleted and its intent cleared.
func TestConfirmAccountDeletionClearsOnlyWhatItDeleted(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	fleet := newCleanupNode(t)
	fleet.deleteMode.Store(1)
	fleetID := h.registerStorageNode(t, fleet.URL)
	centralKey := "abababababababababababababababab"
	fleetKey := "acacacacacacacacacacacacacacacac"
	if _, err := h.disk.Put(ctx, centralKey, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	putOnNode(t, fleet.dir, fleetKey)
	for id, f := range map[string]StoredFile{
		"c-central": {BlobKey: centralKey},
		"c-fleet":   {BlobKey: fleetKey, NodeID: fleetID},
	} {
		f.ID, f.UserID, f.EncManifest, f.Size, f.CreatedAt, f.ExpiresAt, f.Purpose = id, h.userID, []byte{1}, 1, h.now, h.now+3600, StoredPurposeShare
		if err := h.store.CreateStoredFile(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken("confirm-raw"), UserID: u.ID, Email: u.Email,
		Purpose: "delete", CreatedAt: h.now, ExpiresAt: h.now + 3600}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.ConfirmAccountDeletion(ctx, "confirm-raw"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.disk.Get(ctx, centralKey); !errors.Is(err, storage.ErrNotFound) || len(queuedFor(t, h, centralKey)) != 0 {
		t.Fatalf("central: get err=%v queue=%+v, want deleted and cleared", err, queuedFor(t, h, centralKey))
	}
	if !nodeBlobPresent(t, fleet.dir, fleetKey) || len(queuedFor(t, h, fleetKey)) != 1 {
		t.Fatalf("fleet: blob=%v queue=%+v, want kept and queued", nodeBlobPresent(t, fleet.dir, fleetKey), queuedFor(t, h, fleetKey))
	}
}

// A-L6: re-posting an existing browser device with no kind keeps it a browser
// device, so it still counts against MaxBrowserDevicesPerAccount.
func TestUpsertDeviceKeepsAnExistingKind(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "kind@example.com", "K")
	if _, err := st.RegisterBrowserDevice(ctx, BrowserDeviceRegistration{UserID: u.ID, DeviceID: "b1",
		TokenHash: authx.HashToken("b1tok"), Name: "Browser", At: 1}); err != nil {
		t.Fatal(err)
	}
	count := func() int {
		var n int
		if err := st.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE user_id = ? AND kind = 'browser'`, u.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := count()
	d, err := st.UpsertDevice(ctx, Device{ID: "b1", UserID: u.ID, Name: "Renamed", CreatedAt: 2})
	if err != nil {
		t.Fatal(err)
	}
	if d.Kind != "browser" || d.Name != "Renamed" {
		t.Fatalf("after re-post: kind=%q name=%q, want kind kept and name updated", d.Kind, d.Name)
	}
	if after := count(); after != before || after != 1 {
		t.Fatalf("browser device count %d -> %d", before, after)
	}
}
