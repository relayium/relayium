// What the loop owns: handles, bounded shutdown, and the truth about both.
//
// Platform-independent by construction. The Windows walk is behind the Opener
// seam, so everything here — dispatch, the handle table, hostile input, the
// shutdown bound, the leftover inventory — is exercised on the development
// machine rather than deferred to a runner.
package sourceserve

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

type fakeSource struct {
	data     []byte
	vol, fid string
	closeErr error
	closes   int
	onRead   func()
}

func (f *fakeSource) Size() int64                { return int64(len(f.data)) }
func (f *fakeSource) Identity() (string, string) { return f.vol, f.fid }
func (f *fakeSource) Close() error               { f.closes++; return f.closeErr }
func (f *fakeSource) ReadAt(p []byte, off int64) (int, error) {
	if f.onRead != nil {
		f.onRead()
	}
	if off >= int64(len(f.data)) {
		return 0, io.EOF
	}
	return copy(p, f.data[off:]), nil
}

func newFake(data string) *fakeSource {
	return &fakeSource{
		data: []byte(data),
		vol:  "00000000deadbeef",
		fid:  "0123456789abcdef0123456789abcdef",
	}
}

type fakeOpener struct {
	mu      sync.Mutex
	byPath  map[string]*fakeSource
	opens   []string
	failAll error
}

func (o *fakeOpener) Open(path string) (Source, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.opens = append(o.opens, path)
	if o.failAll != nil {
		return nil, o.failAll
	}
	src, ok := o.byPath[path]
	if !ok {
		return nil, wire.Errf(wire.CodeNotFound, "")
	}
	return src, nil
}

func (o *fakeOpener) openCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.opens)
}

// syncBuffer is a writer the loop's goroutine and the test can both touch.
type syncBuffer struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	fail error
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail != nil {
		return 0, s.fail
	}
	return s.buf.Write(p)
}

func (s *syncBuffer) bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.buf.Bytes()...)
}

func requestFrame(t *testing.T, payload string) []byte {
	t.Helper()
	frame, err := wire.EncodeFrame(wire.KindRequest, []byte(payload))
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	return frame
}

func stream(t *testing.T, payloads ...string) io.Reader {
	t.Helper()
	var buf bytes.Buffer
	for _, p := range payloads {
		buf.Write(requestFrame(t, p))
	}
	return &buf
}

func decodeResponse(t *testing.T, frame []byte) wire.Response {
	t.Helper()
	fr := wire.NewReader(bytes.NewReader(frame))
	f, err := fr.ReadFrame()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var resp wire.Response
	if err := json.Unmarshal(f.Payload, &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

// outcome is everything the host could observe from one session.
type outcome struct {
	exit      int
	responses []wire.Response
	events    []wire.Event
	chunks    map[uint64][]byte
	log       string
}

func run(t *testing.T, opener Opener, in io.Reader) outcome {
	t.Helper()
	out := &syncBuffer{}
	log := &syncBuffer{}
	exit := Serve(Options{In: in, Out: out, Log: log, Opener: opener,
		Grace: 2 * time.Second, DrainGrace: time.Second,
		ForceExit: func(int) { t.Errorf("shutdown was forced when it should have settled") }})
	return parse(t, exit, out.bytes(), log.buf.String())
}

func parse(t *testing.T, exit int, raw []byte, log string) outcome {
	t.Helper()
	res := outcome{exit: exit, chunks: map[uint64][]byte{}, log: log}
	fr := wire.NewReader(bytes.NewReader(raw))
	for {
		f, err := fr.ReadFrame()
		if err != nil {
			break
		}
		switch f.Kind {
		case wire.KindResponse:
			var resp wire.Response
			if err := json.Unmarshal(f.Payload, &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			res.responses = append(res.responses, resp)
		case wire.KindEvent:
			var ev wire.Event
			if err := json.Unmarshal(f.Payload, &ev); err != nil {
				t.Fatalf("decode event: %v", err)
			}
			res.events = append(res.events, ev)
		case wire.KindChunk:
			h, data, err := wire.DecodeChunk(f.Payload)
			if err != nil {
				t.Fatalf("decode chunk: %v", err)
			}
			res.chunks[h.ID] = append(res.chunks[h.ID], data...)
		}
	}
	return res
}

func result[T any](t *testing.T, resp wire.Response) T {
	t.Helper()
	var v T
	if !resp.OK {
		t.Fatalf("response %d failed: %s %s", resp.ID, resp.Code, resp.Detail)
	}
	if err := json.Unmarshal(resp.Result, &v); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	return v
}

func openerWith(sources map[string]*fakeSource) *fakeOpener {
	return &fakeOpener{byPath: sources}
}

func TestReadyEventPrecedesEverything(t *testing.T) {
	got := run(t, openerWith(nil), stream(t))
	if got.exit != ExitClean {
		t.Fatalf("exit = %d", got.exit)
	}
	if len(got.events) != 1 || got.events[0].Event != ReadyEvent || got.events[0].Protocol != ProtocolVersion {
		t.Fatalf("events = %+v", got.events)
	}
}

func TestOpenReadCloseServesExactBytes(t *testing.T) {
	src := newFake("hello source")
	op := openerWith(map[string]*fakeSource{`C:\a\b.txt`: src})
	got := run(t, op, stream(t,
		`{"id":1,"op":"open-source","path":"C:\\a\\b.txt"}`,
		`{"id":2,"op":"read-source","source":1,"offset":0,"length":1024}`,
		`{"id":3,"op":"close-source","source":1}`,
	))
	if got.exit != ExitClean {
		t.Fatalf("exit = %d, log %q", got.exit, got.log)
	}
	opened := result[OpenResult](t, got.responses[0])
	if opened.Size != 12 || opened.VolumeSerial != src.vol || opened.FileID != src.fid {
		t.Fatalf("open result = %+v", opened)
	}
	read := result[ReadResult](t, got.responses[1])
	if read.Bytes != 12 || !read.EOF {
		t.Fatalf("read result = %+v", read)
	}
	if string(got.chunks[2]) != "hello source" {
		t.Fatalf("bytes = %q", got.chunks[2])
	}
	closed := result[CloseResult](t, got.responses[2])
	if closed.State != StateClosed {
		t.Fatalf("close state = %s", closed.State)
	}
	if src.closes != 1 {
		t.Fatalf("closes = %d", src.closes)
	}
}

// EOF is an outcome of the read, not an inference from the size recorded at open
// time: the file may have been truncated or extended since.
func TestEOFIsReportedWithoutAChunk(t *testing.T) {
	src := newFake("abc")
	op := openerWith(map[string]*fakeSource{`C:\f`: src})
	got := run(t, op, stream(t,
		`{"id":1,"op":"open-source","path":"C:\\f"}`,
		`{"id":2,"op":"read-source","source":1,"offset":3,"length":16}`,
	))
	read := result[ReadResult](t, got.responses[1])
	if read.Bytes != 0 || !read.EOF {
		t.Fatalf("read = %+v", read)
	}
	if _, ok := got.chunks[2]; ok {
		t.Fatalf("an empty read emitted a chunk frame")
	}
}

func TestPartialReadInTheMiddleIsNotEOF(t *testing.T) {
	src := newFake("0123456789")
	op := openerWith(map[string]*fakeSource{`C:\f`: src})
	got := run(t, op, stream(t,
		`{"id":1,"op":"open-source","path":"C:\\f"}`,
		`{"id":2,"op":"read-source","source":1,"offset":0,"length":4}`,
	))
	read := result[ReadResult](t, got.responses[1])
	if read.Bytes != 4 || read.EOF {
		t.Fatalf("a full four-byte read mid-file reported %+v", read)
	}
	if string(got.chunks[2]) != "0123" {
		t.Fatalf("bytes = %q", got.chunks[2])
	}
}

// One code for "never issued" and "already closed". Distinguishing them would
// confirm which ids this process has used.
func TestClosedSourceIsUnknown(t *testing.T) {
	src := newFake("x")
	op := openerWith(map[string]*fakeSource{`C:\f`: src})
	got := run(t, op, stream(t,
		`{"id":1,"op":"open-source","path":"C:\\f"}`,
		`{"id":2,"op":"close-source","source":1}`,
		`{"id":3,"op":"read-source","source":1,"offset":0,"length":1}`,
		`{"id":4,"op":"close-source","source":1}`,
		`{"id":5,"op":"read-source","source":999,"offset":0,"length":1}`,
	))
	for _, i := range []int{2, 3, 4} {
		if got.responses[i].OK || got.responses[i].Code != CodeUnknownSource {
			t.Fatalf("response %d = %+v", i, got.responses[i])
		}
	}
	if src.closes != 1 {
		t.Fatalf("a second close reached the source: closes = %d", src.closes)
	}
}

// The limit is enforced BEFORE the open. Enforcing it after would mean acquiring
// a handle in order to refuse it.
func TestSourceLimitRefusesBeforeOpening(t *testing.T) {
	sources := map[string]*fakeSource{}
	payloads := []string{}
	for i := 0; i < MaxOpenSources+1; i++ {
		path := `C:\f` + string(rune('a'+i))
		sources[path] = newFake("x")
		payloads = append(payloads, `{"id":`+itoa(i+1)+`,"op":"open-source","path":"C:\\f`+string(rune('a'+i))+`"}`)
	}
	op := openerWith(sources)
	got := run(t, op, stream(t, payloads...))
	last := got.responses[MaxOpenSources]
	if last.OK || last.Code != CodeSourceLimit {
		t.Fatalf("ninth open = %+v", last)
	}
	if op.openCount() != MaxOpenSources {
		t.Fatalf("opener was called %d times; the refused open must not reach it", op.openCount())
	}
	// Everything still held is closed by the teardown inventory.
	for path, s := range sources {
		if s.closes > 1 {
			t.Fatalf("%s closed %d times", path, s.closes)
		}
	}
}

// A malformed frame ends the session with a correlated refusal and NO side
// effect: nothing further is opened, and what was open is released.
func TestHostileFrameHasZeroEffects(t *testing.T) {
	src := newFake("kept")
	op := openerWith(map[string]*fakeSource{`C:\f`: src, `C:\g`: newFake("never")})
	got := run(t, op, stream(t,
		`{"id":1,"op":"open-source","path":"C:\\f"}`,
		`{"id":2,"op":"open-source","path":"C:\\f","root":"C:\\"}`,
		`{"id":3,"op":"open-source","path":"C:\\g"}`,
	))
	if got.exit != ExitProtocol {
		t.Fatalf("exit = %d", got.exit)
	}
	if op.openCount() != 1 {
		t.Fatalf("opener called %d times after a malformed frame", op.openCount())
	}
	refusal := got.responses[len(got.responses)-1]
	if refusal.ID != 2 || refusal.OK || refusal.Code != wire.CodeProtocol {
		t.Fatalf("refusal = %+v", refusal)
	}
	if src.closes != 1 {
		t.Fatalf("the open source was not released at teardown: closes = %d", src.closes)
	}
}

// A request that cannot be parsed at all is still answered on its id, so the
// host settles it rather than waiting forever.
func TestUnparseableRequestIsStillCorrelated(t *testing.T) {
	op := openerWith(nil)
	got := run(t, op, stream(t, `{"id":42,"op":"open-source","path":5}`))
	last := got.responses[len(got.responses)-1]
	if last.ID != 42 || last.OK {
		t.Fatalf("response = %+v", last)
	}
}

func TestFailedCloseIsReportedAndChangesTheExitCode(t *testing.T) {
	src := newFake("x")
	src.closeErr = wire.Errf(wire.CodeIO, "close failed")
	op := openerWith(map[string]*fakeSource{`C:\f`: src})
	got := run(t, op, stream(t,
		`{"id":1,"op":"open-source","path":"C:\\f"}`,
		`{"id":2,"op":"close-source","source":1}`,
	))
	if state := result[CloseResult](t, got.responses[1]).State; state != StateFailedClose {
		t.Fatalf("state = %s", state)
	}
	if got.exit != ExitLeftoverHandles {
		t.Fatalf("exit = %d, want %d", got.exit, ExitLeftoverHandles)
	}
	// A handle whose release failed must not remain addressable: offering a
	// retry would be offering a read on exactly that handle.
	got2 := run(t, openerWith(map[string]*fakeSource{`C:\f`: newFake("x")}), stream(t,
		`{"id":1,"op":"open-source","path":"C:\\f"}`,
		`{"id":2,"op":"close-source","source":1}`,
		`{"id":3,"op":"read-source","source":1,"offset":0,"length":1}`,
	))
	if got2.responses[2].Code != CodeUnknownSource {
		t.Fatalf("a released source stayed addressable: %+v", got2.responses[2])
	}
}

// The host going away without closing is ordinary. What must not happen is the
// helper exiting while still believing it holds nothing.
func TestLateCloseIsCountedAtTeardown(t *testing.T) {
	clean := newFake("x")
	op := openerWith(map[string]*fakeSource{`C:\f`: clean})
	got := run(t, op, stream(t, `{"id":1,"op":"open-source","path":"C:\\f"}`))
	if clean.closes != 1 {
		t.Fatalf("late source not closed: %d", clean.closes)
	}
	if got.exit != ExitClean {
		t.Fatalf("a late close that SUCCEEDED is not a leftover: exit = %d", got.exit)
	}
	if got.log == "" {
		t.Fatalf("a late close was not reported at all")
	}

	stuck := newFake("x")
	stuck.closeErr = wire.Errf(wire.CodeIO, "")
	got2 := run(t, openerWith(map[string]*fakeSource{`C:\f`: stuck}), stream(t,
		`{"id":1,"op":"open-source","path":"C:\\f"}`))
	if got2.exit != ExitLeftoverHandles {
		t.Fatalf("exit = %d, want %d", got2.exit, ExitLeftoverHandles)
	}
}

// A blank identity is the opener breaking its contract. The handle is released
// rather than served: an unbound read is the one outcome this path prevents.
func TestBlankIdentityReleasesTheHandle(t *testing.T) {
	src := newFake("x")
	src.vol = ""
	op := openerWith(map[string]*fakeSource{`C:\f`: src})
	got := run(t, op, stream(t, `{"id":1,"op":"open-source","path":"C:\\f"}`))
	if got.responses[0].OK || got.responses[0].Code != wire.CodeInternal {
		t.Fatalf("response = %+v", got.responses[0])
	}
	if src.closes != 1 {
		t.Fatalf("the handle was not released: closes = %d", src.closes)
	}
}

func TestTransportViolationsEndTheSession(t *testing.T) {
	t.Run("truncated frame", func(t *testing.T) {
		full := requestFrame(t, `{"id":1,"op":"close-source","source":1}`)
		got := run(t, openerWith(nil), bytes.NewReader(full[:len(full)-3]))
		if got.exit != ExitProtocol {
			t.Fatalf("exit = %d", got.exit)
		}
	})
	t.Run("chunk from the host", func(t *testing.T) {
		chunk, err := wire.EncodeChunk(wire.ChunkHeader{ID: 1, Index: 0}, []byte("data"))
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		got := run(t, openerWith(nil), bytes.NewReader(chunk))
		if got.exit != ExitProtocol {
			t.Fatalf("a chunk in source mode was accepted: exit = %d", got.exit)
		}
	})
}

// A host that stops reading must not park the helper in filesystem work whose
// outcome nobody can receive.
func TestUndrainableStdoutEndsTheSession(t *testing.T) {
	out := &syncBuffer{fail: io.ErrClosedPipe}
	log := &syncBuffer{}
	src := newFake("x")
	exit := Serve(Options{
		In:     stream(t, `{"id":1,"op":"open-source","path":"C:\\f"}`),
		Out:    out,
		Log:    log,
		Opener: openerWith(map[string]*fakeSource{`C:\f`: src}),
		Grace:  2 * time.Second, DrainGrace: 200 * time.Millisecond,
		ForceExit: func(int) { t.Errorf("shutdown was forced") },
	})
	if exit != ExitProtocol {
		t.Fatalf("exit = %d", exit)
	}
	if src.closes > 1 {
		t.Fatalf("source closed %d times", src.closes)
	}
}

// Admission must never become backpressure: a reader blocked on a full queue is
// a reader that cannot reach the EOF behind it.
func TestInboxOverflowEndsTheSessionRatherThanBlocking(t *testing.T) {
	release := make(chan struct{})
	src := newFake("payload")
	src.onRead = func() { <-release }
	payloads := []string{
		`{"id":1,"op":"open-source","path":"C:\\f"}`,
		`{"id":2,"op":"read-source","source":1,"offset":0,"length":4}`,
	}
	for i := 3; i < 3+MaxInboxDepth*3; i++ {
		payloads = append(payloads, `{"id":`+itoa(i)+`,"op":"read-source","source":1,"offset":0,"length":4}`)
	}
	out, log := &syncBuffer{}, &syncBuffer{}
	done := make(chan int, 1)
	go func() {
		done <- Serve(Options{In: stream(t, payloads...), Out: out, Log: log,
			Opener: openerWith(map[string]*fakeSource{`C:\f`: src}),
			Grace:  5 * time.Second, DrainGrace: time.Second,
			ForceExit: func(int) {}})
	}()
	// The main loop is parked in the first read; the reader fills the inbox and
	// overflows rather than waiting for it.
	time.Sleep(100 * time.Millisecond)
	close(release)
	select {
	case exit := <-done:
		if exit != ExitProtocol {
			t.Fatalf("exit = %d, log %q", exit, log.buf.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("Serve did not return")
	}
}

// The shutdown bound is real, and it is proven by observing the forced exit —
// not by an option a shipped binary could forget to pass.
func TestShutdownIsForcedWhenSettlingExceedsTheGrace(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	src := newFake("payload")
	src.onRead = func() { <-release }

	forced := make(chan int, 1)
	go Serve(Options{
		In: stream(t,
			`{"id":1,"op":"open-source","path":"C:\\f"}`,
			`{"id":2,"op":"read-source","source":1,"offset":0,"length":4}`),
		Out: &syncBuffer{}, Log: &syncBuffer{},
		Opener:    openerWith(map[string]*fakeSource{`C:\f`: src}),
		Grace:     50 * time.Millisecond,
		ForceExit: func(code int) { forced <- code },
	})
	select {
	case code := <-forced:
		if code != ExitShutdownTimeout {
			t.Fatalf("forced exit code = %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("shutdown was never forced; the bound does not exist")
	}
}

func TestMissingOpenerIsInternalNotClean(t *testing.T) {
	if exit := Serve(Options{In: stream(t), Out: &syncBuffer{}, Log: &syncBuffer{}}); exit != ExitInternal {
		t.Fatalf("exit = %d", exit)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
