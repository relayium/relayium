package account

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// Fourth adversarial suite: the two things a room's void races against a REAL
// storage node, held open on purpose so the interleaving is the one the
// production code has to survive rather than the one the scheduler happens to
// pick.
//
//  1. An append that is already streaming when the void deletes the blob. It
//     lands afterwards and RE-CREATES the key, at a moment when nothing central
//     holds points at it: the session row is gone, no stored_files row was ever
//     written, and no generic sweep has anything to find it by. Every byte it
//     leaves is unreferenced ciphertext on somebody's disk, forever.
//  2. A void whose physical work cannot finish inside its budget, because every
//     node it has to talk to is unreachable or simply never answers.
//
// Both are written against an httptest node speaking the real blob protocol —
// PATCH with X-Blob-Offset, DELETE — because both are about the ORDER in which
// central's HTTP calls reach a node and what is on that node's disk afterwards.
// A store-level simulation of the commit cannot hold either of them.

// heldPatchNode is a storage node whose write can be suspended AFTER the request
// has arrived and its body has been read, and released later.
//
// The hold is deliberately placed between reading the body and writing it: a
// node that holds its per-key lock across the whole copy would serialize
// central's DELETE behind the append and hide the race, and central must not be
// relying on any node's internal locking for a property of its own. Real nodes
// buffer, queue, retry and run on filesystems with their own ordering; this one
// simply makes the losing order reachable.
type heldPatchNode struct {
	*httptest.Server
	dir string
	ds  *storage.DiskStore
	// hold, when non-nil, suspends the next non-empty append until it is closed.
	// started fires once that append has arrived and read its body.
	hold    chan struct{}
	started chan struct{}
	// events records what the node was asked to do, in order, so a test can
	// assert the interleaving it staged actually happened.
	events chan string
}

func newHeldPatchNode(t *testing.T) *heldPatchNode {
	t.Helper()
	dir := t.TempDir()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("node disk store: %v", err)
	}
	n := &heldPatchNode{dir: dir, ds: ds, events: make(chan string, 32)}
	n.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		switch r.Method {
		case http.MethodPatch:
			off, _ := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
			body, _ := io.ReadAll(r.Body)
			if len(body) > 0 && n.hold != nil {
				n.events <- "append-arrived"
				close(n.started)
				<-n.hold // ...and central's void runs to completion in here
				n.events <- "append-writes"
			}
			size, aerr := n.ds.Append(r.Context(), key, off, bytes.NewReader(body))
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
			rc, gerr := n.ds.Get(r.Context(), key)
			if gerr != nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			defer rc.Close()
			_, _ = io.Copy(w, rc)
		case http.MethodDelete:
			n.events <- "delete"
			_ = n.ds.Delete(r.Context(), key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(n.Server.Close)
	return n
}

// order drains what the node was asked to do.
func (n *heldPatchNode) order() []string {
	var out []string
	for {
		select {
		case e := <-n.events:
			out = append(out, e)
		default:
			return out
		}
	}
}

// nodeBlobPresent reports whether the key exists on the node's disk AT ALL —
// which "size 0" does not answer, because an append at a stale offset creates an
// empty file before it refuses.
func nodeBlobPresent(t *testing.T, dir, key string) bool {
	t.Helper()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("node disk store: %v", err)
	}
	rc, err := ds.Get(context.Background(), key)
	if err != nil {
		return false
	}
	rc.Close()
	return true
}

// THE RACE, end to end, against a real node.
//
// A PATCH arrives and is held. The room times out and its void runs the whole
// way through — the session row settled and deleted, the blob DELETEd on the
// node — and only then is the PATCH released, so its write lands on a key
// central has already reclaimed and re-creates it.
//
// What used to happen: the 410 was returned and nothing else. The DELETE had
// succeeded, so there was no pending_node_deletes row; the session row was gone,
// so the orphan pass had nothing to enumerate; no stored_files row was ever
// created. The bytes stayed on the node forever, referenced by nothing and
// findable by nothing.
func TestAnAppendReleasedAfterTheVoidsDeleteLeavesNothingOnTheNode(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newHeldPatchNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "818181")
	sess := h.session(t, uploadID)
	billedBefore := h.uploadMetered(t)

	// Offset 0 on purpose: an append whose offset no longer matches what the node
	// holds is refused and leaves an empty file, which is a leak of a file but not
	// of bytes. The FIRST chunk is the case that re-creates real ciphertext.
	blob := bytes.Repeat([]byte("R"), 4096)
	node.hold = make(chan struct{})
	node.started = make(chan struct{})
	done := make(chan int, 1)
	go func() { done <- h.patch(t, uploadID, blob, 0, len(blob), len(blob)) }()

	select {
	case <-node.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the append never reached the node")
	}

	// Nobody joined. The void runs to completion while the append is suspended
	// mid-write: this is the whole point of holding it.
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)
	if h.sessionExists(t, uploadID) {
		t.Fatal("the void did not remove the session row")
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("the void did not delete the blob before the append was released")
	}

	close(node.hold)
	var status int
	select {
	case status = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the released append never returned")
	}

	if status != 410 {
		t.Fatalf("an append into a room that was voided under it: %d, want 410", status)
	}
	// THE ASSERTION. The node's disk holds nothing for this key: not the 4096
	// bytes the released append wrote, not an empty file, nothing.
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatalf("the released append left %d bytes on the node that nothing references and nothing would ever collect",
			nodeBlobSize(t, node.dir, sess.BlobKey))
	}
	// The interleaving really was the losing one — otherwise this test proves
	// nothing at all.
	got := node.order()
	del, write := eventIndex(got, "delete"), eventIndex(got, "append-writes")
	if del < 0 || write < 0 || del > write {
		t.Fatalf("the staged race did not happen: node saw %v, want the DELETE before the append's write", got)
	}
	// Every byte that crossed the wire is billed, including these — they moved,
	// they simply bought no deadline and no object.
	if got := h.uploadMetered(t); got != billedBefore+int64(len(blob)) {
		t.Fatalf("billed %d, want %d — bytes that crossed the wire after a void are still bytes that crossed the wire",
			got, billedBefore+int64(len(blob)))
	}
	// ...and the responsibility that would have caught this if the process had
	// died between the append and the cleanup is on disk, not in memory.
	assertQueuedForDeletion(t, h, sess.BlobKey)
}

// The same race, with the append released at an offset the node no longer
// holds — the ordinary shape once any chunk has committed. The append is refused
// by the node's own offset check, but the file it opened on the way is still a
// file, and it must not survive either.
func TestAReleasedAppendAtAStaleOffsetLeavesNoEmptyBlobEither(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newHeldPatchNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "828282")
	sess := h.session(t, uploadID)

	blob := bytes.Repeat([]byte("S"), 4096)
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("first chunk: %d", got)
	}
	billed := h.uploadMetered(t)

	node.hold = make(chan struct{})
	node.started = make(chan struct{})
	done := make(chan int, 1)
	go func() { done <- h.patch(t, uploadID, blob, 2048, 4096, len(blob)) }()
	select {
	case <-node.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the append never reached the node")
	}

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)
	close(node.hold)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the released append never returned")
	}

	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("a refused append re-opened the reclaimed blob and the empty file was left behind")
	}
	// Nothing landed, so nothing more is owed: a refused append bills nothing.
	if got := h.uploadMetered(t); got != billed {
		t.Fatalf("billed %d for an append the node refused, want %d", got, billed)
	}
}

// eventIndex locates one thing the node was asked to do, -1 when it never was.
func eventIndex(xs []string, want string) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}

// The close can only take the sessions it can SEE, so nothing may bind a new one
// to a room that is already closed.
//
// The window is real: init resolves the room in one statement and inserts the
// session in another, and the room can end in between. A session inserted after
// its room's void has run is the one row nothing would ever enumerate again — it
// would hold one of the account's open-session slots, and any blob it went on to
// accept, until the generic one-hour reaper.
func TestASessionCannotBeBoundToARoomThatHasAlreadyClosed(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, err := st.UpsertUserByEmail(ctx, "bind@example.com", "B")
	if err != nil {
		t.Fatalf("user: %v", err)
	}
	room := PairRoom{ID: "room-bind", Code: "848484", UserID: u.ID,
		CreatedAt: 1000, ExpiresAt: 1000 + pairRoomJoinWindow}
	if _, created, err := st.CreatePairRoomIfAbsent(ctx, room); err != nil || !created {
		t.Fatalf("create room: created=%v err=%v", created, err)
	}
	row := UploadSessionRow{ID: "sess-bind", UserID: u.ID, BlobKey: "key-bind",
		PairRoomID: room.ID, Purpose: StoredPurposePairRoom, CreatedAt: 1100}

	// While the room is open the insert is ordinary.
	if ok, err := st.CreateUploadSession(ctx, row, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("insert into an open room: ok=%v err=%v", ok, err)
	}

	if _, err := st.ClosePairRoom(ctx, room.ID, 1200, 1200+pairRoomBlobHold); err != nil {
		t.Fatalf("close: %v", err)
	}
	second := row
	second.ID, second.BlobKey = "sess-late", "key-late"
	if _, err := st.CreateUploadSession(ctx, second, maxSessionsPerUser); !errors.Is(err, ErrPairRoomClosed) {
		t.Fatalf("insert into a closed room: %v, want ErrPairRoomClosed", err)
	}
	if _, ok, err := st.GetUploadSession(ctx, second.ID, u.ID); err != nil || ok {
		t.Fatalf("a session was stored for a closed room: ok=%v err=%v", ok, err)
	}

	// ...and the same for a room that is merely past its deadline: nothing has
	// closed it yet, but it is over, and a void that has not run yet is still a
	// void that will not see this row.
	open := PairRoom{ID: "room-late", Code: "858585", UserID: u.ID,
		CreatedAt: 1000, ExpiresAt: 1000 + pairRoomJoinWindow}
	if _, created, err := st.CreatePairRoomIfAbsent(ctx, open); err != nil || !created {
		t.Fatalf("create the second room: created=%v err=%v", created, err)
	}
	third := row
	third.ID, third.BlobKey, third.PairRoomID = "sess-expired", "key-expired", open.ID
	third.CreatedAt = open.ExpiresAt + 1
	if _, err := st.CreateUploadSession(ctx, third, maxSessionsPerUser); !errors.Is(err, ErrPairRoomClosed) {
		t.Fatalf("insert into an expired room: %v, want ErrPairRoomClosed", err)
	}
}

// stallingNode answers nothing, ever, until the test lets it go: every request
// blocks. It is the worst case the reclaim budget exists for — not a node that
// refuses quickly, which is easy, but one that simply never replies.
//
// It COUNTS what reached it, and that counter is load-bearing: a test that
// believes it has made a node unreachable and has in fact left every upload
// pointing at a healthy one looks identical from the outside — same assertions,
// same pass — except that nothing ever knocks on this door.
type stallingNode struct {
	*httptest.Server
	hits atomic.Int64
}

func newStallingNode(t *testing.T) (*stallingNode, chan struct{}) {
	t.Helper()
	release := make(chan struct{})
	n := &stallingNode{}
	n.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.hits.Add(1)
		select {
		case <-release:
		case <-r.Context().Done():
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		n.Server.Close()
	})
	return n, release
}

// THE BUDGET. Several uploads in one room, and by the time its deadline passes
// the node holding all of them has stopped answering. The physical work cannot
// finish — not "is slow", cannot finish — and the room's promise must not depend
// on it.
//
// What used to happen: the void reclaimed sessions one at a time under a single
// ten-second budget, checking it between them, and returned as soon as it ran
// out. Every session it had not reached kept its row, its share of the account's
// open-session budget, and its ciphertext, until the generic one-hour reaper.
// Which sessions those were depended on nothing but map order.
func TestAVoidFreesEveryRowAndQueuesEveryBlobWhenNoNodeAnswers(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newCommitThenFailNode(t)
	nodeID := h.registerStorageNode(t, node.URL)
	h.mintCode("838383", "")

	// Three uploads in one room, each with bytes committed and billed, plus one
	// object that finished.
	const per = 1024
	blob := bytes.Repeat([]byte("M"), per)
	var uploads []string
	var keys []string
	for i := 0; i < 3; i++ {
		status, uploadID, _ := h.initPairUpload(t, "838383", per, "")
		if status != 200 {
			t.Fatalf("init %d: %d", i, status)
		}
		if got := h.patch(t, uploadID, blob, 0, per/2, per); got != 200 {
			t.Fatalf("chunk %d: %d", i, got)
		}
		uploads = append(uploads, uploadID)
		keys = append(keys, h.session(t, uploadID).BlobKey)
	}
	billed := h.uploadMetered(t)
	if billed != 3*per/2 {
		t.Fatalf("billed %d for the chunks that landed, want %d", billed, 3*per/2)
	}

	// Now every node call hangs. The blobs are real and on disk; nothing central
	// can reach them, and nothing can be told to delete them.
	//
	// THE EXISTING node is moved, not a new one added. Every session above holds
	// this node's id, so inserting a second node at the stalling address would
	// leave all three uploads pointing at a machine that answers instantly — the
	// void would finish in microseconds, every assertion below would still pass,
	// and the exhausted-budget path this test is named for would never run.
	stall, _ := newStallingNode(t)
	h.pointStorageNodeAt(t, nodeID, stall.URL)
	// A budget far too small to finish even one artifact, so the exhausted path is
	// the one under test rather than an accident of timing.
	restore := pairRoomReclaimBudget
	pairRoomReclaimBudget = 200 * time.Millisecond
	t.Cleanup(func() { pairRoomReclaimBudget = restore })

	h.advance(pairRoomJoinWindow + 1)
	started := time.Now()
	h.svc.SweepPairRooms(ctx, h.now)
	elapsed := time.Since(started)
	if elapsed > 30*time.Second {
		t.Fatalf("the void waited %s on a node that never answers", elapsed)
	}
	// THE BUDGET REALLY RAN OUT. Both halves are needed: the node must have been
	// asked (otherwise nothing was unreachable), and the void must have spent the
	// budget waiting for it (otherwise the answer came from somewhere else).
	if hits := stall.hits.Load(); hits == 0 {
		t.Fatal("the void never reached the unreachable node, so nothing here was unreachable")
	}
	if elapsed < pairRoomReclaimBudget {
		t.Fatalf("the void returned in %s, less than the %s budget it was supposed to exhaust", elapsed, pairRoomReclaimBudget)
	}
	// ...and it stopped there, rather than paying the budget once per artifact.
	if elapsed > 4*pairRoomReclaimBudget {
		t.Fatalf("the void spent %s on a %s budget, so it is being charged per artifact", elapsed, pairRoomReclaimBudget)
	}

	// EVERY row is gone, and every slot with it — decided by the database alone.
	for i, uploadID := range uploads {
		if h.sessionExists(t, uploadID) {
			t.Fatalf("upload %d's session survived a void whose physical work could not run", i)
		}
	}
	used, err := h.store.CurrentStorage(ctx, h.userID, h.now)
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	if used != 0 {
		t.Fatalf("CurrentStorage = %d after the void, want 0", used)
	}
	ok, err := h.store.CreateUploadSession(ctx, UploadSessionRow{
		ID: "probe-session", UserID: h.userID, BlobKey: "probe-key", CreatedAt: h.now,
	}, 1)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if !ok {
		t.Fatal("a voided room's sessions are still occupying the account's open-session slots")
	}

	// EVERY blob has an owner that survives this process, so nothing depends on
	// the sweep having got to it — and the ciphertext really is still there, which
	// is what makes that ownership the only thing standing between it and a leak.
	for i, key := range keys {
		if !queuedForDeletion(t, h, key) {
			t.Fatalf("upload %d's partial blob %s has no durable delete responsibility", i, key)
		}
		if !nodeBlobPresent(t, node.dir, key) {
			t.Fatalf("upload %d's blob %s is gone, so the physical phase ran after all and this test proves nothing", i, key)
		}
	}
	// The responsibility is UNDISCHARGED, so no amount of time may retire it (see
	// RetirePendingNodeDeletes): a week of sweeps against a node that never
	// answers must leave every one of these rows in place.
	if _, retained, err := h.store.RetirePendingNodeDeletes(ctx, h.now+pendingDeleteMaxAge); err != nil {
		t.Fatalf("retire: %v", err)
	} else if retained != len(keys) {
		t.Fatalf("retirement kept %d of %d never-succeeded rows", retained, len(keys))
	}
	for i, key := range keys {
		if !queuedForDeletion(t, h, key) {
			t.Fatalf("upload %d's blob %s lost its only owner to age while its node had never once answered", i, key)
		}
	}

	// Billing is exactly what crossed the wire. The unknown residual on a node
	// nobody can reach is the owner-approved write-off, and it is the ONLY thing
	// the exhausted budget cost.
	if got := h.uploadMetered(t); got != billed {
		t.Fatalf("billed %d after the void, want the %d bytes the nodes acknowledged", got, billed)
	}
}
