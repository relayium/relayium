// The source-mode transport loop: bounded ownership of stdin, stdout, handles
// and shutdown.
//
// ## Same ownership split as the receive loop, and for the same reason
//
// A single sequential loop deadlocks: if the host pipelines requests without
// draining stdout, replies accumulate until the pipe buffer fills, WriteFile
// blocks, and a loop parked there can never read the EOF that would rescue it.
// Splitting reader, writer and monitor is what bounds every direction.
//
//   - The READER owns stdin and blocks on nothing else. Admission to the bounded
//     inbox is non-blocking, so EOF is always reached.
//   - The WRITER owns stdout exclusively. The main loop's sends are
//     non-blocking; a full outbox is proof the host stopped draining and ends
//     the session rather than growing a buffer.
//   - The MONITOR bounds shutdown. If settling exceeds the grace, the process
//     exits regardless.
//
// ## Handles are the thing this loop actually owns
//
// The receive loop owns staged bytes; this one owns open handles, and the
// failure that matters is a handle this process still holds after saying it let
// go. So every close is reported by outcome, a close that fails still removes
// the source from the table (nothing may be read through a handle whose state is
// unknown), and whatever is left at teardown is COUNTED and reported in the exit
// code rather than assumed released.
//
// ## What this does not guarantee
//
// A read from a wedged volume is not interruptible from inside this process. The
// helper guarantees it will not hang forever; it does not guarantee it can
// always finish. The parent owns a deadline and a kill. The reader goroutine may
// also still be parked in a stdin read when Serve returns — bounded by the
// monitor and by process exit, not by joining it.
//
// ## Logging
//
// stderr carries codes and counts only. Never a path, never a filename. A source
// path is user content and this is a crash diagnostic surface.
package sourceserve

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// Exit codes. Non-zero exit is itself a signal: the host must treat premature
// exit as failure of every outstanding request.
const (
	ExitClean           = 0
	ExitProtocol        = 2
	ExitLeftoverHandles = 3
	ExitInternal        = 4
	ExitShutdownTimeout = 5
)

const (
	// MaxInboxDepth bounds admitted-but-unprocessed frames. The contract is
	// strict request/response, so a correct host has at most one in flight and
	// this is headroom. Exceeding it is a host contract violation and must NOT
	// become backpressure: blocking the reader is precisely what would hide an
	// EOF behind pipelined data.
	MaxInboxDepth = 8

	// MaxOutboxDepth bounds replies in flight toward a host that may have
	// stopped reading.
	MaxOutboxDepth = 64

	// ShutdownGrace is how long settling may take before the process exits
	// regardless.
	ShutdownGrace = 5 * time.Second

	// WriterDrainGrace bounds the final wait for the stdout writer. A host that
	// stopped draining must not be able to park teardown forever; abandoning an
	// undeliverable reply is the correct trade, and the exit code still reports
	// the failure.
	WriterDrainGrace = time.Second
)

// Source is one opened file. Implemented on Windows by winio.Source; the
// interface exists so this loop, its dispatch and its ownership accounting are
// testable on any platform without pretending the walk is portable.
type Source interface {
	Size() int64
	Identity() (volumeSerial, fileID string)
	ReadAt(p []byte, off int64) (int, error)
	Close() error
}

// Opener opens one source by absolute local path.
type Opener interface {
	Open(path string) (Source, error)
}

// Options configures one run. Every field has a production default; they exist
// so tests can drive the loop in-process and observe a forced exit rather than
// taking the test binary down.
type Options struct {
	In     io.Reader
	Out    io.Writer
	Log    io.Writer
	Opener Opener
	Grace  time.Duration
	// DrainGrace bounds the final wait for the stdout writer.
	DrainGrace time.Duration
	// ForceExit is called when shutdown exceeds Grace. It DEFAULTS TO os.Exit,
	// never nil: a default of nil would mean the shipped executable, which
	// passes none, had no shutdown bound at all while in-process tests injected
	// an observer and appeared to prove the timeout path.
	ForceExit func(code int)
}

// admitted is one frame that has already been judged by the strict validator.
type admitted struct {
	req Request
	err error
	// id correlates a refusal. Probed numerically from the payload when strict
	// decoding failed, so a malformed request is still answered rather than
	// dropped silently.
	id uint64
}

// entry is one open source and the id it was issued under.
type entry struct {
	src Source
}

// Serve runs one source-mode session and returns the process exit code.
func Serve(o Options) int {
	if o.Grace <= 0 {
		o.Grace = ShutdownGrace
	}
	if o.DrainGrace <= 0 {
		o.DrainGrace = WriterDrainGrace
	}
	if o.ForceExit == nil {
		o.ForceExit = os.Exit
	}
	if o.Log == nil {
		o.Log = io.Discard
	}
	if o.Opener == nil {
		fmt.Fprintln(o.Log, wire.CodeInternal, "no opener")
		return ExitInternal
	}

	var (
		shutdownOnce sync.Once
		shutdown     = make(chan struct{})
		finished     = make(chan struct{})
		inbox        = make(chan admitted, MaxInboxDepth)
		outbox       = make(chan []byte, MaxOutboxDepth)

		protocolFailed atomic.Bool
		internalFailed atomic.Bool
	)
	stop := func() { shutdownOnce.Do(func() { close(shutdown) }) }

	// The monitor is armed before anything can fail, so there is no window in
	// which shutdown is unbounded.
	go func() {
		select {
		case <-finished:
			return
		case <-shutdown:
		}
		select {
		case <-finished:
		case <-time.After(o.Grace):
			fmt.Fprintln(o.Log, "E_SHUTDOWN_TIMEOUT")
			o.ForceExit(ExitShutdownTimeout)
		}
	}()

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for frame := range outbox {
			if _, err := o.Out.Write(frame); err != nil {
				// The reply channel is gone. Continuing to do filesystem work
				// with no way to report its outcome would be work nobody can
				// use, so this ends the session.
				protocolFailed.Store(true)
				fmt.Fprintln(o.Log, wire.CodeHostBackpressure, "write failed")
				stop()
				return
			}
		}
	}()

	// send is non-blocking by construction. A full outbox is not a reason to
	// wait; it is proof the host stopped draining.
	send := func(frame []byte) bool {
		select {
		case outbox <- frame:
			return true
		default:
			protocolFailed.Store(true)
			fmt.Fprintln(o.Log, wire.CodeHostBackpressure, "outbox full")
			stop()
			return false
		}
	}

	go func() {
		reader := wire.NewReader(o.In)
		for {
			frame, err := reader.ReadFrame()
			if err != nil {
				switch {
				case errors.Is(err, io.EOF):
					// A clean frame boundary: the parent finished with us.
				case errors.Is(err, io.ErrUnexpectedEOF):
					protocolFailed.Store(true)
					fmt.Fprintln(o.Log, wire.CodeProtocol, "truncated frame")
				default:
					protocolFailed.Store(true)
					fmt.Fprintln(o.Log, wire.CodeOf(err), wire.DetailOf(err))
				}
				stop()
				close(inbox)
				return
			}
			if frame.Kind != wire.KindRequest {
				// This mode never receives bytes from the host. A chunk here is
				// either the wrong protocol on this pipe or a probe.
				protocolFailed.Store(true)
				fmt.Fprintln(o.Log, wire.CodeProtocol, "unexpected frame kind")
				stop()
				close(inbox)
				return
			}
			// Validated on READ. A frame still queued at teardown has already
			// been judged, so it can be dropped without executing anything and
			// without losing the fact that it was malformed.
			req, decErr := DecodeRequest(frame.Payload)
			item := admitted{req: req, err: decErr}
			if decErr != nil {
				item.id = probeID(frame.Payload)
			}
			select {
			case inbox <- item:
			default:
				protocolFailed.Store(true)
				fmt.Fprintln(o.Log, wire.CodeProtocol, "inbox overflow")
				stop()
				close(inbox)
				return
			}
		}
	}()

	srv := &server{
		opener:  o.Opener,
		table:   make(map[uint64]entry),
		scratch: make([]byte, MaxReadBytes),
	}

	if frame, err := wire.EncodeEvent(wire.Event{Event: ReadyEvent, Protocol: ProtocolVersion}); err != nil {
		internalFailed.Store(true)
		stop()
	} else if !send(frame) {
		// stop() already signalled.
	}

	// Admitted work is drained before shutdown is honoured.
	//
	// A single select over both channels would be wrong: at clean end of input
	// the reader signals shutdown AND closes the inbox, both become ready at
	// once, and Go chooses between ready cases at random. A request the host
	// sent before closing its end would then be answered or silently dropped
	// depending on a coin flip. Shutdown is therefore only consulted when
	// nothing is already waiting, which is the one moment at which abandoning
	// the session loses no already-judged work.
loop:
	for {
		var (
			item admitted
			ok   bool
		)
		select {
		case item, ok = <-inbox:
		default:
			select {
			case item, ok = <-inbox:
			case <-shutdown:
				break loop
			}
		}
		{
			if !ok {
				break loop
			}
			if item.err != nil {
				protocolFailed.Store(true)
				if item.id != 0 {
					if frame, encErr := EncodeErr(item.id, item.err); encErr == nil {
						send(frame)
					}
				}
				stop()
				break loop
			}
			for _, frame := range srv.handle(item.req) {
				if !send(frame) {
					break loop
				}
			}
		}
	}

	// Ownership inventory, and the truth about it. Sources still in the table
	// were never closed by the host; each is closed here and counted, and a
	// close that fails is a handle this process still holds.
	late, failed := srv.releaseAll()
	if late > 0 {
		fmt.Fprintln(o.Log, "E_LATE_CLOSE", late)
	}
	if failed > 0 {
		fmt.Fprintln(o.Log, CodeFailedClose, failed)
	}

	close(outbox)
	select {
	case <-writerDone:
	case <-time.After(o.DrainGrace):
		fmt.Fprintln(o.Log, wire.CodeHostBackpressure, "writer drain abandoned")
	}
	close(finished)

	switch {
	case internalFailed.Load():
		return ExitInternal
	case protocolFailed.Load():
		return ExitProtocol
	case failed > 0 || srv.failedCloses > 0:
		return ExitLeftoverHandles
	default:
		return ExitClean
	}
}

// server holds the dispatch state. The main loop is single-threaded, so nothing
// here needs a lock, and no handler may start a goroutine.
type server struct {
	opener       Opener
	table        map[uint64]entry
	nextID       uint64
	scratch      []byte
	failedCloses int
}

// handle runs one validated request and returns the frames to emit, in order.
func (s *server) handle(req Request) [][]byte {
	switch req.Op {
	case OpOpen:
		return s.handleOpen(req)
	case OpRead:
		return s.handleRead(req)
	case OpClose:
		return s.handleClose(req)
	default:
		// Unreachable: DecodeRequest rejects unknown operations. Stated rather
		// than assumed, because silently returning no frames would strand the
		// request forever.
		return s.fail(req.ID, wire.Errf(wire.CodeInternal, "unhandled operation"))
	}
}

func (s *server) handleOpen(req Request) [][]byte {
	// Checked BEFORE the open, so a refused request opens nothing. Checking
	// after would mean the limit is enforced by closing a handle we should not
	// have acquired.
	if len(s.table) >= MaxOpenSources {
		return s.fail(req.ID, wire.Errf(CodeSourceLimit, fmt.Sprintf("%d open", len(s.table))))
	}
	src, err := s.opener.Open(req.Path)
	if err != nil {
		return s.fail(req.ID, err)
	}
	volumeSerial, fileID := src.Identity()
	if volumeSerial == "" || fileID == "" {
		// The opener is contracted to refuse rather than return a blank
		// identity. If one arrives anyway, the handle is released here rather
		// than served: an unbound read is the one outcome this path exists to
		// prevent.
		if closeErr := src.Close(); closeErr != nil {
			s.failedCloses++
		}
		return s.fail(req.ID, wire.Errf(wire.CodeInternal, "opener returned blank identity"))
	}
	s.nextID++
	id := s.nextID
	s.table[id] = entry{src: src}
	frame, err := EncodeOK(req.ID, OpenResult{
		Source:       id,
		Size:         src.Size(),
		VolumeSerial: volumeSerial,
		FileID:       fileID,
	})
	if err != nil {
		return s.fail(req.ID, err)
	}
	return [][]byte{frame}
}

func (s *server) handleRead(req Request) [][]byte {
	e, ok := s.table[req.Source]
	if !ok {
		// The same code for "never issued" and "already closed". Distinguishing
		// them would confirm which ids this process has used.
		return s.fail(req.ID, wire.Errf(CodeUnknownSource, ""))
	}
	length := *req.Length
	n, err := e.src.ReadAt(s.scratch[:length], *req.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return s.fail(req.ID, err)
	}
	// EOF is reported as an outcome of THIS read, never inferred from the size
	// recorded at open time: the file may have been extended or truncated since,
	// and a stale size would make the helper assert something it did not observe.
	// A short read from a local disk file means end of file; io.EOF means the
	// offset was already at or past it.
	eof := errors.Is(err, io.EOF) || n < length

	frames := make([][]byte, 0, 2)
	if n > 0 {
		// The chunk precedes the response so the host can attribute bytes to a
		// request before that request settles.
		chunk, encErr := wire.EncodeChunk(wire.ChunkHeader{ID: req.ID, Index: 0}, s.scratch[:n])
		if encErr != nil {
			return s.fail(req.ID, encErr)
		}
		frames = append(frames, chunk)
	}
	resp, encErr := EncodeOK(req.ID, ReadResult{Bytes: n, EOF: eof})
	if encErr != nil {
		return s.fail(req.ID, encErr)
	}
	return append(frames, resp)
}

func (s *server) handleClose(req Request) [][]byte {
	e, ok := s.table[req.Source]
	if !ok {
		return s.fail(req.ID, wire.Errf(CodeUnknownSource, ""))
	}
	// Removed from the table BEFORE the close is attempted. A handle whose
	// release failed is in an unknown state, and nothing may be read through it;
	// leaving it addressable so the host could retry would be offering a read on
	// exactly that handle.
	delete(s.table, req.Source)
	state := StateClosed
	if err := e.src.Close(); err != nil {
		state = StateFailedClose
		s.failedCloses++
	}
	frame, err := EncodeOK(req.ID, CloseResult{State: state})
	if err != nil {
		return s.fail(req.ID, err)
	}
	return [][]byte{frame}
}

// releaseAll closes everything still held and reports how many were still open
// and how many could not be released. Every source is attempted even after one
// fails; stopping early would leak the rest to make the count tidier.
func (s *server) releaseAll() (late, failed int) {
	for id, e := range s.table {
		late++
		if err := e.src.Close(); err != nil {
			failed++
		}
		delete(s.table, id)
	}
	return late, failed
}

func (s *server) fail(id uint64, err error) [][]byte {
	frame, encErr := EncodeErr(id, err)
	if encErr != nil {
		return nil
	}
	return [][]byte{frame}
}

// probeID recovers only the correlation id from a payload that failed strict
// validation, so a malformed request is refused by name rather than dropped.
//
// It reads ONE numeric field. Nothing host-authored is extracted, and nothing
// extracted here is ever echoed into a detail.
func probeID(payload []byte) uint64 {
	var probe struct {
		ID uint64 `json:"id"`
	}
	if err := json.Unmarshal(payload, &probe); err != nil {
		return 0
	}
	return probe.ID
}
