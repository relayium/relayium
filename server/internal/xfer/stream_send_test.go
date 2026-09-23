package xfer

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/stdinpump"
)

// The xfer test binary doubles as the stdin helper (until the CLI dispatches
// __pump-stdin in phase 2b) and as the child process of the receiver's
// watchdog tests (stream_recv_test.go).
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == stdinpump.HelperArg {
		os.Exit(stdinpump.RunHelper(os.Args[2:]))
	}
	if role := os.Getenv(streamChildEnv); role != "" {
		os.Exit(runStreamChild(role))
	}
	os.Exit(m.Run())
}

var errFakeAborted = errors.New("fake transport aborted")

// fakeTransport is a StreamTransport whose two directions are separately
// controllable:
//
//   - sender -> peer is an io.Pipe: a Write blocks until the scripted peer
//     reads it, so "the peer stopped reading" is real blocking;
//   - peer -> sender is a queue the peer appends to without ever blocking, and
//     from which the sender's Read takes bytes only while the queue's gate is
//     open, so a reply can be held back and handed to R at a chosen moment.
//
// Each sender Write is one frame (SendStream writes a frame with one Write);
// the fake records every frame. An End frame can be held: it is delivered to
// the peer, then the Write stays "in the kernel" until endRet is closed or the
// transport is aborted. Nothing in SendStream can close endRet.
//
// inflight counts sender Read/Write calls that have not returned; it must be 0
// when SendStream returns (W and R joined).
type fakeTransport struct {
	toPeerR *io.PipeReader
	toPeerW *io.PipeWriter

	qmu    sync.Mutex
	qcond  *sync.Cond
	queue  []byte
	qEOF   bool
	gateOn bool // true: sender reads are held

	holdEnd      bool
	failEnd      bool          // End write returns an error instead of being delivered
	holdData     chan struct{} // when set, a data Write blocks until it is closed (or Abort)
	dataHeld     chan struct{} // closed when a data Write is being held
	endDelivered chan struct{}
	endRet       chan struct{} // closed by the test only
	endReturned  chan struct{} // closed when the End Write returned

	abortOnce sync.Once
	aborted   chan struct{}
	aborts    atomic.Int32
	inflight  atomic.Int32

	fmu    sync.Mutex
	frames []recFrame
}

type recFrame struct {
	t       MsgType
	payload []byte
}

func newFakeTransport() *fakeTransport {
	r, w := io.Pipe()
	f := &fakeTransport{
		toPeerR: r, toPeerW: w,
		endDelivered: make(chan struct{}),
		endRet:       make(chan struct{}),
		endReturned:  make(chan struct{}),
		aborted:      make(chan struct{}),
	}
	f.qcond = sync.NewCond(&f.qmu)
	return f
}

func (f *fakeTransport) Write(b []byte) (int, error) {
	f.inflight.Add(1)
	defer f.inflight.Add(-1)
	select {
	case <-f.aborted:
		return 0, errFakeAborted
	default:
	}
	if len(b) >= streamFrameHeader {
		f.fmu.Lock()
		f.frames = append(f.frames, recFrame{MsgType(b[0]), append([]byte(nil), b[streamFrameHeader:]...)})
		f.fmu.Unlock()
	}
	isEnd := len(b) > 0 && MsgType(b[0]) == MsgStreamEnd
	if isEnd {
		defer close(f.endReturned)
	}
	if isEnd && f.failEnd {
		f.peerEOF() // the connection is gone
		return 0, errors.New("fake: broken pipe on End")
	}
	if f.holdData != nil && len(b) > 0 && MsgType(b[0]) == MsgStreamData {
		select {
		case <-f.dataHeld:
		default:
			close(f.dataHeld)
		}
		select {
		case <-f.holdData:
		case <-f.aborted:
			return 0, errFakeAborted
		}
	}
	n, err := f.toPeerW.Write(b)
	if err != nil {
		return n, err
	}
	if isEnd && f.holdEnd {
		close(f.endDelivered)
		select {
		case <-f.endRet:
		case <-f.aborted:
			return n, errFakeAborted
		}
	}
	return n, nil
}

func (f *fakeTransport) Read(b []byte) (int, error) {
	f.inflight.Add(1)
	defer f.inflight.Add(-1)
	f.qmu.Lock()
	defer f.qmu.Unlock()
	for {
		select {
		case <-f.aborted:
			return 0, errFakeAborted
		default:
		}
		if !f.gateOn && len(f.queue) > 0 {
			n := copy(b, f.queue)
			f.queue = f.queue[n:]
			return n, nil
		}
		if !f.gateOn && f.qEOF {
			return 0, io.EOF
		}
		f.qcond.Wait()
	}
}

func (f *fakeTransport) Abort() error {
	f.aborts.Add(1)
	f.abortOnce.Do(func() {
		close(f.aborted)
		f.toPeerR.CloseWithError(errFakeAborted)
		f.toPeerW.CloseWithError(errFakeAborted)
		f.qmu.Lock()
		f.qcond.Broadcast()
		f.qmu.Unlock()
	})
	return nil
}

// Peer side.

func (f *fakeTransport) peerSend(t MsgType, v any) {
	var payload []byte
	switch p := v.(type) {
	case []byte:
		payload = p
	default:
		payload, _ = json.Marshal(v)
	}
	f.peerRaw(appendFrame(nil, t, payload))
}

func (f *fakeTransport) peerRaw(b []byte) {
	f.qmu.Lock()
	f.queue = append(f.queue, b...)
	f.qcond.Broadcast()
	f.qmu.Unlock()
}

func (f *fakeTransport) peerEOF() {
	f.qmu.Lock()
	f.qEOF = true
	f.qcond.Broadcast()
	f.qmu.Unlock()
}

// holdReplies holds (true) or releases (false) what the peer sent.
func (f *fakeTransport) holdReplies(on bool) {
	f.qmu.Lock()
	f.gateOn = on
	f.qcond.Broadcast()
	f.qmu.Unlock()
}

// queuedReplies reports how many peer bytes the sender has not read yet.
func (f *fakeTransport) queuedReplies() int {
	f.qmu.Lock()
	defer f.qmu.Unlock()
	return len(f.queue)
}

func (f *fakeTransport) peerRead() (MsgType, []byte, error) {
	return ReadFrame(f.toPeerR)
}

// peerExpect reads frames until one of type want (skipping keepalives), and
// fails the test on anything else.
func (f *fakeTransport) peerExpect(t *testing.T, want MsgType) []byte {
	t.Helper()
	for {
		typ, p, err := f.peerRead()
		if err != nil {
			t.Errorf("peer: reading for type %d: %v", want, err)
			return nil
		}
		if typ == want {
			return p
		}
		if typ == MsgStreamData {
			continue
		}
		t.Errorf("peer: got type %d, want %d", typ, want)
		return nil
	}
}

func (f *fakeTransport) recorded() []recFrame {
	f.fmu.Lock()
	defer f.fmu.Unlock()
	return append([]recFrame(nil), f.frames...)
}

func (f *fakeTransport) sentTypes() []MsgType {
	var ts []MsgType
	for _, fr := range f.recorded() {
		ts = append(ts, fr.t)
	}
	return ts
}

// fakeSource yields data in reads of at most chunk bytes, then either io.EOF
// or, with block set, blocks until Stop. It records whether Read was ever
// called, and whether a Read in progress returned after Stop.
type fakeSource struct {
	data  []byte
	chunk int
	block bool
	err   error // returned after data instead of EOF, when set

	mu       sync.Mutex
	off      int
	stopped  chan struct{}
	stopOnce sync.Once
	stops    atomic.Int32
	reads    atomic.Int32
	inRead   atomic.Int32
}

func newSource(data []byte, chunk int) *fakeSource {
	return &fakeSource{data: data, chunk: chunk, stopped: make(chan struct{})}
}

func (s *fakeSource) Read(b []byte) (int, error) {
	s.reads.Add(1)
	s.inRead.Add(1)
	defer s.inRead.Add(-1)
	s.mu.Lock()
	if s.off < len(s.data) {
		n := min(len(b), s.chunk, len(s.data)-s.off)
		copy(b, s.data[s.off:s.off+n])
		s.off += n
		s.mu.Unlock()
		return n, nil
	}
	s.mu.Unlock()
	if s.err != nil {
		return 0, s.err
	}
	if s.block {
		<-s.stopped
		return 0, errors.New("fake source stopped")
	}
	return 0, io.EOF
}

func (s *fakeSource) Stop() error {
	s.stops.Add(1)
	s.stopOnce.Do(func() { close(s.stopped) })
	return nil
}

func startOf(s StreamSource) func() (StreamSource, error) {
	return func() (StreamSource, error) { return s, nil }
}

func noStart(t *testing.T, called *atomic.Bool) func() (StreamSource, error) {
	return func() (StreamSource, error) {
		called.Store(true)
		t.Error("start called before the receiver accepted the stream")
		return nil, errors.New("must not start")
	}
}

type sendResult struct {
	rep StreamReport
	err error
	at  time.Time
}

func sendAsync(ctx context.Context, tr StreamTransport, name string, start func() (StreamSource, error)) <-chan sendResult {
	c := make(chan sendResult, 1)
	go func() {
		rep, err := SendStream(ctx, tr, name, start, StreamSendOpts{})
		c <- sendResult{rep, err, time.Now()}
	}()
	return c
}

func waitSend(t *testing.T, c <-chan sendResult, d time.Duration) sendResult {
	t.Helper()
	select {
	case r := <-c:
		return r
	case <-time.After(d):
		t.Fatalf("SendStream did not return within %v", d)
		return sendResult{}
	}
}

// joined asserts W and R and P have all returned: no transport call and no
// source Read is still in progress.
func joined(t *testing.T, f *fakeTransport, s *fakeSource) {
	t.Helper()
	if n := f.inflight.Load(); n != 0 {
		t.Fatalf("%d transport calls still in progress after SendStream returned", n)
	}
	if s != nil && s.inRead.Load() != 0 {
		t.Fatal("a source Read is still in progress after SendStream returned")
	}
}

// peerAccept plays a receiver up to StreamAccept.
func peerAccept(t *testing.T, f *fakeTransport) {
	t.Helper()
	f.peerExpect(t, MsgHello)
	f.peerExpect(t, MsgManifest)
	f.peerSend(MsgStreamAccept, StreamAccept{ChunkMax: StreamChunkMax})
}

// connTransport is a StreamTransport over a net.Conn: Abort closes it.
type connTransport struct {
	net.Conn
	aborts atomic.Int32
}

func (c *connTransport) Abort() error { c.aborts.Add(1); return c.Conn.Close() }

// realPair connects SendStream and ReceiveStream over net.Pipe, receiving
// into dir/name. The receiver runs in its own goroutine.
func realPair(t *testing.T, dir, name string, o StreamRecvOpts) (*connTransport, <-chan recvResult) {
	t.Helper()
	a, b := net.Pipe()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := make(chan recvResult, 1)
	go func() {
		defer root.Close()
		defer b.Close()
		rep, err := ReceiveStream(b, StreamTarget{Parent: root, Leaf: name}, o)
		c <- recvResult{rep, err}
	}()
	return &connTransport{Conn: a}, c
}

type recvResult struct {
	rep StreamRecvReport
	err error
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range es {
		names = append(names, e.Name())
	}
	return names
}

func assertNoStaging(t *testing.T, dir string) {
	t.Helper()
	for _, n := range listDir(t, dir) {
		if strings.HasPrefix(n, stagePrefix) {
			t.Fatalf("staging %s left in %s (listing %v)", n, dir, listDir(t, dir))
		}
	}
}

func specialBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := 0; i < n; i += 97 {
		b[i] = []byte{0, '\r', '\n', 0xFF}[(i/97)%4]
	}
	return b
}

// U-S1: exact round trip through the real receiver, for boundary sizes and
// for a source that returns one byte per Read.
func TestStreamRoundTrip(t *testing.T) {
	cases := []struct {
		size, chunk int
	}{
		{0, 1 << 20}, {1, 1 << 20}, {StreamChunkMax - 1, 1 << 20}, {StreamChunkMax, 1 << 20},
		{StreamChunkMax + 1, 1 << 20}, {5*StreamChunkMax + 7, 256 << 10}, {5*StreamChunkMax + 7, 3 << 20},
		{4099, 1}, // one byte per Read: every byte its own frame
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%d_by_%d", c.size, c.chunk), func(t *testing.T) {
			dir := t.TempDir()
			data := specialBytes(c.size)
			tr, rc := realPair(t, dir, "out.bin", StreamRecvOpts{})
			src := newSource(data, c.chunk)
			rep, err := SendStream(context.Background(), tr, "out.bin", startOf(src), StreamSendOpts{})
			if err != nil {
				t.Fatalf("SendStream: %v", err)
			}
			rr := <-rc
			if rr.err != nil || !rr.rep.Installed {
				t.Fatalf("receiver: %+v %v", rr.rep, rr.err)
			}
			sum := sha256.Sum256(data)
			if rep.Bytes != int64(c.size) || rep.SHA256 != hex.EncodeToString(sum[:]) || rr.rep.SHA256 != rep.SHA256 {
				t.Fatalf("report %+v, receiver %+v", rep, rr.rep)
			}
			got, err := os.ReadFile(filepath.Join(dir, "out.bin"))
			if err != nil || !bytes.Equal(got, data) {
				t.Fatalf("installed %d bytes (err %v), want %d identical", len(got), err, len(data))
			}
			assertNoStaging(t, dir)
			if tr.aborts.Load() != 0 {
				t.Fatal("healthy transfer aborted its transport")
			}
			if src.stops.Load() != 1 {
				t.Fatalf("source stopped %d times, want exactly once (reap)", src.stops.Load())
			}
		})
	}
}

// U-S2: whatever the receiver answers instead of StreamAccept, the source is
// never started (nothing reads stdin), the transport is aborted, and every
// goroutine is joined.
func TestStreamNoSourceBeforeAccept(t *testing.T) {
	cases := []struct {
		name  string
		reply func(f *fakeTransport)
		want  error
	}{
		{"eof (old __recv exits on the unknown flag)", func(f *fakeTransport) { f.peerEOF() }, ErrStreamNotAccepted},
		{"v1 resume state (v0.11 receiver)", func(f *fakeTransport) { f.peerSend(MsgResume, ResumeState{}) }, ErrStreamNotAccepted},
		{"refusal", func(f *fakeTransport) {
			f.peerSend(MsgError, WireError{Code: ErrCodeDestinationExists, Msg: "out.bin already exists on the receiver"})
		}, nil},
		{"garbage (remote shell noise)", func(f *fakeTransport) { f.peerRaw([]byte("Welcome to host\n")) }, ErrStreamNotAccepted},
		{"v1 result", func(f *fakeTransport) { f.peerSend(MsgResult, Result{OK: true}) }, ErrStreamNotAccepted},
		{"stream result first", func(f *fakeTransport) { f.peerSend(MsgStreamResult, StreamResult{}) }, ErrStreamNotAccepted},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeTransport()
			var called atomic.Bool
			res := sendAsync(context.Background(), f, "out.bin", noStart(t, &called))
			f.peerExpect(t, MsgHello)
			f.peerExpect(t, MsgManifest)
			c.reply(f)
			r := waitSend(t, res, 5*time.Second)
			if r.err == nil {
				t.Fatal("success without an accept")
			}
			var se *StreamSendError
			if !errors.As(r.err, &se) || se.Stage != StreamBeforeAccept {
				t.Fatalf("error %v, want a StreamSendError at StreamBeforeAccept", r.err)
			}
			if c.want != nil && !errors.Is(r.err, c.want) {
				t.Fatalf("error %v, want %v", r.err, c.want)
			}
			var re *RemoteError
			if c.want == nil && (!errors.As(r.err, &re) || re.Code != ErrCodeDestinationExists) {
				t.Fatalf("error %v, want the receiver's destination_exists", r.err)
			}
			if !strings.Contains(r.err.Error(), "nothing was read from stdin and nothing was installed") {
				t.Fatalf("wording %q", r.err)
			}
			if called.Load() {
				t.Fatal("source started")
			}
			if f.aborts.Load() != 1 {
				t.Fatalf("aborts = %d, want 1", f.aborts.Load())
			}
			joined(t, f, nil)
			if got := f.sentTypes(); len(got) != 2 || got[0] != MsgHello || got[1] != MsgManifest {
				t.Fatalf("sent %v, want only Hello and Manifest", got)
			}
		})
	}
}

// A write that already failed (here: the Manifest) is not undone by an Accept
// that still arrives: the input is never started.
func TestStreamNoSourceAfterWriteFailure(t *testing.T) {
	defer func(d time.Duration) { streamErrDrainGrace = d }(streamErrDrainGrace)
	streamErrDrainGrace = 300 * time.Millisecond
	f := newFakeTransport()
	var called atomic.Bool
	res := sendAsync(context.Background(), f, "out.bin", noStart(t, &called))
	f.peerExpect(t, MsgHello)
	f.toPeerR.CloseWithError(errors.New("fake: connection reset")) // the Manifest write fails
	// W's Write has returned (only R's Read is in progress); W reports the
	// failure as its very next step, before this Accept exists.
	for deadline := time.Now().Add(5 * time.Second); f.inflight.Load() != 1; {
		if time.Now().After(deadline) {
			t.Fatal("the Manifest write never failed")
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	f.peerSend(MsgStreamAccept, StreamAccept{ChunkMax: StreamChunkMax})
	r := waitSend(t, res, 5*time.Second)
	var se *StreamSendError
	if !errors.As(r.err, &se) || se.Stage != StreamBeforeAccept || !strings.Contains(r.err.Error(), "connection reset") {
		t.Fatalf("error %v", r.err)
	}
	if called.Load() {
		t.Fatal("source started after the Manifest could not be sent")
	}
	joined(t, f, nil)
}

// U-S3: a source blocked in Read (silent stdin) is released and joined when
// the receiver refuses mid-stream and when the caller cancels.
func TestStreamJoinsBlockedSource(t *testing.T) {
	for _, mode := range []string{"remote error", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newFakeTransport()
			src := newSource([]byte("head"), 1<<20)
			src.block = true
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			res := sendAsync(ctx, f, "out.bin", startOf(src))
			peerAccept(t, f)
			if p := f.peerExpect(t, MsgStreamData); string(p) != "head" {
				t.Fatalf("first chunk %q", p)
			}
			// The source is now blocked in its second Read.
			deadline := time.Now().Add(5 * time.Second)
			for src.inRead.Load() == 0 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if src.inRead.Load() == 0 {
				t.Fatal("source never blocked")
			}
			if mode == "cancel" {
				cancel()
			} else {
				f.peerSend(MsgError, WireError{Code: ErrCodeWriteFailed, Msg: "disk full"})
			}
			r := waitSend(t, res, 5*time.Second)
			var se *StreamSendError
			if !errors.As(r.err, &se) || se.Stage != StreamSending {
				t.Fatalf("error %v, want StreamSending", r.err)
			}
			if mode == "cancel" && !errors.Is(r.err, ErrStreamCancelled) {
				t.Fatalf("error %v, want ErrStreamCancelled", r.err)
			}
			if !strings.HasSuffix(r.err.Error(), "; nothing was installed on the receiver") {
				t.Fatalf("wording %q", r.err)
			}
			if src.stops.Load() < 1 {
				t.Fatal("source not stopped")
			}
			joined(t, f, src)
			for _, typ := range f.sentTypes() {
				if typ == MsgStreamEnd {
					t.Fatal("End sent for an unfinished input")
				}
			}
		})
	}
}

// U-S4: a helper that vanished mid-stream is an error; End is never written,
// so the receiver can never install a truncated input.
func TestStreamSourceVanishedNeverEnds(t *testing.T) {
	f := newFakeTransport()
	src := newSource([]byte("partial input"), 1<<20)
	src.err = stdinpump.ErrHelperVanished
	res := sendAsync(context.Background(), f, "out.bin", startOf(src))
	peerAccept(t, f)
	go func() {
		for {
			if _, _, err := f.peerRead(); err != nil {
				return
			}
		}
	}()
	r := waitSend(t, res, 5*time.Second)
	if !errors.Is(r.err, stdinpump.ErrHelperVanished) {
		t.Fatalf("error %v, want ErrHelperVanished", r.err)
	}
	if want := "the stdin reader ended unexpectedly; nothing was installed on the receiver"; r.err.Error() != want {
		t.Fatalf("wording %q, want %q", r.err, want)
	}
	for _, typ := range f.sentTypes() {
		if typ == MsgStreamEnd {
			t.Fatal("End sent after the source vanished")
		}
	}
	joined(t, f, src)
}

// U-S5: W blocked in a data Write (the receiver stopped reading) is released
// by Abort when the receiver's refusal arrives.
func TestStreamAbortReleasesBlockedWrite(t *testing.T) {
	f := newFakeTransport()
	src := newSource(make([]byte, 8*StreamChunkMax), StreamChunkMax)
	res := sendAsync(context.Background(), f, "out.bin", startOf(src))
	peerAccept(t, f)
	f.peerExpect(t, MsgStreamData) // then stop reading: the next data Write blocks
	deadline := time.Now().Add(5 * time.Second)
	for f.inflight.Load() < 2 && time.Now().Before(deadline) { // W in Write, R in Read
		time.Sleep(time.Millisecond)
	}
	start := time.Now()
	f.peerSend(MsgError, WireError{Code: ErrCodeWriteFailed, Msg: "writing out.bin on the receiver failed: no space left on device"})
	r := waitSend(t, res, 5*time.Second)
	t.Logf("returned %v after the refusal", r.at.Sub(start))
	if r.at.Sub(start) > 2*time.Second {
		t.Fatalf("took %v", r.at.Sub(start))
	}
	var re *RemoteError
	if !errors.As(r.err, &re) || re.Code != ErrCodeWriteFailed {
		t.Fatalf("error %v, want the receiver's write_failed", r.err)
	}
	if f.aborts.Load() != 1 {
		t.Fatalf("aborts %d", f.aborts.Load())
	}
	joined(t, f, src)
}

// U-S6: the same over a real TLS connection whose peer stops reading: the
// sender's Write is blocked in the kernel (observed: one Write in progress,
// no progress for 300 ms), and Abort (Close) releases it.
func TestStreamAbortReleasesBlockedTLSWrite(t *testing.T) {
	cert := selfSignedCert(t)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	tr := &countingTLS{}
	peerDone := make(chan struct{})
	release := make(chan struct{})
	var refusedAt time.Time
	go func() {
		defer close(peerDone)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		for _, want := range []MsgType{MsgHello, MsgManifest} {
			if typ, _, err := ReadFrame(c); err != nil || typ != want {
				t.Errorf("peer: %v %v", typ, err)
				return
			}
		}
		_ = WriteJSON(c, MsgStreamAccept, StreamAccept{ChunkMax: StreamChunkMax})
		// Stop reading. Wait until the sender is provably stuck in a Write.
		last, still := int64(-1), 0
		for deadline := time.Now().Add(10 * time.Second); still < 6; {
			if time.Now().After(deadline) {
				t.Error("the sender never blocked in a Write")
				return
			}
			time.Sleep(50 * time.Millisecond)
			if w := tr.written.Load(); tr.writing.Load() == 1 && w == last {
				still++
			} else {
				last, still = w, 0
			}
		}
		refusedAt = time.Now()
		_ = WriteJSON(c, MsgError, WireError{Code: ErrCodeWriteFailed, Msg: "disk full"})
		<-release
	}()
	conn, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	tr.Conn = conn
	src := &zeroSource{stopped: make(chan struct{})}
	res := sendAsync(context.Background(), tr, "out.bin", startOf(src))
	r := waitSend(t, res, 20*time.Second)
	close(release)
	<-peerDone
	t.Logf("returned %v after the refusal; %d bytes written before the peer stopped reading", r.at.Sub(refusedAt), tr.written.Load())
	var re *RemoteError
	if !errors.As(r.err, &re) || re.Code != ErrCodeWriteFailed {
		t.Fatalf("error %v", r.err)
	}
	if d := r.at.Sub(refusedAt); d > 2*time.Second {
		t.Fatalf("returned %v after the refusal", d)
	}
	if tr.aborts.Load() != 1 || tr.writing.Load() != 0 {
		t.Fatalf("aborts %d, writes in progress %d", tr.aborts.Load(), tr.writing.Load())
	}
}

// countingTLS observes the sender's writes on a real TLS connection.
type countingTLS struct {
	connTransport
	writing atomic.Int32
	written atomic.Int64
}

func (c *countingTLS) Write(b []byte) (int, error) {
	c.writing.Add(1)
	defer c.writing.Add(-1)
	n, err := c.Conn.Write(b)
	c.written.Add(int64(n))
	return n, err
}

// zeroSource is an endless input of zeros until Stop.
type zeroSource struct {
	n       atomic.Int64
	stopped chan struct{}
	once    sync.Once
}

func (z *zeroSource) Read(b []byte) (int, error) {
	select {
	case <-z.stopped:
		return 0, errors.New("stopped")
	default:
	}
	clear(b)
	z.n.Add(int64(len(b)))
	return len(b), nil
}

func (z *zeroSource) Stop() error { z.once.Do(func() { close(z.stopped) }); return nil }

func selfSignedCert(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "stream-test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// U-S7: a result right after Accept — with no challenge, with a guessed
// challenge, or a v1 result — is never success.
func TestStreamPrematureResultRejected(t *testing.T) {
	guess := newStreamChallenge()
	cases := []struct {
		name string
		send func(f *fakeTransport)
	}{
		{"no challenge", func(f *fakeTransport) {
			f.peerSend(MsgStreamResult, StreamResult{Size: 4, SHA256: sha256Hex([]byte("data"))})
		}},
		{"guessed challenge", func(f *fakeTransport) {
			f.peerSend(MsgStreamResult, StreamResult{Size: 4, SHA256: sha256Hex([]byte("data")), Challenge: guess})
		}},
		{"v1 result", func(f *fakeTransport) { f.peerSend(MsgResult, Result{OK: true}) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeTransport()
			src := newSource([]byte("data"), 1<<20)
			src.block = true // End is never reached
			res := sendAsync(context.Background(), f, "out.bin", startOf(src))
			peerAccept(t, f)
			c.send(f)
			r := waitSend(t, res, 5*time.Second)
			if !errors.Is(r.err, ErrStreamUnconfirmed) {
				t.Fatalf("error %v, want ErrStreamUnconfirmed", r.err)
			}
			if !strings.Contains(r.err.Error(), "NOT confirmed; do not trust out.bin on the receiver") {
				t.Fatalf("wording %q", r.err)
			}
			joined(t, f, src)
		})
	}
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// U-S8: cancellation while W is blocked writing Hello (the peer reads
// nothing): Abort releases it, start is never called.
func TestStreamCancelBeforeAcceptWithBlockedWrite(t *testing.T) {
	f := newFakeTransport() // the peer never reads: Write(Hello) blocks
	var called atomic.Bool
	ctx, cancel := context.WithCancel(context.Background())
	res := sendAsync(ctx, f, "out.bin", noStart(t, &called))
	time.Sleep(100 * time.Millisecond)
	if n := f.inflight.Load(); n != 2 {
		t.Fatalf("%d transport calls in progress, want W in Write and R in Read", n)
	}
	start := time.Now()
	cancel()
	r := waitSend(t, res, 5*time.Second)
	if d := r.at.Sub(start); d > 2*time.Second {
		t.Fatalf("returned %v after cancel", d)
	}
	var se *StreamSendError
	if !errors.As(r.err, &se) || se.Stage != StreamBeforeAccept || !errors.Is(r.err, ErrStreamCancelled) {
		t.Fatalf("error %v", r.err)
	}
	if called.Load() {
		t.Fatal("source started")
	}
	joined(t, f, nil)
}

// honestEcho answers End like a correct receiver would: same size, hash and
// challenge.
func honestEcho(t *testing.T, endPayload []byte) StreamResult {
	t.Helper()
	var end StreamEnd
	if err := json.Unmarshal(endPayload, &end); err != nil {
		t.Errorf("End: %v", err)
	}
	return StreamResult(end)
}

// U-S9 (C1): the receiver's correct confirmation reaches R while W is still
// inside Write(End); the End write then returns normally. Success, no Abort.
func TestStreamValidFastReceipt(t *testing.T) {
	f := newFakeTransport()
	f.holdEnd = true
	data := []byte("the whole input")
	src := newSource(data, 1<<20)
	res := sendAsync(context.Background(), f, "out.bin", startOf(src))
	peerAccept(t, f)
	end := f.peerExpect(t, MsgStreamEnd)
	<-f.endDelivered
	f.peerSend(MsgStreamResult, honestEcho(t, end))
	// Release the End write only after R consumed the whole result.
	deadline := time.Now().Add(5 * time.Second)
	for f.queuedReplies() > 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	select {
	case <-f.endReturned:
		t.Fatal("End returned before the result was read")
	default:
	}
	time.Sleep(20 * time.Millisecond)
	close(f.endRet)
	r := waitSend(t, res, 5*time.Second)
	if r.err != nil {
		t.Fatalf("valid fast receipt rejected: %v", r.err)
	}
	if r.rep.Bytes != int64(len(data)) || len(r.rep.Notes) != 0 || f.aborts.Load() != 0 {
		t.Fatalf("report %+v, aborts %d", r.rep, f.aborts.Load())
	}
	joined(t, f, src)
}

// U-S10: wording is keyed on the phase at judgment. An End write that fails
// with no confirmation is ambiguous; a data write that fails is "nothing was
// installed".
func TestStreamWordingByPhase(t *testing.T) {
	t.Run("end write fails", func(t *testing.T) {
		f := newFakeTransport()
		f.failEnd = true
		src := newSource([]byte("abc"), 1<<20)
		res := sendAsync(context.Background(), f, "out.bin", startOf(src))
		peerAccept(t, f)
		f.peerExpect(t, MsgStreamData)
		r := waitSend(t, res, 10*time.Second)
		var se *StreamSendError
		if !errors.As(r.err, &se) || se.Stage != StreamEndAttempted {
			t.Fatalf("error %v, want StreamEndAttempted", r.err)
		}
		if !strings.Contains(r.err.Error(), "it may or may not have installed out.bin. Check it there before retrying") {
			t.Fatalf("wording %q", r.err)
		}
		joined(t, f, src)
	})
	t.Run("data write fails", func(t *testing.T) {
		defer func(d time.Duration) { streamErrDrainGrace = d }(streamErrDrainGrace)
		streamErrDrainGrace = 200 * time.Millisecond // the peer stays silent: no explanation comes
		f := newFakeTransport()
		src := newSource(make([]byte, 3*StreamChunkMax), StreamChunkMax)
		res := sendAsync(context.Background(), f, "out.bin", startOf(src))
		peerAccept(t, f)
		f.peerExpect(t, MsgStreamData)
		f.toPeerR.CloseWithError(errors.New("fake: connection reset")) // the next data Write fails
		checkDataWriteFailure(t, f, src, res)
	})
	// The same with the source blocked in Read (silent stdin) when the write
	// fails: stopping the source must not replace the cause with the
	// source's own "stopped".
	t.Run("data write fails while the source blocks", func(t *testing.T) {
		defer func(d time.Duration) { streamErrDrainGrace = d }(streamErrDrainGrace)
		streamErrDrainGrace = 200 * time.Millisecond
		f := newFakeTransport()
		src := newSource([]byte("one chunk"), 1<<20)
		src.block = true
		res := sendAsync(context.Background(), f, "out.bin", startOf(src))
		peerAccept(t, f)
		f.toPeerR.CloseWithError(errors.New("fake: connection reset")) // the first data Write fails
		checkDataWriteFailure(t, f, src, res)
	})
}

func checkDataWriteFailure(t *testing.T, f *fakeTransport, src *fakeSource, res <-chan sendResult) {
	t.Helper()
	{
		r := waitSend(t, res, 10*time.Second)
		var se *StreamSendError
		if !errors.As(r.err, &se) || se.Stage != StreamSending {
			t.Fatalf("error %v, want StreamSending", r.err)
		}
		if !strings.HasSuffix(r.err.Error(), "; nothing was installed on the receiver") || !strings.Contains(r.err.Error(), "connection reset") {
			t.Fatalf("wording %q", r.err)
		}
		joined(t, f, src)
	}
}

// U-S11 (C2): the receiver confirms correctly, but the End write never
// returns locally. The sender's own endGrace timer fires, Abort is called
// exactly once BEFORE the join, the gate is never released by the sender, and
// the verdict is success with a note.
func TestStreamHeldEndAfterValidReceiptIsBounded(t *testing.T) {
	defer func(d time.Duration) { streamEndGrace = d }(streamEndGrace)
	streamEndGrace = 300 * time.Millisecond
	f := newFakeTransport()
	f.holdEnd = true
	src := newSource([]byte("x"), 1<<20)
	res := sendAsync(context.Background(), f, "out.bin", startOf(src))
	peerAccept(t, f)
	end := f.peerExpect(t, MsgStreamEnd)
	f.peerSend(MsgStreamResult, honestEcho(t, end))
	start := time.Now()
	r := waitSend(t, res, 5*time.Second)
	d := r.at.Sub(start)
	t.Logf("returned %v after the confirmation (endGrace %v)", d, streamEndGrace)
	if r.err != nil {
		t.Fatalf("validated confirmation rejected: %v", r.err)
	}
	if d < streamEndGrace || d > 2*streamEndGrace {
		t.Fatalf("returned after %v; want the endGrace timer (%v) and no more than twice it", d, streamEndGrace)
	}
	if f.aborts.Load() != 1 {
		t.Fatalf("aborts %d, want exactly 1", f.aborts.Load())
	}
	select {
	case <-f.endRet:
		t.Fatal("the End gate was released")
	default:
	}
	if len(r.rep.Notes) != 1 || !strings.Contains(r.rep.Notes[0], "did not complete locally after the receiver confirmed out.bin") {
		t.Fatalf("notes %q", r.rep.Notes)
	}
	joined(t, f, src)
}

// U-S12 (C3/C3b/C3c): a StreamResult the peer sent BEFORE End, handed to R
// only after W's End write completed — the schedule in which "the reply was
// read after End" is true and says nothing. Rejected by content, whatever the
// schedule. The third variant hands it over before End.
func TestStreamDelayedPrematureReceiptRejected(t *testing.T) {
	data := []byte("some input")
	for _, v := range []struct {
		name, challenge, wording string
		afterEnd                 bool
	}{
		{"empty echo, read after End", "", "does not belong to this transfer's end", true},
		{"random echo, read after End", newStreamChallenge(), "does not belong to this transfer's end", true},
		{"read before End", "", "answered before the end of input was sent", false},
	} {
		t.Run(v.name, func(t *testing.T) {
			f := newFakeTransport()
			src := newSource(data, 1<<20)
			if !v.afterEnd {
				src.block = true
			}
			res := sendAsync(context.Background(), f, "out.bin", startOf(src))
			peerAccept(t, f)
			// Wait until R consumed the accept, then hold every later reply.
			deadline := time.Now().Add(5 * time.Second)
			for f.queuedReplies() > 0 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if v.afterEnd {
				f.holdReplies(true)
			}
			// Premature: before End exists, with the right size and hash.
			f.peerSend(MsgStreamResult, StreamResult{Size: int64(len(data)), SHA256: sha256Hex(data), Challenge: v.challenge})
			if v.afterEnd {
				f.peerExpect(t, MsgStreamEnd)
				<-f.endReturned // W's Write(End) completed on the fake
				f.holdReplies(false)
			}
			r := waitSend(t, res, 5*time.Second)
			if !errors.Is(r.err, ErrStreamUnconfirmed) || !strings.Contains(r.err.Error(), v.wording) {
				t.Fatalf("error %v, want ErrStreamUnconfirmed with %q", r.err, v.wording)
			}
			joined(t, f, src)
		})
	}
}

// U-S13: over many transfers, every End challenge is 32 lowercase hex, all
// are distinct, and none appears in any frame before its End.
func TestStreamChallengeFreshAndOnlyInEnd(t *testing.T) {
	const runs = 2000
	seen := make(map[string]bool, runs)
	for i := range runs {
		f := newFakeTransport()
		src := newSource([]byte(fmt.Sprintf("input %d", i)), 1<<20)
		res := sendAsync(context.Background(), f, "out.bin", startOf(src))
		peerAccept(t, f)
		end := f.peerExpect(t, MsgStreamEnd)
		f.peerSend(MsgStreamResult, honestEcho(t, end))
		if r := waitSend(t, res, 5*time.Second); r.err != nil {
			t.Fatalf("run %d: %v", i, r.err)
		}
		var e StreamEnd
		_ = json.Unmarshal(end, &e)
		if !validStreamChallenge(e.Challenge) {
			t.Fatalf("run %d: challenge %q", i, e.Challenge)
		}
		if seen[e.Challenge] {
			t.Fatalf("run %d: challenge repeated", i)
		}
		seen[e.Challenge] = true
		raw, _ := hex.DecodeString(e.Challenge)
		frames := f.recorded()
		for _, fr := range frames[:len(frames)-1] {
			if fr.t == MsgStreamEnd {
				t.Fatalf("run %d: End is not the last frame", i)
			}
			if bytes.Contains(fr.payload, []byte(e.Challenge)) || bytes.Contains(fr.payload, raw) {
				t.Fatalf("run %d: challenge appears in a type-%d frame before End", i, fr.t)
			}
		}
		if frames[len(frames)-1].t != MsgStreamEnd {
			t.Fatalf("run %d: last frame type %d", i, frames[len(frames)-1].t)
		}
	}
}

// U-S14: a peer that holds End but echoes the wrong value, or the right value
// with the wrong size or hash, is never success.
func TestStreamWrongEchoOrWrongBytes(t *testing.T) {
	// End is held, so a (wrongly) accepted answer would return after
	// endGrace; keep that short so such a failure shows as a false success.
	defer func(d time.Duration) { streamEndGrace = d }(streamEndGrace)
	streamEndGrace = 200 * time.Millisecond
	cases := []struct {
		name   string
		mutate func(*StreamResult)
		want   error
	}{
		{"wrong echo", func(r *StreamResult) { r.Challenge = newStreamChallenge() }, ErrStreamUnconfirmed},
		{"echo off by one char", func(r *StreamResult) {
			r.Challenge = r.Challenge[:31] + string("0123456789abcdef"[(strings.IndexByte("0123456789abcdef", r.Challenge[31])+1)%16])
		}, ErrStreamUnconfirmed},
		{"short echo", func(r *StreamResult) { r.Challenge = r.Challenge[:31] }, ErrStreamUnconfirmed},
		{"wrong size", func(r *StreamResult) { r.Size++ }, ErrStreamDifferentBytes},
		{"wrong hash", func(r *StreamResult) { r.SHA256 = sha256Hex([]byte("other")) }, ErrStreamDifferentBytes},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeTransport()
			f.holdEnd = true
			src := newSource([]byte("input"), 1<<20)
			res := sendAsync(context.Background(), f, "out.bin", startOf(src))
			peerAccept(t, f)
			end := f.peerExpect(t, MsgStreamEnd)
			r := honestEcho(t, end)
			c.mutate(&r)
			f.peerSend(MsgStreamResult, r)
			got := waitSend(t, res, 5*time.Second)
			if !errors.Is(got.err, c.want) {
				t.Fatalf("error %v, want %v", got.err, c.want)
			}
			if !strings.Contains(got.err.Error(), "do not trust out.bin on the receiver") {
				t.Fatalf("wording %q", got.err)
			}
			if f.aborts.Load() != 1 {
				t.Fatalf("aborts %d", f.aborts.Load())
			}
			joined(t, f, src)
		})
	}
}

// A failure judged while End was not yet attempted ("nothing was installed")
// cannot be overtaken by an End written afterwards. The schedule is forced:
// the last data Write is held; the caller cancels; the supervisor judges the
// stage and, as the first step of teardown, stops the source — whose Stop
// here releases the held Write, so W is free (input at EOF, stop not yet
// closed) to go on to End before Abort. It must not.
func TestStreamJudgedStageIsNotOvertakenByEnd(t *testing.T) {
	f := newFakeTransport()
	f.holdData = make(chan struct{})
	f.dataHeld = make(chan struct{})
	src := &releasingSource{fakeSource: newSource([]byte("all of it"), 1<<20), f: f}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res := sendAsync(ctx, f, "out.bin", startOf(src))
	peerAccept(t, f)
	go func() { // drain whatever W writes, as a live peer would
		for {
			if _, _, err := f.peerRead(); err != nil {
				return
			}
		}
	}()
	<-f.dataHeld
	cancel()
	r := waitSend(t, res, 5*time.Second)
	var se *StreamSendError
	if !errors.As(r.err, &se) || se.Stage != StreamSending || !strings.HasSuffix(r.err.Error(), "; nothing was installed on the receiver") {
		t.Fatalf("error %v", r.err)
	}
	for _, typ := range f.sentTypes() {
		if typ == MsgStreamEnd {
			t.Fatal("End was written after the failure was judged as 'nothing was installed'")
		}
	}
	joined(t, f, src.fakeSource)
}

// releasingSource's Stop releases the transport's held data Write and gives
// W time to act on it before returning.
type releasingSource struct {
	*fakeSource
	f    *fakeTransport
	once sync.Once
}

func (s *releasingSource) Stop() error {
	s.once.Do(func() {
		close(s.f.holdData)
		deadline := time.Now().Add(300 * time.Millisecond)
		for time.Now().Before(deadline) {
			select {
			case <-s.f.endReturned:
				return
			default:
			}
			time.Sleep(time.Millisecond)
		}
	})
	return s.fakeSource.Stop()
}

// A silent input does not let the receiver's idle bound end the transfer:
// keepalives flow while nothing is read.
func TestStreamKeepaliveHoldsIdleReceiver(t *testing.T) {
	defer func(d time.Duration) { streamKeepalive = d }(streamKeepalive)
	streamKeepalive = 50 * time.Millisecond
	dir := t.TempDir()
	tr, rc := realPair(t, dir, "slow.bin", StreamRecvOpts{Idle: 400 * time.Millisecond})
	src := &slowSource{parts: [][]byte{[]byte("a"), []byte("b")}, pause: time.Second}
	rep, err := SendStream(context.Background(), tr, "slow.bin", startOf(src), StreamSendOpts{})
	if err != nil {
		t.Fatalf("SendStream: %v", err)
	}
	if rr := <-rc; rr.err != nil {
		t.Fatalf("receiver: %v", rr.err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "slow.bin")); string(got) != "ab" || rep.Bytes != 2 {
		t.Fatalf("installed %q", got)
	}
}

type slowSource struct {
	parts [][]byte
	pause time.Duration
	i     int
}

func (s *slowSource) Read(b []byte) (int, error) {
	if s.i >= len(s.parts) {
		return 0, io.EOF
	}
	if s.i > 0 {
		time.Sleep(s.pause)
	}
	n := copy(b, s.parts[s.i])
	s.i++
	return n, nil
}

func (s *slowSource) Stop() error { return nil }

// Progress reports cumulative bytes sent.
func TestStreamProgress(t *testing.T) {
	dir := t.TempDir()
	tr, rc := realPair(t, dir, "p.bin", StreamRecvOpts{})
	var last atomic.Int64
	data := make([]byte, 2*StreamChunkMax+5)
	_, err := SendStream(context.Background(), tr, "p.bin", startOf(newSource(data, StreamChunkMax)),
		StreamSendOpts{Progress: func(n int64) { last.Store(n) }})
	if err != nil {
		t.Fatal(err)
	}
	<-rc
	if last.Load() != int64(len(data)) {
		t.Fatalf("last progress %d, want %d", last.Load(), len(data))
	}
}

// --- The real stdin pump (a real helper process) in front of SendStream. ---

func realPump(stdin *os.File) func() (StreamSource, error) {
	return func() (StreamSource, error) {
		return stdinpump.StartWith(stdinpump.Options{Exe: os.Args[0], Args: []string{stdinpump.HelperArg}, Stdin: stdin})
	}
}

func tempInput(t *testing.T, b []byte) *os.File {
	t.Helper()
	p := filepath.Join(t.TempDir(), "input")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// Real helper, real receiver: exact bytes installed, helper reaped.
func TestStreamRealPumpRoundTrip(t *testing.T) {
	data := specialBytes(3*StreamChunkMax + 7)
	in := tempInput(t, data)
	dir := t.TempDir()
	tr, rc := realPair(t, dir, "real.bin", StreamRecvOpts{})
	var pump *stdinpump.Pump
	start := func() (StreamSource, error) {
		s, err := realPump(in)()
		if err == nil {
			pump = s.(*stdinpump.Pump)
		}
		return s, err
	}
	rep, err := SendStream(context.Background(), tr, "real.bin", start, StreamSendOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if rr := <-rc; rr.err != nil {
		t.Fatal(rr.err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "real.bin"))
	if !bytes.Equal(got, data) || rep.Bytes != int64(len(data)) {
		t.Fatalf("installed %d bytes", len(got))
	}
	if !pump.Exited() {
		t.Fatal("helper not reaped after success")
	}
	assertNoStaging(t, dir)
}

// Refused before Accept with the real pump wired: stdin (a regular file,
// shared description) is still at offset 0 — nothing was read.
func TestStreamRealPumpRefusalLeavesStdinUnread(t *testing.T) {
	in := tempInput(t, specialBytes(1<<20))
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "exists.bin"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr, rc := realPair(t, dir, "exists.bin", StreamRecvOpts{})
	_, err := SendStream(context.Background(), tr, "exists.bin", realPump(in), StreamSendOpts{})
	var re *RemoteError
	if !errors.As(err, &re) || re.Code != ErrCodeDestinationExists {
		t.Fatalf("error %v", err)
	}
	<-rc
	if pos, _ := in.Seek(0, io.SeekCurrent); pos != 0 {
		t.Fatalf("stdin offset %d after a refusal before Accept, want 0", pos)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "exists.bin")); string(got) != "keep" {
		t.Fatalf("existing file changed to %q", got)
	}
}

// The helper killed mid-stream (exact PID) while stdin is silent: the
// transfer fails as "the stdin reader ended unexpectedly", End is never sent,
// and the receiver installs nothing and removes its staging.
func TestStreamRealPumpKilledMidStream(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	if _, err := w.Write([]byte("first part")); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	tr, rc := realPair(t, dir, "k.bin", StreamRecvOpts{})
	pumpCh := make(chan *stdinpump.Pump, 1)
	start := func() (StreamSource, error) {
		s, err := realPump(r)()
		if err == nil {
			pumpCh <- s.(*stdinpump.Pump)
		}
		return s, err
	}
	res := sendAsync(context.Background(), tr, "k.bin", start)
	p := <-pumpCh
	time.Sleep(200 * time.Millisecond) // the first part is relayed; the helper blocks on the silent pipe
	proc, err := os.FindProcess(p.Pid())
	if err != nil {
		t.Fatal(err)
	}
	_ = proc.Kill()
	sr := waitSend(t, res, 10*time.Second)
	if !errors.Is(sr.err, stdinpump.ErrHelperVanished) ||
		sr.err.Error() != "the stdin reader ended unexpectedly; nothing was installed on the receiver" {
		t.Fatalf("error %v", sr.err)
	}
	rr := <-rc
	if rr.err == nil || rr.rep.Installed {
		t.Fatalf("receiver %+v %v", rr.rep, rr.err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "k.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("destination exists: %v", err)
	}
	assertNoStaging(t, dir)
}

// frameBytes builds one frame (tests).
func frameBytes(t MsgType, payload []byte) []byte {
	b := make([]byte, streamFrameHeader, streamFrameHeader+len(payload))
	b[0] = byte(t)
	binary.BigEndian.PutUint32(b[1:], uint32(len(payload)))
	return append(b, payload...)
}
