package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// faultDisk is a real DiskStore whose next `failWrites` body-carrying appends
// end the way DiskStore.Append ends when its flush fails: the bytes are on
// disk, nothing certified them, and the answer is a *NotDurableError with the
// offset as the durable size. (The storage package's own tests drive that
// outcome through the real fsync seam; it is not reachable from here.)
// Everything else is the real store, so the tail it leaves is exactly the
// "not known durable" tail the real store then refuses to vouch for.
type faultDisk struct {
	*storage.DiskStore
	dir        string
	failWrites atomic.Int32
	// forge, when set, replaces a failing append's answer (a lying v1 node).
	forge func(offset, wrote int64) *storage.NotDurableError
}

func (f *faultDisk) path(key string) string { return filepath.Join(f.dir, key[:2], key) }

func (f *faultDisk) Append(ctx context.Context, key string, offset int64, r io.Reader) (int64, error) {
	if f.failWrites.Load() > 0 {
		body, _ := io.ReadAll(r)
		if len(body) > 0 && f.failWrites.Add(-1) >= 0 {
			if err := os.MkdirAll(filepath.Dir(f.path(key)), 0o700); err != nil {
				return 0, err
			}
			fh, err := os.OpenFile(f.path(key), os.O_CREATE|os.O_WRONLY, 0o600)
			if err != nil {
				return 0, err
			}
			defer fh.Close()
			if info, _ := fh.Stat(); info.Size() != offset {
				return f.DiskStore.Append(ctx, key, offset, bytes.NewReader(body))
			}
			n, _ := fh.WriteAt(body, offset)
			if f.forge != nil {
				return offset, f.forge(offset, int64(n))
			}
			return offset, &storage.NotDurableError{Durable: offset, Physical: offset + int64(n), Written: int64(n), Err: errors.New("INJECTED_FSYNC_EIO")}
		}
		r = bytes.NewReader(body)
	}
	return f.DiskStore.Append(ctx, key, offset, r)
}

type durHarness struct {
	ts     *httptest.Server
	svc    *Service
	st     *SQLiteStore
	disk   *faultDisk
	cookie *http.Cookie
	userID string
}

func newDurHarness(t *testing.T) *durHarness {
	t.Helper()
	ts, svc, st, mail := newFileServer(t)
	dir := t.TempDir()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	fd := &faultDisk{DiskStore: ds, dir: dir}
	svc.SetBlobStore(fd)
	cookie := loginCookie(t, ts, mail, "durable@example.com")
	u, err := st.UpsertUserByEmail(context.Background(), "durable@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	return &durHarness{ts: ts, svc: svc, st: st, disk: fd, cookie: cookie, userID: u.ID}
}

// restart swaps in a FRESH DiskStore over the same directory: same bytes, an
// empty record of what this process flushed.
func (h *durHarness) restart(t *testing.T) {
	t.Helper()
	ds, err := storage.NewDiskStore(h.disk.dir)
	if err != nil {
		t.Fatal(err)
	}
	h.disk = &faultDisk{DiskStore: ds, dir: h.disk.dir}
	h.svc.SetBlobStore(h.disk)
}

func (h *durHarness) row(t *testing.T, id string) UploadSessionRow {
	t.Helper()
	r, ok, err := h.st.GetUploadSession(context.Background(), id, h.userID)
	if err != nil || !ok {
		t.Fatalf("session %s: ok=%v err=%v", id, ok, err)
	}
	return r
}

func (h *durHarness) meter(t *testing.T) int64 {
	t.Helper()
	var n int64
	if err := h.st.db.QueryRow(`SELECT COALESCE(SUM(upload_bytes), 0) FROM usage_monthly WHERE user_id = ?`, h.userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (h *durHarness) status(t *testing.T, id string) int64 {
	t.Helper()
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/uploads/"+id, nil)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Received int64 `json:"received"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Received
}

func (h *durHarness) blob(t *testing.T, id string) []byte {
	t.Helper()
	b, err := os.ReadFile(h.disk.path(h.row(t, id).BlobKey))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func cipher(n int, seed byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = seed + byte(i%251)
	}
	return b
}

// Root's handler-level RED case, now safe: a failed flush is billed (accepted
// traffic) but never advertised as a resume offset, and the accepted tail is
// kept as evidence. A healthy replay of the SAME bytes then lands durably and
// costs nothing more: 512 billed once.
func TestAFailedFlushIsBilledButNeverResumedFrom(t *testing.T) {
	h := newDurHarness(t)
	data := cipher(512, 7)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 512, 0)
	h.disk.failWrites.Store(1)
	code, _ := patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512)
	if code != http.StatusInternalServerError {
		t.Fatalf("PATCH over a failed flush = %d; want 500 (no false ACK)", code)
	}
	if got := h.status(t, id); got != 0 {
		t.Fatalf("GET received = %d after a failed flush; want 0", got)
	}
	r := h.row(t, id)
	if r.Received != 0 || r.Metered != 512 {
		t.Fatalf("row received=%d metered=%d; want 0 / 512", r.Received, r.Metered)
	}
	if m := h.meter(t); m != 512 {
		t.Fatalf("meter = %d; the accepted 512 must be billed", m)
	}
	if n := len(h.blob(t, id)); n != 512 {
		t.Fatalf("blob holds %d bytes; the accepted tail must be kept until it is settled", n)
	}

	code, received := patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512)
	if code != http.StatusOK || received != 512 {
		t.Fatalf("healthy replay = %d received %d; want 200 512", code, received)
	}
	if r := h.row(t, id); r.Received != 512 || r.Metered != 512 {
		t.Fatalf("after replay received=%d metered=%d", r.Received, r.Metered)
	}
	if m := h.meter(t); m != 512 {
		t.Fatalf("meter = %d after the replay; want 512 billed exactly once", m)
	}
	if !bytes.Equal(h.blob(t, id), data) {
		t.Fatal("replayed ciphertext differs")
	}
}

// A retry that DEMOTES to a shorter chunk must not erase the larger accepted
// extent from the bill: the abandoned upload still owes the first 512.
func TestAShorterRetryKeepsTheLargerAcceptedExtentOwed(t *testing.T) {
	h := newDurHarness(t)
	data := cipher(512, 9)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 512, 0)
	h.disk.failWrites.Store(1)
	if code, _ := patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512); code != http.StatusInternalServerError {
		t.Fatalf("setup = %d", code)
	}
	code, received := patchChunk(t, h.ts, h.cookie, id, data, 0, 200, 512)
	if code != http.StatusConflict || received != 200 {
		t.Fatalf("shorter retry = %d %d", code, received)
	}
	r := h.row(t, id)
	if r.Received != 200 || r.Metered != 512 {
		t.Fatalf("received=%d metered=%d; the 512 accepted stays billed", r.Received, r.Metered)
	}
	if m := h.meter(t); m != 512 {
		t.Fatalf("meter = %d; want 512 (not 200, not 712)", m)
	}
	// Abandon: the reaper settles; nothing more and nothing less is owed.
	h.svc.ReapPendingUploads(h.svc.now().Unix() + pendingUploadTTL + 10)
	if m := h.meter(t); m != 512 {
		t.Fatalf("meter after reaping = %d; want 512", m)
	}
}

// The ledger commit fails on the not-durable append: nothing is billed yet, so
// the evidence must survive until a later commit settles it — no repair before.
func TestALostLedgerCommitKeepsTheEvidenceUntilItIsBilled(t *testing.T) {
	h := newDurHarness(t)
	flaky := newFlakyStore(h.st)
	h.svc.store = flaky
	data := cipher(512, 11)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 512, 0)
	h.disk.failWrites.Store(1)
	flaky.failNext("CommitUploadProgress", 1)
	if code, _ := patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512); code != http.StatusInternalServerError {
		t.Fatalf("setup = %d", code)
	}
	if r := h.row(t, id); r.Metered != 0 || r.Received != 0 {
		t.Fatalf("row after failed commit received=%d metered=%d", r.Received, r.Metered)
	}
	if n := len(h.blob(t, id)); n != 512 {
		t.Fatalf("unbilled evidence lost: blob %d bytes", n)
	}
	// Each fresh request settles once and never reuses its body. A shorter
	// request cannot destroy any of the retained, unbilled extent.
	flaky.failNext("CommitUploadProgress", 1)
	if code, _ := patchChunk(t, h.ts, h.cookie, id, data, 0, 200, 512); code != http.StatusInternalServerError {
		t.Fatalf("second attempt with a failing settle = %d; want 500", code)
	}
	if n := len(h.blob(t, id)); n != 512 || h.meter(t) != 0 {
		t.Fatalf("blob %d / meter %d; evidence must stay, nothing billed", n, h.meter(t))
	}
	// First healthy request settles the retained tail without consuming/reusing
	// its body; the next fresh request rewrites only the matching prefix.
	if code, _ := patchChunk(t, h.ts, h.cookie, id, data, 0, 200, 512); code != 500 || h.meter(t) != 512 || h.row(t, id).Received != 0 {
		t.Fatalf("settlement = %d meter %d; want 500, 512 billed, no durable progress", code, h.meter(t))
	}
	code, received := patchChunk(t, h.ts, h.cookie, id, data, 0, 200, 512)
	if code != http.StatusConflict || received != 200 || h.meter(t) != 512 || !bytes.Equal(h.blob(t, id), data) {
		t.Fatalf("recovery = %d %d meter %d; want 409 200, original 512 retained and billed once", code, received, h.meter(t))
	}
}

// Same process, the flush SUCCEEDED, but the commit failed (or the answer was
// lost): the store certified the size itself, so the retry re-syncs from the
// durable size without a replay, and the bytes are billed once.
func TestASameProcessLostCommitResyncsWithoutReplay(t *testing.T) {
	h := newDurHarness(t)
	flaky := newFlakyStore(h.st)
	h.svc.store = flaky
	data := cipher(512, 13)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 512, 0)
	flaky.failNext("CommitUploadProgress", 1)
	if code, _ := patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512); code != http.StatusInternalServerError {
		t.Fatalf("setup = %d", code)
	}
	code, received := patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512)
	if code != http.StatusConflict || received != 512 {
		t.Fatalf("retry = %d %d; want 409 with the certified 512", code, received)
	}
	if r := h.row(t, id); r.Received != 512 || h.meter(t) != 512 {
		t.Fatalf("received=%d meter=%d", r.Received, h.meter(t))
	}
}

// After a restart, a tail on disk that the database never recorded (a crash
// between the write and the commit) is accepted evidence but not a resume
// offset; the client's replay settles and repairs it, billed once per offset.
func TestAColdRestartTailIsBilledOnceAndReplayed(t *testing.T) {
	h := newDurHarness(t)
	data := cipher(600, 17)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 600, 0)
	if code, rec := patchChunk(t, h.ts, h.cookie, id, data, 0, 300, 600); code != 200 || rec != 300 {
		t.Fatalf("first chunk = %d %d", code, rec)
	}
	fh, err := os.OpenFile(h.disk.path(h.row(t, id).BlobKey), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.Write(data[300:500]); err != nil {
		t.Fatal(err)
	}
	fh.Close()
	h.restart(t)
	if got := h.status(t, id); got != 300 {
		t.Fatalf("GET after restart = %d; want the durable 300", got)
	}
	if code, _ := patchChunk(t, h.ts, h.cookie, id, data, 300, 600, 600); code != 500 || h.row(t, id).Received != 300 || h.meter(t) != 500 {
		t.Fatalf("cold settlement = %d; must bill 500 once without certifying the tail", code)
	}
	code, rec := patchChunk(t, h.ts, h.cookie, id, data, 300, 600, 600)
	if code != 200 || rec != 600 {
		t.Fatalf("replay after restart = %d %d; want 200 600", code, rec)
	}
	if r := h.row(t, id); r.Received != 600 || r.Metered != 600 || h.meter(t) != 600 {
		t.Fatalf("received=%d metered=%d meter=%d; want 600 each, every offset billed once", r.Received, r.Metered, h.meter(t))
	}
	if !bytes.Equal(h.blob(t, id), data) {
		t.Fatal("blob differs from the ciphertext")
	}
}

// A lying store cannot bill more than central actually read (this attempt's
// write) or, for evidence it claims was already there, more than the
// session's authorized max_size — the existing trust envelope, not a wider one.
func TestForgedNotDurableNumbersStayInsideTheTrustEnvelope(t *testing.T) {
	h := newDurHarness(t)
	data := cipher(100, 19)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 100, 0)
	maxSize := h.row(t, id).MaxSize
	h.disk.forge = func(offset, wrote int64) *storage.NotDurableError {
		return &storage.NotDurableError{Durable: offset, Physical: offset + 1<<40, Written: 1 << 40, Err: errors.New("forged")}
	}
	h.disk.failWrites.Store(1)
	patchChunk(t, h.ts, h.cookie, id, data, 0, 100, 100)
	if r := h.row(t, id); r.Received != 0 || r.Metered != 100 {
		t.Fatalf("forged write count: received=%d metered=%d; want 0 / the 100 central read", r.Received, r.Metered)
	}
	// A fresh upload (the first one's 100 accepted bytes are billed now, so its
	// next append would legitimately repair and land them): a store claiming a
	// huge tail was already there is held to max_size, never more.
	id2 := initUpload(t, h.ts, h.cookie, []byte("opaque"), 100, 0)
	h.disk.forge = func(offset, wrote int64) *storage.NotDurableError {
		return &storage.NotDurableError{Durable: offset, Physical: offset + 1<<40, Written: 0, Err: errors.New("forged")}
	}
	h.disk.failWrites.Store(1)
	if code, _ := patchChunk(t, h.ts, h.cookie, id2, data, 0, 100, 100); code != http.StatusInternalServerError {
		t.Fatalf("forged pre-existing tail answered %d; want 500", code)
	}
	if r := h.row(t, id2); r.Received != 0 || r.Metered != maxSize {
		t.Fatalf("forged pre-existing tail: received=%d metered=%d; want 0 and exactly the max_size %d clamp", r.Received, r.Metered, maxSize)
	}
}

// Concurrent same-key traffic after a failed flush: replays, stale probes and
// status reads race; whatever order they take, no answer advertises bytes as
// durable that are not, the blob ends as the ciphertext, and the meter is 512.
func TestConcurrentReplaysAfterAFailedFlushBillOnce(t *testing.T) {
	h := newDurHarness(t)
	data := cipher(512, 23)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 512, 0)
	h.disk.failWrites.Store(1)
	patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512)
	var wg sync.WaitGroup
	var bad atomic.Int64
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			code, rec := patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512)
			if (code == 200 || code == 409) && rec != 512 && rec != 0 {
				bad.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			if got := h.status(t, id); got != 0 && got != 512 {
				bad.Add(1)
			}
		}()
	}
	wg.Wait()
	if bad.Load() != 0 {
		t.Fatalf("%d answers advertised a non-durable offset", bad.Load())
	}
	if r := h.row(t, id); r.Received != 512 || h.meter(t) != 512 {
		t.Fatalf("received=%d meter=%d; want 512 / 512", r.Received, h.meter(t))
	}
	if !bytes.Equal(h.blob(t, id), data) {
		t.Fatal("blob differs")
	}
}

// The reaper bills a tail it finds (accepted) but never writes it into
// `received`, which a racing finalize would turn into an object's size.
// RED control: committing the probe's physical size as Committed.
func TestReaperNeverPromotesAnUncertifiedTail(t *testing.T) {
	h := newDurHarness(t)
	data := cipher(600, 29)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 600, 0)
	if code, rec := patchChunk(t, h.ts, h.cookie, id, data, 0, 300, 600); code != 200 || rec != 300 {
		t.Fatalf("first chunk = %d %d", code, rec)
	}
	fh, err := os.OpenFile(h.disk.path(h.row(t, id).BlobKey), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fh.Write(data[300:500])
	fh.Close()
	h.restart(t)
	if !h.svc.recoverUploadSize(context.Background(), h.row(t, id), h.svc.now().Unix()) {
		t.Fatal("recovery could not ask the blob")
	}
	r := h.row(t, id)
	if r.Received != 300 {
		t.Fatalf("reaper promoted the uncertified tail: received %d", r.Received)
	}
	if r.Metered != 500 || h.meter(t) != 500 {
		t.Fatalf("reaper billed metered=%d meter=%d; want the 500 accepted", r.Metered, h.meter(t))
	}
}

// End to end through the reaper's hand-off and GC: a not-durable tail billed at
// append time is not billed again when GC settles the blob, and the blob goes.
func TestGCDoesNotRebillAnAcceptedTail(t *testing.T) {
	h := newDurHarness(t)
	data := cipher(512, 31)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 512, 0)
	h.disk.failWrites.Store(1)
	patchChunk(t, h.ts, h.cookie, id, data, 0, 512, 512)
	key := h.row(t, id).BlobKey
	if h.meter(t) != 512 {
		t.Fatalf("setup meter %d", h.meter(t))
	}
	later := h.svc.now().Unix() + pendingUploadTTL + 10
	h.svc.ReapPendingUploads(later)
	g := &GC{Store: h.st, Blobs: h.disk, Now: func() int64 { return later + 1 }, Log: log.New(io.Discard, "", 0)}
	for i := 0; i < 3; i++ {
		g.sweep(context.Background())
	}
	if m := h.meter(t); m != 512 {
		t.Fatalf("meter after reap+GC = %d; want 512 (no rebill of the accepted tail)", m)
	}
	if _, err := os.Stat(h.disk.path(key)); !os.IsNotExist(err) {
		t.Fatalf("blob still present after GC settled it: %v", err)
	}
}

// v1TestNode is a storage node speaking relayium-append-durability-v1 the way
// cmd/relayium-node does (that package is main and cannot be imported): it
// answers a not-durable outcome with the echoed header and the JSON body, and
// passes a settled floor through. It never reads a body Append refused.
type v1TestNode struct {
	*httptest.Server
	dir     string
	ds      atomic.Pointer[storage.DiskStore]
	patches atomic.Int64
}

func newV1TestNode(t *testing.T) *v1TestNode {
	t.Helper()
	n := &v1TestNode{dir: t.TempDir()}
	n.restart(t)
	n.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			http.Error(w, "unsupported", http.StatusMethodNotAllowed)
			return
		}
		n.patches.Add(1)
		key := filepath.Base(r.URL.Path)
		off, _ := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
		ctx := r.Context()
		if v := r.Header.Get(storage.SettledThroughHeader); v != "" {
			settled, _ := strconv.ParseInt(v, 10, 64)
			ctx = storage.WithSettledThrough(ctx, settled)
		}
		w.Header().Set(storage.AppendDurabilityHeader, storage.AppendDurabilityV1)
		size, err := n.ds.Load().Append(ctx, key, off, r.Body)
		var nde *storage.NotDurableError
		switch {
		case errors.As(err, &nde):
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(storage.NotDurableBody{NotDurable: true, Durable: nde.Durable, Physical: nde.Physical, Written: nde.Written})
		case errors.Is(err, storage.ErrOffsetMismatch):
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
		case err != nil:
			http.Error(w, "append failed", http.StatusInternalServerError)
		default:
			_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
		}
	}))
	t.Cleanup(n.Server.Close)
	return n
}

func (n *v1TestNode) restart(t *testing.T) {
	t.Helper()
	ds, err := storage.NewDiskStore(n.dir)
	if err != nil {
		t.Fatal(err)
	}
	n.ds.Store(ds)
}

// Remote placement after a NODE restart: the cold tail is settled and then
// repaired even though the HTTP transport usually starts streaming the body
// before the node's refusal arrives (so it cannot be replayed in-request): the
// next request carries the settled floor up front. RED control: no floor on
// the first append -> every retry is refused forever.
func TestARemoteColdTailIsRepairedByTheNextRequest(t *testing.T) {
	h := newDurHarness(t)
	node := newV1TestNode(t)
	h.svc.SetBlobStore(storage.NewRemoteBlobStore(node.URL, "s", "", node.Client()))
	data := cipher(1000, 37)
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 1000, 0)
	if code, rec := patchChunk(t, h.ts, h.cookie, id, data, 0, 400, 1000); code != 200 || rec != 400 {
		t.Fatalf("first chunk = %d %d", code, rec)
	}
	key := h.row(t, id).BlobKey
	fh, err := os.OpenFile(filepath.Join(node.dir, key[:2], key), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fh.Write(data[400:700])
	fh.Close()
	node.restart(t)

	var code int
	var rec int64
	attempts := 0
	for attempts < 3 {
		attempts++
		code, rec = patchChunk(t, h.ts, h.cookie, id, data, 400, 1000, 1000)
		if code == 200 {
			break
		}
		if code != http.StatusInternalServerError {
			t.Fatalf("attempt %d = %d", attempts, code)
		}
		if got := h.status(t, id); got != 400 {
			t.Fatalf("GET after a refused attempt = %d; want the durable 400", got)
		}
	}
	if code != 200 || rec != 1000 || attempts > 2 {
		t.Fatalf("after %d attempt(s): %d %d; want 200 1000 within two", attempts, code, rec)
	}
	if r := h.row(t, id); r.Received != 1000 || r.Metered != 1000 || h.meter(t) != 1000 {
		t.Fatalf("received=%d metered=%d meter=%d; want 1000 each", r.Received, r.Metered, h.meter(t))
	}
	got, _ := os.ReadFile(filepath.Join(node.dir, key[:2], key))
	if !bytes.Equal(got, data) {
		t.Fatal("node blob differs from the ciphertext")
	}
	t.Logf("repaired in %d attempt(s), %d node PATCHes", attempts, node.patches.Load())
}
