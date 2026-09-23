package account

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// W-N33: a request cancelled AFTER its daily-quota reservation committed must
// not leave that reservation behind with no stored file.
//
// Both upload routes reserve with ReserveUpload(r.Context()) and then persist
// with persistStoredFile(r.Context()). If the client hangs up in between, the
// persist fails on the cancelled context, and the refund used to run on that
// same context: it failed too, the error was discarded, and the user stayed
// charged daily quota for a file that never landed.
//
// The cancel is placed by a store hook rather than by a real client hangup, so
// the interleaving is exact rather than probable: the hook calls the real
// ReserveUpload and cancels the request's context only after it returned ok.
// Everything else is the production composition — Routes(), session auth, the
// real SQLite store and a real disk blob store. RefundUpload is observed, not
// replaced, except where a test injects a store failure.

type cancelMode int

const (
	cancelNever cancelMode = iota
	cancelAfterReserve
	cancelBeforeReserve
)

type cancelCtxKey struct{}

const cancelCtxValue = "w-n33-request-value"

// refundCall is what the hook saw when a handler asked for a refund.
type refundCall struct {
	id          string
	ctxErr      error // the context's state at the call: must be live
	hasDeadline bool
	budget      time.Duration // time left on the context at the call
	value       any           // the request's context value, if it survived
	err         error         // what RefundUpload returned
}

type cancelReserveStore struct {
	Store
	mu       sync.Mutex
	mode     cancelMode
	cancel   context.CancelFunc
	reserved []string // IDs of reservations that actually committed
	refunds  []refundCall
	// failRefund, when set, makes RefundUpload return it without touching the
	// store — a database failure the detached context cannot prevent.
	failRefund error
}

func (c *cancelReserveStore) arm(mode cancelMode, cancel context.CancelFunc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mode, c.cancel, c.reserved, c.refunds = mode, cancel, nil, nil
}

// disarm stops cancelling but keeps the records, so they can be read after
// the request.
func (c *cancelReserveStore) disarm() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mode, c.cancel = cancelNever, nil
}

func (c *cancelReserveStore) ReserveUpload(ctx context.Context, e UploadEvent, since, quota int64) (bool, error) {
	c.mu.Lock()
	mode, cancel := c.mode, c.cancel
	c.mu.Unlock()
	if mode == cancelBeforeReserve && cancel != nil {
		cancel()
	}
	ok, err := c.Store.ReserveUpload(ctx, e, since, quota)
	if ok && err == nil {
		c.mu.Lock()
		c.reserved = append(c.reserved, e.ID)
		c.mu.Unlock()
		if mode == cancelAfterReserve && cancel != nil {
			cancel()
		}
	}
	return ok, err
}

func (c *cancelReserveStore) RefundUpload(ctx context.Context, id string) error {
	call := refundCall{id: id, ctxErr: ctx.Err(), value: ctx.Value(cancelCtxKey{})}
	if dl, ok := ctx.Deadline(); ok {
		call.hasDeadline, call.budget = true, time.Until(dl)
	}
	c.mu.Lock()
	inject := c.failRefund
	c.mu.Unlock()
	if inject != nil {
		call.err = inject
	} else {
		call.err = c.Store.RefundUpload(ctx, id)
	}
	c.mu.Lock()
	c.refunds = append(c.refunds, call)
	c.mu.Unlock()
	return call.err
}

type cancelHarness struct {
	ts      *httptest.Server
	handler http.Handler
	store   *SQLiteStore
	hook    *cancelReserveStore
	blobDir string
	cookie  *http.Cookie
	userID  string
	seedID  string
}

// seedBytes is a legitimate earlier upload in the same user's window. A refund
// that deletes the wrong event, or more than its own, takes it with it.
const seedBytes = 70000

func newCancelHarness(t *testing.T, email string) *cancelHarness {
	t.Helper()
	store := newTestStore(t)
	hook := &cancelReserveStore{Store: store}
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
	now := time.Now().Unix()
	if ok, err := store.ReserveUpload(context.Background(),
		UploadEvent{ID: seedID, UserID: u.ID, Bytes: seedBytes, UploadedAt: now}, now-dayWindow, 8<<20); err != nil || !ok {
		t.Fatalf("seed event: ok=%v err=%v", ok, err)
	}
	return &cancelHarness{ts: ts, handler: h, store: store, hook: hook, blobDir: blobDir, cookie: cookie, userID: u.ID, seedID: seedID}
}

// serve runs one request through the real handler chain on a context the test
// owns — carrying a value the refund must still see — so the hook can cancel
// it at an exact point.
func (h *cancelHarness) serve(t *testing.T, mode cancelMode, method, target string, body *bytes.Buffer) int {
	t.Helper()
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), cancelCtxKey{}, cancelCtxValue))
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

func (h *cancelHarness) records() (reserved []string, refunds []refundCall) {
	h.hook.mu.Lock()
	defer h.hook.mu.Unlock()
	return append([]string(nil), h.hook.reserved...), append([]refundCall(nil), h.hook.refunds...)
}

func (h *cancelHarness) eventExists(t *testing.T, id string) bool {
	t.Helper()
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM upload_events WHERE id = ?`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}

// assertNoRefund: nothing that was not reserved, and nothing that succeeded,
// is ever refunded.
func assertNoRefund(t *testing.T, h *cancelHarness) {
	t.Helper()
	if _, refunds := h.records(); len(refunds) != 0 {
		t.Fatalf("refund called %d time(s), want none: %+v", len(refunds), refunds)
	}
}

// assertLiveRefundOf: exactly one refund, of exactly the one reservation that
// committed, on a live, bounded context that still carries the request's
// values. Returns the refunded ID.
func assertLiveRefundOf(t *testing.T, h *cancelHarness) string {
	t.Helper()
	reserved, refunds := h.records()
	if len(reserved) != 1 {
		t.Fatalf("reservations committed: %v, want exactly 1", reserved)
	}
	if len(refunds) != 1 {
		t.Fatalf("refund calls: %+v, want exactly 1", refunds)
	}
	c := refunds[0]
	if c.id != reserved[0] {
		t.Fatalf("refunded %q, want the reservation %q", c.id, reserved[0])
	}
	if c.ctxErr != nil {
		t.Fatalf("refund ran on a dead context: %v", c.ctxErr)
	}
	if !c.hasDeadline || c.budget <= 0 || c.budget > uploadRefundBudget {
		t.Fatalf("refund context budget: deadline=%v left=%v, want bounded by %v", c.hasDeadline, c.budget, uploadRefundBudget)
	}
	if c.value != cancelCtxValue {
		t.Fatalf("refund context lost the request's values: got %v", c.value)
	}
	return c.id
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
	if code != http.StatusOK || st != want {
		t.Fatalf("control broken: code=%d state=%+v, want 200 %+v", code, st, want)
	}
	if reserved, _ := h.records(); len(reserved) != 1 {
		t.Fatalf("reservations: %v, want 1", reserved)
	}
	assertNoRefund(t, h)
}

func TestSingleShotCancelBeforeReserveLeavesNoEvent(t *testing.T) {
	h := newCancelHarness(t, "ss-before@example.com")
	code := h.serve(t, cancelBeforeReserve, "POST", "/api/files?ttl=0", singleShotBody())
	st := h.state(t)
	t.Logf("cancel-before-reserve single-shot: code=%d state=%+v", code, st)
	// The body was read and written before the refusal, so its 900 bytes of
	// traffic moved and are metered (W-N35); nothing else is kept or charged.
	want := cancelState{meter: 900, seed: true}
	if code == http.StatusOK || st != want {
		t.Fatalf("control broken: code=%d state=%+v, want non-200 %+v", code, st, want)
	}
	if reserved, _ := h.records(); len(reserved) != 0 {
		t.Fatalf("reservations: %v, want none", reserved)
	}
	assertNoRefund(t, h)
}

func TestSingleShotCancelAfterReserveRefundsDailyQuota(t *testing.T) {
	h := newCancelHarness(t, "ss-after@example.com")
	before := h.state(t)
	code := h.serve(t, cancelAfterReserve, "POST", "/api/files?ttl=0", singleShotBody())
	st := h.state(t)
	t.Logf("cancel-after-reserve single-shot: code=%d before=%+v after=%+v", code, before, st)
	if code != http.StatusInternalServerError {
		t.Fatalf("cancelled upload answered %d, want 500", code)
	}
	id := assertLiveRefundOf(t, h)
	// The daily-quota reservation is refunded, but the 900 bytes this request
	// moved stay metered as monthly traffic (W-N35): a refund is a quota
	// correction, not a traffic refund.
	wantBefore := cancelState{seed: true}
	want := cancelState{meter: 900, seed: true}
	if before != wantBefore || st != want {
		t.Fatalf("state: before=%+v after=%+v, want %+v then %+v (no event, file or blob; 900 bytes of traffic; seed intact)", before, st, wantBefore, want)
	}
	if h.eventExists(t, id) {
		t.Fatalf("reservation %s still charged", id)
	}

	// A retry is a fresh upload and is charged once: one daily-quota event, and
	// its own 900 bytes of traffic on top of the cancelled attempt's 900.
	rcode := h.serve(t, cancelNever, "POST", "/api/files?ttl=0", singleShotBody())
	rs := h.state(t)
	t.Logf("retry after cancelled single-shot: code=%d state=%+v", rcode, rs)
	rwant := cancelState{events: 1, eventBytes: minBillableBytes, files: 1, blobs: 1, meter: 1800, seed: true}
	if rcode != http.StatusOK || rs != rwant {
		t.Fatalf("retry: code=%d state=%+v, want 200 %+v", rcode, rs, rwant)
	}
	assertNoRefund(t, h)
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
	if code != http.StatusOK || st != want {
		t.Fatalf("control broken: code=%d state=%+v, want 200 %+v", code, st, want)
	}
	if reserved, _ := h.records(); len(reserved) != 1 {
		t.Fatalf("reservations: %v, want 1", reserved)
	}
	assertNoRefund(t, h)
}

func TestFinalizeCancelBeforeReserveLeavesNoEvent(t *testing.T) {
	h := newCancelHarness(t, "fin-before@example.com")
	id := h.landSession(t)
	code := h.serve(t, cancelBeforeReserve, "POST", "/api/uploads/"+id+"/finalize", nil)
	st := h.state(t)
	t.Logf("cancel-before-reserve finalize: code=%d state=%+v", code, st)
	want := cancelState{meter: 900, seed: true}
	if code == http.StatusOK || st != want {
		t.Fatalf("control broken: code=%d state=%+v, want non-200 %+v", code, st, want)
	}
	if reserved, _ := h.records(); len(reserved) != 0 {
		t.Fatalf("reservations: %v, want none", reserved)
	}
	assertNoRefund(t, h)
}

func TestFinalizeCancelAfterReserveRefundsDailyQuota(t *testing.T) {
	h := newCancelHarness(t, "fin-after@example.com")
	id := h.landSession(t)
	before := h.state(t)
	code := h.serve(t, cancelAfterReserve, "POST", "/api/uploads/"+id+"/finalize", nil)
	st := h.state(t)
	tomb := sessionRowExists(t, h.store, id, h.userID)
	t.Logf("cancel-after-reserve finalize: code=%d before=%+v after=%+v tombstone=%v", code, before, st, tomb)
	if code != http.StatusInternalServerError {
		t.Fatalf("cancelled finalize answered %d, want 500", code)
	}
	evID := assertLiveRefundOf(t, h)
	// The session's 900 bytes were metered as they arrived and stay billed.
	wantBefore := cancelState{blobs: 1, meter: 900, seed: true}
	wantAfter := cancelState{meter: 900, seed: true}
	if before != wantBefore || st != wantAfter {
		t.Fatalf("state: before=%+v after=%+v, want %+v then %+v", before, st, wantBefore, wantAfter)
	}
	if h.eventExists(t, evID) {
		t.Fatalf("reservation %s still charged", evID)
	}
	// The tombstone semantics are unchanged: the claim was terminal, so the
	// same session answers 409 and charges nothing more.
	rcode := h.serve(t, cancelNever, "POST", "/api/uploads/"+id+"/finalize", nil)
	rs := h.state(t)
	t.Logf("retry finalize of the same session: code=%d state=%+v", rcode, rs)
	if !tomb || rcode != http.StatusConflict || rs != wantAfter {
		t.Fatalf("tombstone/retry: row=%v retry=%d state=%+v, want row kept, 409, %+v", tomb, rcode, rs, wantAfter)
	}
	assertNoRefund(t, h)
}

// --- a refund the store itself refuses ---------------------------------------

// A refund can still fail for a reason the detached context does not cover
// (a locked or broken database). The handler must say so in the log, keep the
// upload refused, and never behave as if the quota had been returned: the
// reservation stays in the ledger rather than being credited on faith.
func TestCancelAfterReserveRefundFailureIsLoggedNotCredited(t *testing.T) {
	injected := errors.New("injected refund failure: database is locked")
	routes := []struct {
		name      string
		prepare   func(h *cancelHarness) (method, target string, body func() *bytes.Buffer)
		wantMeter int64
	}{
		{"single-shot", func(h *cancelHarness) (string, string, func() *bytes.Buffer) {
			return "POST", "/api/files?ttl=0", singleShotBody
		}, 900},
		{"finalize", func(h *cancelHarness) (string, string, func() *bytes.Buffer) {
			id := h.landSession(t)
			return "POST", "/api/uploads/" + id + "/finalize", func() *bytes.Buffer { return nil }
		}, 900},
	}
	for _, rt := range routes {
		t.Run(rt.name, func(t *testing.T) {
			h := newCancelHarness(t, "refund-fail-"+rt.name+"@example.com")
			method, target, body := rt.prepare(h)
			h.hook.failRefund = injected
			logs := captureRefundLog(t)
			code := h.serve(t, cancelAfterReserve, method, target, body())
			st := h.state(t)
			t.Logf("%s with failing refund: code=%d state=%+v", rt.name, code, st)
			if code != http.StatusInternalServerError {
				t.Fatalf("answered %d, want 500", code)
			}
			id := assertLiveRefundOf(t, h)
			if _, refunds := h.records(); !errors.Is(refunds[0].err, injected) {
				t.Fatalf("refund error: %v, want the injected one", refunds[0].err)
			}
			want := cancelState{events: 1, eventBytes: minBillableBytes, meter: rt.wantMeter, seed: true}
			if st != want || !h.eventExists(t, id) {
				t.Fatalf("state=%+v reservationKept=%v, want %+v with the reservation still charged", st, h.eventExists(t, id), want)
			}
			out := logs.String()
			if !strings.Contains(out, id) || !strings.Contains(out, injected.Error()) {
				t.Fatalf("refund failure for %s not logged; log:\n%s", id, out)
			}
		})
	}
}
