package account

import (
	"bytes"
	"context"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// W-N33, restated for A33: a request whose client hangs up must leave the
// daily-quota ledger agreeing with the objects it created.
//
// W-N33 found that both upload routes reserved the debit with
// ReserveUpload(r.Context()) and then persisted with persistStoredFile(r.Context());
// a hangup in between failed the persist and, on the same dead context, the
// refund. W-N33 moved the refund to a detached context. A33 removed the
// window instead: the debit is now written by the object's own insert
// transaction (StoredFile.QuotaCharge), so there is no committed reservation
// and no refund. What remains to pin is the two sides of that one commit:
//
//   - cancelled BEFORE the insert: no object, no debit — and the bytes that
//     moved stay metered as traffic (W-N35);
//   - cancelled AFTER the insert committed: the object is real, so its debit is
//     kept, and a retry is a second real upload charged once more.
//
// The cancel is placed by a store hook rather than by a real client hangup, so
// the interleaving is exact rather than probable. Everything else is the
// production composition — Routes(), session auth, the real SQLite store and a
// real disk blob store. The hook also records any call to the retired
// ReserveUpload/RefundUpload, which must never happen now.

type cancelMode int

const (
	cancelNever cancelMode = iota
	cancelBeforeInsert
	cancelAfterInsert
)

type cancelInsertStore struct {
	Store
	mu      sync.Mutex
	mode    cancelMode
	cancel  context.CancelFunc
	inserts int      // capped inserts that committed an object
	legacy  []string // calls to ReserveUpload/RefundUpload
}

func (c *cancelInsertStore) arm(mode cancelMode, cancel context.CancelFunc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mode, c.cancel, c.inserts = mode, cancel, 0
}

func (c *cancelInsertStore) disarm() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mode, c.cancel = cancelNever, nil
}

func (c *cancelInsertStore) CreateStoredFileWithinStorageCaps(ctx context.Context, f StoredFile, now, userCap, globalCap int64) (StoredFileWrite, error) {
	c.mu.Lock()
	mode, cancel := c.mode, c.cancel
	c.mu.Unlock()
	if mode == cancelBeforeInsert && cancel != nil {
		cancel()
	}
	w, err := c.Store.CreateStoredFileWithinStorageCaps(ctx, f, now, userCap, globalCap)
	if err == nil && w.Reason == "" {
		c.mu.Lock()
		c.inserts++
		c.mu.Unlock()
		if mode == cancelAfterInsert && cancel != nil {
			cancel()
		}
	}
	return w, err
}

func (c *cancelInsertStore) ReserveUpload(ctx context.Context, e UploadEvent, since, quota int64) (bool, error) {
	c.mu.Lock()
	c.legacy = append(c.legacy, "ReserveUpload")
	c.mu.Unlock()
	return c.Store.ReserveUpload(ctx, e, since, quota)
}

func (c *cancelInsertStore) RefundUpload(ctx context.Context, id string) error {
	c.mu.Lock()
	c.legacy = append(c.legacy, "RefundUpload")
	c.mu.Unlock()
	return c.Store.RefundUpload(ctx, id)
}

type cancelHarness struct {
	ts      *httptest.Server
	handler http.Handler
	store   *SQLiteStore
	hook    *cancelInsertStore
	blobDir string
	cookie  *http.Cookie
	userID  string
	seedID  string
}

// seedBytes is a legitimate earlier upload in the same user's window. Anything
// that deletes the wrong event, or more than its own, takes it with it.
const seedBytes = 70000

func newCancelHarness(t *testing.T, email string) *cancelHarness {
	t.Helper()
	store := newTestStore(t)
	hook := &cancelInsertStore{Store: store}
	mail := &capturingMailer{}
	svc := NewService(hook, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		MaxFileSize: 1024, DailyQuota: 8 << 20, DefaultTTL: 3600, MaxTTL: 7200,
		DefaultRetention: retentionTTL,
	})
	blobDir := t.TempDir()
	disk, err := storage.NewDiskStore(blobDir)
	if err != nil {
		t.Fatalf("disk: %v", err)
	}
	svc.SetBlobStore(disk)
	h := svc.Routes()
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	cookie := loginCookie(t, ts, mail, email)
	u, err := store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatal(err)
	}
	seedID := "seed-" + u.ID
	if err := store.RecordUpload(context.Background(),
		UploadEvent{ID: seedID, UserID: u.ID, Bytes: seedBytes, UploadedAt: time.Now().Unix()}); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	return &cancelHarness{ts: ts, handler: h, store: store, hook: hook, blobDir: blobDir, cookie: cookie, userID: u.ID, seedID: seedID}
}

// serve runs one request through the real handler chain on a context the test
// owns, so the hook can cancel it at an exact point.
func (h *cancelHarness) serve(t *testing.T, mode cancelMode, method, target string, body *bytes.Buffer) int {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.hook.arm(mode, cancel)
	defer h.hook.disarm()
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, body)
	}
	req = req.WithContext(ctx)
	req.AddCookie(h.cookie)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec.Code
}

// cancelState counts upload events EXCLUDING the seed, which is reported
// separately.
type cancelState struct {
	events, eventBytes, files, blobs, meter int64
	seed                                    bool
}

func (h *cancelHarness) state(t *testing.T) cancelState {
	t.Helper()
	var s cancelState
	if err := h.store.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM upload_events WHERE user_id = ? AND id != ?`,
		h.userID, h.seedID).Scan(&s.events, &s.eventBytes); err != nil {
		t.Fatal(err)
	}
	var seedBytesNow int64
	if err := h.store.db.QueryRow(`SELECT COALESCE(SUM(bytes),0) FROM upload_events WHERE id = ? AND user_id = ?`,
		h.seedID, h.userID).Scan(&seedBytesNow); err != nil {
		t.Fatal(err)
	}
	s.seed = seedBytesNow == seedBytes
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE user_id = ?`,
		h.userID).Scan(&s.files); err != nil {
		t.Fatal(err)
	}
	if err := filepath.WalkDir(h.blobDir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			s.blobs++
		}
		return nil
	}); err != nil {
		t.Fatalf("walking blob dir: %v", err)
	}
	s.meter = uploadedThisMonth(t, h.store, h.userID)
	return s
}

func (h *cancelHarness) inserts() int {
	h.hook.mu.Lock()
	defer h.hook.mu.Unlock()
	return h.hook.inserts
}

// assertNoSeparateLedgerWrites: no upload route reserves or refunds on its
// own any more; the debit exists only as part of the object's insert.
func assertNoSeparateLedgerWrites(t *testing.T, h *cancelHarness) {
	t.Helper()
	h.hook.mu.Lock()
	defer h.hook.mu.Unlock()
	if len(h.hook.legacy) != 0 {
		t.Fatalf("separate ledger writes: %v, want none", h.hook.legacy)
	}
}

// lockedBuffer is a log sink that background goroutines may also write to.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureRefundLog captures the standard logger for one test. (The name is
// historical; the W-N35 meter tests read their failure lines through it.)
func captureRefundLog(t *testing.T) *lockedBuffer {
	t.Helper()
	var logs lockedBuffer
	previous := log.Writer()
	log.SetOutput(io.MultiWriter(&logs, os.Stderr))
	t.Cleanup(func() { log.SetOutput(previous) })
	return &logs
}

// --- single-shot POST /api/files -------------------------------------------

func singleShotBody() *bytes.Buffer {
	return uploadBody([]byte("MANIFEST"), bytes.Repeat([]byte("S"), 900))
}

func TestSingleShotUncancelledControlKeepsOneEventForOneFile(t *testing.T) {
	h := newCancelHarness(t, "ss-control@example.com")
	code := h.serve(t, cancelNever, "POST", "/api/files?ttl=0", singleShotBody())
	st := h.state(t)
	t.Logf("uncancelled single-shot: code=%d state=%+v", code, st)
	want := cancelState{events: 1, eventBytes: minBillableBytes, files: 1, blobs: 1, meter: 900, seed: true}
	if code != http.StatusOK || st != want || h.inserts() != 1 {
		t.Fatalf("control broken: code=%d state=%+v inserts=%d, want 200 %+v 1", code, st, h.inserts(), want)
	}
	assertNoSeparateLedgerWrites(t, h)
}

func TestSingleShotCancelBeforeInsertLeavesNoEvent(t *testing.T) {
	h := newCancelHarness(t, "ss-before@example.com")
	code := h.serve(t, cancelBeforeInsert, "POST", "/api/files?ttl=0", singleShotBody())
	st := h.state(t)
	t.Logf("cancel-before-insert single-shot: code=%d state=%+v", code, st)
	// The body was read and written before the refusal, so its 900 bytes of
	// traffic moved and are metered (W-N35); nothing else is kept or charged.
	want := cancelState{meter: 900, seed: true}
	if code != http.StatusInternalServerError || st != want {
		t.Fatalf("code=%d state=%+v, want 500 %+v (no event, file or blob; seed intact)", code, st, want)
	}
	assertNoSeparateLedgerWrites(t, h)

	// A retry is a fresh upload, charged once: one debit, and its own 900
	// bytes of traffic on top of the cancelled attempt's.
	rcode := h.serve(t, cancelNever, "POST", "/api/files?ttl=0", singleShotBody())
	rs := h.state(t)
	rwant := cancelState{events: 1, eventBytes: minBillableBytes, files: 1, blobs: 1, meter: 1800, seed: true}
	if rcode != http.StatusOK || rs != rwant {
		t.Fatalf("retry: code=%d state=%+v, want 200 %+v", rcode, rs, rwant)
	}
	assertNoSeparateLedgerWrites(t, h)
}

func TestSingleShotCancelAfterInsertKeepsObjectAndDebit(t *testing.T) {
	h := newCancelHarness(t, "ss-after@example.com")
	code := h.serve(t, cancelAfterInsert, "POST", "/api/files?ttl=0", singleShotBody())
	st := h.state(t)
	t.Logf("cancel-after-insert single-shot: code=%d state=%+v", code, st)
	// The object committed with its debit. The caller leaving afterwards
	// changes neither: the object is real and listed, so its debit stays (I6).
	want := cancelState{events: 1, eventBytes: minBillableBytes, files: 1, blobs: 1, meter: 900, seed: true}
	if st != want || h.inserts() != 1 {
		t.Fatalf("state=%+v inserts=%d, want %+v 1 (object and debit both kept)", st, h.inserts(), want)
	}
	// A retry is a second real upload: a second object with its own debit.
	rcode := h.serve(t, cancelNever, "POST", "/api/files?ttl=0", singleShotBody())
	rs := h.state(t)
	rwant := cancelState{events: 2, eventBytes: 2 * minBillableBytes, files: 2, blobs: 2, meter: 1800, seed: true}
	if rcode != http.StatusOK || rs != rwant {
		t.Fatalf("retry: code=%d state=%+v, want 200 %+v", rcode, rs, rwant)
	}
	assertNoSeparateLedgerWrites(t, h)
}

// --- resumable POST /api/uploads/{id}/finalize ------------------------------

func (h *cancelHarness) landSession(t *testing.T) string {
	t.Helper()
	blob := bytes.Repeat([]byte("R"), 900)
	id := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), len(blob), 0)
	if code, got := patchChunk(t, h.ts, h.cookie, id, blob, 0, len(blob), len(blob)); code != 200 || got != 900 {
		t.Fatalf("patch: code=%d received=%d", code, got)
	}
	return id
}

func TestFinalizeUncancelledControlKeepsOneEventForOneFile(t *testing.T) {
	h := newCancelHarness(t, "fin-control@example.com")
	id := h.landSession(t)
	code := h.serve(t, cancelNever, "POST", "/api/uploads/"+id+"/finalize", nil)
	st := h.state(t)
	t.Logf("uncancelled finalize: code=%d state=%+v", code, st)
	want := cancelState{events: 1, eventBytes: minBillableBytes, files: 1, blobs: 1, meter: 900, seed: true}
	if code != http.StatusOK || st != want || h.inserts() != 1 {
		t.Fatalf("control broken: code=%d state=%+v inserts=%d, want 200 %+v 1", code, st, h.inserts(), want)
	}
	assertNoSeparateLedgerWrites(t, h)
}

func TestFinalizeCancelBeforeInsertLeavesNoEvent(t *testing.T) {
	h := newCancelHarness(t, "fin-before@example.com")
	id := h.landSession(t)
	before := h.state(t)
	code := h.serve(t, cancelBeforeInsert, "POST", "/api/uploads/"+id+"/finalize", nil)
	st := h.state(t)
	tomb := sessionRowExists(t, h.store, id, h.userID)
	t.Logf("cancel-before-insert finalize: code=%d before=%+v after=%+v tombstone=%v", code, before, st, tomb)
	// The session's 900 bytes were metered as they arrived and stay billed.
	wantBefore := cancelState{blobs: 1, meter: 900, seed: true}
	wantAfter := cancelState{meter: 900, seed: true}
	if code != http.StatusInternalServerError || before != wantBefore || st != wantAfter {
		t.Fatalf("code=%d state: before=%+v after=%+v, want 500, %+v then %+v", code, before, st, wantBefore, wantAfter)
	}
	// The tombstone semantics are unchanged: the claim was terminal, so the
	// same session answers 409 and charges nothing more.
	rcode := h.serve(t, cancelNever, "POST", "/api/uploads/"+id+"/finalize", nil)
	rs := h.state(t)
	if !tomb || rcode != http.StatusConflict || rs != wantAfter {
		t.Fatalf("tombstone/retry: row=%v retry=%d state=%+v, want row kept, 409, %+v", tomb, rcode, rs, wantAfter)
	}
	assertNoSeparateLedgerWrites(t, h)
}

func TestFinalizeCancelAfterInsertKeepsObjectAndDebit(t *testing.T) {
	h := newCancelHarness(t, "fin-after@example.com")
	id := h.landSession(t)
	code := h.serve(t, cancelAfterInsert, "POST", "/api/uploads/"+id+"/finalize", nil)
	st := h.state(t)
	t.Logf("cancel-after-insert finalize: code=%d state=%+v", code, st)
	want := cancelState{events: 1, eventBytes: minBillableBytes, files: 1, blobs: 1, meter: 900, seed: true}
	if st != want || h.inserts() != 1 {
		t.Fatalf("state=%+v inserts=%d, want %+v 1 (object and debit both kept)", st, h.inserts(), want)
	}
	// A retried finalize of the same session is refused and charges nothing.
	rcode := h.serve(t, cancelNever, "POST", "/api/uploads/"+id+"/finalize", nil)
	if rs := h.state(t); rcode != http.StatusConflict || rs != want {
		t.Fatalf("retry: code=%d state=%+v, want 409 %+v", rcode, rs, want)
	}
	assertNoSeparateLedgerWrites(t, h)
}
