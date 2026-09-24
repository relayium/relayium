package account

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"io/fs"
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

// W-N35: a single-shot POST /api/files that the server refuses AFTER bs.Put
// consumed the body must still bill the ciphertext it moved, exactly once.
//
// Monthly traffic is "how much moved" (docs/billing-transparency.md): the
// resumable route meters every committed append whatever happens to the
// session later, and this route already bills what it read when bs.Put itself
// fails. A refusal after a successful Put used to bill nothing — the body had
// crossed the network and landed on disk, the blob was dropped, and the meter
// stayed at 0 — so hanging up (or being refused by a later gate) after the
// last byte was free bandwidth.
//
// Everything is the production composition — Routes(), session auth, the real
// SQLite store, a real disk blob store or a real RemoteBlobStore against a
// loopback node — with two narrow observation points: the store wrapper
// records every upload RecordMeter call (and can inject persist or meter
// failures), and the blob wrapper can cancel the request's context the moment
// the real Put returns, which is exactly "the client hung up after the last
// byte".

const wn35CtxValue = "w-n35-request-value"

type wn35CtxKey struct{}

// meterCall is what the hook saw when a handler recorded upload traffic.
type meterCall struct {
	bytes       int64
	ctxErr      error
	hasDeadline bool
	budget      time.Duration
	value       any
	err         error
}

type meterHookStore struct {
	Store
	mu          sync.Mutex
	uploads     []meterCall
	failMeter   error // returned by upload RecordMeter without touching the store
	failPersist error // returned by both CreateStoredFile variants
	// cancelAfterPersist cancels the request once the file row committed.
	cancelAfterPersist context.CancelFunc
}

func (m *meterHookStore) RecordMeter(ctx context.Context, userID string, kind UsageKind, n, at int64) error {
	if kind != MeterUpload {
		return m.Store.RecordMeter(ctx, userID, kind, n, at)
	}
	call := meterCall{bytes: n, ctxErr: ctx.Err(), value: ctx.Value(wn35CtxKey{})}
	if dl, ok := ctx.Deadline(); ok {
		call.hasDeadline, call.budget = true, time.Until(dl)
	}
	m.mu.Lock()
	inject := m.failMeter
	m.mu.Unlock()
	if inject != nil {
		call.err = inject
	} else {
		call.err = m.Store.RecordMeter(ctx, userID, kind, n, at)
	}
	m.mu.Lock()
	m.uploads = append(m.uploads, call)
	m.mu.Unlock()
	return call.err
}

func (m *meterHookStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
	m.mu.Lock()
	inject := m.failPersist
	m.mu.Unlock()
	if inject != nil {
		return inject
	}
	return m.Store.CreateStoredFile(ctx, f)
}

func (m *meterHookStore) CreateStoredFileWithinStorageCaps(ctx context.Context, f StoredFile, now, userCap, globalCap int64) (StoredFileWrite, error) {
	m.mu.Lock()
	inject := m.failPersist
	m.mu.Unlock()
	if inject != nil {
		return StoredFileWrite{}, inject
	}
	w, err := m.Store.CreateStoredFileWithinStorageCaps(ctx, f, now, userCap, globalCap)
	m.mu.Lock()
	cancel := m.cancelAfterPersist
	m.mu.Unlock()
	if err == nil && w.Reason == "" && cancel != nil {
		cancel()
	}
	return w, err
}

func (m *meterHookStore) calls() []meterCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]meterCall(nil), m.uploads...)
}

// cancelAfterPutBlobs is the real central disk store; when armed it cancels
// the request's context right after the real Put returned successfully.
type cancelAfterPutBlobs struct {
	storage.BlobStore
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (c *cancelAfterPutBlobs) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	n, err := c.BlobStore.Put(ctx, key, r)
	c.mu.Lock()
	cancel := c.cancel
	c.mu.Unlock()
	if err == nil && cancel != nil {
		cancel()
	}
	return n, err
}

// countingNode is a loopback storage node speaking the real node's PUT/DELETE
// contract ({"size":N} = bytes it wrote), with its objects behind a mutex.
type countingNode struct {
	mu      sync.Mutex
	objects map[string]int
}

func newCountingNode(t *testing.T) (*countingNode, *httptest.Server) {
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

func (n *countingNode) count() (objects, bytes int) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, b := range n.objects {
		objects++
		bytes += b
	}
	return
}

type meterHarness struct {
	ts      *httptest.Server
	handler http.Handler
	svc     *Service
	store   *SQLiteStore
	hook    *meterHookStore
	blobs   *cancelAfterPutBlobs
	blobDir string
	cookie  *http.Cookie
	userID  string
}

func newMeterHarness(t *testing.T, email string) *meterHarness {
	t.Helper()
	store := newTestStore(t)
	hook := &meterHookStore{Store: store}
	mail := &capturingMailer{}
	svc := NewService(hook, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		MaxFileSize: 1024, DailyQuota: 8 << 20, DefaultTTL: 3600, MaxTTL: 7200,
		DefaultRetention: retentionTTL,
	})
	svc.nodeHTTP.Transport.(*http.Transport).DialContext = guardedDialContext(true)
	blobDir := t.TempDir()
	disk, err := storage.NewDiskStore(blobDir)
	if err != nil {
		t.Fatalf("disk: %v", err)
	}
	blobs := &cancelAfterPutBlobs{BlobStore: disk}
	svc.SetBlobStore(blobs)
	h := svc.Routes()
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	cookie := loginCookie(t, ts, mail, email)
	u, err := store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatal(err)
	}
	mh := &meterHarness{ts: ts, handler: h, svc: svc, store: store, hook: hook, blobs: blobs, blobDir: blobDir, cookie: cookie, userID: u.ID}
	mh.plan(t, 1<<30, 1<<30, 8<<20)
	return mh
}

// plan gives the user a plan with exactly these caps (0 = unlimited storage
// or traffic; the daily quota is always explicit).
func (h *meterHarness) plan(t *testing.T, storageCap, traffic, daily int64) {
	t.Helper()
	ctx := context.Background()
	if err := h.store.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: storageCap, TrafficBytes: traffic,
		RetentionSecs: 3 * 86400, DailyQuotaBytes: daily, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := h.store.SetUserPlan(ctx, h.userID, "free", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
}

// addNode registers a storage node for placement: ownerType "user" is the
// user's own (free) node, "fleet" is a billable operator node.
func (h *meterHarness) addNode(t *testing.T, ownerType string, srv *httptest.Server) {
	t.Helper()
	n := Node{ID: "wn35-" + ownerType, OwnerType: ownerType, URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: srv.URL, StorageSecret: "ss", StorageFree: 100 << 30,
		CreatedAt: 1, LastSeenAt: time.Now().Unix()}
	if ownerType == "user" {
		n.OwnerUserID = h.userID
	}
	if _, err := h.store.UpsertNode(context.Background(), n); err != nil {
		t.Fatal(err)
	}
}

type meterReq struct {
	body           io.Reader
	chunked        bool // no Content-Length, as a chunked client sends
	cancelAfterPut bool
	// cancelAfterPersist hangs up once the stored-file row committed.
	cancelAfterPersist bool
	// cancelOnBodyError hangs the request up when body returns its error.
	cancelOnBodyError bool
}

// wn35Body is a well-framed upload of n ciphertext bytes.
func wn35Body(n int) *bytes.Buffer {
	return uploadBody([]byte("MANIFEST"), bytes.Repeat([]byte("T"), n))
}

// failingBody delivers the framing, then sent ciphertext bytes, then fails as
// a dropped connection does.
type failingBody struct {
	r      io.Reader
	err    error
	onFail func()
}

func (f *failingBody) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err == io.EOF {
		if f.onFail != nil {
			f.onFail()
		}
		return n, f.err
	}
	return n, err
}

func (h *meterHarness) serve(t *testing.T, mr meterReq) int {
	t.Helper()
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), wn35CtxKey{}, wn35CtxValue))
	defer cancel()
	if mr.cancelAfterPut {
		h.blobs.mu.Lock()
		h.blobs.cancel = cancel
		h.blobs.mu.Unlock()
		defer func() {
			h.blobs.mu.Lock()
			h.blobs.cancel = nil
			h.blobs.mu.Unlock()
		}()
	}
	if mr.cancelAfterPersist {
		h.hook.mu.Lock()
		h.hook.cancelAfterPersist = cancel
		h.hook.mu.Unlock()
		defer func() {
			h.hook.mu.Lock()
			h.hook.cancelAfterPersist = nil
			h.hook.mu.Unlock()
		}()
	}
	if fb, ok := mr.body.(*failingBody); ok && mr.cancelOnBodyError {
		fb.onFail = cancel
	}
	req := httptest.NewRequest("POST", "/api/files?ttl=0", mr.body)
	if mr.chunked {
		req.ContentLength = -1
		req.Body = io.NopCloser(mr.body)
	}
	req = req.WithContext(ctx)
	req.AddCookie(h.cookie)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec.Code
}

type meterState struct {
	meter, events, files, blobs int64
}

func (h *meterHarness) state(t *testing.T) meterState {
	t.Helper()
	s := meterState{meter: uploadedThisMonth(t, h.store, h.userID)}
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM upload_events WHERE user_id = ?`, h.userID).Scan(&s.events); err != nil {
		t.Fatal(err)
	}
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE user_id = ?`, h.userID).Scan(&s.files); err != nil {
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
	return s
}

// assertMeteredOnce: exactly one upload RecordMeter call for want bytes, on a
// live, bounded context that still carries the request's values.
func assertMeteredOnce(t *testing.T, h *meterHarness, want int64) {
	t.Helper()
	calls := h.hook.calls()
	if len(calls) != 1 {
		t.Fatalf("upload meter calls: %+v, want exactly one of %d bytes", calls, want)
	}
	c := calls[0]
	if c.bytes != want {
		t.Fatalf("metered %d bytes, want %d", c.bytes, want)
	}
	if c.ctxErr != nil {
		t.Fatalf("meter ran on a dead context: %v", c.ctxErr)
	}
	if !c.hasDeadline || c.budget <= 0 || c.budget > uploadMeterBudget {
		t.Fatalf("meter context budget: deadline=%v left=%v, want bounded by %v", c.hasDeadline, c.budget, uploadMeterBudget)
	}
	if c.value != wn35CtxValue {
		t.Fatalf("meter context lost the request's values: got %v", c.value)
	}
}

func assertNotMetered(t *testing.T, h *meterHarness) {
	t.Helper()
	if calls := h.hook.calls(); len(calls) != 0 {
		t.Fatalf("upload meter calls: %+v, want none", calls)
	}
}

// --- billable central disk: success and every post-Put refusal -------------

func TestSingleShotBillableSuccessMetersOnce(t *testing.T) {
	h := newMeterHarness(t, "wn35-ok@example.com")
	code := h.serve(t, meterReq{body: wn35Body(900)})
	st := h.state(t)
	t.Logf("billable success: code=%d state=%+v", code, st)
	if want := (meterState{meter: 900, events: 1, files: 1, blobs: 1}); code != http.StatusOK || st != want {
		t.Fatalf("code=%d state=%+v, want 200 %+v", code, st, want)
	}
	assertMeteredOnce(t, h, 900)
}

func TestSingleShotPostPutRefusalsMeterConsumedBytesOnce(t *testing.T) {
	persistErr := errors.New("injected persist failure: database is locked")
	cases := []struct {
		name  string
		setup func(t *testing.T, h *meterHarness)
		req   meterReq
		code  int
	}{
		{"cancelled after Put", nil,
			meterReq{body: wn35Body(900), cancelAfterPut: true}, http.StatusInternalServerError},
		{"monthly traffic post-check", func(t *testing.T, h *meterHarness) { h.plan(t, 1<<30, 899, 8<<20) },
			meterReq{body: wn35Body(900), chunked: true}, http.StatusTooManyRequests},
		{"daily quota reservation", func(t *testing.T, h *meterHarness) { h.plan(t, 1<<30, 1<<30, 1000) },
			meterReq{body: wn35Body(900)}, http.StatusTooManyRequests},
		{"persist store failure", func(t *testing.T, h *meterHarness) { h.hook.failPersist = persistErr },
			meterReq{body: wn35Body(900)}, http.StatusInternalServerError},
		{"plan storage cap at persist", func(t *testing.T, h *meterHarness) { h.plan(t, 500, 1<<30, 8<<20) },
			meterReq{body: wn35Body(900), chunked: true}, http.StatusRequestEntityTooLarge},
		{"global storage cap at persist", func(t *testing.T, h *meterHarness) {
			if err := h.store.SetSetting(context.Background(), SettingStorageDiskCap, 500, time.Now().Unix()); err != nil {
				t.Fatal(err)
			}
		}, meterReq{body: wn35Body(900), chunked: true}, http.StatusInsufficientStorage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newMeterHarness(t, "wn35-refuse-"+strings.ReplaceAll(tc.name, " ", "-")+"@example.com")
			if tc.setup != nil {
				tc.setup(t, h)
			}
			code := h.serve(t, tc.req)
			st := h.state(t)
			t.Logf("%s: code=%d state=%+v", tc.name, code, st)
			// The body was fully read and written, then refused: no file, no
			// blob, no daily-quota event — but its 900 bytes moved.
			if want := (meterState{meter: 900}); code != tc.code || st != want {
				t.Fatalf("code=%d state=%+v, want %d %+v", code, st, tc.code, want)
			}
			assertMeteredOnce(t, h, 900)
		})
	}
}

// A client that hangs up after the file committed still stored it: the
// upload succeeded and its traffic must not be lost to the dead context.
func TestSingleShotCancelAfterPersistStillMetersOnce(t *testing.T) {
	h := newMeterHarness(t, "wn35-afterpersist@example.com")
	code := h.serve(t, meterReq{body: wn35Body(900), cancelAfterPersist: true})
	st := h.state(t)
	t.Logf("cancel after persist: code=%d state=%+v", code, st)
	if want := (meterState{meter: 900, events: 1, files: 1, blobs: 1}); code != http.StatusOK || st != want {
		t.Fatalf("code=%d state=%+v, want 200 %+v", code, st, want)
	}
	assertMeteredOnce(t, h, 900)
}

// The post-Put traffic gate must judge THIS upload against the traffic that
// existed before it, not against a meter that already includes it: an upload
// that exactly fills the remaining allowance is admitted and billed once.
func TestSingleShotTrafficGateSeesPreUploadSnapshot(t *testing.T) {
	h := newMeterHarness(t, "wn35-exact@example.com")
	h.plan(t, 1<<30, 900, 8<<20)
	code := h.serve(t, meterReq{body: wn35Body(900), chunked: true})
	st := h.state(t)
	t.Logf("exact-cap chunked upload: code=%d state=%+v", code, st)
	if want := (meterState{meter: 900, events: 1, files: 1, blobs: 1}); code != http.StatusOK || st != want {
		t.Fatalf("code=%d state=%+v, want 200 %+v", code, st, want)
	}
	assertMeteredOnce(t, h, 900)
}

// The same refusal over a real TCP connection with real chunked framing, so
// nothing about the direct ServeHTTP harness manufactures the result.
func TestSingleShotChunkedTrafficRefusalOverHTTPMetersOnce(t *testing.T) {
	h := newMeterHarness(t, "wn35-tcp@example.com")
	h.plan(t, 1<<30, 899, 8<<20)
	req, err := http.NewRequest("POST", h.ts.URL+"/api/files?ttl=0", io.NopCloser(wn35Body(900)))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	st := h.state(t)
	t.Logf("chunked over TCP: code=%d state=%+v", resp.StatusCode, st)
	if want := (meterState{meter: 900}); resp.StatusCode != http.StatusTooManyRequests || st != want {
		t.Fatalf("code=%d state=%+v, want 429 %+v", resp.StatusCode, st, want)
	}
	if calls := h.hook.calls(); len(calls) != 1 || calls[0].bytes != 900 || calls[0].err != nil {
		t.Fatalf("meter calls: %+v, want one successful 900-byte call", calls)
	}
}

// A retry after a post-Put hang-up is a new upload: it is billed its own 900
// bytes once, on top of the 900 the abandoned attempt moved.
func TestSingleShotRetryAfterPostPutCancelAddsItsBytesOnce(t *testing.T) {
	h := newMeterHarness(t, "wn35-retry@example.com")
	code := h.serve(t, meterReq{body: wn35Body(900), cancelAfterPut: true})
	if st := h.state(t); code != http.StatusInternalServerError || st != (meterState{meter: 900}) {
		t.Fatalf("cancelled: code=%d state=%+v", code, st)
	}
	rcode := h.serve(t, meterReq{body: wn35Body(900)})
	st := h.state(t)
	t.Logf("retry: code=%d state=%+v", rcode, st)
	if want := (meterState{meter: 1800, events: 1, files: 1, blobs: 1}); rcode != http.StatusOK || st != want {
		t.Fatalf("retry: code=%d state=%+v, want 200 %+v", rcode, st, want)
	}
	calls := h.hook.calls()
	if len(calls) != 2 || calls[0].bytes != 900 || calls[1].bytes != 900 {
		t.Fatalf("meter calls: %+v, want exactly two of 900", calls)
	}
}

// --- what must stay unbilled, or billed exactly as before --------------------

func TestSingleShotPrePutRefusalsMeterNothing(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, h *meterHarness)
		body  *bytes.Buffer
		code  int
	}{
		{"declared size over traffic", func(t *testing.T, h *meterHarness) { h.plan(t, 1<<30, 500, 8<<20) },
			wn35Body(900), http.StatusTooManyRequests},
		{"declared size over daily quota", func(t *testing.T, h *meterHarness) { h.plan(t, 1<<30, 1<<30, 500) },
			wn35Body(900), http.StatusTooManyRequests},
		{"truncated manifest", nil, bytes.NewBuffer([]byte{0, 0, 0, 9, 'M'}), http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newMeterHarness(t, "wn35-pre-"+strings.ReplaceAll(tc.name, " ", "-")+"@example.com")
			if tc.setup != nil {
				tc.setup(t, h)
			}
			code := h.serve(t, meterReq{body: tc.body})
			st := h.state(t)
			t.Logf("%s: code=%d state=%+v", tc.name, code, st)
			if code != tc.code || st != (meterState{}) {
				t.Fatalf("code=%d state=%+v, want %d and nothing billed or kept", code, st, tc.code)
			}
			assertNotMetered(t, h)
		})
	}
}

// A body that breaks mid-stream fails inside bs.Put; that path already billed
// what was read before this change and must still bill it exactly once —
// even when the failure is the client hanging up.
func TestSingleShotPartialPutMetersReadBytesOnce(t *testing.T) {
	for _, hangUp := range []bool{false, true} {
		t.Run("hangUp="+strconv.FormatBool(hangUp), func(t *testing.T) {
			h := newMeterHarness(t, "wn35-partial-"+strconv.FormatBool(hangUp)+"@example.com")
			var framed bytes.Buffer
			_ = binary.Write(&framed, binary.BigEndian, uint32(len("MANIFEST")))
			framed.WriteString("MANIFEST")
			framed.Write(bytes.Repeat([]byte("P"), 400))
			body := &failingBody{r: &framed, err: io.ErrUnexpectedEOF}
			code := h.serve(t, meterReq{body: body, chunked: true, cancelOnBodyError: hangUp})
			st := h.state(t)
			t.Logf("partial Put: code=%d state=%+v", code, st)
			if want := (meterState{meter: 400}); code != http.StatusInternalServerError || st != want {
				t.Fatalf("code=%d state=%+v, want 500 %+v", code, st, want)
			}
			assertMeteredOnce(t, h, 400)
		})
	}
}

// Own-node uploads land on the user's own disk and are never metered, whether
// they succeed or are refused after the node accepted the bytes.
func TestSingleShotOwnNodeNeverMetered(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run("persistFails="+strconv.FormatBool(fail), func(t *testing.T) {
			h := newMeterHarness(t, "wn35-own-"+strconv.FormatBool(fail)+"@example.com")
			node, srv := newCountingNode(t)
			h.addNode(t, "user", srv)
			want, wantCode, wantObjects := meterState{files: 1}, http.StatusOK, 1
			if fail {
				h.hook.failPersist = errors.New("injected persist failure")
				want, wantCode, wantObjects = meterState{}, http.StatusInternalServerError, 0
			}
			code := h.serve(t, meterReq{body: wn35Body(900)})
			st := h.state(t)
			objects, _ := node.count()
			t.Logf("own node (persist fails=%v): code=%d state=%+v nodeObjects=%d", fail, code, st, objects)
			if code != wantCode || st != want || objects != wantObjects {
				t.Fatalf("code=%d state=%+v nodeObjects=%d, want %d %+v %d", code, st, objects, wantCode, want, wantObjects)
			}
			assertNotMetered(t, h)
		})
	}
}

// A billable fleet node goes through RemoteBlobStore: the node's reported size
// and the bytes central read from the client agree, and both success and a
// post-Put refusal bill them once.
func TestSingleShotFleetNodeMetersOnce(t *testing.T) {
	for _, refuse := range []bool{false, true} {
		t.Run("storageRefusal="+strconv.FormatBool(refuse), func(t *testing.T) {
			h := newMeterHarness(t, "wn35-fleet-"+strconv.FormatBool(refuse)+"@example.com")
			node, srv := newCountingNode(t)
			h.addNode(t, "fleet", srv)
			want, wantCode, wantObjects := meterState{meter: 900, events: 1, files: 1}, http.StatusOK, 1
			req := meterReq{body: wn35Body(900)}
			if refuse {
				h.plan(t, 500, 1<<30, 8<<20)
				req.chunked = true
				want, wantCode, wantObjects = meterState{meter: 900}, http.StatusRequestEntityTooLarge, 0
			}
			code := h.serve(t, req)
			st := h.state(t)
			objects, _ := node.count()
			t.Logf("fleet node (refuse=%v): code=%d state=%+v nodeObjects=%d", refuse, code, st, objects)
			if code != wantCode || st != want || objects != wantObjects {
				t.Fatalf("code=%d state=%+v nodeObjects=%d, want %d %+v %d", code, st, objects, wantCode, want, wantObjects)
			}
			assertMeteredOnce(t, h, 900)
		})
	}
}

// A meter write the store refuses is logged with who and how much, and never
// changes the upload's answer.
func TestSingleShotMeterFailureIsLogged(t *testing.T) {
	injected := errors.New("injected meter failure: database is locked")
	for _, tc := range []struct {
		name string
		req  meterReq
		code int
	}{
		{"success", meterReq{body: wn35Body(900)}, http.StatusOK},
		{"cancelled after Put", meterReq{body: wn35Body(900), cancelAfterPut: true}, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMeterHarness(t, "wn35-meterfail-"+strings.ReplaceAll(tc.name, " ", "-")+"@example.com")
			h.hook.failMeter = injected
			logs := captureRefundLog(t)
			code := h.serve(t, tc.req)
			t.Logf("%s with failing meter: code=%d", tc.name, code)
			if code != tc.code {
				t.Fatalf("answered %d, want %d", code, tc.code)
			}
			calls := h.hook.calls()
			if len(calls) != 1 || calls[0].bytes != 900 || !errors.Is(calls[0].err, injected) {
				t.Fatalf("meter calls: %+v, want one failed 900-byte attempt", calls)
			}
			out := logs.String()
			if !strings.Contains(out, h.userID) || !strings.Contains(out, "900") || !strings.Contains(out, injected.Error()) {
				t.Fatalf("meter failure not logged with user and bytes; log:\n%s", out)
			}
		})
	}
}
