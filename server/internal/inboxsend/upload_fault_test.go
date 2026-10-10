package inboxsend

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// Socket-level and timing fault acceptance for the Device Inbox sender's
// resumable upload, against the real central (sendtest). The existing suite
// loses answers and feeds the handler a truncated body from INSIDE the server;
// these put the fault on the client's real connection — a TCP reset mid-PATCH,
// a client-side response timeout, the caller's own cancellation mid-body — and
// then judge the outcome from what central committed.

// sessionVia opens the sender over transport (a fresh Session, as a new
// command would) with notices captured like world.session.
func (w *world) sessionVia(tr http.RoundTripper) *Session {
	w.t.Helper()
	s, err := Open(w.cfgDir, tr)
	if err != nil {
		w.t.Fatalf("open session: %v", err)
	}
	s.Notice = &lockedBuf{b: &w.notice}
	return s
}

// dialVia is a production-shaped transport whose every connection goes to
// addr, whatever host the request names: the journal and bearer keep naming
// central while the bytes cross the test's proxy.
func dialVia(addr string, headerTimeout time.Duration) *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = headerTimeout
	var d net.Dialer
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return d.DialContext(ctx, network, addr)
	}
	return tr
}

// tcpCut is a loopback proxy that, once, resets both sides of the connection
// after exactly cutAfter body bytes of the first request containing marker.
type tcpCut struct {
	ln       net.Listener
	target   string
	marker   []byte
	cutAfter int64

	mu    sync.Mutex
	fired bool
	conns []net.Conn
	cuts  atomic.Int32
	wg    sync.WaitGroup
}

func newTCPCut(t *testing.T, target, marker string, cutAfter int64) *tcpCut {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &tcpCut{ln: ln, target: target, marker: []byte(marker), cutAfter: cutAfter}
	p.wg.Add(1)
	go p.accept()
	t.Cleanup(func() {
		p.ln.Close()
		p.mu.Lock()
		for _, c := range p.conns {
			c.Close()
		}
		p.mu.Unlock()
		p.wg.Wait()
	})
	return p
}

func (p *tcpCut) accept() {
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
		p.mu.Lock()
		p.conns = append(p.conns, cc, sc)
		p.mu.Unlock()
		p.wg.Add(2)
		go func() { defer p.wg.Done(); _, _ = io.Copy(cc, sc); cc.Close() }()
		go func() { defer p.wg.Done(); p.upstream(cc, sc) }()
	}
}

func (p *tcpCut) upstream(cc, sc net.Conn) {
	defer sc.Close()
	var win []byte
	inBody := false
	var counted int64
	buf := make([]byte, 64<<10)
	for {
		n, err := cc.Read(buf)
		chunk := buf[:n]
		forward, cut := n, false
		p.mu.Lock()
		armed := !p.fired
		p.mu.Unlock()
		if armed && n > 0 {
			switch {
			case !inBody:
				win = append(win, chunk...)
				i := bytes.Index(win, p.marker)
				if i < 0 {
					if len(win) > len(p.marker) {
						win = append([]byte(nil), win[len(win)-len(p.marker):]...)
					}
					break
				}
				e := bytes.Index(win[i:], []byte("\r\n\r\n"))
				if e < 0 {
					win = append([]byte(nil), win[i:]...)
					break
				}
				inBody = true
				body := min(len(win)-(i+e+4), n)
				if int64(body) >= p.cutAfter {
					forward, cut = n-body+int(p.cutAfter), true
				} else {
					counted = int64(body)
				}
			case counted+int64(n) >= p.cutAfter:
				forward, cut = int(p.cutAfter-counted), true
			default:
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
			p.fired = true
			p.mu.Unlock()
			p.cuts.Add(1)
			if tc, ok := cc.(*net.TCPConn); ok {
				_ = tc.SetLinger(0) // RST: the client's in-flight write fails
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

// waitPatches waits (bounded) until central has recorded n PATCHes and
// returns them.
func waitPatches(t *testing.T, w *world, n int) []sendtest.Patch {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if p := w.env.Faults.Patches(); len(p) >= n {
			if len(p) > n {
				t.Fatalf("central saw %d PATCHes; want %d", len(p), n)
			}
			return p
		}
		if time.Now().After(deadline) {
			t.Fatalf("central never recorded %d PATCH(es)", n)
		}
	}
}

// assertQuietAfterReturn: once the command has returned, nothing it started
// sends another request.
func assertQuietAfterReturn(t *testing.T, w *world) {
	t.Helper()
	before, status := hitsOf(w), w.env.Faults.Hits(sendtest.KeyStatus)
	time.Sleep(300 * time.Millisecond)
	if after := hitsOf(w); after != before || w.env.Faults.Hits(sendtest.KeyStatus) != status {
		t.Fatalf("requests after the command returned: %+v -> %+v", before, after)
	}
}

// The connection is RESET mid-PATCH on the socket — the client is still
// writing an 8 MiB chunk. The sender asks central where it got to and resumes
// there from its held ciphertext: one upload session, every byte ever sent
// identical to the committed ciphertext (N4), no seq sealed twice (N1), one
// quota debit, the exact content delivered. The PATCH is never replayed by
// net/http itself.
func TestPatchResetMidBodyOnTheSocketResumesAtTheServerOffset(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 64<<20)
	data := randomBytes(t, 17<<20+999)
	root := writeTree(t, map[string][]byte{"big.bin": data})
	const cutAfter = 3 << 20
	px := newTCPCut(t, strings.TrimPrefix(w.env.TS.URL, "http://"), "PATCH /api/uploads/", cutAfter)

	res, err := w.sessionVia(dialVia(px.ln.Addr().String(), 30*time.Second)).Send(context.Background(),
		SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "big.bin")}})
	if err != nil {
		t.Fatalf("send across a mid-body reset: %v\nnotices:\n%s", err, w.notice.String())
	}
	if px.cuts.Load() != 1 {
		t.Fatalf("the proxy cut %d times; the fault did not fire", px.cuts.Load())
	}
	patches := w.env.Faults.Patches()
	if len(patches) == 0 || int64(len(patches[0].Body)) >= 8<<20 {
		t.Fatal("central received the first PATCH whole; the reset did not land mid-body")
	}
	if got := int64(len(patches[0].Body)); got > cutAfter {
		t.Fatalf("central read %d bytes of the cut PATCH; the proxy forwarded only %d", got, cutAfter)
	}
	if w.env.Faults.Hits(sendtest.KeyStatus) == 0 {
		t.Fatal("the sender resumed without asking central where the upload stood")
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 {
		t.Fatalf("hits %+v; want one upload, one finalize, one create", h)
	}
	d := w.receive(res.TaskID)
	if !bytes.Equal(d.files["big.bin"], data) {
		t.Fatal("delivered content differs")
	}
	assertBytesMatchFinalBlob(t, patches, d.blob)
	if want := 1 + framesFor(len(data)); reg.seals() != want {
		t.Fatalf("C1: sealed %d units, want %d", reg.seals(), want)
	}
	if q := w.env.QuotaBytes(w.uid); q != res.CiphertextBytes {
		t.Fatalf("quota %d, want one upload's %d", q, res.CiphertextBytes)
	}
	assertNoSendState(t, w)
	t.Logf("cut after %d body bytes; central read %d of the first PATCH; %d PATCHes, %d status reads",
		cutAfter, len(patches[0].Body), len(patches), w.env.Faults.Hits(sendtest.KeyStatus))
}

// Central COMMITS a chunk but its answer never comes; the client's own
// response timeout (a real net/http timeout, not a dropped connection) ends
// the wait. The sender reads the committed offset and continues FROM it: the
// next PATCH starts where the committed chunk ended — the committed chunk is
// not sent again.
func TestPatchAnswerTimeoutAdoptsTheCommittedOffset(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 64<<20)
	data := randomBytes(t, 9<<20+4321)
	root := writeTree(t, map[string][]byte{"a.bin": data})
	r := atPatch
	r.Action, r.Hit = sendtest.HoldResponse, make(chan struct{})
	hold := w.env.Faults.Add(&r)
	t.Cleanup(hold.Release)

	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = 1500 * time.Millisecond
	start := time.Now()
	res, err := w.sessionVia(tr).Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.bin")}})
	if err != nil {
		t.Fatalf("send: %v\nnotices:\n%s", err, w.notice.String())
	}
	if el := time.Since(start); el > 20*time.Second {
		t.Fatalf("took %s", el)
	}
	select {
	case <-hold.Hit:
	default:
		t.Fatal("the held PATCH never reached central")
	}
	p := w.env.Faults.Patches()
	if len(p) < 2 {
		t.Fatalf("%d PATCHes", len(p))
	}
	committed := p[0].Start + int64(len(p[0].Body))
	if p[1].Start != committed {
		t.Fatalf("after the timeout the next PATCH started at %d; central had committed %d", p[1].Start, committed)
	}
	if w.env.Faults.Hits(sendtest.KeyStatus) == 0 {
		t.Fatal("the sender continued without reading the committed offset")
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 {
		t.Fatalf("hits %+v", h)
	}
	d := w.receive(res.TaskID)
	if !bytes.Equal(d.files["a.bin"], data) {
		t.Fatal("delivered content differs")
	}
	assertBytesMatchFinalBlob(t, p, d.blob)
	if want := 1 + framesFor(len(data)); reg.seals() != want {
		t.Fatalf("C1: sealed %d units, want %d", reg.seals(), want)
	}
	if q := w.env.QuotaBytes(w.uid); q != res.CiphertextBytes {
		t.Fatalf("quota %d, want %d", q, res.CiphertextBytes)
	}
}

// The login is revoked between two PATCHes (an expired or signed-out
// credential): central's real auth answers 401. That is definitive for the
// request it answers and nothing was finalized, so the send stops — no PATCH
// replay, no status probe, no finalize — reports signed_out with what the
// partial upload leaves behind, and keeps no record (nothing can resume it).
func TestCredentialRevokedMidUploadStopsWithoutRetrying(t *testing.T) {
	fastBackoff(t)
	watchNonces(t)
	w := newWorld(t, 64<<20)
	root := writeTree(t, map[string][]byte{"a.bin": randomBytes(t, 17<<20)})
	revoked := make(chan error, 1)
	r := atPatch
	r.Skip, r.Action = 1, sendtest.Before
	r.Fn = func(req *http.Request) {
		revoked <- w.env.Store.DeleteCLIToken(context.Background(),
			authx.HashToken(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")))
	}
	w.env.Faults.Add(&r)

	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.bin")}})
	select {
	case rerr := <-revoked:
		if rerr != nil {
			t.Fatal(rerr)
		}
	default:
		t.Fatal("the revocation never ran")
	}
	e := AsError(err)
	if e == nil || e.Class != ClassFailed || e.Code != CodeSignedOut {
		t.Fatalf("err = %v; want a definitive signed_out", err)
	}
	if !strings.Contains(e.Msg, "partial upload stays on the server") {
		t.Fatalf("the message must say what the partial upload leaves behind: %s", e.Msg)
	}
	if h := hitsOf(w); h.init != 1 || h.patch != 2 || h.finalize != 0 || h.create != 0 {
		t.Fatalf("hits %+v; want the refused PATCH as the last request", h)
	}
	if n := w.env.Faults.Hits(sendtest.KeyStatus); n != 0 {
		t.Fatalf("%d status reads; a 401 is not a transport failure to probe after", n)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("records kept: %v", ids)
	}
	if q := w.env.QuotaBytes(w.uid); q != 0 {
		t.Fatalf("quota %d for an upload that was never completed", q)
	}
	if n := len(w.tasks()); n != 0 {
		t.Fatalf("tasks = %d", n)
	}
	assertQuietAfterReturn(t, w)
}

// cancelMidBody is a transport whose FIRST PATCH body cancels the command's
// context after `after` bytes have been read from it, then fails the read: the
// caller's cancellation lands while net/http is still writing the body.
type cancelMidBody struct {
	base   http.RoundTripper
	after  int64
	cancel context.CancelFunc
	armed  atomic.Bool
	fired  atomic.Bool
}

func (c *cancelMidBody) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodPatch && r.Body != nil && c.armed.CompareAndSwap(true, false) {
		r = r.Clone(r.Context())
		r.Body = &cancellingBody{ReadCloser: r.Body, left: c.after, ctx: r.Context(), cm: c}
	}
	return c.base.RoundTrip(r)
}

type cancellingBody struct {
	io.ReadCloser
	left int64
	ctx  context.Context
	cm   *cancelMidBody
}

func (b *cancellingBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		b.cm.fired.Store(true)
		b.cm.cancel()
		<-b.ctx.Done()
		return 0, b.ctx.Err()
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	n, err := b.ReadCloser.Read(p)
	b.left -= int64(n)
	return n, err
}

// The caller cancels while a PATCH body is in flight. The command ends
// interrupted with its record kept, sends nothing after it returned, and the
// interrupted upload can never be completed by anything but an explicit,
// truthful `inbox retry`: for a streamed send that is not_resumable (no
// upload, no finalize, no task — the record is then gone), for a resumable
// send it finishes from the same local ciphertext without sealing anything.
func TestCancelMidPatchBody(t *testing.T) {
	t.Run("before any request", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := w.session().Send(ctx, SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
		if e := AsError(err); e == nil || e.Class != ClassInterrupted {
			t.Fatalf("err = %v; want interrupted", err)
		}
		if h := hitsOf(w); h != (hits{}) {
			t.Fatalf("hits %+v; a command cancelled before it started writes nothing", h)
		}
		if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
			t.Fatalf("records: %v", ids)
		}
	})

	t.Run("streamed send", func(t *testing.T) {
		fastBackoff(t)
		watchNonces(t)
		w := newWorld(t, 64<<20)
		root := writeTree(t, map[string][]byte{"a.bin": randomBytes(t, 9<<20)})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		cm := &cancelMidBody{base: http.DefaultTransport.(*http.Transport).Clone(), after: 2 << 20, cancel: cancel}
		cm.armed.Store(true)
		_, err := w.sessionVia(cm).Send(ctx, SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.bin")}})
		if !cm.fired.Load() {
			t.Fatal("the cancellation never fired mid-body")
		}
		e := AsError(err)
		if e == nil || e.Class != ClassInterrupted || e.LocalSendID == "" {
			t.Fatalf("err = %v; want interrupted with the record kept", err)
		}
		// Barrier: central finishes reading the cut PATCH after the client has
		// already returned, so wait for its own record of it.
		if p := waitPatches(t, w, 1); int64(len(p[0].Body)) >= 8<<20 {
			t.Fatalf("central received %d bytes of the PATCH; want it cut short", len(p[0].Body))
		}
		if j := theRecord(t, w); j.Phase != PhaseUploading {
			t.Fatalf("phase = %s", j.Phase)
		}
		assertQuietAfterReturn(t, w)

		before := hitsOf(w)
		_, err = w.session().Retry(context.Background(), e.LocalSendID)
		if re := AsError(err); re == nil || re.Code != CodeNotResumable {
			t.Fatalf("retry = %v; want not_resumable", err)
		}
		if after := hitsOf(w); after != before {
			t.Fatalf("retry wrote: %+v -> %+v", before, after)
		}
		_, err = w.session().Retry(context.Background(), e.LocalSendID)
		if re := AsError(err); re == nil || re.Code != CodeNoSuchSend {
			t.Fatalf("second retry = %v; want no_such_send", err)
		}
		if len(w.tasks()) != 0 || w.env.QuotaBytes(w.uid) != 0 {
			t.Fatal("an interrupted streamed send was completed or counted")
		}
		assertNoSendState(t, w)
	})

	t.Run("resumable send", func(t *testing.T) {
		fastBackoff(t)
		reg := watchNonces(t)
		w := newWorld(t, 64<<20)
		data := randomBytes(t, 17<<20+77)
		root := writeTree(t, map[string][]byte{"a.bin": data})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		cm := &cancelMidBody{base: http.DefaultTransport.(*http.Transport).Clone(), after: 2 << 20, cancel: cancel}
		cm.armed.Store(true)
		_, err := w.sessionVia(cm).Send(ctx, SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.bin")}, Resumable: true})
		if !cm.fired.Load() {
			t.Fatal("the cancellation never fired mid-body")
		}
		e := AsError(err)
		if e == nil || e.Class != ClassInterrupted || e.LocalSendID == "" {
			t.Fatalf("err = %v; want interrupted with the record kept", err)
		}
		j := theRecord(t, w)
		if !j.Spooled() || j.Phase != PhaseUploading {
			t.Fatalf("record = %+v", j)
		}
		copyBefore := spoolBytes(t, w, j.ID)
		if p := waitPatches(t, w, 1); int64(len(p[0].Body)) >= 8<<20 {
			t.Fatalf("central received %d bytes of the PATCH; want it cut short", len(p[0].Body))
		}
		assertQuietAfterReturn(t, w)

		seals := reg.seals()
		res, err := w.session().Retry(context.Background(), e.LocalSendID)
		if err != nil {
			t.Fatalf("retry: %v", err)
		}
		if reg.seals() != seals {
			t.Fatalf("N3: retry sealed %d units", reg.seals()-seals)
		}
		if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 || len(w.tasks()) != 1 {
			t.Fatalf("hits %+v tasks %d", h, len(w.tasks()))
		}
		d := w.receive(res.TaskID)
		if !bytes.Equal(d.files["a.bin"], data) || !bytes.Equal(copyBefore[j.HeaderBytes:], d.blob) {
			t.Fatal("the delivery is not the ciphertext the interrupted send produced")
		}
		assertBytesMatchFinalBlob(t, w.env.Faults.Patches(), d.blob)
		if q := w.env.QuotaBytes(w.uid); q != res.CiphertextBytes {
			t.Fatalf("quota %d, want %d", q, res.CiphertextBytes)
		}
		assertNoSendState(t, w)
	})
}

// A create LANDED but its answer was lost; the user then cancels the delivery
// (it is deleted, and its stored object released). Nothing may queue it again:
// neither the in-process replay nor a later `inbox retry` creates a task, the
// replay is byte-identical, nothing is uploaded again, and the outcome is
// never reported as a newly queued delivery.
func TestACancelledLandedDeliveryIsNeverQueuedAgain(t *testing.T) {
	assertNeverRequeued := func(t *testing.T, w *world, err error, quota int64) {
		t.Helper()
		if err == nil {
			t.Fatal("a cancelled delivery was reported as queued")
		}
		e := AsError(err)
		if e == nil || e.Class != ClassUnknown || e.LocalSendID == "" {
			t.Fatalf("err = %v; want unknown with the record kept", err)
		}
		if n := len(w.tasks()); n != 0 {
			t.Fatalf("tasks = %d; the cancelled delivery was queued again", n)
		}
		c := w.env.Faults.Creates()
		for i := range c {
			if !bytes.Equal(c[i], c[0]) {
				t.Fatalf("create #%d differs from the first; a replay must be byte-identical", i)
			}
		}
		if h := hitsOf(w); h.init != 1 {
			t.Fatalf("inits = %d; nothing may be uploaded again", h.init)
		}
		if got := w.env.QuotaBytes(w.uid); got != quota {
			t.Fatalf("quota %d -> %d", quota, got)
		}
	}

	t.Run("cancelled before an in-process replay", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		lost := atCreate
		lost.Action = sendtest.DropResponse
		w.env.Faults.Add(&lost)
		fixture := make(chan error, 1)
		replay := atCreate
		replay.Action = sendtest.Before
		replay.Fn = func(*http.Request) { fixture <- cancelTheLandedTask(w) }
		w.env.Faults.Add(&replay)
		_, err := sendOne(t, w)
		drainFixture(t, fixture)
		assertNeverRequeued(t, w, errOrNil(err), w.env.QuotaBytes(w.uid))
		if len(w.env.Faults.Creates()) < 2 {
			t.Fatal("the lost create was not replayed")
		}
	})

	t.Run("cancelled before inbox retry", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
		hold := w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
		id := interruptAt(t, w, hold, filepath.Join(root, "a.txt"))
		if err := cancelTheLandedTask(w); err != nil {
			t.Fatal(err)
		}
		quota := w.env.QuotaBytes(w.uid)
		for range 2 {
			_, err := w.session().Retry(context.Background(), id)
			assertNeverRequeued(t, w, err, quota)
		}
		if n := len(w.env.Faults.Creates()); n != 3 {
			t.Fatalf("creates = %d; want the original and one replay per retry", n)
		}
	})
}

// errOrNil turns a nil *Error into a nil error (sendOne returns *Error).
func errOrNil(e *Error) error {
	if e == nil {
		return nil
	}
	return e
}
