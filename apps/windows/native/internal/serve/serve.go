// The transport loop: bounded ownership of stdin, stdout and shutdown.
//
// ## Why three goroutines and not one
//
// A single sequential loop is easier to reason about and was the first design,
// but it deadlocks. If the host pipelines requests without draining stdout, this
// process accumulates replies until the pipe buffer fills; an anonymous-pipe
// WriteFile then blocks, and a loop stuck there can never read the `cancel` or
// the EOF that would rescue it. Bounding a single reply says nothing about the
// total outstanding bytes.
//
// See https://learn.microsoft.com/en-us/windows/win32/ipc/anonymous-pipe-operations
//
// ## Why the reader never blocks on the queue either
//
// Splitting the goroutines is not enough on its own. A reader that hands frames
// to the main loop over an unbuffered channel blocks there as soon as the loop is
// busy in sink IO — and a single pipelined data frame ahead of a `cancel` is then
// enough to stop the reader from ever seeing that cancel, or the EOF behind it.
// The shutdown monitor is armed by the reader, so that also strands the one
// mechanism that bounds shutdown. The queue is therefore bounded AND admission is
// non-blocking: a full queue terminates the session instead of parking the reader
// behind unconsumed data.
//
// Ownership, with every direction bounded:
//
//   - The READER owns stdin and never blocks on anything but stdin. Admission to
//     the bounded inbox is non-blocking, so cancel and EOF are always reached.
//   - The WRITER owns stdout exclusively. The main loop never blocks on it: sends
//     are non-blocking, and a full outbox is proof the host stopped draining. A
//     failed write signals shutdown rather than quietly continuing file IO with no
//     usable reply channel.
//   - The MONITOR bounds shutdown. Once cancellation is signalled the main loop
//     has ShutdownGrace to settle; if it has not, the process exits.
//
// ## What this still does not guarantee
//
// A write to a wedged volume is not interruptible from inside this process. The
// helper guarantees it will not hang forever; it does not guarantee it can always
// finish. The parent must own a deadline and a kill. Residue after a forced exit
// is the bounded residue documented in winio: one staging directory under the
// chosen root, never a destination pathname.
//
// ## Logging
//
// stderr carries codes and indices only. Never a path, never a filename, never
// the destination root. Filenames are user content and this is a crash
// diagnostic surface.
package serve

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// Exit codes. Non-zero exit is itself a signal: the host must treat premature
// exit as failure of every outstanding request.
const (
	ExitClean             = 0
	ExitProtocol          = 2
	ExitCleanupIncomplete = 3
	ExitInternal          = 4
	ExitShutdownTimeout   = 5
)

const (
	// MaxInboxDepth bounds frames accepted from the host but not yet processed.
	//
	// The documented contract is strict request/response, so a correct host has
	// at most one in flight and this is pure headroom. Exceeding it is a host
	// contract violation and terminates the session. It must NOT become
	// backpressure: blocking the reader here is the precise defect that lets a
	// pipelined data frame hide a cancel.
	MaxInboxDepth = 8

	// MaxOutboxDepth bounds replies in flight toward a host that may have
	// stopped reading. Exceeding it is a host contract violation, not a reason
	// to grow a buffer.
	MaxOutboxDepth = 64

	// ShutdownGrace is how long the main loop may take to settle after
	// cancellation before the process exits regardless.
	ShutdownGrace = 5 * time.Second

	// WriterDrainGrace bounds the final wait for the stdout writer.
	//
	// Waiting unboundedly here was a defect: a host that stops draining leaves
	// the writer parked in Write forever, and Serve could then never return even
	// though cleanup had already finished. That made the shutdown monitor the
	// only way out of an ordinary, recoverable situation. Cleanup does not touch
	// stdout, so abandoning an undeliverable reply is the correct trade — the
	// exit code still reports the failure.
	WriterDrainGrace = time.Second
)

// Options configures one run. Every field has a production default; they exist
// so tests can drive the loop in-process and observe a forced exit instead of
// taking the test binary down with it.
type Options struct {
	In    io.Reader
	Out   io.Writer
	Log   io.Writer
	Sink  session.Sink
	Grace time.Duration
	// DrainGrace bounds the final wait for the stdout writer. Defaults to
	// WriterDrainGrace.
	DrainGrace time.Duration
	// ForceExit is called when shutdown exceeds Grace.
	//
	// It DEFAULTS TO os.Exit rather than to nil. An earlier version left it nil
	// and had runMonitor skip forcing when unset, so the shipped executable —
	// which did not pass one — had no shutdown bound at all, while in-process
	// tests injected an observer and appeared to prove the timeout path. The
	// guarantee now lives here, where no caller can drop it by omission.
	ForceExit func(code int)
}

// reqFrame is one admitted frame. A request has already been through the strict
// bounded validator by the time it gets here; a chunk carries its raw payload.
type reqFrame struct {
	kind    byte
	req     wire.Request
	payload []byte
}

// shutdown records why the session is ending, set by whichever goroutine notices
// first.
type shutdown struct {
	once      sync.Once
	ch        chan struct{}
	cancelled atomic.Bool
	cancelID  atomic.Uint64
	overflow  atomic.Bool
	writeFail atomic.Bool
	// protoFail distinguishes a stream that ENDED from a stream that BROKE.
	// Without it both arrive as "the reader stopped" and a malformed or
	// truncated frame reports a clean exit, telling the parent the session
	// finished normally when the transport actually failed.
	protoFail atomic.Bool
}

func newShutdown() *shutdown { return &shutdown{ch: make(chan struct{})} }

func (s *shutdown) signal() { s.once.Do(func() { close(s.ch) }) }

// Serve runs one lease to completion and returns the process exit code.
func Serve(opts Options) int {
	grace := opts.Grace
	if grace == 0 {
		grace = ShutdownGrace
	}
	drainGrace := opts.DrainGrace
	if drainGrace == 0 {
		drainGrace = WriterDrainGrace
	}
	if opts.ForceExit == nil {
		opts.ForceExit = os.Exit
	}

	down := newShutdown()
	frames := make(chan reqFrame, MaxInboxDepth)
	outbox := make(chan []byte, MaxOutboxDepth)
	settled := make(chan struct{})
	writerDone := make(chan struct{})

	go runWriter(opts, outbox, down, writerDone)
	go runReader(opts, frames, down, settled)
	go runMonitor(opts, down, settled, grace)

	code := run(opts, frames, outbox, down)
	close(settled)
	close(outbox)

	drained := true
	select {
	case <-writerDone:
	case <-time.After(drainGrace):
		// The writer is wedged against a host that is not reading. Its goroutine
		// is abandoned; the process is on its way out and cleanup already ran.
		drained = false
		logf(opts.Log, "stdout writer did not drain")
	}

	// Reconcile AFTER the drain. run() computed its code before these replies
	// were flushed, so a write that failed — or never completed — during this
	// final drain would otherwise be lost and Serve would return a stale zero
	// while a reply the host is waiting on was never delivered. An already
	// non-zero code is left alone: it is the more specific fact, and residue in
	// particular names bytes left on the user's disk.
	if code == ExitClean && (!drained || down.writeFail.Load()) {
		logf(opts.Log, "final reply undelivered")
		code = ExitProtocol
	}
	return code
}

// runWriter is the sole owner of stdout.
func runWriter(opts Options, outbox <-chan []byte, down *shutdown, doneCh chan<- struct{}) {
	defer close(doneCh)
	broken := false
	for buf := range outbox {
		if broken {
			continue
		}
		// io.Writer permits a short write only alongside an error, but this
		// accepts an arbitrary writer, and a silently truncated frame is
		// indistinguishable from a corrupt one at the peer. So the loop is
		// explicit, matching the discipline the chunk write path uses.
		for off := 0; off < len(buf); {
			n, err := opts.Out.Write(buf[off:])
			if err != nil {
				// The reply channel is gone. Continuing to run file IO with no
				// way to settle any caller is worse than stopping, so this is a
				// shutdown signal rather than a silent drain.
				down.writeFail.Store(true)
				down.signal()
				broken = true
				logf(opts.Log, "stdout write failed")
				break
			}
			if n <= 0 {
				down.writeFail.Store(true)
				down.signal()
				broken = true
				logf(opts.Log, "stdout accepted zero bytes")
				break
			}
			off += n
		}
	}
}

// runReader is the sole owner of stdin. It blocks only on stdin, never on the
// main loop, which is what keeps cancel and EOF reachable at all times.
func runReader(opts Options, frames chan<- reqFrame, down *shutdown, settled <-chan struct{}) {
	defer close(frames)
	r := wire.NewReader(opts.In)
	for {
		frame, err := r.ReadFrame()
		if err != nil {
			// Clean EOF at a frame boundary is the parent finishing with us and
			// stays a clean exit. Anything else — an oversized or zero length
			// prefix, an unknown kind, a header or payload cut mid-frame — is a
			// broken transport, and it must be RECORDED, not merely logged.
			// Sharing one shutdown entry point with EOF is fine; sharing EOF's
			// exit code is not.
			if !errors.Is(err, io.EOF) {
				down.protoFail.Store(true)
				logf(opts.Log, "reader %s", wire.CodeOf(err))
			}
			down.signal()
			return
		}

		// Response and event kinds are helper-to-host only. Refused HERE rather
		// than only in dispatch: this is the boundary that already rejects an
		// undecodable request, and a frame the protocol does not allow the host
		// to send should never be admitted to the queue in the first place. It
		// also means the violation is recorded even if the main loop never gets
		// to the frame.
		if frame.Kind != wire.KindRequest && frame.Kind != wire.KindChunk {
			down.protoFail.Store(true)
			logf(opts.Log, "unexpected frame kind %d", frame.Kind)
			down.signal()
			return
		}

		admitted := reqFrame{kind: frame.Kind}
		if frame.Kind == wire.KindRequest {
			// Decoded HERE, through the same strict bounded validator every
			// other request uses. An earlier version recognised cancel with a
			// bare json.Unmarshal, which let a cancel skip the size limit, the
			// unknown-field check and the id validation that every other
			// operation is held to — a hole in the boundary precisely because
			// cancel is the one message handled out of band.
			req, err := wire.DecodeRequest(frame.Payload)
			if err != nil {
				down.protoFail.Store(true)
				logf(opts.Log, "request %s %s", wire.CodeOf(err), wire.DetailOf(err))
				down.signal()
				return
			}
			// Cancel is recognised before the frame reaches the queue, so it is
			// observed even while the main loop is mid-operation.
			if req.Op == wire.OpCancel {
				down.cancelID.Store(req.ID)
				down.cancelled.Store(true)
				down.signal()
				return
			}
			admitted.req = req
		} else {
			// Chunk shape is validated HERE, for the same reason request shape
			// is: a frame still queued at shutdown is refused rather than
			// dispatched, so anything wrong with it must be known before it is
			// admitted or the failure goes unrecorded.
			//
			// ReadFrame already guarantees the LENGTH — payloadLen >=
			// ChunkHeaderBytes and the data within MaxChunkBytes — so
			// DecodeChunk's length check cannot fail on a frame that got this
			// far; TestReadFrameLeavesNoDecodableChunkFailure pins that. What
			// this adds is the correlation id rule, which is a real gap: a
			// zero-id chunk followed immediately by EOF was refused with no
			// reply and no protoFail, so the session reported a clean exit.
			if _, _, err := wire.DecodeChunk(frame.Payload); err != nil {
				down.protoFail.Store(true)
				logf(opts.Log, "chunk %s", wire.CodeOf(err))
				down.signal()
				return
			}
			// Chunk payloads alias the reader's scratch buffer, which the next
			// ReadFrame reuses. The copy is what makes handing one to another
			// goroutine safe. Decoded requests own their strings already.
			owned := make([]byte, len(frame.Payload))
			copy(owned, frame.Payload)
			admitted.payload = owned
		}

		select {
		case frames <- admitted:
		case <-settled:
			return
		default:
			// Deliberately NOT a blocking send. The host exceeded the in-flight
			// contract; parking here would hide any cancel or EOF queued behind
			// this frame and strand the shutdown monitor with it.
			down.overflow.Store(true)
			down.signal()
			logf(opts.Log, "%s inbox depth %d exceeded", wire.CodeProtocol, MaxInboxDepth)
			return
		}
	}
}

// runMonitor bounds shutdown so the process cannot hang forever inside an
// uninterruptible sink write.
func runMonitor(opts Options, down *shutdown, settled <-chan struct{}, grace time.Duration) {
	select {
	case <-down.ch:
	case <-settled:
		return
	}
	select {
	case <-settled:
	case <-time.After(grace):
		logf(opts.Log, "shutdown grace exceeded")
		opts.ForceExit(ExitShutdownTimeout)
	}
}

func run(opts Options, frames <-chan reqFrame, outbox chan<- []byte, down *shutdown) int {
	sess := session.New(opts.Sink)

	emit := func(buf []byte, err error) bool {
		if err != nil {
			logf(opts.Log, "encode %s", wire.CodeOf(err))
			return false
		}
		// Non-blocking by design. A full outbox means the host stopped draining
		// stdout; blocking here is exactly the deadlock this package avoids.
		select {
		case outbox <- buf:
			return true
		default:
			logf(opts.Log, "%s", wire.CodeHostBackpressure)
			return false
		}
	}

	settle := func(code int) int {
		// Cleanup touches handles only, never stdout, so a writer wedged in
		// Write cannot block teardown.
		res := sess.Cleanup()
		if down.cancelled.Load() {
			// The cancel never reaches the main loop as a frame — the reader
			// stops at it — so its correlated reply is emitted here, from the
			// recorded id. A cancel that produced no reply would leave the host
			// waiting on a promise nothing will settle.
			if id := down.cancelID.Load(); id != 0 {
				emit(wire.EncodeResponse(responseFor(id, res)))
			}
		}
		logf(opts.Log, "settle exit=%d published=%d residue=%v", code, sess.PublishedCount(), res.Residue)
		return finalCode(code, res, down)
	}

	// runFrame dispatches one frame. A non-zero result is a terminal exit code;
	// zero means carry on.
	runFrame := func(frame reqFrame) int {
		resp, terminal := dispatch(sess, frame, opts.Log)
		if resp != nil && !emit(wire.EncodeResponse(*resp)) {
			return ExitProtocol
		}
		return terminal
	}

	if !emit(wire.EncodeEvent(wire.Event{Event: "ready", Protocol: wire.ProtocolVersion})) {
		return settle(ExitProtocol)
	}

	// refuseQueued answers frames still in the queue at shutdown WITHOUT running
	// them.
	//
	// Shutdown means no queued operation may start. Silently dropping a request
	// the host already sent would nonetheless leave it waiting on a promise
	// nothing will settle — the same failure the cancel reply in settle() exists
	// to avoid — so each queued frame gets an explicit E_CANCELLED refusal.
	//
	// Nothing here touches the session or the sink. The frames are inspected for
	// their correlation id and for nothing else, which is what makes this a
	// refusal rather than the drain root rejected: no staged file is created, no
	// byte is written, no destination is renamed.
	//
	// Non-blocking, so a shutdown raised by the writer while the reader is still
	// parked on stdin cannot park this too.
	refuseQueued := func() {
		for {
			select {
			case frame, ok := <-frames:
				if !ok {
					return
				}
				if id := correlationID(frame); id != 0 {
					emit(wire.EncodeResponse(*errorReply(id, wire.Errf(wire.CodeCancelled, "shutting down"))))
				}
			default:
				return
			}
		}
	}

	// stop is the single shutdown exit: refuse what is queued, then settle.
	stop := func() int {
		refuseQueued()
		return settle(ExitClean)
	}

	// stopping reports whether shutdown is already known.
	//
	// `select` gives its ready cases NO priority — it chooses among them
	// uniformly at random — so shutdown has to be asked about explicitly rather
	// than raced against a queued frame in the same select.
	stopping := func() bool {
		select {
		case <-down.ch:
			return true
		default:
			return false
		}
	}

	for {
		// ## Shutdown invalidates FUTURE operations
		//
		// Checked twice, and both checks are load-bearing.
		//
		// An operation already inside the sink is allowed to settle: it holds a
		// handle, it may be mid-write, and abandoning it would be worse than
		// finishing it. But an operation still sitting in the queue must NEVER
		// be started once shutdown is known. `publish` is the case that makes
		// this non-negotiable — it renames staged files to their destinations,
		// so starting one during teardown would create user-visible files after
		// the host asked to stop, after the parent went away, or after the reply
		// channel was already broken and nothing could report the result.
		//
		// An earlier version of this loop DRAINED the queue on shutdown instead,
		// to keep a queued protocol violation from being silently dropped.
		// Root's independent review showed that was wrong: it actively executed
		// future IO during teardown, and root's finish-gated test proved a
		// queued publication started after a known EOF, after a writer failure,
		// and after an explicit cancel. Draining is not how that gap is closed —
		// wire.DecodeRequest now judges every request when it is READ, so a
		// violation is recorded without the loop having to execute it.
		if stopping() {
			return stop()
		}

		select {
		case frame, ok := <-frames:
			if !ok {
				return settle(ExitClean)
			}
			// Re-checked AFTER the dequeue. The frame and the shutdown signal can
			// become ready in the same instant, and the select above cannot rank
			// them, so without this a queued operation still starts about half
			// the time. This is the check root's cancel case failed on, and that
			// half of the defect predates the drain.
			if stopping() {
				// This frame was dequeued but must not run. It is refused with
				// the rest rather than dropped, so the host still gets an answer
				// for every request it sent.
				if id := correlationID(frame); id != 0 {
					emit(wire.EncodeResponse(*errorReply(id, wire.Errf(wire.CodeCancelled, "shutting down"))))
				}
				return stop()
			}
			if code := runFrame(frame); code != 0 {
				return settle(code)
			}

		case <-down.ch:
			return stop()
		}
	}
}

// finalCode reports the most serious truthful outcome. Residue upgrades a clean
// exit so bytes left on disk are visible to the parent even if it ignored the
// reply.
func finalCode(code int, res wire.CancelResult, down *shutdown) int {
	if code == ExitClean && (down.protoFail.Load() || down.overflow.Load() || down.writeFail.Load()) {
		code = ExitProtocol
	}
	if code == ExitClean && res.Residue {
		return ExitCleanupIncomplete
	}
	return code
}

func responseFor(id uint64, res wire.CancelResult) wire.Response {
	raw, err := json.Marshal(res)
	if err != nil {
		return wire.Response{ID: id, OK: false, Code: wire.CodeInternal}
	}
	return wire.Response{ID: id, OK: true, Result: raw}
}

// dispatch handles one frame. A non-zero second return is a terminal exit code.
func dispatch(sess *session.Session, frame reqFrame, log io.Writer) (*wire.Response, int) {
	switch frame.kind {
	case wire.KindChunk:
		header, data, err := wire.DecodeChunk(frame.payload)
		if err != nil {
			logf(log, "chunk %s", wire.CodeOf(err))
			return nil, ExitProtocol
		}
		result, err := sess.WriteChunk(int(header.Index), data)
		return reply(header.ID, result, err), 0

	case wire.KindRequest:
		// Already validated by the reader.
		req := frame.req
		switch req.Op {
		case wire.OpOpen:
			result, err := sess.Open(req.Root, req.Manifest)
			return reply(req.ID, result, err), 0
		case wire.OpBegin:
			// Unreachable: wire.DecodeRequest refuses a begin without an index
			// when the frame is read, so this frame never reaches the queue.
			// Kept because "the dispatcher assumes nothing" is cheaper to hold
			// than to re-establish if the reader contract ever changes.
			if req.Index == nil {
				return errorReply(req.ID, wire.Errf(wire.CodeProtocol, "begin without index")), 0
			}
			return reply(req.ID, struct{}{}, sess.BeginFile(*req.Index)), 0
		case wire.OpFinish:
			// Unreachable for the same reason as begin, above.
			if req.Index == nil {
				return errorReply(req.ID, wire.Errf(wire.CodeProtocol, "finish without index")), 0
			}
			result, err := sess.FinishFile(*req.Index)
			return reply(req.ID, result, err), 0
		case wire.OpPublish:
			result, err := sess.Publish()
			if err != nil {
				// The partial receipt travels WITH the failure. A caller cannot
				// see published files without also seeing the batch failed,
				// because this response is never ok:true.
				raw, _ := json.Marshal(result)
				return &wire.Response{
					ID: req.ID, OK: false,
					Code: wire.CodeOf(err), Detail: wire.DetailOf(err),
					Result: raw,
				}, 0
			}
			return reply(req.ID, result, nil), 0
		case wire.OpCancel:
			// Normally unreachable: the reader stops at a cancel and the reply is
			// emitted from the settle path. Handled anyway so the operation has
			// one meaning if the reader contract ever changes.
			return reply(req.ID, sess.Cleanup(), nil), 0
		default:
			// Unreachable: an op this protocol does not define is refused by
			// wire.DecodeRequest at read time, which is what lets the main loop
			// drop a queued frame during shutdown without losing the failure.
			// The op literal is host-supplied text and is never echoed.
			logf(log, "unknown op")
			return nil, ExitProtocol
		}

	default:
		// Response and event kinds are helper-to-host only; receiving one means
		// the peer is not the host this protocol describes.
		logf(log, "unexpected frame kind %d", frame.kind)
		return nil, ExitProtocol
	}
}

// correlationID is the id a queued frame must be answered on. Pure inspection:
// it parses the chunk header the reader already length-checked and calls nothing.
// Zero means there is no id to answer.
func correlationID(frame reqFrame) uint64 {
	switch frame.kind {
	case wire.KindRequest:
		return frame.req.ID
	case wire.KindChunk:
		if header, _, err := wire.DecodeChunk(frame.payload); err == nil {
			return header.ID
		}
	}
	return 0
}

func reply(id uint64, result any, err error) *wire.Response {
	if err != nil {
		return errorReply(id, err)
	}
	raw, mErr := json.Marshal(result)
	if mErr != nil {
		return errorReply(id, wire.Errf(wire.CodeInternal, "result marshal failed"))
	}
	return &wire.Response{ID: id, OK: true, Result: raw}
}

func errorReply(id uint64, err error) *wire.Response {
	return &wire.Response{ID: id, OK: false, Code: wire.CodeOf(err), Detail: wire.DetailOf(err)}
}

func logf(w io.Writer, format string, args ...any) {
	if w == nil {
		return
	}
	fmt.Fprintf(w, format+"\n", args...)
}
