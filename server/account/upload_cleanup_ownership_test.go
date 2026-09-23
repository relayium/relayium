package account

// Cleanup ownership of an upload session's blob (W-N36).
//
// The rule under test has two halves, and each test below pins one ordering of
// the race between them:
//
//   - the reaper never touches a blob from a list snapshot. It ends a session
//     with a CLEANUP CLAIM — one transaction that re-checks the row (including
//     that no stored file references its blob), queues the blob in
//     pending_node_deletes and deletes the row — and GC's drainPending is the
//     only thing that deletes a queued blob;
//   - a resumable finalize's stored-file insert carries its session id, and
//     inside the insert's own transaction refuses when that row is gone.
//
// Everything runs on the real SQLite store, the real handler, the real
// Service.ReapPendingUploads / SweepPairRooms and the real GC drain, with a
// logical clock. DELETEs to storage nodes are counted at central's node HTTP
// transport, so a DELETE is counted whoever issues it.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// cleanupDrain runs GC's drainPending at `at` against st — the one destroyer of
// queued blobs.
func cleanupDrain(h *pairHarness, st Store, at int64) {
	cleanupDrainCtx(context.Background(), h, st, at)
}

func cleanupDrainCtx(ctx context.Context, h *pairHarness, st Store, at int64) {
	(&GC{Store: st, Now: func() int64 { return at }, Log: log.New(io.Discard, "", 0),
		BlobFor: h.svc.blobFor}).drainPending(ctx)
}

// cleanupDeletes counts blob DELETEs central sends to any storage node.
type cleanupDeletes struct {
	inner http.RoundTripper
	n     atomic.Int32
}

func (c *cleanupDeletes) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/blob/") {
		c.n.Add(1)
	}
	return c.inner.RoundTrip(r)
}

func countCleanupDeletes(h *pairHarness) *cleanupDeletes {
	c := &cleanupDeletes{inner: h.svc.nodeHTTP.Transport}
	h.svc.nodeHTTP.Transport = c
	return c
}

// cleanupGate holds the goroutine that reaches it until the test releases it.
type cleanupGate struct {
	armed   atomic.Bool
	once    sync.Once
	relOnce sync.Once
	entered chan struct{}
	release chan struct{}
}

func newCleanupGate() *cleanupGate {
	return &cleanupGate{entered: make(chan struct{}), release: make(chan struct{})}
}

func (g *cleanupGate) pass() {
	if !g.armed.Load() {
		return
	}
	g.once.Do(func() { close(g.entered) })
	<-g.release
}

// open releases the gate; idempotent, so a test may release it early and the
// cleanup again.
func (g *cleanupGate) open() {
	g.relOnce.Do(func() { close(g.release) })
}

func (g *cleanupGate) waitEntered(t *testing.T, what string) {
	t.Helper()
	select {
	case <-g.entered:
	case <-time.After(10 * time.Second):
		t.Fatalf("%s never reached its gate", what)
	}
}

// cleanupStore is a pass-through Store with the gates and hooks these races
// need. Only the calls it names are touched; every write lands in the real store.
type cleanupStore struct {
	Store
	persist *cleanupGate // before a stored-file insert
	list    *cleanupGate // after the orphan list, with the snapshot in hand

	failOrphanList atomic.Bool

	mu             sync.Mutex
	afterClaimDone func() // once, after a successful ClaimUploadDone
	afterOrphans   func() // once, after a non-empty orphan list
}

// newCleanupStore also releases both gates when the test ends, so a test that
// fails while a request is held cannot leave the server blocked in Close.
func newCleanupStore(t *testing.T, inner Store) *cleanupStore {
	c := &cleanupStore{Store: inner, persist: newCleanupGate(), list: newCleanupGate()}
	t.Cleanup(func() {
		c.persist.open()
		c.list.open()
	})
	return c
}

func (c *cleanupStore) take(f *func()) func() {
	c.mu.Lock()
	defer c.mu.Unlock()
	g := *f
	*f = nil
	return g
}

func (c *cleanupStore) ClaimUploadDone(ctx context.Context, id string, now int64) (int64, int64, bool, error) {
	received, billed, ok, err := c.Store.ClaimUploadDone(ctx, id, now)
	if ok && err == nil {
		if f := c.take(&c.afterClaimDone); f != nil {
			f()
		}
	}
	return received, billed, ok, err
}

func (c *cleanupStore) ListOrphanDoneUploadSessions(ctx context.Context, before int64) ([]UploadSessionRow, error) {
	if c.failOrphanList.Load() {
		return nil, errInjected
	}
	rows, err := c.Store.ListOrphanDoneUploadSessions(ctx, before)
	if len(rows) > 0 {
		if f := c.take(&c.afterOrphans); f != nil {
			f()
		}
	}
	c.list.pass()
	return rows, err
}

func (c *cleanupStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
	c.persist.pass()
	return c.Store.CreateStoredFile(ctx, f)
}

func (c *cleanupStore) CreateStoredFileWithinStorageCaps(ctx context.Context, f StoredFile, now, userCap, globalCap int64) (StoredFileWrite, error) {
	c.persist.pass()
	return c.Store.CreateStoredFileWithinStorageCaps(ctx, f, now, userCap, globalCap)
}

// cleanupNode is a disk-backed storage node whose DELETE can be made to fail
// fast (503) or hang until the caller gives up.
type cleanupNode struct {
	*httptest.Server
	dir        string
	deleteMode atomic.Int32 // 0 ok, 1 503, 2 hang
}

func newCleanupNode(t *testing.T) *cleanupNode {
	t.Helper()
	dir := t.TempDir()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("node disk store: %v", err)
	}
	n := &cleanupNode{dir: dir}
	stop := make(chan struct{})
	n.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		switch r.Method {
		case http.MethodPatch:
			off, _ := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
			body, _ := io.ReadAll(r.Body)
			size, aerr := ds.Append(r.Context(), key, off, bytes.NewReader(body))
			if errors.Is(aerr, storage.ErrOffsetMismatch) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				fmt.Fprintf(w, `{"size":%d}`, size)
				return
			}
			if aerr != nil {
				http.Error(w, "append failed", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"size":%d}`, size)
		case http.MethodGet:
			rc, gerr := ds.Get(r.Context(), key)
			if gerr != nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			defer rc.Close()
			_, _ = io.Copy(w, rc)
		case http.MethodDelete:
			switch n.deleteMode.Load() {
			case 1:
				http.Error(w, "node refusing deletes", http.StatusServiceUnavailable)
				return
			case 2:
				select {
				case <-r.Context().Done():
				case <-stop:
				}
				return
			}
			_ = ds.Delete(r.Context(), key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(n.Server.Close)
	t.Cleanup(func() { close(stop) }) // runs first: releases a hung DELETE
	return n
}

// cleanupUpload uploads `size` bytes as one ordinary (non-pair) resumable upload
// and returns it with its blob key. It is not finalized.
func cleanupUpload(t *testing.T, h *pairHarness, size int) (uploadID, key string) {
	t.Helper()
	blob := bytes.Repeat([]byte("C"), size)
	uploadID = initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), size, 0)
	if code, got := patchChunk(t, h.ts, h.cookie, uploadID, blob, 0, size, size); code != 200 || got != int64(size) {
		t.Fatalf("patch: %d, %d bytes", code, got)
	}
	return uploadID, h.session(t, uploadID).BlobKey
}

// finalizeAsync runs a finalize on its own goroutine. No t here: a test's
// Fatal is not callable off its goroutine.
func finalizeAsync(h *pairHarness, uploadID string) <-chan int {
	out := make(chan int, 1)
	go func() {
		req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
		req.AddCookie(h.cookie)
		resp, err := h.ts.Client().Do(req)
		if err != nil {
			out <- -1
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		out <- resp.StatusCode
	}()
	return out
}

func awaitCode(t *testing.T, ch <-chan int, what string) int {
	t.Helper()
	select {
	case c := <-ch:
		return c
	case <-time.After(20 * time.Second):
		t.Fatalf("%s never answered", what)
		return 0
	}
}

// queuedFor returns the pending-delete rows naming key.
func queuedFor(t *testing.T, h *pairHarness, key string) []PendingNodeDelete {
	t.Helper()
	var out []PendingNodeDelete
	for _, p := range h.pendingDeletes(t) {
		if p.BlobKey == key {
			out = append(out, p)
		}
	}
	return out
}

func storedFilesFor(t *testing.T, h *pairHarness, key string) int {
	t.Helper()
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE blob_key = ?`, key).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func dailyEvents(t *testing.T, h *pairHarness) int {
	t.Helper()
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM upload_events WHERE user_id = ?`, h.userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func failQueueWrites(t *testing.T, h *pairHarness) (heal func()) {
	t.Helper()
	if _, err := h.store.db.Exec(`CREATE TRIGGER cleanup_queue_refuses BEFORE INSERT ON pending_node_deletes
		BEGIN SELECT RAISE(ABORT, 'injected queue write failure'); END`); err != nil {
		t.Fatal(err)
	}
	return func() {
		if _, err := h.store.db.Exec(`DROP TRIGGER cleanup_queue_refuses`); err != nil {
			t.Fatal(err)
		}
	}
}

// ---------------------------------------------------------------------------
// R1. The cleanup claim wins; the finalize persists afterwards.
// ---------------------------------------------------------------------------

// A finalize held past the idle TTL between its claim and its insert: the reaper
// claims the tombstone (blob queued, row gone), and the insert must then be
// refused rather than answer 200 for an object whose blob is going away. The
// bill for the bytes stays, the daily reservation is refunded, and the blob is
// deleted by the drain.
func TestALateFinalizeIsRefusedOnceCleanupOwnsItsBlob(t *testing.T) {
	for _, byo := range []bool{false, true} {
		t.Run("byo="+strconv.FormatBool(byo), func(t *testing.T) {
			h := newPairHarness(t)
			deletes := countCleanupDeletes(h)
			present := func(key string) bool { return h.blobExists(t, key) }
			if byo {
				node := newCleanupNode(t)
				h.registerOwnStorageNode(t, node.URL)
				present = func(key string) bool { return nodeBlobPresent(t, node.dir, key) }
			}
			const size = 700
			uploadID, key := cleanupUpload(t, h, size)
			if got := h.session(t, uploadID).NodeID != ""; got != byo {
				t.Fatalf("upload placed on a node = %v, want %v", got, byo)
			}
			wantMeter := int64(size)
			if byo {
				wantMeter = 0 // own-node uploads are never metered
			}

			st := newCleanupStore(t, h.store)
			h.svc.store = st
			st.persist.armed.Store(true)
			codeCh := finalizeAsync(h, uploadID)
			st.persist.waitEntered(t, "finalize")
			h.advance(pendingUploadTTL + 1)
			h.svc.ReapPendingUploads(h.now) // cleanup wins
			if n := deletes.n.Load(); n != 0 {
				t.Fatalf("the reaper sent %d DELETE(s); the drain is the only destroyer", n)
			}
			if q := queuedFor(t, h, key); len(q) != 1 || q[0].BillUserID != "" {
				t.Fatalf("after the claim the queue holds %+v, want one deletion-only row", q)
			}
			st.persist.open()
			code := awaitCode(t, codeCh, "finalize")

			if code != http.StatusInternalServerError {
				t.Fatalf("finalize after the claim = %d, want 500", code)
			}
			if n := storedFilesFor(t, h, key); n != 0 {
				t.Fatalf("%d stored file(s) point at a blob the queue owns", n)
			}
			if h.sessionExists(t, uploadID) {
				t.Fatal("the claimed session row came back")
			}
			if n := dailyEvents(t, h); n != 0 {
				t.Fatalf("the refused finalize kept %d daily-quota reservation(s)", n)
			}
			if got := h.uploadMetered(t); got != wantMeter {
				t.Fatalf("metered %d, want exactly %d (the bytes moved)", got, wantMeter)
			}
			if retry, _ := h.finalize(t, uploadID); retry != http.StatusNotFound {
				t.Fatalf("a retry after the refusal = %d, want 404", retry)
			}

			cleanupDrain(h, h.store, h.now)
			if present(key) {
				t.Fatal("the drain left the claimed blob on disk")
			}
			if q := queuedFor(t, h, key); len(q) != 0 {
				t.Fatalf("the queue row outlived a confirmed delete: %+v", q)
			}
			if got := h.uploadMetered(t); got != wantMeter {
				t.Fatalf("metered %d after the drain, want %d", got, wantMeter)
			}
		})
	}
}

// The pair-room variants. (a) The room closes while the finalize is held: the
// insert's room check comes before its session check, so the answer is still
// the 410 "room over" with its endPairRoomByID, not the reclaim's 500. (b) The
// room is joined, so it outlives the idle TTL, and only the orphan claim ran:
// 500, and the finalize itself sends no DELETE — a pair-room session's blob is
// not the handler's to delete.
func TestALateFinalizeInAPairRoomKeepsTheRoomAnswerAndDeletesNothing(t *testing.T) {
	t.Run("closed room answers 410", func(t *testing.T) {
		h := newPairHarness(t)
		ctx := context.Background()
		h.mintCode("515151", "")
		blob := bytes.Repeat([]byte("A"), 900)
		status, uploadID, _ := h.initPairUpload(t, "515151", len(blob), "")
		if status != 200 {
			t.Fatalf("init: %d", status)
		}
		if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
			t.Fatalf("patch: %d", got)
		}
		sess := h.session(t, uploadID)

		st := newCleanupStore(t, h.store)
		h.svc.store = st
		st.persist.armed.Store(true)
		codeCh := finalizeAsync(h, uploadID)
		st.persist.waitEntered(t, "finalize")
		h.advance(pairRoomJoinWindow + 1)
		h.svc.SweepPairRooms(ctx, h.now) // the deadline passes with nobody joined: void
		room, found, err := h.store.GetPairRoom(ctx, sess.PairRoomID)
		if err != nil || !found || room.ClosedAt == 0 {
			t.Fatalf("the sweep did not void the room: found=%v closed=%d err=%v", found, room.ClosedAt, err)
		}
		st.persist.open()
		code := awaitCode(t, codeCh, "finalize")

		if code != http.StatusGone {
			t.Fatalf("finalize into a room closed under it = %d, want 410", code)
		}
		if n := storedFilesFor(t, h, sess.BlobKey); n != 0 {
			t.Fatalf("%d object(s) landed in a closed room", n)
		}
		if n := dailyEvents(t, h); n != 0 {
			t.Fatalf("the refused finalize kept %d daily-quota reservation(s)", n)
		}
		if got := h.uploadMetered(t); got != int64(len(blob)) {
			t.Fatalf("metered %d, want exactly %d", got, len(blob))
		}
	})

	t.Run("joined room past the TTL answers 500", func(t *testing.T) {
		h := newPairHarness(t)
		deletes := countCleanupDeletes(h)
		node := newCommitThenFailNode(t)
		h.registerStorageNode(t, node.URL)
		uploadID := h.initOnNode(t, "525252")
		blob := bytes.Repeat([]byte("B"), 1100)
		if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
			t.Fatalf("patch: %d", got)
		}
		sess := h.session(t, uploadID)

		st := newCleanupStore(t, h.store)
		h.svc.store = st
		st.persist.armed.Store(true)
		codeCh := finalizeAsync(h, uploadID)
		st.persist.waitEntered(t, "finalize")
		h.joinRoom(t, "525252") // a joined room has no deadline
		h.advance(pendingUploadTTL + 1)
		h.svc.ReapPendingUploads(h.now)
		if h.sessionExists(t, uploadID) {
			t.Fatal("the orphan pass did not claim the idle tombstone")
		}
		before := deletes.n.Load()
		if before != 0 {
			t.Fatalf("the reaper sent %d DELETE(s)", before)
		}
		st.persist.open()
		code := awaitCode(t, codeCh, "finalize")

		if code != http.StatusInternalServerError {
			t.Fatalf("finalize after the claim in an open room = %d, want 500", code)
		}
		if n := deletes.n.Load() - before; n != 0 {
			t.Fatalf("the refused pair-room finalize sent %d DELETE(s) itself", n)
		}
		if !nodeBlobPresent(t, node.dir, sess.BlobKey) {
			t.Fatal("the blob went before the drain")
		}
		if q := queuedFor(t, h, sess.BlobKey); len(q) != 1 || q[0].BillUserID != "" {
			t.Fatalf("queue = %+v, want one deletion-only row", q)
		}
		if n := storedFilesFor(t, h, sess.BlobKey); n != 0 {
			t.Fatalf("%d stored file(s) point at a claimed blob", n)
		}
		if n := dailyEvents(t, h); n != 0 {
			t.Fatalf("the refused finalize kept %d daily-quota reservation(s)", n)
		}
		if got := h.uploadMetered(t); got != int64(len(blob)) {
			t.Fatalf("metered %d, want exactly %d", got, len(blob))
		}
		if room := h.roomFor(t, "525252"); room.ClosedAt != 0 {
			t.Fatalf("the refusal closed a joined room: %+v", room)
		}

		cleanupDrain(h, h.store, h.now)
		if nodeBlobPresent(t, node.dir, sess.BlobKey) {
			t.Fatal("the drain left the claimed blob on the node")
		}
		if q := queuedFor(t, h, sess.BlobKey); len(q) != 0 {
			t.Fatalf("the queue row outlived a confirmed delete: %+v", q)
		}
		if got := h.uploadMetered(t); got != int64(len(blob)) {
			t.Fatalf("metered %d after the drain, want %d", got, len(blob))
		}
	})
}

// ---------------------------------------------------------------------------
// R2. The finalize wins; the reaper resumes from a stale snapshot.
// ---------------------------------------------------------------------------

// The orphan pass lists a tombstone, then waits; the finalize commits its
// object; the pass resumes holding a row that is no longer an orphan. The claim
// re-reads stored_files inside its transaction, so nothing is queued and
// nothing is deleted — now, or on any later sweep, including the purge that
// collects the tombstone.
func TestAStaleCleanupSnapshotNeverTakesALiveObjectsBlob(t *testing.T) {
	for _, byo := range []bool{false, true} {
		t.Run("byo="+strconv.FormatBool(byo), func(t *testing.T) {
			h := newPairHarness(t)
			deletes := countCleanupDeletes(h)
			present := func(key string) bool { return h.blobExists(t, key) }
			if byo {
				node := newCleanupNode(t)
				h.registerOwnStorageNode(t, node.URL)
				present = func(key string) bool { return nodeBlobPresent(t, node.dir, key) }
			}
			const size = 700
			uploadID, key := cleanupUpload(t, h, size)

			st := newCleanupStore(t, h.store)
			h.svc.store = st
			st.persist.armed.Store(true)
			codeCh := finalizeAsync(h, uploadID)
			st.persist.waitEntered(t, "finalize")
			h.advance(pendingUploadTTL + 1)
			st.list.armed.Store(true)
			reaped := make(chan struct{})
			reapAt := h.now
			go func() { defer close(reaped); h.svc.ReapPendingUploads(reapAt) }()
			st.list.waitEntered(t, "the orphan pass")
			st.persist.open() // the finalize commits first
			code := awaitCode(t, codeCh, "finalize")
			st.list.open() // the reaper resumes from its snapshot
			select {
			case <-reaped:
			case <-time.After(20 * time.Second):
				t.Fatal("the reaper never finished")
			}

			if code != http.StatusOK {
				t.Fatalf("finalize = %d, want 200 (it committed first)", code)
			}
			if n := storedFilesFor(t, h, key); n != 1 {
				t.Fatalf("%d stored files for the blob, want 1", n)
			}
			check := func(when string) {
				t.Helper()
				if !present(key) {
					t.Fatalf("%s: a live object's blob was deleted", when)
				}
				if q := queuedFor(t, h, key); len(q) != 0 {
					t.Fatalf("%s: a live object's blob was queued for deletion: %+v", when, q)
				}
				if n := deletes.n.Load(); n != 0 {
					t.Fatalf("%s: %d DELETE(s) against a live object", when, n)
				}
			}
			check("after the stale snapshot")
			// Later sweeps: the tombstone is idle past the TTL again and the purge
			// collects it. The blob is the live object's; neither may queue it.
			h.svc.store = h.store
			h.advance(pendingUploadTTL + 1)
			h.svc.ReapPendingUploads(h.now)
			cleanupDrain(h, h.store, h.now)
			if h.sessionExists(t, uploadID) {
				t.Fatal("the referenced tombstone was never collected")
			}
			check("after the purge and a drain")
			if n := storedFilesFor(t, h, key); n != 1 {
				t.Fatalf("%d stored files after the sweeps, want 1", n)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// R3. A queue write that fails leaves the row owning the blob, with no I/O.
// ---------------------------------------------------------------------------

func TestAFailedCleanupClaimLeavesTheSessionOwningItsBlob(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	deletes := countCleanupDeletes(h)
	node := newCleanupNode(t)
	h.registerOwnStorageNode(t, node.URL)
	uploadID, key := cleanupUpload(t, h, 600)
	// A finalize that crashed after its claim: the tombstone owns an orphan blob.
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, uploadID, h.now); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	heal := failQueueWrites(t, h)
	node.deleteMode.Store(1) // and a node refusing deletes
	h.advance(pendingUploadTTL + 1)
	h.svc.ReapPendingUploads(h.now)
	cleanupDrain(h, h.store, h.now)

	if n := deletes.n.Load(); n != 0 {
		t.Fatalf("%d DELETE(s) before any durable cleanup ownership existed", n)
	}
	if !h.sessionExists(t, uploadID) {
		t.Fatal("the session row went although its blob was never handed to the queue")
	}
	if !nodeBlobPresent(t, node.dir, key) {
		t.Fatal("the blob went")
	}
	if q := queuedFor(t, h, key); len(q) != 0 {
		t.Fatalf("queue = %+v under a failing queue write", q)
	}

	heal()
	node.deleteMode.Store(0)
	h.advance(600)
	h.svc.ReapPendingUploads(h.now)
	if h.sessionExists(t, uploadID) {
		t.Fatal("the healed sweep did not claim the tombstone")
	}
	if !nodeBlobPresent(t, node.dir, key) {
		t.Fatal("the reaper deleted the blob itself")
	}
	if q := queuedFor(t, h, key); len(q) != 1 || q[0].BillUserID != "" {
		t.Fatalf("after the healed claim the queue holds %+v, want one deletion-only row", q)
	}
	cleanupDrain(h, h.store, h.now)
	if nodeBlobPresent(t, node.dir, key) || len(queuedFor(t, h, key)) != 0 {
		t.Fatalf("after the drain: blob=%v queue=%+v, want both gone",
			nodeBlobPresent(t, node.dir, key), queuedFor(t, h, key))
	}
}

// ---------------------------------------------------------------------------
// R4. A node whose DELETE never answers: the drain's delete is bounded by its
// sweep, and the blob stays queued until the node comes back.
// ---------------------------------------------------------------------------

func TestAClaimedBlobWhoseNodeHangsStaysQueuedUntilItAnswers(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	deletes := countCleanupDeletes(h)
	node := newCleanupNode(t)
	h.registerOwnStorageNode(t, node.URL)
	uploadID, key := cleanupUpload(t, h, 600)
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, uploadID, h.now); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	node.deleteMode.Store(2)
	h.advance(pendingUploadTTL + 1)
	start := time.Now()
	h.svc.ReapPendingUploads(h.now)
	if n := deletes.n.Load(); n != 0 {
		t.Fatalf("the reaper sent %d DELETE(s)", n)
	}
	if h.sessionExists(t, uploadID) || len(queuedFor(t, h, key)) != 1 {
		t.Fatalf("after the reaper: row=%v queue=%+v, want row gone and one queue row",
			h.sessionExists(t, uploadID), queuedFor(t, h, key))
	}
	dctx, cancel := context.WithTimeout(ctx, time.Second)
	cleanupDrainCtx(dctx, h, h.store, h.now)
	cancel()
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Fatalf("a hung DELETE held the sweep for %v", elapsed)
	}
	if deletes.n.Load() == 0 {
		t.Fatal("the drain never attempted the delete")
	}
	if !nodeBlobPresent(t, node.dir, key) || len(queuedFor(t, h, key)) != 1 {
		t.Fatalf("after the hung drain: blob=%v queue=%+v, want blob kept and still queued",
			nodeBlobPresent(t, node.dir, key), queuedFor(t, h, key))
	}
	node.deleteMode.Store(0)
	cleanupDrain(h, h.store, h.now)
	if nodeBlobPresent(t, node.dir, key) || len(queuedFor(t, h, key)) != 0 {
		t.Fatalf("after the node answered: blob=%v queue=%+v, want both gone",
			nodeBlobPresent(t, node.dir, key), queuedFor(t, h, key))
	}
}

// ---------------------------------------------------------------------------
// R5'. A retirement hold already on the key survives the claim.
// ---------------------------------------------------------------------------

// A completion deleted a pair-room object with a hold and left its tombstone.
// The claim's upsert keeps the hold; the reaper deletes nothing; the drain
// deletes the blob, stamps deleted_at, and retires the row only after the hold.
func TestAHoldOnTheKeySurvivesTheCleanupClaim(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	deletes := countCleanupDeletes(h)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "545454")
	blob := bytes.Repeat([]byte("Z"), 2000)
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	sess := h.session(t, uploadID)
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, sess.ID, h.now); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	h.advance(pendingUploadTTL + 1)
	hold := h.now + 5000
	if err := enqueueNodeDeleteOn(ctx, h.store.db, sess.BlobKey, sess.NodeID, h.now, hold); err != nil {
		t.Fatal(err)
	}
	h.svc.ReapPendingUploads(h.now)

	q := queuedFor(t, h, sess.BlobKey)
	if len(q) != 1 || q[0].NotBefore != hold {
		t.Fatalf("after the claim the queue holds %+v, want the hold %d kept", q, hold)
	}
	if h.sessionExists(t, uploadID) {
		t.Fatal("the tombstone was not claimed")
	}
	if n := deletes.n.Load(); n != 0 {
		t.Fatalf("the reaper sent %d DELETE(s)", n)
	}
	cleanupDrain(h, h.store, h.now)
	q = queuedFor(t, h, sess.BlobKey)
	if nodeBlobPresent(t, node.dir, sess.BlobKey) || len(q) != 1 || q[0].DeletedAt == 0 {
		t.Fatalf("inside the hold: blob=%v queue=%+v, want the blob gone and the row kept and stamped",
			nodeBlobPresent(t, node.dir, sess.BlobKey), q)
	}
	h.advance(5001)
	cleanupDrain(h, h.store, h.now)
	if q := queuedFor(t, h, sess.BlobKey); len(q) != 0 {
		t.Fatalf("the row was not retired after the hold: %+v", q)
	}
}

// ---------------------------------------------------------------------------
// R6. The purge is a set-based claim.
// ---------------------------------------------------------------------------

// With the orphan list failing, the end-of-sweep purge is what reaches the
// tombstones. An unreferenced one's blob is queued in the transaction that
// deletes its row; a referenced one's row just goes, its blob untouched and
// unqueued. With the queue write failing too, the purge commits nothing.
func TestThePurgeQueuesWhatTheOrphanPassMissed(t *testing.T) {
	stage := func(t *testing.T) (h *pairHarness, node *cleanupNode, st *cleanupStore, orphanID, orphanKey, liveID, liveKey string) {
		h = newPairHarness(t)
		node = newCleanupNode(t)
		h.registerOwnStorageNode(t, node.URL)
		orphanID, orphanKey = cleanupUpload(t, h, 500)
		if _, _, ok, err := h.store.ClaimUploadDone(context.Background(), orphanID, h.now); err != nil || !ok {
			t.Fatalf("claim: ok=%v err=%v", ok, err)
		}
		liveID, liveKey = cleanupUpload(t, h, 400)
		if code, _ := h.finalize(t, liveID); code != 200 {
			t.Fatalf("finalize the live object: %d", code)
		}
		st = newCleanupStore(t, h.store)
		st.failOrphanList.Store(true)
		h.svc.store = st
		h.advance(pendingUploadTTL + 1)
		return
	}

	t.Run("queues the unreferenced, not the referenced", func(t *testing.T) {
		h, node, _, orphanID, orphanKey, liveID, liveKey := stage(t)
		deletes := countCleanupDeletes(h)
		h.svc.ReapPendingUploads(h.now)
		if h.sessionExists(t, orphanID) || h.sessionExists(t, liveID) {
			t.Fatalf("the purge left rows: orphan=%v live=%v", h.sessionExists(t, orphanID), h.sessionExists(t, liveID))
		}
		if q := queuedFor(t, h, orphanKey); len(q) != 1 || q[0].BillUserID != "" || q[0].EnqueuedAt != h.now {
			t.Fatalf("the unreferenced blob's queue = %+v, want one deletion-only row enqueued at %d", q, h.now)
		}
		if q := queuedFor(t, h, liveKey); len(q) != 0 {
			t.Fatalf("the purge queued a live object's blob: %+v", q)
		}
		if n := deletes.n.Load(); n != 0 {
			t.Fatalf("the reaper sent %d DELETE(s)", n)
		}
		if !nodeBlobPresent(t, node.dir, orphanKey) || !nodeBlobPresent(t, node.dir, liveKey) {
			t.Fatal("a blob went before the drain")
		}
		cleanupDrain(h, h.store, h.now)
		if nodeBlobPresent(t, node.dir, orphanKey) || len(queuedFor(t, h, orphanKey)) != 0 {
			t.Fatal("the drain did not delete and retire the purged orphan")
		}
		if !nodeBlobPresent(t, node.dir, liveKey) || storedFilesFor(t, h, liveKey) != 1 {
			t.Fatal("the live object lost its blob")
		}
	})

	t.Run("a failed queue write keeps both rows", func(t *testing.T) {
		h, node, _, orphanID, orphanKey, liveID, liveKey := stage(t)
		heal := failQueueWrites(t, h)
		defer heal()
		h.svc.ReapPendingUploads(h.now)
		if !h.sessionExists(t, orphanID) || !h.sessionExists(t, liveID) {
			t.Fatalf("a purge whose queue write failed still deleted rows: orphan=%v live=%v",
				h.sessionExists(t, orphanID), h.sessionExists(t, liveID))
		}
		if len(queuedFor(t, h, orphanKey)) != 0 || len(queuedFor(t, h, liveKey)) != 0 {
			t.Fatal("rows queued under a failing queue write")
		}
		if !nodeBlobPresent(t, node.dir, orphanKey) || !nodeBlobPresent(t, node.dir, liveKey) {
			t.Fatal("a blob went")
		}
	})
}

// ---------------------------------------------------------------------------
// R8–R10. Billing evidence: a pair-room void's obligation is settled before its
// blob is destroyed, whatever else is in flight.
// ---------------------------------------------------------------------------

// settleThenHeal drives the GC with every billing write failing, then healed.
// While failing: zero DELETEs, the blob and its obligation row kept. Healed: the
// exact residual billed once, the blob deleted, and a later sweep bills nothing.
func settleThenHeal(t *testing.T, h *pairHarness, flaky *flakyStore, deletes *cleanupDeletes,
	node *commitThenFailNode, key string, known, onNode int64) {
	t.Helper()
	ctx := context.Background()
	g := &GC{Store: flaky, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0), BlobFor: h.svc.blobFor}
	g.sweep(ctx)
	g.sweep(ctx)
	if n := deletes.n.Load(); n != 0 {
		t.Fatalf("%d DELETE(s) while the obligation was not durable", n)
	}
	if !nodeBlobPresent(t, node.dir, key) {
		t.Fatalf("evidence destroyed: the blob is gone with a %d-byte residual unbilled", onNode-known)
	}
	q := queuedFor(t, h, key)
	if len(q) != 1 || q[0].BillUserID != h.userID || q[0].BilledThrough != known {
		t.Fatalf("obligation row = %+v, want one billing %q through %d", q, h.userID, known)
	}
	if got := h.uploadMetered(t); got != known {
		t.Fatalf("metered %d while billing fails, want the confirmed %d", got, known)
	}
	flaky.failNext("SettleBlobBilling", 0)
	flaky.failNext("JournalBlobBilling", 0)
	g.sweep(ctx)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("metered %d after the heal, want exactly %d", got, onNode)
	}
	if nodeBlobPresent(t, node.dir, key) {
		t.Fatal("the blob survived the sweep that settled its bill")
	}
	if deletes.n.Load() < 1 {
		t.Fatal("no DELETE after the heal")
	}
	g.sweep(ctx)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("a second healed sweep re-billed: %d, want %d", got, onNode)
	}
	// The row may still be inside the void's hold; if so, its floor records the
	// whole bill, which is what makes every later sweep bill nothing.
	if q := queuedFor(t, h, key); len(q) > 1 || (len(q) == 1 && q[0].BilledThrough != onNode) {
		t.Fatalf("after the heal the queue holds %+v, want it retired or its floor at %d", q, onNode)
	}
}

// R8. A finalize has claimed its pair-room session; the room is voided by the
// deadline sweep before the finalize reaches its room check, with every billing
// write failing, so the void keeps the blob as its obligation's evidence. The
// finalize answers 410 — and must not delete that evidence on its way out.
func TestARefusedPairFinalizeLeavesTheVoidsBillingEvidence(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	deletes := countCleanupDeletes(h)
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "585858")
	key := h.session(t, uploadID).BlobKey
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)
	flaky := h.withFlakyStore(t)
	flaky.failNext("SettleBlobBilling", -1)
	flaky.failNext("JournalBlobBilling", -1)
	st := newCleanupStore(t, flaky)
	st.afterClaimDone = func() {
		h.advance(pairRoomJoinWindow + 1)
		h.svc.SweepPairRooms(ctx, h.now)
	}
	h.svc.store = st
	if code, _ := h.finalize(t, uploadID); code != http.StatusGone {
		t.Fatalf("finalize = %d, want 410 (room over)", code)
	}
	if n := deletes.n.Load(); n != 0 {
		t.Fatalf("the refused finalize sent %d DELETE(s) against obligated evidence", n)
	}
	settleThenHeal(t, h, flaky, deletes, node, key, known, onNode)
}

// R9. The orphan pass lists a pair-room tombstone; before it acts, the room is
// voided (obligation written, row deleted, billing failing). The reaper resumes
// from its stale snapshot and must not touch the blob.
func TestAStaleOrphanSnapshotLeavesTheVoidsBillingEvidence(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	deletes := countCleanupDeletes(h)
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "595959")
	sess := h.session(t, uploadID)
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, sess.ID, h.now); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err) // a finalize that crashed after its claim
	}
	flaky := h.withFlakyStore(t)
	flaky.failNext("SettleBlobBilling", -1)
	flaky.failNext("JournalBlobBilling", -1)
	st := newCleanupStore(t, flaky)
	st.afterOrphans = func() { h.svc.SweepPairRooms(ctx, h.now) }
	h.svc.store = st
	h.advance(pendingUploadTTL + 1)
	h.svc.ReapPendingUploads(h.now)
	if st.take(&st.afterOrphans) != nil {
		t.Fatal("the orphan pass never listed the tombstone; the race was not staged")
	}
	if n := deletes.n.Load(); n != 0 {
		t.Fatalf("the reaper sent %d DELETE(s) from its stale snapshot", n)
	}
	settleThenHeal(t, h, flaky, deletes, node, sess.BlobKey, known, onNode)
}

// R10. Claim first, void second: the void no longer sees the session, so no
// obligation can attach to the deletion-only row the claim created.
func TestAVoidAfterTheCleanupClaimAttachesNoObligation(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	deletes := countCleanupDeletes(h)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "535353")
	blob := bytes.Repeat([]byte("Q"), 3000)
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	sess := h.session(t, uploadID)
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, sess.ID, h.now); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	metered := h.uploadMetered(t)
	h.advance(pendingUploadTTL + 1)
	h.svc.ReapPendingUploads(h.now)
	if n := deletes.n.Load(); n != 0 {
		t.Fatalf("the reaper sent %d DELETE(s)", n)
	}
	h.svc.SweepPairRooms(ctx, h.now) // the room's deadline has long passed
	q := queuedFor(t, h, sess.BlobKey)
	if len(q) != 1 || q[0].BillUserID != "" {
		t.Fatalf("after the claim and the void the queue holds %+v, want one deletion-only row", q)
	}
	cleanupDrain(h, h.store, h.now)
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("the blob survived the drain")
	}
	if q := queuedFor(t, h, sess.BlobKey); len(q) != 0 {
		t.Fatalf("a deletion-only row outlived its confirmed delete: %+v", q)
	}
	if got := h.uploadMetered(t); got != metered {
		t.Fatalf("metered %d, want the unchanged %d", got, metered)
	}
}
