package cloud

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// Fault acceptance for the single-shot `relayium up` POST, against the REAL
// central upload handler (sendtest: real account.Service, real DiskStore, real
// device-code login) wherever the fault can be placed in front of it, and a
// synthetic HTTP/2 server only where a stream reset is the fault. Every fault is
// observed from the server side — requests that arrived, bytes the handler
// read, objects stored, quota debited — not inferred from the client's error.
//
// The invariants (root-reviewed before these tests were written):
//   - the POST is not idempotent and is never retried, by Upload or by net/http;
//   - an outcome the client cannot know is never reported as success;
//   - when Upload returns, no Progress or Confirming call is running or starts
//     later, and the body writer goroutine ends.

const faultMaxFile = 64 << 20

// faultCentral is one account on a real central with a CLI bearer.
type faultCentral struct {
	env   *sendtest.Env
	uid   string
	token string
}

func newFaultCentral(t *testing.T) *faultCentral {
	t.Helper()
	env := sendtest.New(t, faultMaxFile)
	uid := env.User("uploader@example.com")
	return &faultCentral{env: env, uid: uid, token: env.Login(uid, "uploader-box")}
}

// posts is how many upload POSTs reached central (counted before any fault).
func (fc *faultCentral) posts() int { return fc.env.Faults.Hits("POST /api/files") }

// stored is how many objects central holds for the account.
func (fc *faultCentral) stored(t *testing.T) int {
	t.Helper()
	fs, err := fc.env.Store.ListStoredFilesByUser(context.Background(), fc.uid)
	if err != nil {
		t.Fatalf("list stored files: %v", err)
	}
	return len(fs)
}

// client is a CLI client with the production transport split, bounded so a
// withheld answer ends the command in well under a second.
func (fc *faultCentral) client(server string) *Client {
	c := newClientWith(server, http.DefaultTransport.(*http.Transport), clientTimeouts{
		responseHeader: 10 * time.Second,
		confirmBase:    300 * time.Millisecond,
		confirmMinRate: 1 << 30, // the tail adds nothing: loopback
	})
	c.Token = fc.token
	return c
}

var atUploadPOST = sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/files", PathSuffix: "/api/files"}

// hookWatch records every Progress and Confirming call and whether it ran (or
// was still running) after Upload returned.
type hookWatch struct {
	returned   atomic.Bool
	inFlight   atomic.Int32
	late       atomic.Int32
	progress   atomic.Int32
	confirming atomic.Int32
	maxSent    atomic.Int64
	onProgress func(sent int64)
}

func (h *hookWatch) install(c *Client) {
	c.Progress = func(done, _ int64) {
		h.inFlight.Add(1)
		defer h.inFlight.Add(-1)
		if h.returned.Load() {
			h.late.Add(1)
		}
		h.progress.Add(1)
		if done > h.maxSent.Load() {
			h.maxSent.Store(done)
		}
		if h.onProgress != nil {
			h.onProgress(done)
		}
	}
	c.Confirming = func() {
		h.inFlight.Add(1)
		defer h.inFlight.Add(-1)
		if h.returned.Load() {
			h.late.Add(1)
		}
		h.confirming.Add(1)
	}
}

// upload runs Upload and marks the return the way the CLI does (it clears its
// progress line at that moment).
func (h *hookWatch) upload(c *Client, ctx context.Context, path string) (string, error) {
	id, _, _, err := c.Upload(ctx, []string{path}, UploadOpts{})
	if h.inFlight.Load() != 0 {
		h.late.Add(1)
	}
	h.returned.Store(true)
	return id, err
}

// assertQuiescent: no hook ran after the return, and the body writer
// goroutine Upload started has ended.
func (h *hookWatch) assertQuiescent(t *testing.T) {
	t.Helper()
	waitUploadWriterGone(t)
	if n := h.late.Load(); n != 0 {
		t.Fatalf("%d Progress/Confirming call(s) ran at or after Upload returned", n)
	}
}

// waitUploadWriterGone waits (bounded) until no goroutine started by Upload is
// alive: the body writer must end on every path, not linger on a pipe or timer.
func waitUploadWriterGone(t *testing.T) {
	t.Helper()
	const marker = "created by github.com/relayium/relayium/internal/cloud.(*Client).Upload"
	deadline := time.Now().Add(5 * time.Second)
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if !bytes.Contains(buf[:n], []byte(marker)) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the upload body writer goroutine is still alive 5s after Upload returned:\n%s", buf[:n])
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func writeFaultFile(t *testing.T, size int) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "payload.bin")
	b := make([]byte, size)
	for i := range b {
		b[i] = byte(i * 7)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// bodyProbe wraps the request body the REAL handler reads, so the test knows
// how many bytes central consumed and when its read ended (and how).
type bodyProbe struct {
	io.ReadCloser
	n    atomic.Int64
	once sync.Once
	done chan struct{}
	err  error
}

func (b *bodyProbe) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.n.Add(int64(n))
	if err != nil {
		b.once.Do(func() { b.err = err; close(b.done) })
	}
	return n, err
}

// probeUploadBody installs a rule that wraps the next upload POST's body.
func (fc *faultCentral) probeUploadBody() *bodyProbe {
	probe := &bodyProbe{done: make(chan struct{})}
	r := atUploadPOST
	r.Action = sendtest.Before
	r.Fn = func(req *http.Request) {
		probe.ReadCloser = req.Body
		req.Body = probe
	}
	fc.env.Faults.Add(&r)
	return probe
}

func (b *bodyProbe) wait(t *testing.T) {
	t.Helper()
	select {
	case <-b.done:
	case <-time.After(10 * time.Second):
		t.Fatal("central's read of the upload body never ended")
	}
}

// assertNothingStoredAfter waits for central's body read to end and then for
// the handler's cleanup window, and requires no object and no quota debit.
func (fc *faultCentral) assertNothingStoredAfter(t *testing.T, probe *bodyProbe) {
	t.Helper()
	probe.wait(t)
	if probe.err == io.EOF {
		t.Fatalf("central read the whole body (%d bytes) to a clean EOF; the fault did not cut it", probe.n.Load())
	}
	for end := time.Now().Add(300 * time.Millisecond); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if n := fc.stored(t); n != 0 {
			t.Fatalf("central stored %d object(s) from a body it never received in full", n)
		}
	}
	if q := fc.env.QuotaBytes(fc.uid); q != 0 {
		t.Fatalf("daily quota debited %d bytes for an upload that was never completed", q)
	}
}

// The answer to a COMMITTED upload is lost: central stored the object and
// debited the quota, then the connection closed before the client read a byte
// of the response. Exactly one POST; Upload does not report success; nothing is
// retried by Upload or by net/http; hooks and writer are quiescent.
func TestUploadCommittedThenConnectionDroppedIsNeverRetried(t *testing.T) {
	fc := newFaultCentral(t)
	r := atUploadPOST
	r.Action = sendtest.DropResponse
	fc.env.Faults.Add(&r)

	p := writeFaultFile(t, 3<<20+17)
	c := fc.client(fc.env.TS.URL)
	var h hookWatch
	h.install(c)
	id, err := h.upload(c, context.Background(), p)
	if err == nil || id != "" {
		t.Fatalf("Upload = (%q, %v); an answer that never arrived must not be reported as success", id, err)
	}
	if n := fc.posts(); n != 1 {
		t.Fatalf("central saw %d upload POSTs; a lost answer must never be retried", n)
	}
	if n := fc.stored(t); n != 1 {
		t.Fatalf("central holds %d objects; the fault must have let the handler commit exactly one", n)
	}
	if fc.env.QuotaBytes(fc.uid) == 0 {
		t.Fatal("the committed upload debited no quota; the fault did not run the real handler to completion")
	}
	if h.confirming.Load() != 1 {
		t.Fatalf("Confirming called %d times; the whole body was handed over, so once", h.confirming.Load())
	}
	h.assertQuiescent(t)
	t.Logf("client-visible error after a committed upload whose answer was lost: %q", err)
}

// The answer to a COMMITTED upload is withheld (a hung proxy, a stalled
// response path). Upload ends after confirmTimeout with UploadUnconfirmedError,
// whose "if this upload did arrive after all" is, here, provably the case.
func TestUploadCommittedThenAnswerWithheldIsUnconfirmedNotFailed(t *testing.T) {
	fc := newFaultCentral(t)
	r := atUploadPOST
	r.Action = sendtest.HoldResponse
	r.Hit = make(chan struct{})
	hold := fc.env.Faults.Add(&r)
	t.Cleanup(hold.Release)

	p := writeFaultFile(t, 2<<20)
	c := fc.client(fc.env.TS.URL)
	var h hookWatch
	h.install(c)
	start := time.Now()
	_, err := h.upload(c, context.Background(), p)
	var unconfirmed *UploadUnconfirmedError
	if !errors.As(err, &unconfirmed) {
		t.Fatalf("err = %v; a withheld answer must be reported as unconfirmed, not as a failure", err)
	}
	if el := time.Since(start); el > 10*time.Second {
		t.Fatalf("took %s; the wait for the answer is not bounded", el)
	}
	select {
	case <-hold.Hit:
	default:
		t.Fatal("the withheld request never reached central")
	}
	if n := fc.stored(t); n != 1 {
		t.Fatalf("central holds %d objects; the unconfirmed upload did arrive (want 1)", n)
	}
	if n := fc.posts(); n != 1 {
		t.Fatalf("central saw %d upload POSTs; an unconfirmed upload is never retried", n)
	}
	if !strings.Contains(err.Error(), "nothing was retried") || !strings.Contains(err.Error(), "did arrive after all") {
		t.Fatalf("the message must say the outcome is unknown: %q", err)
	}
	h.assertQuiescent(t)
}

// cutProxy is a loopback TCP proxy that forwards to target and, once, cuts
// BOTH connections after exactly cutAfter bytes of the body of the first
// request whose bytes contain marker. A real socket fault, mid-body: the
// client is still writing when its connection dies.
type cutProxy struct {
	ln       net.Listener
	target   string
	marker   []byte
	cutAfter int64

	mu    sync.Mutex
	cut   bool
	conns []net.Conn
	cuts  atomic.Int32
	wg    sync.WaitGroup
}

func newCutProxy(t *testing.T, target, marker string, cutAfter int64) *cutProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &cutProxy{ln: ln, target: target, marker: []byte(marker), cutAfter: cutAfter}
	p.wg.Add(1)
	go p.accept()
	t.Cleanup(p.close)
	return p
}

func (p *cutProxy) addr() string { return p.ln.Addr().String() }

func (p *cutProxy) close() {
	p.ln.Close()
	p.mu.Lock()
	for _, c := range p.conns {
		c.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
}

func (p *cutProxy) track(c net.Conn) {
	p.mu.Lock()
	p.conns = append(p.conns, c)
	p.mu.Unlock()
}

func (p *cutProxy) accept() {
	defer p.wg.Done()
	for {
		cc, err := p.ln.Accept()
		if err != nil {
			return
		}
		sc, err := net.Dial("tcp", p.target)
		if err != nil {
			cc.Close()
			continue
		}
		p.track(cc)
		p.track(sc)
		p.wg.Add(2)
		go func() { defer p.wg.Done(); _, _ = io.Copy(cc, sc); cc.Close() }()
		go func() { defer p.wg.Done(); p.upstream(cc, sc) }()
	}
}

// upstream forwards client->server, counting body bytes after the marked
// request's header, and cuts once at cutAfter.
func (p *cutProxy) upstream(cc, sc net.Conn) {
	defer sc.Close()
	var win []byte
	inBody := false
	var counted int64
	buf := make([]byte, 64<<10)
	for {
		n, err := cc.Read(buf)
		chunk := buf[:n]
		forward := len(chunk)
		cut := false
		p.mu.Lock()
		armed := !p.cut
		p.mu.Unlock()
		if armed && n > 0 {
			if !inBody {
				win = append(win, chunk...)
				if i := bytes.Index(win, p.marker); i >= 0 {
					if e := bytes.Index(win[i:], []byte("\r\n\r\n")); e >= 0 {
						inBody = true
						bodyInChunk := min(len(win)-(i+e+4), len(chunk))
						if int64(bodyInChunk) >= p.cutAfter {
							forward = len(chunk) - bodyInChunk + int(p.cutAfter)
							cut = true
						} else {
							counted = int64(bodyInChunk)
						}
					} else {
						win = append([]byte(nil), win[i:]...)
					}
				} else if len(win) > len(p.marker) {
					win = append([]byte(nil), win[len(win)-len(p.marker):]...)
				}
			} else if counted+int64(n) >= p.cutAfter {
				forward = int(p.cutAfter - counted)
				cut = true
			} else {
				counted += int64(n)
			}
		}
		if forward > 0 {
			if _, werr := sc.Write(chunk[:forward]); werr != nil {
				cc.Close()
				return
			}
		}
		if cut {
			p.mu.Lock()
			p.cut = true
			p.mu.Unlock()
			p.cuts.Add(1)
			// Hard close on both sides: the client's next write fails.
			if tc, ok := cc.(*net.TCPConn); ok {
				_ = tc.SetLinger(0)
			}
			cc.Close()
			sc.Close()
			return
		}
		if err != nil {
			cc.Close()
			return
		}
	}
}

// The connection dies MID-BODY, on the socket, over HTTP/1.1 to the real
// central: the client is still streaming when its connection is reset. Central
// must store nothing; the client reports a failure (truthfully — central never
// had the whole body), never retries, never says "confirming".
func TestUploadBodyCutMidStreamOnTheSocketStoresNothingAndIsNotRetried(t *testing.T) {
	fc := newFaultCentral(t)
	probe := fc.probeUploadBody()
	const cutAfter = 1 << 20
	px := newCutProxy(t, strings.TrimPrefix(fc.env.TS.URL, "http://"), "POST /api/files", cutAfter)

	p := writeFaultFile(t, 24<<20)
	c := fc.client("http://" + px.addr())
	var h hookWatch
	h.install(c)
	id, err := h.upload(c, context.Background(), p)
	if err == nil || id != "" {
		t.Fatalf("Upload = (%q, %v); want a failure", id, err)
	}
	var unconfirmed *UploadUnconfirmedError
	if errors.As(err, &unconfirmed) {
		t.Fatalf("err = %v; the body was never fully sent, so the outcome is not 'unconfirmed'", err)
	}
	if px.cuts.Load() != 1 {
		t.Fatalf("the proxy cut %d times; the fault did not fire", px.cuts.Load())
	}
	if n := fc.posts(); n != 1 {
		t.Fatalf("central saw %d upload POSTs; a broken stream must never be re-sent", n)
	}
	fc.assertNothingStoredAfter(t, probe)
	if got := probe.n.Load(); got >= 24<<20 {
		t.Fatalf("central read %d bytes; want fewer than the body", got)
	}
	if h.confirming.Load() != 0 {
		t.Fatal("Confirming was called for a body that was never fully handed over")
	}
	if h.maxSent.Load() >= 24<<20 {
		t.Fatalf("progress reached %d of %d; it must not claim a body that never left", h.maxSent.Load(), 24<<20)
	}
	h.assertQuiescent(t)
	t.Logf("cut after %d body bytes; central read %d bytes, ended with %v; client error %q",
		cutAfter, probe.n.Load(), probe.err, err)
}

// The same mid-body fault over HTTP/2 with TLS: the server resets the stream
// after reading part of the body. One stream, no retry, no "confirming".
func TestUploadStreamResetMidBodyOverHTTP2IsNotRetried(t *testing.T) {
	var posts atomic.Int32
	var read atomic.Int64
	const cutAfter = 1 << 20
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		if r.ProtoMajor != 2 {
			t.Errorf("proto = %s; the case is HTTP/2", r.Proto)
		}
		n, _ := io.CopyN(io.Discard, r.Body, cutAfter)
		read.Store(n)
		panic(http.ErrAbortHandler) // RST_STREAM mid-body
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)

	p := writeFaultFile(t, 24<<20)
	c := newClientWith(srv.URL, srv.Client().Transport.(*http.Transport), clientTimeouts{
		responseHeader: 10 * time.Second, confirmBase: 300 * time.Millisecond, confirmMinRate: 1 << 30,
	})
	c.Token = "t"
	var h hookWatch
	h.install(c)
	_, err := h.upload(c, context.Background(), p)
	if err == nil {
		t.Fatal("a reset stream was reported as success")
	}
	var unconfirmed *UploadUnconfirmedError
	if errors.As(err, &unconfirmed) {
		t.Fatalf("err = %v; the body was never fully sent", err)
	}
	if n := posts.Load(); n != 1 {
		t.Fatalf("server saw %d streams; a reset POST must never be re-sent", n)
	}
	if read.Load() != cutAfter {
		t.Fatalf("server read %d bytes before the reset; the fault did not fire where intended", read.Load())
	}
	if h.confirming.Load() != 0 {
		t.Fatal("Confirming was called for a body that was never fully handed over")
	}
	h.assertQuiescent(t)
	t.Logf("HTTP/2 client error after a mid-body stream reset: %q", err)
}

// The stored login is no longer valid (revoked/expired): central answers 401
// before reading the body. The client must say so — "session expired, run
// `relayium login` again" — not report a network failure, and never retry.
// Run several times: the 401 races the client's still-streaming body.
func TestUploadWithARevokedLoginSaysSessionExpired(t *testing.T) {
	fc := newFaultCentral(t)
	if err := fc.env.Store.DeleteCLIToken(context.Background(), authx.HashToken(fc.token)); err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{64 << 10, 8 << 20} {
		p := writeFaultFile(t, size)
		const rounds = 5
		for i := 0; i < rounds; i++ {
			before := fc.posts()
			c := fc.client(fc.env.TS.URL)
			var h hookWatch
			h.install(c)
			_, err := h.upload(c, context.Background(), p)
			if err == nil || !strings.Contains(err.Error(), "session expired") {
				t.Fatalf("size %d round %d: err = %v; a revoked login must be reported as an expired session", size, i, err)
			}
			if n := fc.posts() - before; n != 1 {
				t.Fatalf("size %d round %d: %d POSTs; a refused upload is never retried", size, i, n)
			}
			h.assertQuiescent(t)
		}
	}
	if n := fc.stored(t); n != 0 {
		t.Fatalf("central stored %d objects for a revoked login", n)
	}
	if q := fc.env.QuotaBytes(fc.uid); q != 0 {
		t.Fatalf("quota debited %d for a revoked login", q)
	}
}

// The caller's context ends BEFORE, DURING and AFTER the body. Before: nothing
// reaches central. During: central stores nothing and the writer stops. After
// (central committed, answer not yet sent): the result is "cancelled" — never
// success, never "unconfirmed" (the caller chose to stop waiting) — and the one
// stored object is the only one.
func TestUploadCallerCancellationBeforeDuringAndAfterTheBody(t *testing.T) {
	t.Run("before", func(t *testing.T) {
		fc := newFaultCentral(t)
		p := writeFaultFile(t, 1<<20)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		c := fc.client(fc.env.TS.URL)
		var h hookWatch
		h.install(c)
		_, err := h.upload(c, ctx, p)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v; want context.Canceled", err)
		}
		if n := fc.posts(); n != 0 {
			t.Fatalf("central saw %d POSTs from a command cancelled before it started", n)
		}
		if h.confirming.Load() != 0 {
			t.Fatal("Confirming was called")
		}
		h.assertQuiescent(t)
	})

	t.Run("during the body", func(t *testing.T) {
		fc := newFaultCentral(t)
		probe := fc.probeUploadBody()
		const size = 24 << 20
		p := writeFaultFile(t, size)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := fc.client(fc.env.TS.URL)
		var h hookWatch
		var once sync.Once
		h.onProgress = func(sent int64) {
			if sent >= 2<<20 {
				once.Do(cancel)
			}
		}
		h.install(c)
		_, err := h.upload(c, ctx, p)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v; want context.Canceled", err)
		}
		var unconfirmed *UploadUnconfirmedError
		if errors.As(err, &unconfirmed) {
			t.Fatal("a caller's cancellation is not an unconfirmed upload")
		}
		if n := fc.posts(); n != 1 {
			t.Fatalf("central saw %d POSTs", n)
		}
		fc.assertNothingStoredAfter(t, probe)
		if h.confirming.Load() != 0 {
			t.Fatal("Confirming was called for a body that was never fully handed over")
		}
		h.assertQuiescent(t)
	})

	t.Run("after the body, before the answer", func(t *testing.T) {
		fc := newFaultCentral(t)
		r := atUploadPOST
		r.Action = sendtest.HoldResponse
		r.Hit = make(chan struct{})
		hold := fc.env.Faults.Add(&r)
		t.Cleanup(hold.Release)
		p := writeFaultFile(t, 2<<20)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := newClientWith(fc.env.TS.URL, http.DefaultTransport.(*http.Transport), clientTimeouts{
			responseHeader: 10 * time.Second, confirmBase: time.Minute, confirmMinRate: 1 << 30,
		})
		c.Token = fc.token
		var h hookWatch
		h.install(c)
		go func() {
			select {
			case <-hold.Hit: // central has committed the object
				cancel()
			case <-time.After(30 * time.Second):
			}
		}()
		id, err := h.upload(c, ctx, p)
		if id != "" || !errors.Is(err, context.Canceled) {
			t.Fatalf("Upload = (%q, %v); want context.Canceled", id, err)
		}
		var unconfirmed *UploadUnconfirmedError
		if errors.As(err, &unconfirmed) {
			t.Fatal("the caller's own cancellation was reported as a confirm timeout")
		}
		if n := fc.posts(); n != 1 {
			t.Fatalf("central saw %d POSTs", n)
		}
		if n := fc.stored(t); n != 1 {
			t.Fatalf("central holds %d objects; it committed exactly one before the cancel", n)
		}
		if h.confirming.Load() != 1 {
			t.Fatalf("Confirming called %d times; want once", h.confirming.Load())
		}
		h.assertQuiescent(t)
	})
}
