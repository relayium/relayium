package account

// Harness for the A33 daily-quota ledger tests (upload_quota_*_test.go).
//
// The debit an upload leaves in upload_events must track the objects it
// created exactly: one debit of max(size, minBillableBytes) per billable
// object, none for a refused, failed, crashed or own-node upload. These tests
// check that against the production composition rather than a model of it:
//
//   - Service.Routes() behind a real httptest TCP listener;
//   - a FILE-backed SQLite store opened by OpenSQLite (WAL, busy_timeout,
//     _txlock=immediate — exactly as production opens it), so a restart can
//     reopen the same database and blob directory;
//   - a real storage.DiskStore for central blobs;
//   - raw TCP clients, so "the caller is gone" is a real socket close that
//     net/http turns into a cancelled request context.
//
// The store wrapper only observes and pauses: every write lands in the real
// store. It also records any call to the retired ReserveUpload/RefundUpload,
// which no upload handler may make any more.

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

type quotaPoint string

const (
	// qpPersistBefore: the handler is about to call the capped insert.
	qpPersistBefore quotaPoint = "persist.before"
	// qpPersistAfter: the capped insert committed an object.
	qpPersistAfter quotaPoint = "persist.after"
	// qpClaimAfter: a finalize's terminal claim committed.
	qpClaimAfter quotaPoint = "claim.after"
)

// quotaHookStore pauses at one armed point, runs an optional callback at every
// point, and records what the handlers asked of the ledger.
type quotaHookStore struct {
	Store
	mu      sync.Mutex
	armed   quotaPoint
	entered chan context.Context
	release chan struct{}
	onPoint func(p quotaPoint, ctx context.Context)

	persistErrs []error  // every capped-insert error, in order
	reasons     []string // every capped-insert refusal Reason, in order
	legacy      []string // calls to the retired ReserveUpload/RefundUpload
}

func newQuotaHookStore(inner Store) *quotaHookStore {
	return &quotaHookStore{Store: inner, entered: make(chan context.Context, 1), release: make(chan struct{})}
}

func (q *quotaHookStore) arm(p quotaPoint) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.armed = p
	q.release = make(chan struct{})
}

func (q *quotaHookStore) setOnPoint(f func(p quotaPoint, ctx context.Context)) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.onPoint = f
}

func (q *quotaHookStore) hit(ctx context.Context, p quotaPoint) {
	q.mu.Lock()
	cb := q.onPoint
	armed := q.armed == p
	rel := q.release
	if armed {
		q.armed = ""
	}
	q.mu.Unlock()
	if cb != nil {
		cb(p, ctx)
	}
	if !armed {
		return
	}
	q.entered <- ctx
	<-rel
}

func (q *quotaHookStore) open() {
	q.mu.Lock()
	defer q.mu.Unlock()
	select {
	case <-q.release:
	default:
		close(q.release)
	}
}

func (q *quotaHookStore) ReserveUpload(ctx context.Context, e UploadEvent, since, quota int64) (bool, error) {
	q.mu.Lock()
	q.legacy = append(q.legacy, "ReserveUpload "+e.ID)
	q.mu.Unlock()
	return q.Store.ReserveUpload(ctx, e, since, quota)
}

func (q *quotaHookStore) RefundUpload(ctx context.Context, id string) error {
	q.mu.Lock()
	q.legacy = append(q.legacy, "RefundUpload "+id)
	q.mu.Unlock()
	return q.Store.RefundUpload(ctx, id)
}

func (q *quotaHookStore) CreateStoredFileWithinStorageCaps(ctx context.Context, sf StoredFile, now, userCap, globalCap int64) (StoredFileWrite, error) {
	q.hit(ctx, qpPersistBefore)
	w, err := q.Store.CreateStoredFileWithinStorageCaps(ctx, sf, now, userCap, globalCap)
	q.mu.Lock()
	if err != nil {
		q.persistErrs = append(q.persistErrs, err)
	}
	if w.Reason != "" {
		q.reasons = append(q.reasons, w.Reason)
	}
	q.mu.Unlock()
	if err == nil && w.Reason == "" {
		q.hit(ctx, qpPersistAfter)
	}
	return w, err
}

func (q *quotaHookStore) ClaimUploadDone(ctx context.Context, id string, now int64) (int64, int64, bool, error) {
	r, b, ok, err := q.Store.ClaimUploadDone(ctx, id, now)
	if ok && err == nil {
		q.hit(ctx, qpClaimAfter)
	}
	return r, b, ok, err
}

func (q *quotaHookStore) legacyCalls() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]string(nil), q.legacy...)
}

func (q *quotaHookStore) persistErrors() []error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]error(nil), q.persistErrs...)
}

func (q *quotaHookStore) refusals() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]string(nil), q.reasons...)
}

// ---- handler completion observer -------------------------------------------

type quotaStatusWriter struct {
	http.ResponseWriter
	code int
}

func (w *quotaStatusWriter) WriteHeader(c int) {
	if w.code == 0 {
		w.code = c
	}
	w.ResponseWriter.WriteHeader(c)
}

func (w *quotaStatusWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *quotaStatusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type quotaDone struct {
	method, path string
	code         int
	ctxErr       error
}

// ---- harness -----------------------------------------------------------------

type quotaHarness struct {
	t       *testing.T
	dir     string
	dbPath  string
	blobDir string
	store   *SQLiteStore
	hook    *quotaHookStore
	svc     *Service
	ts      *httptest.Server
	cookie  *http.Cookie
	userID  string
	done    chan quotaDone
}

type quotaOpts struct {
	dir        string // reuse a data dir (a restart); "" = a fresh one
	dailyQuota int64
	email      string
}

func newQuotaHarness(t *testing.T, o quotaOpts) *quotaHarness {
	t.Helper()
	dir := o.dir
	if dir == "" {
		dir = t.TempDir()
	}
	if o.dailyQuota == 0 {
		o.dailyQuota = 8 << 20
	}
	if o.email == "" {
		o.email = "quota@example.com"
	}
	dbPath := filepath.Join(dir, "relayium.db")
	store, err := OpenSQLite(dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	hook := newQuotaHookStore(store)
	mail := &capturingMailer{}
	svc := NewService(hook, mail, Config{
		BaseURL: "http://example.test", SessionTTL: 48 * time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		MaxFileSize: 1 << 20, DailyQuota: o.dailyQuota, DefaultTTL: 3600, MaxTTL: 7200,
		DefaultRetention: retentionTTL,
	})
	svc.nodeHTTP.Transport.(*http.Transport).DialContext = guardedDialContext(true)
	blobDir := filepath.Join(dir, "blobs")
	disk, err := storage.NewDiskStore(blobDir)
	if err != nil {
		t.Fatalf("disk: %v", err)
	}
	svc.SetBlobStore(disk)
	h := &quotaHarness{t: t, dir: dir, dbPath: dbPath, blobDir: blobDir, store: store, hook: hook, svc: svc,
		done: make(chan quotaDone, 256)}
	routes := svc.Routes()
	h.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &quotaStatusWriter{ResponseWriter: w}
		routes.ServeHTTP(sw, r)
		select {
		case h.done <- quotaDone{method: r.Method, path: r.URL.Path, code: sw.code, ctxErr: r.Context().Err()}:
		default:
		}
	}))
	t.Cleanup(func() { hook.open(); h.ts.Close() })
	h.cookie = loginCookie(t, h.ts, mail, o.email)
	u, err := store.UpsertUserByEmail(context.Background(), o.email, "")
	if err != nil {
		t.Fatal(err)
	}
	h.userID = u.ID
	h.drainDone()
	return h
}

func (h *quotaHarness) drainDone() {
	for {
		select {
		case <-h.done:
		default:
			return
		}
	}
}

// waitDone waits for the handler serving `method pathPrefix` to return.
func (h *quotaHarness) waitDone(method, pathPrefix string) quotaDone {
	h.t.Helper()
	deadline := time.After(60 * time.Second)
	for {
		select {
		case d := <-h.done:
			if d.method == method && strings.HasPrefix(d.path, pathPrefix) {
				return d
			}
		case <-deadline:
			h.t.Fatalf("handler %s %s never returned", method, pathPrefix)
		}
	}
}

// rawSend writes one complete HTTP/1.1 request on a fresh TCP connection and
// returns the connection unread.
func (h *quotaHarness) rawSend(method, path string, body []byte, hdr map[string]string) (net.Conn, *http.Request) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.ts.URL+path, bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.AddCookie(h.cookie)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	conn, err := net.Dial("tcp", h.ts.Listener.Addr().String())
	if err != nil {
		h.t.Fatal(err)
	}
	if err := req.Write(conn); err != nil {
		h.t.Fatal(err)
	}
	return conn, req
}

// quotaReadResp reads one response. It must not call t.Fatal: it also runs on
// goroutines other than the test's.
func quotaReadResp(conn net.Conn, req *http.Request) (int, map[string]any, error) {
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return resp.StatusCode, m, nil
}

// do performs one fully answered request and waits for its handler to return.
func (h *quotaHarness) do(method, path string, body []byte) (int, map[string]any) {
	h.t.Helper()
	conn, req := h.rawSend(method, path, body, nil)
	defer conn.Close()
	code, m, err := quotaReadResp(conn, req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	h.waitDone(method, strings.SplitN(path, "?", 2)[0])
	return code, m
}

// closeAt sends the whole request, waits for the handler to reach p, closes
// the TCP connection there (the caller is gone), waits for net/http to cancel
// the request context, then lets the handler continue. It returns the
// handler's final status and whether the context was seen cancelled at p.
func (h *quotaHarness) closeAt(p quotaPoint, method, path string, body []byte) (quotaDone, bool) {
	h.t.Helper()
	h.hook.arm(p)
	conn, _ := h.rawSend(method, path, body, nil)
	var ctx context.Context
	select {
	case ctx = <-h.hook.entered:
	case d := <-h.done:
		h.t.Fatalf("handler returned %d before reaching %s", d.code, p)
	case <-time.After(20 * time.Second):
		h.t.Fatalf("never reached %s", p)
	}
	_ = conn.Close()
	cancelled := false
	select {
	case <-ctx.Done():
		cancelled = true
	case <-time.After(3 * time.Second):
	}
	h.hook.open()
	d := h.waitDone(method, strings.SplitN(path, "?", 2)[0])
	return d, cancelled
}

// quotaLedger is one user's ledger next to what it is supposed to track.
type quotaLedger struct {
	Events       int64 // upload_events rows
	EventBytes   int64 // their bytes
	Files        int64 // stored_files rows
	FileDebit    int64 // Σ max(size, minBillableBytes) over those rows
	CentralBlobs int64 // regular files under the central blob dir
	Meter        int64 // this month's upload traffic
	DoneSessions int64 // finalize-claimed session rows (tombstones)
}

func quotaLedgerOf(t *testing.T, store *SQLiteStore, userID, blobDir string) quotaLedger {
	t.Helper()
	var l quotaLedger
	q := func(dst any, query string, args ...any) {
		if err := store.db.QueryRow(query, args...).Scan(dst); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	q(&l.Events, `SELECT COUNT(*) FROM upload_events WHERE user_id=?`, userID)
	q(&l.EventBytes, `SELECT COALESCE(SUM(bytes),0) FROM upload_events WHERE user_id=?`, userID)
	q(&l.Files, `SELECT COUNT(*) FROM stored_files WHERE user_id=?`, userID)
	q(&l.FileDebit, `SELECT COALESCE(SUM(MAX(size, ?)),0) FROM stored_files WHERE user_id=?`, minBillableBytes, userID)
	q(&l.DoneSessions, `SELECT COUNT(*) FROM upload_sessions WHERE user_id=? AND done=1`, userID)
	l.CentralBlobs = countRegularFiles(t, blobDir)
	l.Meter = uploadedThisMonth(t, store, userID)
	return l
}

func (h *quotaHarness) ledger() quotaLedger {
	h.t.Helper()
	return quotaLedgerOf(h.t, h.store, h.userID, h.blobDir)
}

// assertOneDebitPerObject is invariant I1+I2: the user's debits are exactly one
// per stored object, each max(size, minBillableBytes) — never a debit without
// an object (a phantom charge), never an object without its debit (a free
// upload), never two debits for one object (a double charge).
func (h *quotaHarness) assertOneDebitPerObject(what string) quotaLedger {
	h.t.Helper()
	l := h.ledger()
	h.t.Logf("INVARIANT %-44s events=%d eventBytes=%d files=%d fileDebit=%d meter=%d", what, l.Events, l.EventBytes, l.Files, l.FileDebit, l.Meter)
	if l.Events != l.Files || l.EventBytes != l.FileDebit {
		h.t.Fatalf("%s: %d debit(s)/%d bytes for %d object(s)/%d bytes — ledger and objects diverged", what, l.Events, l.EventBytes, l.Files, l.FileDebit)
	}
	return l
}

func (h *quotaHarness) assertNoLegacyLedgerCalls() {
	h.t.Helper()
	if calls := h.hook.legacyCalls(); len(calls) != 0 {
		h.t.Fatalf("an upload handler called the retired separate ledger writers: %v", calls)
	}
}

// countRegularFiles counts the blobs under dir (DiskStore's own dot-prefixed
// temporaries excluded). A missing dir is zero.
func countRegularFiles(t *testing.T, dir string) int64 {
	t.Helper()
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() && !strings.HasPrefix(d.Name(), ".") {
			n++
		}
		return nil
	})
	return n
}

func quotaSingleBody(n int) []byte {
	return uploadBody([]byte("MANIFEST"), bytes.Repeat([]byte("S"), n)).Bytes()
}

// landSession opens a resumable share upload and commits n bytes, answered.
func (h *quotaHarness) landSession(n int) string {
	h.t.Helper()
	var init bytes.Buffer
	manifest := []byte("MANIFEST")
	init.Write([]byte{0, 0, 0, byte(len(manifest))})
	init.Write(manifest)
	code, m := h.do("POST", "/api/uploads?ttl=7200&size="+strconv.Itoa(n), init.Bytes())
	if code != http.StatusOK {
		h.t.Fatalf("init: %d %v", code, m)
	}
	id := m["uploadId"].(string)
	conn, req := h.rawSend("PATCH", "/api/uploads/"+id, bytes.Repeat([]byte("R"), n),
		map[string]string{"Content-Range": fmt.Sprintf("bytes 0-%d/%d", n-1, n)})
	defer conn.Close()
	pc, pm, err := quotaReadResp(conn, req)
	if err != nil {
		h.t.Fatalf("patch: %v", err)
	}
	h.waitDone("PATCH", "/api/uploads/")
	if pc != http.StatusOK {
		h.t.Fatalf("patch: %d %v", pc, pm)
	}
	return id
}

// route resolves one upload request for a route name: "single" is a
// single-shot POST of n ciphertext bytes, "finalize" lands an n-byte session
// first and finalizes it.
func (h *quotaHarness) route(route string, n int) (path string, body []byte) {
	h.t.Helper()
	switch route {
	case "single":
		return "/api/files?ttl=7200", quotaSingleBody(n)
	case "finalize":
		return "/api/uploads/" + h.landSession(n) + "/finalize", nil
	}
	h.t.Fatalf("unknown route %q", route)
	return "", nil
}

// runGC runs one real GC sweep at the given clock, with the service's own
// reaper and pair-room sweeper wired as production wires them.
func (h *quotaHarness) runGC(at int64) {
	h.svc.now = func() time.Time { return time.Unix(at, 0) }
	g := &GC{Store: h.store, Blobs: h.svc.blobs, Now: func() int64 { return at },
		Log: log.New(io.Discard, "", 0), BlobFor: h.svc.BlobForNode,
		ReapSessions: h.svc.ReapPendingUploads, SweepPairRooms: h.svc.SweepPairRooms}
	g.sweep(context.Background())
	h.svc.now = time.Now
}

// holdWriteLock opens an INDEPENDENT connection to the same database file
// (its own database/sql pool, so not the store's writer) and takes SQLite's
// write lock with BEGIN IMMEDIATE. Until release is called, every writer
// transaction of the store waits out its busy_timeout and fails with
// SQLITE_BUSY — a real database failure that is not a cancellation.
func holdWriteLock(t *testing.T, dbPath string) (release func()) {
	t.Helper()
	db, err := sql.Open("sqlite", withPragmas("file:"+dbPath, "busy_timeout(0)"))
	if err != nil {
		t.Fatalf("lock holder: open: %v", err)
	}
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("lock holder: conn: %v", err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("lock holder: BEGIN IMMEDIATE: %v", err)
	}
	var once sync.Once
	release = func() {
		once.Do(func() {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			_ = conn.Close()
			_ = db.Close()
		})
	}
	t.Cleanup(release)
	return release
}
