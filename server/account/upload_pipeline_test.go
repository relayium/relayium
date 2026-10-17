package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

type pipelineGateStore struct {
	storage.BlobStore
	ready   chan struct{}
	proceed chan struct{}
	once    sync.Once
	calls   atomic.Int32
}

func (g *pipelineGateStore) release() { g.once.Do(func() { close(g.proceed) }) }
func (g *pipelineGateStore) Append(ctx context.Context, key string, offset int64, body io.Reader) (int64, error) {
	g.calls.Add(1)
	n, err := g.BlobStore.Append(ctx, key, offset, body)
	if offset == 0 && err == nil {
		close(g.ready)
		select {
		case <-g.proceed:
		case <-ctx.Done():
			return n, ctx.Err()
		}
	}
	return n, err
}

type pipelineReply struct {
	status   int
	received int64
	err      error
}

func pipelineRequest(ctx context.Context, ts *httptest.Server, cookie *http.Cookie, id string, data []byte, start int, negotiated bool) <-chan pipelineReply {
	ch := make(chan pipelineReply, 1)
	go func() {
		req, err := http.NewRequestWithContext(ctx, "PATCH", ts.URL+"/api/uploads/"+id, bytes.NewReader(data))
		if err != nil {
			ch <- pipelineReply{err: err}
			return
		}
		req.AddCookie(cookie)
		req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/900", start, start+len(data)-1))
		if negotiated {
			req.Header.Set(uploadPipelineHeader, uploadPipelineV1)
		}
		resp, err := ts.Client().Do(req)
		if err != nil {
			ch <- pipelineReply{err: err}
			return
		}
		defer resp.Body.Close()
		var out struct {
			Received int64 `json:"received"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		ch <- pipelineReply{status: resp.StatusCode, received: out.Received}
	}()
	return ch
}

func pipelineAnswer(t *testing.T, ch <-chan pipelineReply) pipelineReply {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("request did not terminate")
		return pipelineReply{}
	}
}

func pipelineWaiterCount(s *Service) int {
	s.uploadPipeline.mu.Lock()
	defer s.uploadPipeline.mu.Unlock()
	return len(s.uploadPipeline.waiting)
}

func waitPipelineWaiter(t *testing.T, s *Service, want int) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for pipelineWaiterCount(s) != want {
		select {
		case <-deadline.C:
			t.Fatalf("waiters=%d, want %d", pipelineWaiterCount(s), want)
		case <-tick.C:
		}
	}
}

func TestUploadPipelineCapabilityIsShareOnly(t *testing.T) {
	for _, tc := range []struct {
		purpose, room string
		want          bool
	}{
		{StoredPurposeShare, "", true}, {"", "", true}, {StoredPurposeDeviceTask, "", false},
		{StoredPurposePairRoom, "room", false}, {StoredPurposeShare, "room", false},
	} {
		body := withUploadPipeline(map[string]any{"received": int64(0)}, UploadSessionRow{Purpose: tc.purpose, PairRoomID: tc.room})
		_, got := body["uploadPipeline"]
		if got != tc.want {
			t.Fatalf("purpose=%q room=%q capability=%v", tc.purpose, tc.room, got)
		}
	}
}

func TestUploadPipelineWaitsForDurableOffsetAndMetersOnce(t *testing.T) {
	h := newDurHarness(t)
	g := &pipelineGateStore{BlobStore: h.disk, ready: make(chan struct{}), proceed: make(chan struct{})}
	h.svc.SetBlobStore(g)
	t.Cleanup(g.release)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	data := cipher(900, 17)
	first := pipelineRequest(context.Background(), h.ts, h.cookie, id, data[:400], 0, true)
	select {
	case <-g.ready:
	case <-time.After(time.Second):
		t.Fatal("first append not reached")
	}
	second := pipelineRequest(context.Background(), h.ts, h.cookie, id, data[400:], 400, true)
	waitPipelineWaiter(t, h.svc, 1)
	if g.calls.Load() != 1 || h.row(t, id).Received != 0 || h.meter(t) != 0 {
		t.Fatal("successor crossed the unconfirmed offset")
	}
	select {
	case r := <-second:
		t.Fatalf("successor answered before predecessor: %+v", r)
	default:
	}
	g.release()
	for _, ch := range []<-chan pipelineReply{first, second} {
		r := pipelineAnswer(t, ch)
		if r.err != nil || r.status != 200 {
			t.Fatalf("append: %+v", r)
		}
	}
	if r := h.row(t, id); r.Received != 900 || r.Metered != 900 || h.meter(t) != 900 || !bytes.Equal(h.blob(t, id), data) {
		t.Fatal("ordered bytes or exact-once meter mismatch")
	}
	// A lost answer and replay must not charge or rewrite the committed bytes.
	r := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, data[400:], 400, true))
	if r.err != nil || r.status != 200 || r.received != 900 || h.meter(t) != 900 || g.calls.Load() != 2 {
		t.Fatalf("replay: %+v calls=%d meter=%d", r, g.calls.Load(), h.meter(t))
	}
	if pipelineWaiterCount(h.svc) != 0 {
		t.Fatal("waiter leaked")
	}
}

func TestUploadPipelineLegacyGapStillRefused(t *testing.T) {
	h := newDurHarness(t)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	r := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, []byte("next"), 400, false))
	if r.err != nil || r.status != 409 || r.received != 0 || pipelineWaiterCount(h.svc) != 0 || h.meter(t) != 0 {
		t.Fatalf("legacy gap changed: %+v", r)
	}
}

func TestUploadPipelineWaitTimeoutAndFutureLimit(t *testing.T) {
	h := newDurHarness(t)
	h.svc.uploadPipelineWaitTimeout = 20 * time.Millisecond
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	for _, start := range []int{400, 901} {
		r := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, []byte("next"), start, true))
		if r.err != nil || r.status != 409 || r.received != 0 || h.row(t, id).Received != 0 || h.meter(t) != 0 {
			t.Fatalf("gap %d: %+v", start, r)
		}
	}
	if pipelineWaiterCount(h.svc) != 0 {
		t.Fatal("timeout waiter leaked")
	}
}

func TestUploadPipelineHTTP1CancellationDoesNotBlockCurrentOffset(t *testing.T) {
	h := newDurHarness(t)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := pipelineRequest(ctx, h.ts, h.cookie, id, []byte("queued"), 400, true)
	waitPipelineWaiter(t, h.svc, 1)
	other := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, []byte("another"), 800, true))
	if other.err != nil || other.status != 409 || pipelineWaiterCount(h.svc) != 1 {
		t.Fatalf("unbounded or displaced waiter: %+v", other)
	}
	cancel()
	if r := pipelineAnswer(t, first); r.err == nil {
		t.Fatalf("cancelled request succeeded: %+v", r)
	}
	// HTTP/1 cannot observe a disconnected peer before reading the body.
	// The one unread waiter stays bounded; it must never block the current
	// offset, and fresh progress must wake and release it without its body.
	data := cipher(900, 27)
	current := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, data, 0, true))
	if current.err != nil || current.status != 200 || current.received != 900 {
		t.Fatalf("current offset blocked by cancelled successor: %+v", current)
	}
	waitPipelineWaiter(t, h.svc, 0)
	if h.meter(t) != 900 || h.row(t, id).Received != 900 || !bytes.Equal(h.blob(t, id), data) {
		t.Fatal("cancelled successor changed the fresh upload or its meter")
	}
}

func TestUploadPipelineSeesAnotherServicesCommit(t *testing.T) {
	h := newDurHarness(t)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	// Deliberately use another Service/map on the same durable store.
	other := NewService(h.st, &capturingMailer{}, h.svc.cfg)
	other.SetBlobStore(h.disk)
	ts := httptest.NewServer(other.Routes())
	defer ts.Close()
	queued := pipelineRequest(context.Background(), h.ts, h.cookie, id, bytes.Repeat([]byte{2}, 500), 400, true)
	waitPipelineWaiter(t, h.svc, 1)
	r := pipelineAnswer(t, pipelineRequest(context.Background(), ts, h.cookie, id, bytes.Repeat([]byte{1}, 400), 0, false))
	if r.err != nil || r.status != 200 {
		t.Fatalf("other instance: %+v", r)
	}
	r = pipelineAnswer(t, queued)
	if r.err != nil || r.status != 200 || r.received != 900 || h.meter(t) != 900 {
		t.Fatalf("cross-instance progress: %+v meter=%d", r, h.meter(t))
	}
}

func TestUploadPipelineRechecksTerminalState(t *testing.T) {
	h := newDurHarness(t)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	queued := pipelineRequest(context.Background(), h.ts, h.cookie, id, []byte("must not land"), 400, true)
	waitPipelineWaiter(t, h.svc, 1)
	if _, _, ok, err := h.st.ClaimUploadDone(context.Background(), id, h.svc.now().Unix()); err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	r := pipelineAnswer(t, queued)
	if r.err != nil || r.status != 404 || h.meter(t) != 0 || pipelineWaiterCount(h.svc) != 0 {
		t.Fatalf("terminal successor: %+v", r)
	}
}

func TestUploadPipelineReadAheadBoundsAndOwnership(t *testing.T) {
	row := UploadSessionRow{ID: "session", UserID: "owner", MaxSize: uploadChunkSize + 100, Purpose: StoredPurposeShare}
	for _, tc := range []struct {
		name   string
		body   string
		length int64
		want   error
	}{
		{"known", "ciphertext", 10, nil}, {"unknown", "ciphertext", -1, nil},
		{"truncated", "short", 10, io.ErrUnexpectedEOF},
		{"overlong-known", "elevenbytes", 10, errTooLarge},
		{"oversize", string(bytes.Repeat([]byte{'x'}, 101)), -1, errTooLarge},
		{"declared-oversize", "", 101, errTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var pool uploadPipelineWaiters
			req := httptest.NewRequest("PATCH", "/", bytes.NewBufferString(tc.body))
			req.ContentLength = tc.length
			original := req.Body
			err := pool.readAhead(context.Background(), row, uploadChunkSize, req)
			if !errors.Is(err, tc.want) {
				t.Fatalf("error=%v want=%v", err, tc.want)
			}
			staged, ok := req.Body.(*pipelineReadAhead)
			if tc.want != nil {
				if ok || pool.held != 0 || req.Body != original {
					t.Fatal("failed staging leaked or replaced network reader")
				}
				return
			}
			if !ok || pool.held <= 0 {
				t.Fatal("ciphertext not staged before offset commit")
			}
			got, err := io.ReadAll(staged)
			if err != nil || string(got) != tc.body {
				t.Fatal("staged ciphertext mismatch")
			}
			if err := staged.Close(); err != nil {
				t.Fatal(err)
			}
			_ = staged.Close()
			if pool.held != 0 || staged.reader.Len() != 0 || staged.original != nil {
				t.Fatal("retained memory after budget release")
			}
			if _, err := staged.Read(make([]byte, 1)); !errors.Is(err, io.ErrClosedPipe) {
				t.Fatal("closed staged body remained readable")
			}
			// Cancellation/failed retry must not replenish the free-ingress allowance.
			retry := httptest.NewRequest("PATCH", "/", bytes.NewBufferString(tc.body))
			retry.ContentLength = tc.length
			if err := pool.readAhead(context.Background(), row, uploadChunkSize, retry); err != nil {
				t.Fatal(err)
			}
			if _, ok := retry.Body.(*pipelineReadAhead); ok {
				t.Fatal("same uncommitted prefix was prefetched twice")
			}
		})
	}
}

func TestUploadPipelineReadAheadAdmissionAndCancellation(t *testing.T) {
	now := time.Now()
	row := UploadSessionRow{ID: "session", UserID: "owner", MaxSize: 4 * uploadChunkSize}
	var pool uploadPipelineWaiters
	if pool.reserve(row, 1, 10, now) {
		t.Fatal("one-byte gap bought read ahead")
	}
	if !pool.reserve(row, uploadChunkSize, uploadPipelineBufferBudget, now) {
		t.Fatal("full budget unavailable")
	}
	other := row
	other.UserID = "another"
	if pool.reserve(other, uploadChunkSize, 1, now) {
		t.Fatal("global budget exceeded")
	}
	pool.unreserve(uploadPipelineBufferBudget)
	if pool.reserve(row, uploadChunkSize, 10, now) {
		t.Fatal("failed attempt forgotten")
	}
	if !pool.reserve(other, uploadChunkSize, 10, now) {
		t.Fatal("owned-session keys collided")
	}
	pool.unreserve(10)
	row.Received = uploadChunkSize
	if !pool.reserve(row, 2*uploadChunkSize, 10, now) {
		t.Fatal("durable progress did not permit next stage")
	}
	pool.unreserve(10)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	row.ID = "cancelled"
	req := httptest.NewRequest("PATCH", "/", bytes.NewBufferString("cipher"))
	if err := pool.readAhead(ctx, row, 2*uploadChunkSize, req); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if pool.held != 0 {
		t.Fatal("cancelled allocation retained")
	}
	if _, ok := req.Body.(*pipelineReadAhead); ok {
		t.Fatal("cancelled body handed off")
	}
	// Metadata is bounded independently of the byte budget.
	pool.seen = make(map[string]uploadPipelineSeen)
	for i := 0; i < uploadPipelineSeenLimit; i++ {
		pool.seen[fmt.Sprint(i)] = uploadPipelineSeen{start: 1, at: now}
	}
	if pool.reserve(row, 2*uploadChunkSize, 1, now) {
		t.Fatal("metadata limit exceeded")
	}
	if !pool.reserve(row, 2*uploadChunkSize, 1, now.Add(uploadPipelineSeenTTL)) {
		t.Fatal("expired metadata not reclaimed")
	}
	pool.unreserve(1)
}

// This is a real HTTP/SQLite/DiskStore path. The second network body reaches
// EOF while the first durable acknowledgment is held, yet no second append or
// accounting can run before the ordinary commit path advances the offset.
func TestUploadPipelineReadAheadOverlapsIngressWithoutEarlyBilling(t *testing.T) {
	h := newDurHarness(t)
	h.svc.cfg.MaxFileSize = 2 * uploadChunkSize
	h.svc.cfg.DailyQuota = 4 * uploadChunkSize
	g := &pipelineGateStore{BlobStore: h.disk, ready: make(chan struct{}), proceed: make(chan struct{})}
	h.svc.SetBlobStore(g)
	t.Cleanup(g.release)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), uploadChunkSize+17, 0)
	data := cipher(uploadChunkSize+17, 29)
	first := pipelineRequest(context.Background(), h.ts, h.cookie, id, data[:uploadChunkSize], 0, true)
	select {
	case <-g.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("first append not reached")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Client cancellation and waiter removal precede the outer handler's body
	// cleanup. Observe that handler returning before checking its reservation.
	finished := make(chan struct{})
	secondServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		h.ts.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(secondServer.Close)
	second := pipelineRequest(ctx, secondServer, h.cookie, id, data[uploadChunkSize:], uploadChunkSize, true)
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.svc.uploadPipeline.mu.Lock()
		held := h.svc.uploadPipeline.held
		h.svc.uploadPipeline.mu.Unlock()
		if held > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second body not admitted before first confirmation")
		}
		time.Sleep(time.Millisecond)
	}
	if g.calls.Load() != 1 || h.row(t, id).Received != 0 || h.meter(t) != 0 {
		t.Fatal("staging crossed durable/meter boundary")
	}
	cancel()
	_ = pipelineAnswer(t, second)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("cancelled request handler did not finish cleanup")
	}
	h.svc.uploadPipeline.mu.Lock()
	held := h.svc.uploadPipeline.held
	waiters := len(h.svc.uploadPipeline.waiting)
	h.svc.uploadPipeline.mu.Unlock()
	if held != 0 || waiters != 0 || h.meter(t) != 0 {
		t.Fatalf("cancelled staged body leaked or billed: held=%d waiters=%d meter=%d", held, waiters, h.meter(t))
	}
	g.release()
	if r := pipelineAnswer(t, first); r.status != 200 || r.err != nil {
		t.Fatalf("first: %+v", r)
	}
	// The cancelled staging was not a receipt; ordinary retry sends the same tail.
	if r := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, data[uploadChunkSize:], uploadChunkSize, true)); r.status != 200 || r.err != nil {
		t.Fatalf("retry: %+v", r)
	}
	if r := h.row(t, id); r.Received != int64(len(data)) || r.Metered != int64(len(data)) || h.meter(t) != int64(len(data)) || !bytes.Equal(h.blob(t, id), data) {
		t.Fatal("final bytes or exact-once meter mismatch")
	}
}

func TestUploadPipelineHandsOverAlreadyCurrentWaitingSlot(t *testing.T) {
	h := newDurHarness(t)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	data := cipher(900, 31)
	if r := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, data[:400], 0, true)); r.status != 200 {
		t.Fatal(r)
	}
	// The predecessor's offset is committed, but its waiting goroutine has not
	// returned yet. The next future request must wait for that slot's handover.
	old, ok := h.svc.uploadPipeline.acquire(h.userID, id, 400)
	if !ok {
		t.Fatal("fixture waiter unavailable")
	}
	defer h.svc.uploadPipeline.release(h.userID, id, old)
	future := pipelineRequest(context.Background(), h.ts, h.cookie, id, data[800:], 800, true)
	select {
	case r := <-future:
		t.Fatalf("current predecessor caused premature gap refusal: %+v", r)
	case <-time.After(30 * time.Millisecond):
	}
	h.svc.uploadPipeline.release(h.userID, id, old)
	waitPipelineWaiter(t, h.svc, 1)
	if r := pipelineAnswer(t, pipelineRequest(context.Background(), h.ts, h.cookie, id, data[400:800], 400, true)); r.status != 200 {
		t.Fatal(r)
	}
	if r := pipelineAnswer(t, future); r.status != 200 || r.received != 900 {
		t.Fatal(r)
	}
	if h.meter(t) != 900 || !bytes.Equal(h.blob(t, id), data) {
		t.Fatal("handover corrupted bytes or meter")
	}
}
