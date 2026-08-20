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
	"sync"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// Third adversarial suite: what happens to the BILL when the blob store, the
// database or the room disagrees with the request that is in flight.
//
// The shape every test here is written against is the same one: a byte crossed
// the network and landed somewhere, and then something failed in a way that
// erased the only record of it. An upload that is refused, interrupted or
// abandoned must still be billed for exactly what moved — no more (a lying node
// must not be able to inflate it) and no less (hanging up must not be free).

// commitThenFailNode is a storage node that writes what it is given and THEN
// answers 500 — a node that crashed after its write, a proxy that reset the
// response, an fsync that reported late. From central this is indistinguishable
// from "nothing landed": RemoteBlobStore.Append reports 0 with an error that is
// neither errTooLarge nor ErrOffsetMismatch.
//
// It exists because the only failure the append path used to ask the blob about
// was the oversize one, and an oversize chunk is the LEAST likely way to lose
// bytes this way.
type commitThenFailNode struct {
	*httptest.Server
	dir string
	// failAfterCommit makes a real (non-empty) write answer 500 after committing.
	failAfterCommit atomic.Bool
	// failProbe breaks the zero-byte read-back probe only, so a test can hold
	// central in the state where it genuinely cannot learn the blob's size while
	// the bytes are demonstrably on the node's disk.
	failProbe atomic.Bool
}

func newCommitThenFailNode(t *testing.T) *commitThenFailNode {
	t.Helper()
	dir := t.TempDir()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("node disk store: %v", err)
	}
	n := &commitThenFailNode{dir: dir}
	n.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		switch r.Method {
		case http.MethodPatch:
			off, _ := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
			// Buffered so the two failure modes can be told apart by what was sent
			// rather than by transfer encoding. Test payloads are kilobytes.
			body, _ := io.ReadAll(r.Body)
			if len(body) == 0 && n.failProbe.Load() {
				http.Error(w, "node unreachable", http.StatusInternalServerError)
				return
			}
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
			if len(body) > 0 && n.failAfterCommit.Load() {
				// Committed, then died on the way back. The bytes are on disk and
				// central is told nothing but "500".
				http.Error(w, "node died after committing", http.StatusInternalServerError)
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
			_ = ds.Delete(r.Context(), key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(n.Server.Close)
	return n
}

// registerStorageNode makes url the harness's one fleet storage node, so every
// upload placed after this call lands there rather than on central's disk. It
// returns the node's id, because moving a node's endpoint later means writing
// back to THAT id (see pointStorageNodeAt).
func (h *pairHarness) registerStorageNode(t *testing.T, url string) string {
	t.Helper()
	n, err := h.store.UpsertNode(context.Background(), Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: url, StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: h.now,
	})
	if err != nil {
		t.Fatalf("register node: %v", err)
	}
	return n.ID
}

// pointStorageNodeAt moves an EXISTING node's blob endpoint, which is the only
// way to make ciphertext that is already placed become unreachable.
//
// The id is the whole point. UpsertNode mints one when the caller leaves it
// empty, so "register a second node at the stalling address" inserts a machine
// nothing references and leaves every existing upload pointing at the healthy
// one — a test that believes it is exercising an unreachable fleet while every
// call is answered immediately. That is exactly how
// TestAVoidFreesEveryRowAndQueuesEveryBlobWhenNoNodeAnswers used to pass in
// twenty milliseconds without ever reaching the path it names.
func (h *pairHarness) pointStorageNodeAt(t *testing.T, nodeID, url string) {
	t.Helper()
	n, ok, err := h.store.GetNode(context.Background(), nodeID)
	if err != nil || !ok {
		t.Fatalf("read node %s: ok=%v err=%v", nodeID, ok, err)
	}
	n.StorageURL = url
	if _, err := h.store.UpsertNode(context.Background(), n); err != nil {
		t.Fatalf("point node %s at %s: %v", nodeID, url, err)
	}
	got, _, err := h.store.GetNode(context.Background(), nodeID)
	if err != nil || got.StorageURL != url {
		t.Fatalf("node %s still points at %q: %v", nodeID, got.StorageURL, err)
	}
}

// initOnNode opens a pre-upload for `code` and asserts it was placed on a node
// rather than on central's own disk.
func (h *pairHarness) initOnNode(t *testing.T, code string) string {
	t.Helper()
	h.mintCode(code, "")
	status, uploadID, _ := h.initPairUpload(t, code, 0, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if h.session(t, uploadID).NodeID == "" {
		t.Fatal("upload did not land on the fleet node")
	}
	return uploadID
}

func (h *pairHarness) session(t *testing.T, uploadID string) UploadSessionRow {
	t.Helper()
	sess, ok, err := h.store.GetUploadSession(context.Background(), uploadID, h.userID)
	if err != nil {
		t.Fatalf("read session: %v", err)
	}
	if !ok {
		t.Fatalf("session %s is gone", uploadID)
	}
	return sess
}

func (h *pairHarness) sessionExists(t *testing.T, uploadID string) bool {
	t.Helper()
	_, ok, err := h.store.GetUploadSession(context.Background(), uploadID, h.userID)
	if err != nil {
		t.Fatalf("read session: %v", err)
	}
	return ok
}

// ---------------------------------------------------------------------------
// An append that fails for ANY reason may have committed a prefix.
// ---------------------------------------------------------------------------

// The oversize path asked the blob how big it really is; every other failure
// wrote down the 0 that Append reports and moved on. A node that commits and
// then dies is the ordinary way to lose bytes that way — nothing about it is
// oversize, and the bytes crossed the network exactly the same.
func TestAnyAppendFailureBillsTheBytesTheBlobActuallyCommitted(t *testing.T) {
	h := newPairHarness(t)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "515151")
	sess := h.session(t, uploadID)

	node.failAfterCommit.Store(true)
	chunk := bytes.Repeat([]byte("G"), 3000)
	if got := h.patch(t, uploadID, chunk, 0, len(chunk), len(chunk)); got != 500 {
		t.Fatalf("a node that died after committing: %d, want 500", got)
	}
	onNode := nodeBlobSize(t, node.dir, sess.BlobKey)
	if onNode != int64(len(chunk)) {
		t.Fatalf("the node holds %d bytes, want the whole %d-byte chunk", onNode, len(chunk))
	}
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("billed %d of the %d bytes the node committed", got, onNode)
	}
	// ...and the offset moved with the bill, so a later reconcile cannot charge
	// them again and the client resumes from the truth.
	after := h.session(t, uploadID)
	if after.Received != onNode || after.Metered != onNode {
		t.Fatalf("received=%d metered=%d, want both %d", after.Received, after.Metered, onNode)
	}
}

// The recovered size is bounded by what CENTRAL actually read from the client
// and forwarded — not by whatever the node claims. A node that answers the
// read-back probe with a wildly inflated size must not be able to charge the
// account for bytes that never crossed central at all.
func TestRecoveredSizeIsBoundedByWhatCentralActuallySent(t *testing.T) {
	h := newPairHarness(t)
	// A node that commits nothing, fails the append, and then lies about its size
	// when asked. The 900000 below is a pure fabrication.
	lying := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if len(body) == 0 { // the read-back probe
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"size":900000}`)
			return
		}
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer lying.Close()
	h.registerStorageNode(t, lying.URL)
	uploadID := h.initOnNode(t, "525252")

	chunk := bytes.Repeat([]byte("L"), 4000)
	if got := h.patch(t, uploadID, chunk, 0, len(chunk), len(chunk)); got != 500 {
		t.Fatalf("append to a lying node: %d, want 500", got)
	}
	if got := h.uploadMetered(t); got > int64(len(chunk)) {
		t.Fatalf("a lying node charged the account %d bytes for a %d-byte chunk", got, len(chunk))
	}
	if got := h.session(t, uploadID).Received; got > int64(len(chunk)) {
		t.Fatalf("received = %d, past the %d bytes central actually sent", got, len(chunk))
	}
}

// ---------------------------------------------------------------------------
// When even the read-back probe fails, the bytes are not written off: the
// session keeps its retryable state and the reaper re-probes before deleting.
// ---------------------------------------------------------------------------

// The probe failing means "the size is unknown", which is not the same as "the
// size is what we last wrote down". Nothing may delete the session — and
// therefore the last record that those bytes were accepted — until something
// has actually asked the blob.
func TestUnprobableSessionIsKeptUntilTheReaperCanReadTheBlobBack(t *testing.T) {
	h := newPairHarness(t)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "535353")
	sess := h.session(t, uploadID)

	// The node commits the chunk, then goes dark: the append answers 500 and the
	// read-back probe answers 500 too, so central genuinely cannot learn the size.
	node.failAfterCommit.Store(true)
	node.failProbe.Store(true)
	chunk := bytes.Repeat([]byte("P"), 2500)
	if got := h.patch(t, uploadID, chunk, 0, len(chunk), len(chunk)); got != 500 {
		t.Fatalf("append to a node that went dark: %d, want 500", got)
	}
	onNode := nodeBlobSize(t, node.dir, sess.BlobKey)
	if onNode != int64(len(chunk)) {
		t.Fatalf("the node holds %d bytes, want %d", onNode, len(chunk))
	}
	if got := h.uploadMetered(t); got != 0 {
		t.Fatalf("central billed %d bytes it had no way to measure", got)
	}

	// Nothing knows the size yet, so nothing may be written off.
	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 1)
	if !h.sessionExists(t, uploadID) {
		t.Fatal("the reaper deleted a session whose blob it could not read back — those bytes can never be billed now")
	}
	if got := h.uploadMetered(t); got != 0 {
		t.Fatalf("the reaper invented a bill of %d bytes for a blob it could not read", got)
	}

	// The node comes back. The next re-probe asks it, and bills what it holds.
	// (The session is in the recovery state now, which is re-probed on its own
	// hourly cadence rather than on every GC tick — a node that is away must not
	// cost a blob-store timeout every sweep.)
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)
	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + uploadUnresolvedRetryEvery + 1)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("the reaper billed %d, want the %d bytes the node was holding", got, onNode)
	}
	if h.sessionExists(t, uploadID) {
		t.Fatal("a settled session was left behind")
	}
}

// unreachableAfterCommit stages the exact shape of the underbill: an upload
// whose node accepted MORE bytes than central ever managed to write down, and
// which then became unreachable. It returns the upload, the node, the offset
// central knows about (the lower bound) and what the node is really holding.
func unreachableAfterCommit(t *testing.T, h *pairHarness, code string) (uploadID string, node *commitThenFailNode, known, onNode int64) {
	t.Helper()
	node = newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID = h.initOnNode(t, code)
	sess := h.session(t, uploadID)

	const acked, unacked = 1200, 3000
	blob := bytes.Repeat([]byte("H"), acked+unacked)
	total := len(blob)

	// One ordinary chunk: committed, acknowledged, billed. This is the offset the
	// database knows — and every number a give-up would be tempted to settle for.
	if got := h.patch(t, uploadID, blob, 0, acked, total); got != 200 {
		t.Fatalf("first chunk: %d", got)
	}
	known = acked

	// Now the node commits a second chunk and goes dark before it can say so:
	// the append answers 500 and the read-back probe answers 500 too, so central
	// genuinely cannot learn the size. The bytes are on the node's disk.
	node.failAfterCommit.Store(true)
	node.failProbe.Store(true)
	if got := h.patch(t, uploadID, blob, acked, total, total); got != 500 {
		t.Fatalf("append to a node that went dark: %d, want 500", got)
	}
	onNode = nodeBlobSize(t, node.dir, sess.BlobKey)
	if onNode != int64(total) {
		t.Fatalf("the node holds %d bytes, want %d", onNode, total)
	}
	if got := h.session(t, uploadID).Received; got != known {
		t.Fatalf("central recorded %d bytes, want the %d it could confirm", got, known)
	}
	if got := h.uploadMetered(t); got != known {
		t.Fatalf("billed %d, want the %d bytes central could confirm", got, known)
	}
	return uploadID, node, known, onNode
}

// A blob nothing can reach is not a blob that holds `received` bytes. Settling
// the session against that offset and deleting it — which is what a 24-hour
// give-up horizon did — permanently underbills every byte the node committed
// but never got to acknowledge, and destroys the only two witnesses to them:
// the session row, and the blob itself.
//
// So there is no horizon. However long the node stays away, the evidence stays:
// the row survives every purge, nothing marks it settled, and its blob is not
// dropped, because the blob is the only thing that can ever answer the
// question.
func TestAnUnreachableBlobIsNeverWrittenOffAgainstTheOffsetWeHappenToKnow(t *testing.T) {
	h := newPairHarness(t)
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "545454")
	sess := h.session(t, uploadID)

	// Thirty days of sweeps, each one far past any give-up horizon that ever
	// existed here.
	for day := int64(1); day <= 30; day++ {
		h.svc.ReapPendingUploads(h.now + day*86400)
		if !h.sessionExists(t, uploadID) {
			t.Fatalf("day %d: the accounting evidence for %d unbilled bytes was deleted",
				day, onNode-known)
		}
		if got := h.uploadMetered(t); got != known {
			t.Fatalf("day %d: billed %d against a blob nothing could read — want the confirmed %d",
				day, got, known)
		}
		if got := nodeBlobSize(t, node.dir, sess.BlobKey); got != onNode {
			t.Fatalf("day %d: the blob — the only witness to the exact number — is %d bytes, want %d",
				day, got, onNode)
		}
	}
	// It is explicitly UNRESOLVED, not settled: nothing may read this row as a
	// finished bill.
	if got := h.session(t, uploadID); got.UnresolvedAt == 0 {
		t.Fatalf("a session whose blob could never be read back is marked settled: %+v", got)
	}
	// ...and the purge agrees, however old the row gets.
	if err := h.store.PurgeDoneUploadSessions(context.Background(), h.now+3650*86400); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if !h.sessionExists(t, uploadID) {
		t.Fatal("the purge swept away unresolved accounting evidence as if it were settled")
	}
}

// ...and when the node does come back, the bill is the EXACT committed size,
// not the lower bound that survived in the meantime. That is what keeping the
// evidence was for.
func TestAnUnreachableBlobIsBilledExactlyOnceItsNodeReturns(t *testing.T) {
	h := newPairHarness(t)
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "555555")
	sess := h.session(t, uploadID)

	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 1) // into the recovery state

	// A week later the node is back.
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)
	h.svc.ReapPendingUploads(h.now + 7*86400)

	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("billed %d, want the %d bytes the node had really committed (%d were never charged)",
			got, onNode, onNode-known)
	}
	if h.sessionExists(t, uploadID) {
		t.Fatal("a settled session was left behind")
	}
	if nodeBlobSize(t, node.dir, sess.BlobKey) != 0 {
		t.Fatal("the partial blob was not reclaimed once its bytes were accounted for")
	}
	// Exactly once: a later sweep must not re-bill what is already paid for.
	h.svc.ReapPendingUploads(h.now + 8*86400)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("a later sweep re-billed: %d, want %d", got, onNode)
	}
}

// ---------------------------------------------------------------------------
// A session is never deleted while its ledger is short: the row is the only
// record of how many bytes an upload accepted.
// ---------------------------------------------------------------------------

// A finalize whose meter cannot be settled must fail in a way the client can
// retry. Claiming the session and then failing to bill it left the upload
// terminally done=1 with unbilled bytes, and the very next line deleted the row
// that said so — a permanent underbill, retryable by nobody.
func TestFinalizeThatCannotSettleItsMeterStaysRetryable(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	h.mintCode("565656", "")
	blob := bytes.Repeat([]byte("S"), 2200)
	status, uploadID, _ := h.initPairUpload(t, "565656", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("chunk: %d", got)
	}
	// The state a crash between committing and billing leaves behind: the offset
	// moved, the ledger did not. Finalize is the place that has to notice.
	if _, err := h.store.db.Exec(
		`UPDATE upload_sessions SET metered = 0 WHERE id = ?`, uploadID); err != nil {
		t.Fatalf("simulate a crashed append: %v", err)
	}
	if _, err := h.store.db.Exec(
		`UPDATE usage_monthly SET upload_bytes = 0 WHERE user_id = ?`, h.userID); err != nil {
		t.Fatalf("reset meter: %v", err)
	}

	f.failNext("ClaimUploadDone", 1)
	if status, _ := h.finalize(t, uploadID); status != 500 {
		t.Fatalf("finalize whose meter could not be settled: %d, want 500", status)
	}
	if !h.sessionExists(t, uploadID) {
		t.Fatal("the session — the only record of the unbilled bytes — was deleted anyway")
	}
	if sess := h.session(t, uploadID); sess.Done {
		t.Fatal("a finalize that failed to settle the meter left the session stuck done=1")
	}
	if got := h.uploadMetered(t); got != 0 {
		t.Fatalf("a failed claim billed %d bytes", got)
	}

	// The retry works, and bills the bytes exactly once.
	status, id := h.finalize(t, uploadID)
	if status != 200 {
		t.Fatalf("retried finalize: %d, want 200", status)
	}
	if id == "" {
		t.Fatal("retried finalize produced no object")
	}
	if got := h.uploadMetered(t); got != int64(len(blob)) {
		t.Fatalf("after the retry metered = %d, want %d billed exactly once", got, len(blob))
	}
}

// The same rule for the reaper's orphan pass: a done=1 row whose reconcile
// fails must survive the purge, because purging it throws away a bill nothing
// can reconstruct.
func TestOrphanSessionIsNotPurgedUntilItsMeterIsSettled(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	ctx := context.Background()
	row := mkUploadRow("orphan-unsettled", h.userID)
	row.CreatedAt = h.now
	row.Received = 4400 // committed by an append that crashed before billing
	if ok, err := h.store.CreateUploadSession(ctx, row, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("create session: ok=%v err=%v", ok, err)
	}
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, row.ID, h.now); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	// Undo the claim's own reconcile, so the row is the crashed-finalize shape the
	// orphan pass exists for: done=1, received > metered.
	if _, err := h.store.db.Exec(
		`UPDATE upload_sessions SET metered = 0 WHERE id = ?`, row.ID); err != nil {
		t.Fatalf("simulate a crashed finalize: %v", err)
	}
	if _, err := h.store.db.Exec(
		`UPDATE usage_monthly SET upload_bytes = 0 WHERE user_id = ?`, h.userID); err != nil {
		t.Fatalf("reset meter: %v", err)
	}

	f.failNext("ReconcileUploadMeter", -1)
	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 1)
	if _, ok, _ := h.store.GetUploadSession(ctx, row.ID, h.userID); !ok {
		t.Fatal("a session whose meter could not be settled was purged, taking its bill with it")
	}

	f.failNext("ReconcileUploadMeter", 0)
	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 2)
	if got := h.uploadMetered(t); got != 4400 {
		t.Fatalf("the recovered reconcile billed %d, want 4400", got)
	}
	if _, ok, _ := h.store.GetUploadSession(ctx, row.ID, h.userID); ok {
		t.Fatal("a settled orphan row was left behind")
	}
	// Exactly once: another sweep must not re-bill what is already paid for.
	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 3)
	if got := h.uploadMetered(t); got != 4400 {
		t.Fatalf("a later sweep re-billed: %d, want 4400", got)
	}
}

// ---------------------------------------------------------------------------
// The room can end in the microseconds between a liveness check and the write
// it authorised. Every one of those windows is closed inside a transaction.
// ---------------------------------------------------------------------------

// closingStore closes a pairing room the instant the server reads (or touches)
// it, which is exactly the race that no test could otherwise reach: the check
// says "open", the room ends, and the write lands anyway.
type closingStore struct {
	Store
	mu sync.Mutex
	// closeAfterGet / closeAfterTouch fire ONCE each, so the recovery paths that
	// read the room again are not fighting a store that keeps re-closing it.
	closeAfterGet   bool
	closeAfterTouch bool
	now             int64
}

func (c *closingStore) closeOnce(ctx context.Context, id string, flag *bool) {
	c.mu.Lock()
	if !*flag {
		c.mu.Unlock()
		return
	}
	*flag = false
	c.mu.Unlock()
	_, _ = c.Store.ClosePairRoom(ctx, id, c.now, c.now+pairRoomBlobHold)
}

func (c *closingStore) GetPairRoom(ctx context.Context, id string) (PairRoom, bool, error) {
	r, ok, err := c.Store.GetPairRoom(ctx, id)
	if ok && err == nil {
		c.closeOnce(ctx, id, &c.closeAfterGet)
	}
	return r, ok, err
}

func (c *closingStore) TouchPairRoomUpload(ctx context.Context, id string, at, expiresAt int64) (PairRoomTouch, error) {
	touch, err := c.Store.TouchPairRoomUpload(ctx, id, at, expiresAt)
	if err == nil {
		c.closeOnce(ctx, id, &c.closeAfterTouch)
	}
	return touch, err
}

// withClosingStore puts a closingStore in front of the harness's service.
func (h *pairHarness) withClosingStore(t *testing.T) *closingStore {
	t.Helper()
	c := &closingStore{Store: h.store, now: h.now}
	h.svc.store = c
	return c
}

func (h *pairHarness) roomFor(t *testing.T, code string) PairRoom {
	t.Helper()
	room, found, err := h.store.LivePairRoomByCode(context.Background(), code)
	if err != nil {
		t.Fatalf("resolve room: %v", err)
	}
	if !found {
		t.Fatalf("no room for code %s", code)
	}
	return room
}

// An append whose room closes underneath it is BILLED (the bytes crossed the
// wire) and REFUSED (they bought nothing). Both halves matter: the old code
// read a zero-row deadline UPDATE as success, so the sender got 200 and went on
// filling a blob no receiver could ever reach.
func TestAppendForARoomThatClosedMidFlightIsBilledAndRefused(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("575757", "")
	blob := bytes.Repeat([]byte("C"), 1800)
	status, uploadID, _ := h.initPairUpload(t, "575757", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	room := h.roomFor(t, "575757")

	c := h.withClosingStore(t)
	c.mu.Lock()
	c.closeAfterGet = true // the room ends between pairRoomStillOpen and the commit
	c.mu.Unlock()

	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 410 {
		t.Fatalf("append into a room that closed mid-flight: %d, want 410", got)
	}
	if got := h.uploadMetered(t); got != int64(len(blob)) {
		t.Fatalf("bytes that crossed the wire went unbilled: %d, want %d", got, len(blob))
	}
	// The deadline did NOT move: a closed room takes no progress.
	after, _, _ := h.store.GetPairRoom(context.Background(), room.ID)
	if after.ClosedAt == 0 {
		t.Fatal("the room is not closed")
	}
	if after.LastUploadAt != 0 {
		t.Fatalf("a closed room recorded progress at %d", after.LastUploadAt)
	}
}

// Progress that is merely STALE — a sibling file in the same batch already
// pushed the deadline further out — is not a closed room and must not be
// refused. Distinguishing the two is the whole point of reading the row.
func TestStaleProgressForAnOpenRoomIsNotTreatedAsClosed(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("585858", "")
	blob := bytes.Repeat([]byte("B"), 1500)
	status, uploadID, _ := h.initPairUpload(t, "585858", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	room := h.roomFor(t, "585858")
	// A sibling upload of the same batch, further along: the room's deadline is
	// already past anything this chunk can buy.
	ahead := room
	ahead.LastUploadAt = h.now + 120
	if _, err := h.store.TouchPairRoomUpload(ctx, room.ID, h.now+120, pairRoomExpiry(ahead)); err != nil {
		t.Fatalf("sibling progress: %v", err)
	}

	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("chunk whose progress is stale: %d, want 200", got)
	}
	if status, _ := h.finalize(t, uploadID); status != 200 {
		t.Fatalf("finalize whose deadline move is a no-op: %d, want 200", status)
	}
	after, _, _ := h.store.GetPairRoom(ctx, room.ID)
	if after.LastUploadAt != h.now+120 {
		t.Fatalf("stale progress moved the deadline backwards: %d", after.LastUploadAt)
	}
}

// Finalize must not hand back an object bound to a room that ended while it was
// running. Three windows, each closed by a different transaction:
//   - after the liveness check, caught by the deadline move's own precondition;
//   - the same, when the deadline needs no moving at all — the case the old
//     early return skipped entirely, so nothing looked;
//   - after the deadline move, caught by the insert's precondition.
func TestFinalizeNeverSucceedsForARoomThatEnded(t *testing.T) {
	for _, tc := range []struct {
		name       string
		afterGet   bool
		afterTouch bool
		// advance moves the clock before finalize, so the deadline move is a real
		// forward step rather than a no-op.
		advance int64
	}{
		{name: "room ends after the liveness check", afterGet: true, advance: 1},
		{name: "room ends and the deadline needs no moving", afterGet: true},
		{name: "room ends after the deadline move", afterTouch: true, advance: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPairHarness(t)
			h.mintCode("595959", "")
			blob := bytes.Repeat([]byte("F"), 1700)
			status, uploadID, _ := h.initPairUpload(t, "595959", len(blob), "")
			if status != 200 {
				t.Fatalf("init: %d", status)
			}
			if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
				t.Fatalf("chunk: %d", got)
			}
			room := h.roomFor(t, "595959")
			h.advance(tc.advance)

			c := h.withClosingStore(t)
			c.now = h.now
			c.mu.Lock()
			c.closeAfterGet, c.closeAfterTouch = tc.afterGet, tc.afterTouch
			c.mu.Unlock()

			status, id := h.finalize(t, uploadID)
			if status != 410 {
				t.Fatalf("finalize into a room that ended: %d (id %q), want 410", status, id)
			}
			// No object may exist for it — a 410 that still inserted the row would
			// leave ciphertext bound to a closed room, which no later void collects.
			var n int
			if err := h.store.db.QueryRow(
				`SELECT COUNT(*) FROM stored_files WHERE pair_room_id = ?`, room.ID).Scan(&n); err != nil {
				t.Fatalf("count objects: %v", err)
			}
			if n != 0 {
				t.Fatalf("%d object(s) bound to a closed room", n)
			}
			// The bytes stay billed: they moved.
			if got := h.uploadMetered(t); got != int64(len(blob)) {
				t.Fatalf("a refused finalize refunded bytes that crossed the wire: %d, want %d",
					got, len(blob))
			}
		})
	}
}

// ---------------------------------------------------------------------------
// An observed join is not allowed to evaporate because the database was busy.
// ---------------------------------------------------------------------------

// The only witness that a receiver arrived is a live websocket, so a join the
// server saw but could not write down cannot be recovered from anywhere. It is
// held instead: the failure is reported to the caller, the room's ciphertext is
// NOT taken away on a deadline that should already have stopped, and the retry
// stamps the join at the instant it actually happened.
func TestObservedJoinSurvivesAPersistentWriteFailureAndLandsOnRetry(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	ctx := context.Background()
	h.mintCode("616161", "")
	id := h.preUpload(t, "616161", bytes.Repeat([]byte("J"), 1400), 1)
	sf, err := h.store.GetStoredFile(ctx, id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	joinedAt := h.now

	f.failNext("JoinPairRoom", -1) // the database is down for this write
	if err := h.svc.MarkPairRoomJoined(ctx, "616161"); err == nil {
		t.Fatal("a join that could not be persisted was reported as success")
	}

	// Long past the join deadline, with every backstop given a chance to run. The
	// room's row still says "five minutes from the last byte", and that row is
	// wrong — somebody joined. Nothing may act on it.
	h.advance(pairRoomJoinWindow * 3)
	h.svc.SweepPairRooms(ctx, h.now)
	if !h.blobExists(t, sf.BlobKey) {
		t.Fatal("the ciphertext of a room somebody joined was deleted while its join was still queued")
	}
	room, found, _ := h.store.GetPairRoom(ctx, sf.PairRoomID)
	if !found || room.ClosedAt != 0 {
		t.Fatalf("the room was voided while its observed join was queued: found=%v %+v", found, room)
	}

	// The database comes back. The retry stamps the join at the instant it was
	// OBSERVED — judging it by "now" would find it long past the deadline and void
	// exactly the transfer the queue exists to protect.
	f.failNext("JoinPairRoom", 0)
	h.svc.RetryPairRoomJoins(ctx)
	room, found, _ = h.store.GetPairRoom(ctx, sf.PairRoomID)
	if !found || room.JoinedAt != joinedAt {
		t.Fatalf("join stamped at %d, want the observed instant %d (%+v)", room.JoinedAt, joinedAt, room)
	}
	// The join buys the room its account's retention window measured from the
	// observed instant — a real deadline now, not the absent one this used to
	// assert, and still far enough out that the transfer this queue exists to
	// protect is nowhere near it.
	if want := pairRoomJoinedExpiry(room); room.ExpiresAt != want {
		t.Fatalf("joined room expiry %d, want %d", room.ExpiresAt, want)
	}
	if room.ExpiresAt != joinedAt+pairRoomFreeRetention {
		t.Fatalf("expiry %d, want the observed join plus the free window %d",
			room.ExpiresAt, joinedAt+pairRoomFreeRetention)
	}
	if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status != 200 {
		t.Fatalf("blob after the queued join landed: %d, want 200", status)
	}
	// Nothing is left queued, so a later sweep is free to act on the room again.
	if h.svc.pairJoins.held("616161") {
		t.Fatal("a join that landed is still queued")
	}
}

// The hold does NOT expire, however long the database stays down.
//
// The room's ceilings are clocks on JOINING, and this observation is proof that
// somebody joined — it was judged timely at the instant it was made, and no
// amount of time passing afterwards makes that judgement less true. Dropping it
// hands the room back the five-minute deadline that the join had already ended,
// and the next sweep deletes a receiver's ciphertext on the strength of a clock
// that stopped hours earlier. The code-recycling protections (room id when it
// is known, "a room opened after the observation cannot be it" when it is not)
// are what make holding it safe; time is not one of them.
func TestAQueuedJoinIsNeverGivenUpOnHoweverLongTheDatabaseIsDown(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	ctx := context.Background()
	h.mintCode("626262", "")
	id := h.preUpload(t, "626262", bytes.Repeat([]byte("K"), 900), 1)
	sf, _ := h.store.GetStoredFile(ctx, id)
	joinedAt := h.now

	f.failNext("JoinPairRoom", -1)
	if err := h.svc.MarkPairRoomJoined(ctx, "626262"); err == nil {
		t.Fatal("a failed join was reported as success")
	}

	// Well past every ceiling this room has: eight times the absolute joinability
	// cap — two days, comfortably past the account's whole retention window too —
	// with the retry and the GC backstop both given their chance at each step.
	for range 8 {
		h.advance(pairRoomMaxJoinable + 1)
		h.svc.RetryPairRoomJoins(ctx)
		h.svc.SweepPairRooms(ctx, h.now)
		if !h.svc.pairJoins.held("626262") {
			t.Fatalf("the observed join was dropped %ds after it was seen", h.now-joinedAt)
		}
		if !h.blobExists(t, sf.BlobKey) {
			t.Fatalf("a joined room's ciphertext was deleted %ds after the join was seen", h.now-joinedAt)
		}
		room, found, _ := h.store.GetPairRoom(ctx, sf.PairRoomID)
		if !found || room.ClosedAt != 0 {
			t.Fatalf("the room was voided while its observed join was queued: found=%v %+v", found, room)
		}
	}

	// The database finally comes back, a day late. The join still lands at the
	// instant it was OBSERVED — not at "now", which is long past every deadline
	// and would void the very transfer the queue exists to protect.
	f.failNext("JoinPairRoom", 0)
	h.svc.RetryPairRoomJoins(ctx)
	room, found, _ := h.store.GetPairRoom(ctx, sf.PairRoomID)
	if !found || room.JoinedAt != joinedAt {
		t.Fatalf("join stamped at %d, want the observed instant %d (%+v)", room.JoinedAt, joinedAt, room)
	}
	// ...and it lands with a BOUNDED deadline, measured from that observed
	// instant. Which was two days ago, so the window this room was entitled to
	// has already run out and its ciphertext is reclaimable rather than immortal.
	// That is the deliberate half of the change: holding the observation is what
	// stops a JOIN clock from deleting a live transfer, and it was never a licence
	// to keep an abandoned room's bytes forever.
	if room.ExpiresAt != joinedAt+pairRoomFreeRetention {
		t.Fatalf("expiry %d, want the observed join plus the free window %d",
			room.ExpiresAt, joinedAt+pairRoomFreeRetention)
	}
	if room.ExpiresAt >= h.now {
		t.Fatalf("a room joined %ds ago still has %ds left", h.now-joinedAt, room.ExpiresAt-h.now)
	}
	if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status == 200 {
		t.Fatal("ciphertext past its whole retention window is still readable")
	}
	if h.svc.pairJoins.held("626262") {
		t.Fatal("a join that landed is still queued")
	}
	// The ordinary GC backstop is what reclaims it — no new deletion path.
	h.svc.SweepPairRooms(ctx, h.now)
	if room, _, _ := h.store.GetPairRoom(ctx, sf.PairRoomID); room.ClosedAt == 0 {
		t.Fatal("an abandoned joined room past its deadline was not reclaimed")
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("the reclaimed room's ciphertext is still on disk")
	}
}

// A join that arrives after the deadline is a genuine latecomer, not a queued
// failure: it voids, and it does not go on the queue to be retried forever.
func TestALateJoinVoidsAndIsNotQueued(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("636363", "")
	id := h.preUpload(t, "636363", bytes.Repeat([]byte("L"), 800), 1)
	sf, _ := h.store.GetStoredFile(ctx, id)

	h.advance(pairRoomJoinWindow + 1)
	if err := h.svc.MarkPairRoomJoined(ctx, "636363"); err != nil {
		t.Fatalf("a late join is not an error: %v", err)
	}
	if h.svc.pairJoins.held("636363") {
		t.Fatal("a late join was queued for retry")
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("a late join left the void ciphertext in place")
	}
}

// TouchPairRoomUpload's contract, pinned at the store, because two call sites
// depend on it telling three outcomes apart: a room that is over refuses the
// write, a room that is merely further along accepts it as a no-op, and the
// difference is not visible in a row count.
//
// (At finalize this guard and the stored-file insert's are deliberately
// redundant — either one alone refuses the object — so only a store-level test
// can hold this one on its own.)
func TestTouchPairRoomUploadDistinguishesClosedFromStale(t *testing.T) {
	ctx := context.Background()
	mk := func(t *testing.T) (*SQLiteStore, PairRoom) {
		t.Helper()
		st := newTestStore(t)
		u, _ := st.UpsertUserByEmail(ctx, "touch@example.com", "T")
		room := PairRoom{ID: "room-touch", Code: "646464", UserID: u.ID,
			CreatedAt: 1000, LastUploadAt: 1200, ExpiresAt: 1200 + pairRoomJoinWindow}
		if _, created, err := st.CreatePairRoomIfAbsent(ctx, room); err != nil || !created {
			t.Fatalf("create room: created=%v err=%v", created, err)
		}
		return st, room
	}

	t.Run("progress older than the room already has is a silent no-op", func(t *testing.T) {
		st, room := mk(t)
		if _, err := st.TouchPairRoomUpload(ctx, room.ID, 1100, 1100+pairRoomJoinWindow); err != nil {
			t.Fatalf("stale but open: %v", err)
		}
		got, _, _ := st.GetPairRoom(ctx, room.ID)
		if got.LastUploadAt != 1200 {
			t.Fatalf("stale progress moved the room backwards to %d", got.LastUploadAt)
		}
	})

	t.Run("a closed room refuses the write", func(t *testing.T) {
		st, room := mk(t)
		if _, err := st.ClosePairRoom(ctx, room.ID, 1300, 1300+pairRoomBlobHold); err != nil {
			t.Fatalf("close: %v", err)
		}
		if _, err := st.TouchPairRoomUpload(ctx, room.ID, 1400, 1400+pairRoomJoinWindow); !errors.Is(err, ErrPairRoomClosed) {
			t.Fatalf("touch of a closed room: %v, want ErrPairRoomClosed", err)
		}
	})

	t.Run("a room past its deadline refuses the write", func(t *testing.T) {
		st, room := mk(t)
		at := room.ExpiresAt + 1
		if _, err := st.TouchPairRoomUpload(ctx, room.ID, at, at+pairRoomJoinWindow); !errors.Is(err, ErrPairRoomClosed) {
			t.Fatalf("touch of an expired room: %v, want ErrPairRoomClosed", err)
		}
	})

	t.Run("a room that vanished refuses the write", func(t *testing.T) {
		st, _ := mk(t)
		if _, err := st.TouchPairRoomUpload(ctx, "no-such-room", 1400, 1700); !errors.Is(err, ErrPairRoomClosed) {
			t.Fatalf("touch of a missing room: %v, want ErrPairRoomClosed", err)
		}
	})
}

// A queued join must never land on a room it did not belong to. Six digits are
// free again minutes after they are minted, so a retry that re-resolved the
// code could stamp the NEXT holder's room as joined — handing a stranger's
// ciphertext the unbounded storage window that joining grants, on the strength
// of somebody else's receiver.
func TestAQueuedJoinNeverLandsOnARecycledCodesNewRoom(t *testing.T) {
	// The queued observation knows which room it meant, because the room was
	// resolved before the join write failed. The retry goes straight there.
	t.Run("the room was known when the write failed", func(t *testing.T) {
		h := newPairHarness(t)
		f := h.withFlakyStore(t)
		ctx := context.Background()
		h.mintCode("656565", "")
		firstID := h.preUpload(t, "656565", bytes.Repeat([]byte("M"), 700), 1)
		firstSF, _ := h.store.GetStoredFile(ctx, firstID)

		f.failNext("JoinPairRoom", -1)
		if err := h.svc.MarkPairRoomJoined(ctx, "656565"); err == nil {
			t.Fatal("a failed join was reported as success")
		}
		// The old room goes away by some other route (an operator, a void), freeing
		// the digits, and they are reissued to somebody else.
		if _, err := h.store.ClosePairRoom(ctx, firstSF.PairRoomID, h.now, h.now+pairRoomBlobHold); err != nil {
			t.Fatalf("close the first room: %v", err)
		}
		newRoom := h.recycleCodeToAnotherAccount(t, "656565", "next-a@example.com")

		f.failNext("JoinPairRoom", 0)
		h.svc.RetryPairRoomJoins(ctx)
		h.assertNotJoined(t, newRoom.ID)
	})

	// The lookup itself is what failed, so nothing knows which room the digits
	// meant. A room opened AFTER the join was seen cannot be it.
	t.Run("only the digits were known", func(t *testing.T) {
		h := newPairHarness(t)
		f := h.withFlakyStore(t)
		ctx := context.Background()
		h.mintCode("666666", "")

		f.failNext("LivePairRoomByCode", -1)
		if err := h.svc.MarkPairRoomJoined(ctx, "666666"); err == nil {
			t.Fatal("a join whose room could not be resolved was reported as success")
		}
		f.failNext("LivePairRoomByCode", 0)

		h.advance(10) // the next holder's room opens after the join was observed
		newRoom := h.recycleCodeToAnotherAccount(t, "666666", "next-b@example.com")

		h.svc.RetryPairRoomJoins(ctx)
		h.assertNotJoined(t, newRoom.ID)
		if h.svc.pairJoins.held("666666") {
			t.Fatal("an unresolvable observation is queued forever")
		}
	})
}

// recycleCodeToAnotherAccount mints `code` for a fresh account and opens its
// room, asserting that the reissue works at all — a queued join must never be
// allowed to burn six digits for whoever is issued them next.
func (h *pairHarness) recycleCodeToAnotherAccount(t *testing.T, code, email string) PairRoom {
	t.Helper()
	ctx := context.Background()
	other, err := h.store.UpsertUserByEmail(ctx, email, "Next")
	if err != nil {
		t.Fatalf("create the next holder: %v", err)
	}
	h.mintCode(code, other.ID)
	room, err := h.svc.pairRoomForUpload(ctx, other.ID, code)
	if err != nil {
		t.Fatalf("the next holder could not open a room for the recycled code: %v", err)
	}
	if room.UserID != other.ID {
		t.Fatalf("the next holder was handed room %s, owned by %s", room.ID, room.UserID)
	}
	return room
}

func (h *pairHarness) assertNotJoined(t *testing.T, roomID string) {
	t.Helper()
	got, found, _ := h.store.GetPairRoom(context.Background(), roomID)
	if !found {
		t.Fatal("the room vanished")
	}
	if got.JoinedAt != 0 {
		t.Fatalf("a stranger's queued join stamped this room as joined at %d", got.JoinedAt)
	}
	if want := pairRoomJoinDeadline(got); got.ExpiresAt != want {
		t.Fatalf("a stranger's queued join moved this room's deadline to %d, want the "+
			"unjoined join deadline %d", got.ExpiresAt, want)
	}
}

// ...and a queued join must not burn the six digits either. A room kept open
// only by an unwritten join still occupies its code's one-open-room slot, so
// resolving the code for the next holder lands that join first.
func TestAQueuedJoinDoesNotBurnTheCodeForTheNextHolder(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	ctx := context.Background()
	h.mintCode("676767", "")
	firstID := h.preUpload(t, "676767", bytes.Repeat([]byte("N"), 600), 1)
	firstSF, _ := h.store.GetStoredFile(ctx, firstID)

	f.failNext("JoinPairRoom", -1)
	if err := h.svc.MarkPairRoomJoined(ctx, "676767"); err == nil {
		t.Fatal("a failed join was reported as success")
	}
	f.failNext("JoinPairRoom", 0) // the database comes back

	h.advance(pairRoomJoinWindow + 1)
	newRoom := h.recycleCodeToAnotherAccount(t, "676767", "next-c@example.com")
	if newRoom.ID == firstSF.PairRoomID {
		t.Fatal("the next holder was handed the previous holder's room")
	}
	// The first transfer was not collateral: its queued join landed on the way,
	// so its ciphertext outlives the deadline it should have shed.
	first, _, _ := h.store.GetPairRoom(ctx, firstSF.PairRoomID)
	if first.JoinedAt == 0 {
		t.Fatal("the queued join was dropped instead of landed when the code was reused")
	}
	if status, _ := h.getAnon(t, "/api/files/"+firstID+"/blob"); status != 200 {
		t.Fatalf("the previous holder's joined transfer: %d, want 200", status)
	}
}

// Rows that predate the metered ledger were billed the old way — the whole
// object at finalize — so they must start out settled. Left at metered=0 they
// would be double-billed by a reconcile, or (since no row is purged while its
// ledger is short) stranded in the table forever.
func TestPreMigrationFinalizedSessionsAreBackfilledAsSettled(t *testing.T) {
	dir := t.TempDir()
	dsn := "file:" + dir + "/acct.db?_txlock=immediate&_journal_mode=WAL&_busy_timeout=5000"
	ctx := context.Background()

	// A store from before the column existed, holding one finalized session.
	old, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	u, _ := old.UpsertUserByEmail(ctx, "premigration@example.com", "P")
	row := mkUploadRow("legacy", u.ID)
	row.Received = 5000
	if ok, err := old.CreateUploadSession(ctx, row, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("create session: ok=%v err=%v", ok, err)
	}
	if _, err := old.db.Exec(`UPDATE upload_sessions SET done = 1 WHERE id = ?`, row.ID); err != nil {
		t.Fatalf("finalize the legacy way: %v", err)
	}
	// Drop the column to make it genuinely pre-migration, then reopen.
	if _, err := old.db.Exec(`ALTER TABLE upload_sessions DROP COLUMN metered`); err != nil {
		t.Fatalf("un-migrate: %v", err)
	}
	old.Close()

	st, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer st.Close()

	got, ok, err := st.GetUploadSession(ctx, row.ID, u.ID)
	if err != nil || !ok {
		t.Fatalf("read the migrated session: ok=%v err=%v", ok, err)
	}
	if got.Metered != got.Received {
		t.Fatalf("metered=%d received=%d — a pre-migration finalized row was left unsettled",
			got.Metered, got.Received)
	}
	if billed, err := st.ReconcileUploadMeter(ctx, row.ID, 2000); err != nil || billed != 0 {
		t.Fatalf("reconciling a pre-migration row billed %d again (err %v)", billed, err)
	}
	if err := st.PurgeDoneUploadSessions(ctx, 1<<40); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if _, ok, _ := st.GetUploadSession(ctx, row.ID, u.ID); ok {
		t.Fatal("a pre-migration finalized row can never be purged")
	}
}
