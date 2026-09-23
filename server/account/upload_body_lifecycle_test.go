package account

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// W-N35 revision: the single-shot upload owns its request body until it has
// counted it. bs.Put can return while something still reads the body — a
// RemoteBlobStore node answers 401/507 before reading and 500 mid-stream, and
// net/http's transport keeps copying the request body after RoundTrip returns
// — so the handler takes the body back (clientBody.release) the moment Put
// returns: no read starts after that, a read still running is interrupted
// through the connection's read deadline and joined, and the bill is exactly
// what was read from the client past the manifest framing.
//
// The end-to-end cases run over real TCP both ways (client → central → node)
// because the interrupt only exists on a real connection; the observation
// point is a counter wrapped around the central's Request.Body, which also
// records any read that starts after the handler returned.

// --- clientBody on its own ---------------------------------------------------

// blockingReader hands out one pre-set chunk per Read, but a Read issued while
// hold is set blocks until release is called and then returns late.
type blockingReader struct {
	mu      sync.Mutex
	chunks  [][]byte
	calls   int
	hold    bool
	entered chan struct{}
	gate    chan struct{}
}

func (b *blockingReader) Read(p []byte) (int, error) {
	b.mu.Lock()
	b.calls++
	hold := b.hold
	b.mu.Unlock()
	if hold {
		close(b.entered)
		<-b.gate
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b.chunks[0])
	b.chunks = b.chunks[1:]
	return n, nil
}

func (b *blockingReader) readCalls() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls
}

func TestClientBodyReleaseRefusesLaterReadsWithoutTouchingTheClient(t *testing.T) {
	src := &blockingReader{chunks: [][]byte{[]byte("abc"), []byte("defg")}}
	b := &clientBody{r: src}
	if n, err := b.Read(make([]byte, 16)); n != 3 || err != nil {
		t.Fatalf("first read: %d, %v", n, err)
	}
	interrupted := 0
	got := b.release(func() error { interrupted++; return nil }, time.Second)
	if got != 3 || interrupted != 0 {
		t.Fatalf("release = %d (interrupts %d), want 3 and no interrupt when no read runs", got, interrupted)
	}
	if n, err := b.Read(make([]byte, 16)); n != 0 || !errors.Is(err, errClientBodyReleased) {
		t.Fatalf("read after release: %d, %v; want errClientBodyReleased", n, err)
	}
	if c := src.readCalls(); c != 1 {
		t.Fatalf("client body read %d times, want once: a released body must not pull more", c)
	}
	if again := b.release(func() error { t.Fatal("second release interrupted"); return nil }, time.Second); again != 3 {
		t.Fatalf("second release = %d, want 3", again)
	}
}

// A read that is running when the body is released is interrupted, joined,
// and its bytes are in the returned count — the legitimate in-flight read.
func TestClientBodyReleaseJoinsTheReadInFlight(t *testing.T) {
	src := &blockingReader{
		chunks:  [][]byte{bytes.Repeat([]byte("x"), 8192)},
		hold:    true,
		entered: make(chan struct{}),
		gate:    make(chan struct{}),
	}
	b := &clientBody{r: src}
	readDone := make(chan int)
	go func() {
		n, _ := b.Read(make([]byte, 32<<10))
		readDone <- n
	}()
	<-src.entered
	var interrupts atomic.Int32
	got := b.release(func() error {
		interrupts.Add(1)
		close(src.gate) // what a past read deadline does to a blocked conn read
		return nil
	}, time.Second)
	if interrupts.Load() != 1 {
		close(src.gate) // unblock the reader so the failure reports instead of hanging
		t.Fatalf("release returned %d without interrupting the read in flight", got)
	}
	if n := <-readDone; n != 8192 {
		t.Fatalf("in-flight read returned %d", n)
	}
	if got != 8192 {
		t.Fatalf("release = %d after %d interrupts, want the in-flight 8192 and one interrupt", got, interrupts.Load())
	}
}

// Where the read deadline cannot be set, release still returns within its
// bound instead of hanging the handler on a client that never sends again.
func TestClientBodyReleaseIsBoundedWhenTheReadCannotBeInterrupted(t *testing.T) {
	src := &blockingReader{
		chunks:  [][]byte{[]byte("late")},
		hold:    true,
		entered: make(chan struct{}),
		gate:    make(chan struct{}),
	}
	b := &clientBody{r: src}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		_, _ = b.Read(make([]byte, 16))
	}()
	<-src.entered
	start := time.Now()
	got := b.release(func() error { return http.ErrNotSupported }, 50*time.Millisecond)
	if d := time.Since(start); got != 0 || d > 2*time.Second {
		t.Fatalf("release = %d after %v, want 0 within its bound", got, d)
	}
	close(src.gate)
	<-readDone
	if n, err := b.Read(make([]byte, 16)); n != 0 || !errors.Is(err, errClientBodyReleased) {
		t.Fatalf("read after release: %d, %v", n, err)
	}
}

// --- end to end over real TCP ------------------------------------------------

// tcpCentral serves the production handler over real TCP and wraps each
// request's Body so a test sees exactly what the central read from its client.
type tcpCentral struct {
	srv  *httptest.Server
	mu   sync.Mutex
	body *observedBody
	done chan struct{}
	took time.Duration
}

type observedBody struct {
	rc           io.ReadCloser
	n            atomic.Int64
	active       atomic.Int32
	returned     atomic.Bool
	afterReturn  atomic.Int32
	activeAtExit int32
	ctxErrAtExit error
}

func (o *observedBody) Read(p []byte) (int, error) {
	if o.returned.Load() {
		o.afterReturn.Add(1)
	}
	o.active.Add(1)
	n, err := o.rc.Read(p)
	o.n.Add(int64(n))
	o.active.Add(-1)
	return n, err
}

func (o *observedBody) Close() error { return o.rc.Close() }

func newTCPCentral(t *testing.T, h *meterHarness) *tcpCentral {
	t.Helper()
	c := &tcpCentral{done: make(chan struct{})}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ob := &observedBody{rc: r.Body}
		r.Body = ob
		c.mu.Lock()
		c.body = ob
		c.mu.Unlock()
		start := time.Now()
		h.handler.ServeHTTP(w, r)
		ob.activeAtExit = ob.active.Load()
		ob.ctxErrAtExit = r.Context().Err()
		ob.returned.Store(true)
		c.mu.Lock()
		c.took = time.Since(start)
		c.mu.Unlock()
		close(c.done)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

// wait returns the central's observed body once its handler returned.
func (c *tcpCentral) wait(t *testing.T, limit time.Duration) (*observedBody, time.Duration) {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(limit):
		t.Fatalf("upload handler still running after %v", limit)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.body, c.took
}

// refusingNode speaks the node's PUT/DELETE contract but, like the real node
// on 401/507 (and 500 on a disk write error), answers after reading at most
// readFirst bytes; readFirst < 0 reads everything slowly and answers 200.
func refusingNode(t *testing.T, status int, readFirst int64) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var got atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			if readFirst < 0 {
				buf := make([]byte, 4096)
				for {
					n, err := r.Body.Read(buf)
					got.Add(int64(n))
					if err != nil {
						if err != io.EOF {
							http.Error(w, "write failed", http.StatusInternalServerError)
							return
						}
						break
					}
					time.Sleep(time.Millisecond)
				}
				io.WriteString(w, `{"size":`+strconv.FormatInt(got.Load(), 10)+`}`)
				return
			}
			if readFirst > 0 {
				c, _ := io.CopyN(io.Discard, r.Body, readFirst)
				got.Add(c)
			}
			http.Error(w, "refused", status)
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

func lifecycleFraming() []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, uint32(len("MANIFEST")))
	b.WriteString("MANIFEST")
	return b.Bytes()
}

// fleetHarness is a meter harness whose billable uploads go to node and may
// be large enough that the upload is still streaming when the node answers.
func fleetHarness(t *testing.T, email string, node *httptest.Server) *meterHarness {
	t.Helper()
	h := newMeterHarness(t, email)
	if err := h.store.SetSetting(context.Background(), SettingMaxFileSize, 8<<20, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	h.addNode(t, "fleet", node)
	return h
}

// streamUpload POSTs a chunked upload to central over TCP: the framing, then
// 8 KiB chunks every 2 ms until the body is refused, for at most maxFor, or
// until stall is closed if stall is non-nil after the first stallAfter bytes.
// It returns the client's status (0 on a transport error) once Do returns.
type streamOpts struct {
	maxFor     time.Duration
	stallAfter int64
	stall      chan struct{}
	stalledAt  *atomic.Int64 // unix nanoseconds when the client stopped sending
	ctx        context.Context
}

func streamUpload(t *testing.T, c *tcpCentral, h *meterHarness, o streamOpts) (int, <-chan struct{}) {
	t.Helper()
	pr, pw := io.Pipe()
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		if _, err := pw.Write(lifecycleFraming()); err != nil {
			return
		}
		chunk := bytes.Repeat([]byte("S"), 8<<10)
		var sent int64
		deadline := time.Now().Add(o.maxFor)
		for time.Now().Before(deadline) {
			if o.stall != nil && sent >= o.stallAfter {
				o.stalledAt.Store(time.Now().UnixNano())
				<-o.stall
				pw.CloseWithError(errors.New("client gave up"))
				return
			}
			n, err := pw.Write(chunk)
			sent += int64(n)
			if err != nil {
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
		pw.Close()
	}()
	ctx := o.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.srv.URL+"/api/files?ttl=0", pr)
	if err != nil {
		t.Error(err) // may run off the test goroutine
		return 0, writerDone
	}
	req.AddCookie(h.cookie)
	resp, err := c.srv.Client().Do(req)
	if err != nil {
		t.Logf("client Do: %v", err)
		return 0, writerDone
	}
	resp.Body.Close()
	return resp.StatusCode, writerDone
}

// assertExactFinalBill: one meter call, equal to every ciphertext byte the
// central read from its client, no read started after the handler returned,
// and none still running when it did.
func assertExactFinalBill(t *testing.T, h *meterHarness, ob *observedBody, consumedAtExit int64) {
	t.Helper()
	framing := int64(len(lifecycleFraming()))
	finalConsumed := ob.n.Load()
	calls := h.hook.calls()
	meter := uploadedThisMonth(t, h.store, h.userID)
	t.Logf("consumed at exit=%d final=%d (framing %d) meter=%d calls=%+v activeAtExit=%d readsAfterReturn=%d",
		consumedAtExit, finalConsumed, framing, meter, calls, ob.activeAtExit, ob.afterReturn.Load())
	if ob.activeAtExit != 0 {
		t.Fatalf("%d request body reads still running when the handler returned", ob.activeAtExit)
	}
	if n := ob.afterReturn.Load(); n != 0 {
		t.Fatalf("%d request body reads started after the handler returned", n)
	}
	if finalConsumed != consumedAtExit {
		t.Fatalf("central read %d bytes from its client after the handler returned", finalConsumed-consumedAtExit)
	}
	want := finalConsumed - framing
	if want <= 0 {
		t.Fatalf("scenario moved no ciphertext (consumed %d)", finalConsumed)
	}
	if len(calls) != 1 || calls[0].bytes != want || calls[0].err != nil || meter != want {
		t.Fatalf("billed %+v / meter %d, want exactly one call of the %d ciphertext bytes read", calls, meter, want)
	}
}

// A node that refuses before (or part-way through) the body, while the client
// is still streaming: the bill is every byte central read from the client,
// fixed when the handler returns, and nothing is read from the client after.
func TestSingleShotEarlyNodeRefusalOverTCPBillsExactlyWhatWasRead(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		readFirst int64
	}{
		{"507 before body", http.StatusInsufficientStorage, 0},
		{"401 before body", http.StatusUnauthorized, 0},
		{"500 after 64KiB", http.StatusInternalServerError, 64 << 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node, _ := refusingNode(t, tc.status, tc.readFirst)
			h := fleetHarness(t, "wn35-early-"+strconv.Itoa(tc.status)+"@example.com", node)
			c := newTCPCentral(t, h)
			code, writerDone := streamUpload(t, c, h, streamOpts{maxFor: 600 * time.Millisecond})
			ob, took := c.wait(t, 10*time.Second)
			consumedAtExit := ob.n.Load()
			<-writerDone
			time.Sleep(100 * time.Millisecond) // any straggling transport read would land now
			t.Logf("%s: client code=%d handler took %v, request context at exit: %v", tc.name, code, took, ob.ctxErrAtExit)
			if code != 0 && code != http.StatusInternalServerError {
				t.Fatalf("client got %d, want the 500 of a refused remote put", code)
			}
			if st := h.state(t); st.files != 0 || st.events != 0 {
				t.Fatalf("refused upload kept state: %+v", st)
			}
			assertExactFinalBill(t, h, ob, consumedAtExit)
		})
	}
}

// A client that stops sending mid-body, and a node that refuses only after
// that — without draining the unread body first (a Go server such as the real
// node drains up to 256 KiB before it answers; full duplex answers at once).
// The transport's copy has then forwarded everything and is blocked reading
// the stalled client when Put returns. The handler must not wait for the
// client: the read deadline ends that read at once — which also ends the
// request's context, the marker that the interrupt, not the client, released
// it — and the bill stays exactly what was read.
func TestSingleShotStalledClientAfterNodeRefusalDoesNotHoldTheHandler(t *testing.T) {
	stalled := make(chan struct{})
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		<-stalled
		time.Sleep(50 * time.Millisecond) // let central forward what it already has
		_ = http.NewResponseController(w).EnableFullDuplex()
		http.Error(w, "refused", http.StatusInsufficientStorage)
	}))
	t.Cleanup(node.Close)
	h := fleetHarness(t, "wn35-stalled@example.com", node)
	c := newTCPCentral(t, h)
	resume := make(chan struct{})
	defer close(resume)
	var stalledAt atomic.Int64
	go func() {
		for stalledAt.Load() == 0 {
			time.Sleep(time.Millisecond)
		}
		close(stalled)
	}()
	go streamUpload(t, c, h, streamOpts{maxFor: time.Minute, stallAfter: 64 << 10, stall: resume, stalledAt: &stalledAt})
	ob, took := c.wait(t, 10*time.Second)
	returnedAt := time.Now()
	consumedAtExit := ob.n.Load()
	sinceStall := returnedAt.Sub(time.Unix(0, stalledAt.Load()))
	t.Logf("stalled client: handler took %v, returned %v after the client stalled, request context at exit: %v", took, sinceStall, ob.ctxErrAtExit)
	if sinceStall > clientBodyReleaseWait/5 {
		t.Fatalf("handler returned %v after the client stalled; the in-flight read was waited out, not interrupted", sinceStall)
	}
	if ob.ctxErrAtExit == nil {
		t.Fatal("request context still live at exit: no in-flight read was interrupted, so this did not test the stall")
	}
	time.Sleep(200 * time.Millisecond)
	assertExactFinalBill(t, h, ob, consumedAtExit)
	if want := int64(64<<10) + int64(len(lifecycleFraming())); consumedAtExit != want {
		t.Fatalf("central read %d bytes, want the %d the client sent before stalling", consumedAtExit, want)
	}
}

// The client hangs up mid-stream against a node that is still reading: Put
// fails on the broken body, the handler returns promptly, and the bill is
// what was read before the hang-up.
func TestSingleShotClientCancelMidStreamBillsWhatWasRead(t *testing.T) {
	node, _ := refusingNode(t, 0, -1)
	h := fleetHarness(t, "wn35-cancel-stream@example.com", node)
	c := newTCPCentral(t, h)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(150*time.Millisecond, cancel)
	code, writerDone := streamUpload(t, c, h, streamOpts{maxFor: time.Minute, ctx: ctx})
	ob, took := c.wait(t, 10*time.Second)
	consumedAtExit := ob.n.Load()
	<-writerDone
	time.Sleep(100 * time.Millisecond)
	t.Logf("client cancel: code=%d handler took %v", code, took)
	if st := h.state(t); st.files != 0 || st.events != 0 {
		t.Fatalf("cancelled upload kept state: %+v", st)
	}
	assertExactFinalBill(t, h, ob, consumedAtExit)
}

// Success through a node over TCP: the whole body is read, billed once at
// the size read, and the body is idle when the handler answers.
func TestSingleShotFleetSuccessOverTCPBillsWhatWasRead(t *testing.T) {
	node, nodeGot := refusingNode(t, 0, -1)
	h := fleetHarness(t, "wn35-fleet-tcp@example.com", node)
	c := newTCPCentral(t, h)
	code, writerDone := streamUpload(t, c, h, streamOpts{maxFor: 100 * time.Millisecond})
	ob, _ := c.wait(t, 10*time.Second)
	consumedAtExit := ob.n.Load()
	<-writerDone
	if code != http.StatusOK {
		t.Fatalf("code=%d, want 200", code)
	}
	if st := h.state(t); st.files != 1 || st.events != 1 {
		t.Fatalf("state %+v, want one stored file and one quota event", st)
	}
	if got := nodeGot.Load(); got != consumedAtExit-int64(len(lifecycleFraming())) {
		t.Fatalf("node stored %d, central read %d ciphertext bytes", got, consumedAtExit-int64(len(lifecycleFraming())))
	}
	assertExactFinalBill(t, h, ob, consumedAtExit)
}

// F2 from the third gate: a client that DECLARES Content-Length for 900
// ciphertext bytes, sends 400 and hangs up is billed the 400 read, never the
// 900 declared — both through the handler directly and over a real socket.
func TestSingleShotDeclaredLengthHangupBillsReadNotDeclared(t *testing.T) {
	framing := lifecycleFraming()
	t.Run("handler", func(t *testing.T) {
		h := newMeterHarness(t, "wn35-declared-direct@example.com")
		var framed bytes.Buffer
		framed.Write(framing)
		framed.Write(bytes.Repeat([]byte("D"), 400))
		body := &failingBody{r: &framed, err: io.ErrUnexpectedEOF}
		req := httptest.NewRequest("POST", "/api/files?ttl=0", body)
		req.ContentLength = int64(len(framing)) + 900
		req = req.WithContext(context.WithValue(context.Background(), wn35CtxKey{}, wn35CtxValue))
		req.AddCookie(h.cookie)
		rec := httptest.NewRecorder()
		h.handler.ServeHTTP(rec, req)
		st := h.state(t)
		t.Logf("declared 900, sent 400: code=%d state=%+v", rec.Code, st)
		if want := (meterState{meter: 400}); rec.Code != http.StatusInternalServerError || st != want {
			t.Fatalf("code=%d state=%+v, want 500 %+v", rec.Code, st, want)
		}
		assertMeteredOnce(t, h, 400)
	})
	t.Run("socket", func(t *testing.T) {
		h := newMeterHarness(t, "wn35-declared-socket@example.com")
		c := newTCPCentral(t, h)
		conn, err := net.Dial("tcp", strings.TrimPrefix(c.srv.URL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		fmt.Fprintf(conn, "POST /api/files?ttl=0 HTTP/1.1\r\nHost: central.test\r\nCookie: %s\r\nContent-Length: %d\r\n\r\n",
			h.cookie.String(), len(framing)+900)
		conn.Write(framing)
		conn.Write(bytes.Repeat([]byte("D"), 400))
		conn.(*net.TCPConn).CloseWrite() // the client hangs up after 400 of the declared 900
		ob, _ := c.wait(t, 10*time.Second)
		consumedAtExit := ob.n.Load()
		if resp, err := http.ReadResponse(bufio.NewReader(conn), nil); err == nil {
			t.Logf("socket client got %d", resp.StatusCode)
			resp.Body.Close()
		}
		if consumedAtExit != int64(len(framing))+400 {
			t.Fatalf("central read %d bytes, want framing+400", consumedAtExit)
		}
		if st := h.state(t); st.files != 0 || st.meter != 400 {
			t.Fatalf("state %+v, want nothing kept and 400 billed", st)
		}
		assertExactFinalBill(t, h, ob, consumedAtExit)
	})
}

// A node that misreports what it stored cannot move the bill: monthly traffic
// is what central read from the client, whatever {"size":N} says. The stored
// row keeps the node's size, as before — that is storage metadata, not
// traffic.
func TestSingleShotNodeReportedSizeDoesNotMoveTheBill(t *testing.T) {
	for _, reported := range []int64{100, 4 << 20} {
		t.Run("reports "+strconv.FormatInt(reported, 10), func(t *testing.T) {
			node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPut {
					_, _ = io.Copy(io.Discard, r.Body)
					io.WriteString(w, `{"size":`+strconv.FormatInt(reported, 10)+`}`)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			t.Cleanup(node.Close)
			h := fleetHarness(t, "wn35-misreport-"+strconv.FormatInt(reported, 10)+"@example.com", node)
			code := h.serve(t, meterReq{body: wn35Body(900)})
			var stored int64
			if err := h.store.db.QueryRow(`SELECT size FROM stored_files WHERE user_id = ?`, h.userID).Scan(&stored); err != nil {
				t.Fatalf("code=%d, stored row: %v", code, err)
			}
			t.Logf("node reported %d: code=%d stored size=%d", reported, code, stored)
			if code != http.StatusOK || stored != reported {
				t.Fatalf("code=%d stored size=%d, want 200 and the node's %d", code, stored, reported)
			}
			assertMeteredOnce(t, h, 900)
		})
	}
}
