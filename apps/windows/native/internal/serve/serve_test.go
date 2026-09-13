// Portable transport-loop tests.
//
// SCOPE: these prove shutdown ownership, bounded queues and protocol handling
// against an in-memory sink. They prove NOTHING about Windows filesystem
// semantics — no publication, no reparse refusal, no handle pinning, no real
// cleanup. Those live in internal/winio and are provable only on Windows.
package serve

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// blockingSink lets a test hold the main loop inside sink IO for as long as it
// needs, which is the state every shutdown claim has to survive.
type blockingSink struct {
	mu           sync.Mutex
	release      chan struct{}
	entered      chan struct{}
	cleanupCalls int
}

func newBlockingSink() *blockingSink {
	return &blockingSink{release: make(chan struct{}), entered: make(chan struct{}, 16)}
}

func (s *blockingSink) Open(string, *nameguard.Plan) error { return nil }
func (s *blockingSink) BeginFile(int) error                { return nil }

func (s *blockingSink) WriteChunk(_ int, p []byte) (int, error) {
	s.entered <- struct{}{}
	<-s.release
	return len(p), nil
}

func (s *blockingSink) FinishFile(int) error { return nil }
func (s *blockingSink) PublishOne(int) error { return nil }

func (s *blockingSink) Cleanup() (session.Residue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupCalls++
	return session.Residue{}, nil
}

func (s *blockingSink) cleanups() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cleanupCalls
}

// gatedReader serves a prefix, then blocks until the gate opens, then serves a
// suffix.
//
// It exists to make "the cancel arrives while the sink is busy" a fact rather
// than a scheduling accident. Without it the reader can race ahead and signal
// shutdown before the main loop ever enters the sink, and the test would then
// pass while proving something weaker than it claims.
type gatedReader struct {
	prefix []byte
	suffix []byte
	gate   <-chan struct{}
	off    int
	opened bool
}

func (r *gatedReader) Read(p []byte) (int, error) {
	if r.off < len(r.prefix) {
		n := copy(p, r.prefix[r.off:])
		r.off += n
		return n, nil
	}
	if !r.opened {
		<-r.gate
		r.opened = true
	}
	rel := r.off - len(r.prefix)
	if rel >= len(r.suffix) {
		return 0, io.EOF
	}
	n := copy(p, r.suffix[rel:])
	r.off += n
	return n, nil
}

func request(t *testing.T, req wire.Request) []byte {
	t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	frame, err := wire.EncodeFrame(wire.KindRequest, raw)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return frame
}

func chunk(t *testing.T, id uint64, index uint32, data []byte) []byte {
	t.Helper()
	frame, err := wire.EncodeChunk(wire.ChunkHeader{ID: id, Index: index}, data)
	if err != nil {
		t.Fatalf("encode chunk: %v", err)
	}
	return frame
}

func openAndBegin(t *testing.T, size int64) []byte {
	t.Helper()
	idx := 0
	var buf bytes.Buffer
	buf.Write(request(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: `C:\dest`,
		Manifest: []wire.ManifestEntry{{Name: "a.bin", Size: size}}}))
	buf.Write(request(t, wire.Request{ID: 2, Op: wire.OpBegin, Index: &idx}))
	return buf.Bytes()
}

// The defect root identified: a reader that blocks handing a frame to a busy
// main loop never reaches the cancel queued behind it, which also strands the
// shutdown monitor that is armed by the reader.
//
// The gate makes the ordering exact — the sink is provably held, and one
// ordinary data frame is provably already queued ahead of the cancel — so a
// regression to blocking admission fails this test rather than passing it on a
// lucky schedule.
func TestBusySinkWithPipelinedFrameStillReachesCancel(t *testing.T) {
	sink := newBlockingSink()

	var prefix bytes.Buffer
	prefix.Write(openAndBegin(t, 1<<20))
	prefix.Write(chunk(t, 3, 0, make([]byte, 8))) // main loop blocks inside this one
	prefix.Write(chunk(t, 4, 0, make([]byte, 8))) // the frame that used to hide the cancel

	gate := make(chan struct{})
	in := &gatedReader{
		prefix: prefix.Bytes(),
		suffix: request(t, wire.Request{ID: 5, Op: wire.OpCancel}),
		gate:   gate,
	}

	out := &syncBuffer{}
	forced := make(chan int, 1)
	done := make(chan int, 1)
	go func() {
		done <- Serve(Options{
			In: in, Out: out, Sink: sink,
			Grace:     150 * time.Millisecond,
			ForceExit: func(code int) { forced <- code },
		})
	}()

	// The sink is now held, and chunk 4 is sitting in the inbox behind it.
	select {
	case <-sink.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("sink never entered; the loop did not reach the chunk")
	}
	close(gate) // only now does the cancel become readable at all

	// The loop genuinely cannot settle while the sink is held, so the monitor is
	// the only thing that can bound this — and it is armed by the reader, which
	// is exactly what a blocked reader would have prevented.
	select {
	case code := <-forced:
		if code != ExitShutdownTimeout {
			t.Fatalf("forced exit code %d, want %d", code, ExitShutdownTimeout)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown monitor never fired: cancel was not observed behind the pipelined frame")
	}

	close(sink.release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after the sink was released")
	}
	if sink.cleanups() == 0 {
		t.Fatal("cancellation did not run cleanup")
	}
	// Asserting the CANCEL reply, not merely that shutdown happened: inbox
	// overflow would also signal shutdown, and this test is about the cancel
	// path specifically.
	if resp := findResponse(t, out.bytes(), 5); resp == nil {
		t.Fatal("cancel produced no correlated reply; the host would wait forever")
	} else if !resp.OK {
		t.Fatalf("cancel reply was a failure: %+v", resp)
	}
}

// The same shape, but the sink completes. Cancellation must settle cleanly and
// still produce a correlated reply for the cancel request.
func TestCancelSettlesAndRepliesWhenSinkCompletes(t *testing.T) {
	sink := newBlockingSink()
	close(sink.release) // never blocks

	var in bytes.Buffer
	in.Write(openAndBegin(t, 32))
	in.Write(chunk(t, 3, 0, make([]byte, 8)))
	in.Write(request(t, wire.Request{ID: 9, Op: wire.OpCancel}))

	var out bytes.Buffer
	code := Serve(Options{In: &in, Out: &out, Sink: sink, Grace: 2 * time.Second,
		ForceExit: func(int) { t.Error("forced exit on a loop that could settle") }})

	if code != ExitClean {
		t.Fatalf("exit %d, want clean", code)
	}
	if sink.cleanups() == 0 {
		t.Fatal("cancel did not run cleanup")
	}
	if id := findResponse(t, out.Bytes(), 9); id == nil {
		t.Fatal("cancel produced no correlated reply; the host would wait forever")
	} else if !id.OK {
		t.Fatalf("cancel reply was a failure: %+v", id)
	}
}

// EOF arriving while an operation is pending must settle the caller and clean
// up. Gated for the same reason as the cancel case.
func TestEOFDuringPendingOperationSettles(t *testing.T) {
	sink := newBlockingSink()

	var prefix bytes.Buffer
	prefix.Write(openAndBegin(t, 1<<20))
	prefix.Write(chunk(t, 3, 0, make([]byte, 8)))

	gate := make(chan struct{})
	in := &gatedReader{prefix: prefix.Bytes(), gate: gate} // empty suffix: EOF

	forced := make(chan int, 1)
	done := make(chan int, 1)
	go func() {
		done <- Serve(Options{In: in, Out: io.Discard, Sink: sink,
			Grace: 150 * time.Millisecond, ForceExit: func(c int) { forced <- c }})
	}()

	select {
	case <-sink.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("sink never entered")
	}
	close(gate) // the parent's pipe closes while the write is still in flight

	select {
	case <-forced:
	case <-time.After(5 * time.Second):
		t.Fatal("EOF during a pending operation did not arm the shutdown monitor")
	}
	close(sink.release)
	<-done
	if sink.cleanups() == 0 {
		t.Fatal("EOF did not run cleanup; unfinished owned files would be left behind")
	}
}

// A host that pipelines beyond the in-flight contract must terminate the session
// rather than park the reader behind unconsumed data.
//
// This asserts the outcome and not an intermediate state: whether the loop
// happens to enter the sink before the reader overflows is a scheduling detail,
// and asserting on it would make the test flaky without making it stronger. What
// must hold either way is that Serve returns, promptly, with a protocol failure.
func TestInboxOverflowTerminatesInsteadOfBlocking(t *testing.T) {
	sink := newBlockingSink()

	var in bytes.Buffer
	in.Write(openAndBegin(t, 1<<20))
	for i := 0; i < MaxInboxDepth*8; i++ {
		in.Write(chunk(t, uint64(10+i), 0, make([]byte, 8)))
	}

	done := make(chan int, 1)
	go func() {
		done <- Serve(Options{In: &in, Out: io.Discard, Sink: sink,
			Grace: 150 * time.Millisecond, ForceExit: func(int) {}})
	}()

	// Released unconditionally so the assertion below covers both schedules: the
	// loop may or may not have entered the sink before the overflow.
	time.Sleep(300 * time.Millisecond)
	close(sink.release)

	select {
	case code := <-done:
		if code != ExitProtocol {
			t.Fatalf("exit %d, want ExitProtocol for a contract violation", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("inbox overflow blocked the reader instead of terminating")
	}
	if sink.cleanups() == 0 {
		t.Fatal("overflow teardown skipped cleanup")
	}
}

// nonDrainingWriter accepts a bounded amount then blocks forever.
type nonDrainingWriter struct {
	mu      sync.Mutex
	allowed int
}

func (w *nonDrainingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	remaining := w.allowed
	if remaining > 0 {
		w.allowed--
	}
	w.mu.Unlock()
	if remaining <= 0 {
		// Parks forever, exactly like a full anonymous pipe whose reader stopped.
		select {}
	}
	return len(p), nil
}

// A host that stops reading stdout must not deadlock this process. Replies fill
// the bounded outbox and the session terminates rather than blocking in Write.
func TestNonDrainingStdoutTerminatesRatherThanDeadlocking(t *testing.T) {
	sink := newBlockingSink()
	close(sink.release)

	var in bytes.Buffer
	in.Write(openAndBegin(t, 1<<24))
	for i := 0; i < MaxOutboxDepth*4; i++ {
		in.Write(chunk(t, uint64(100+i), 0, make([]byte, 8)))
	}

	done := make(chan int, 1)
	go func() {
		done <- Serve(Options{In: &in, Out: &nonDrainingWriter{allowed: 1}, Sink: sink,
			Grace: 500 * time.Millisecond, ForceExit: func(int) {}})
	}()

	select {
	case code := <-done:
		if code != ExitProtocol {
			t.Fatalf("exit %d, want ExitProtocol for host backpressure", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("deadlocked against a non-draining host")
	}
	if sink.cleanups() == 0 {
		t.Fatal("backpressure teardown skipped cleanup")
	}
}

// failWriter fails immediately, standing in for a broken pipe.
type failWriter struct{}

func (failWriter) Write(p []byte) (int, error) { return 0, io.ErrClosedPipe }

// A dead reply channel must stop the session. Continuing to run file IO with no
// way to settle any caller is worse than stopping.
func TestWriterFailureSignalsShutdown(t *testing.T) {
	sink := newBlockingSink()
	close(sink.release)

	var in bytes.Buffer
	in.Write(openAndBegin(t, 1<<20))
	for i := 0; i < 64; i++ {
		in.Write(chunk(t, uint64(200+i), 0, make([]byte, 8)))
	}

	done := make(chan int, 1)
	go func() {
		done <- Serve(Options{In: &in, Out: failWriter{}, Sink: sink,
			Grace: 500 * time.Millisecond, ForceExit: func(int) {}})
	}()

	select {
	case code := <-done:
		if code == ExitClean {
			t.Fatal("a broken reply channel reported a clean exit")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("writer failure did not signal shutdown")
	}
	if sink.cleanups() == 0 {
		t.Fatal("writer failure teardown skipped cleanup")
	}
}

// shortWriter accepts one byte per call. io.Writer forbids this without an
// error, but this loop accepts an arbitrary writer and a truncated frame is
// indistinguishable from a corrupt one at the peer.
type shortWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.WriteByte(p[0])
	return 1, nil
}

func (w *shortWriter) bytes() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.buf.Bytes()...)
}

func TestShortWritesAreCompleted(t *testing.T) {
	sink := newBlockingSink()
	close(sink.release)

	var in bytes.Buffer
	in.Write(request(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: `C:\dest`,
		Manifest: []wire.ManifestEntry{{Name: "a.bin", Size: 0}}}))

	out := &shortWriter{}
	if code := Serve(Options{In: &in, Out: out, Sink: sink, Grace: time.Second,
		ForceExit: func(int) {}}); code != ExitClean {
		t.Fatalf("exit %d, want clean", code)
	}

	// Both frames must have arrived whole: the ready event and the open reply.
	raw := out.bytes()
	r := wire.NewReader(bytes.NewReader(raw))
	frames := 0
	for {
		f, err := r.ReadFrame()
		if err != nil {
			break
		}
		frames++
		_ = f
	}
	if frames < 2 {
		t.Fatalf("a one-byte-at-a-time writer lost frames: recovered %d of 2 from %d bytes", frames, len(raw))
	}
}

// syncBuffer is a bytes.Buffer safe to read while the writer goroutine is still
// running.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

func findResponse(t *testing.T, stream []byte, id uint64) *wire.Response {
	t.Helper()
	r := wire.NewReader(bytes.NewReader(stream))
	for {
		f, err := r.ReadFrame()
		if err != nil {
			return nil
		}
		if f.Kind != wire.KindResponse {
			continue
		}
		var resp wire.Response
		if err := json.Unmarshal(f.Payload, &resp); err != nil {
			continue
		}
		if resp.ID == id {
			return &resp
		}
	}
}
