package xfer

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/relayium/relayium/internal/termtext"
)

// StreamSource is the input of SendStream. In the CLI it is a
// stdinpump.Pump: Read returns io.EOF only at a real end of input, and Stop
// releases a Read in progress and ends whatever reads the input, in bounded
// time. Stop may be called more than once and concurrently with Read.
type StreamSource interface {
	io.Reader
	Stop() error
}

// StreamTransport is the connection to the receiver. Abort must release a
// Read and a Write blocked in it, without waiting for the peer
// (sshx.Session.Abort; closing a TLS connection).
type StreamTransport interface {
	io.ReadWriter
	Abort() error
}

// StreamSendOpts configures SendStream.
type StreamSendOpts struct {
	// Progress, when set, is called from the writer goroutine after each data
	// frame was written, with the total bytes sent so far.
	Progress func(sent int64)
}

// StreamReport describes a stream as sent. Notes are non-fatal observations
// for the user's console (already terminal-safe), in both success and failure.
type StreamReport struct {
	Bytes  int64
	SHA256 string
	Notes  []string
}

// Timing of the sender. Vars so tests can shorten them.
var (
	// streamKeepalive: a zero-length data frame after this long without data,
	// so a receiver's idle bound never fires while the input is merely slow.
	streamKeepalive = 30 * time.Second
	// streamEndGrace bounds the wait for the local End write to return after
	// the receiver's confirmation was validated. It is this sender's own
	// timer: nothing else releases that write before Abort.
	streamEndGrace = 5 * time.Second
	// streamErrDrainGrace: after a write to the receiver failed, how long to
	// wait for the receiver's own explanation before giving up on it.
	streamErrDrainGrace = 5 * time.Second
)

// Sentinel causes a caller can branch on with errors.Is.
var (
	// ErrStreamNotAccepted: the receiver's first answer was not StreamAccept
	// (a closed connection, a v1 resume state, anything else). Nothing was read
	// from the input.
	ErrStreamNotAccepted = errors.New("the receiver did not accept the stream")
	// ErrStreamUnconfirmed: a StreamResult that does not echo this transfer's
	// End challenge (or came before End). Never success.
	ErrStreamUnconfirmed = errors.New("the receiver's answer is not a confirmation of this transfer")
	// ErrStreamDifferentBytes: a fresh confirmation of different bytes.
	ErrStreamDifferentBytes = errors.New("the receiver confirmed different bytes")
	// ErrStreamCancelled: the caller's context ended the transfer.
	ErrStreamCancelled = errors.New("the transfer was cancelled")
)

// StreamStage is how far a failed stream got, which decides what can be said
// about the receiver.
type StreamStage int

const (
	// StreamBeforeAccept: the input was never read, and the receiver installs
	// nothing without a verified End.
	StreamBeforeAccept StreamStage = iota
	// StreamSending: the input was being read; End was never attempted, so
	// the receiver installed nothing.
	StreamSending
	// StreamEndAttempted: End may have left this process. Without a validated
	// confirmation the receiver may or may not have installed the file.
	StreamEndAttempted
)

// StreamSendError is every failure of SendStream. Its text is the cause
// followed by what that means for the receiver, keyed on the stage at which
// the failure was judged — never on whether a write returned.
type StreamSendError struct {
	Stage StreamStage
	Name  string // the destination name as the user gave it
	Err   error
}

func (e *StreamSendError) Unwrap() error { return e.Err }

func (e *StreamSendError) Error() string {
	name := termtext.Safe(e.Name)
	switch {
	case errors.Is(e.Err, ErrStreamUnconfirmed):
		return e.Err.Error() + "; NOT confirmed; do not trust " + name + " on the receiver"
	case errors.Is(e.Err, ErrStreamDifferentBytes):
		return e.Err.Error() + "; do not trust " + name + " on the receiver"
	}
	switch e.Stage {
	case StreamBeforeAccept:
		return e.Err.Error() + "; nothing was read from stdin and nothing was installed on the receiver"
	case StreamSending:
		return e.Err.Error() + "; nothing was installed on the receiver"
	}
	// The receiver sends these codes only after it attempted to remove its
	// staging (its message names a staging directory it could not remove) and
	// before installing anything (stream_recv.go), so "nothing was installed"
	// is definite even after End — as far as the receiver's word goes.
	var re *RemoteError
	if errors.As(e.Err, &re) {
		switch re.Code {
		case ErrCodeWriteFailed, ErrCodeProtocol, ErrCodeDestinationExists:
			return e.Err.Error() + "; nothing was installed on the receiver"
		}
	}
	return e.Err.Error() + "; the end of the stream may have reached the receiver; it may or may not have installed " +
		name + ". Check it there before retrying"
}

// SendStream sends one file of unknown length, read from the source that
// start returns, to a receiver speaking the stream protocol (ReceiveStream),
// under the destination name name.
//
// Ownership, which is the whole point of its shape:
//
//   - One writer goroutine (W) makes every write to t, from the first byte of
//     Hello to End. The calling goroutine never writes t, so every write can
//     be released by Abort.
//   - One reader goroutine (R) makes every read of t.
//   - start is called only after the receiver's StreamAccept arrived, so
//     nothing reads the input before the receiver agreed to take it; its
//     reader goroutine (P) is the only reader of the source.
//   - The calling goroutine supervises: on any failure it stops the source,
//     aborts t, and joins W, R and P before returning.
//
// A StreamResult counts as the receiver's confirmation only when it echoes the
// challenge that exists nowhere before this transfer's End frame, and names
// exactly the bytes sent. The fresh 128-bit echo shows that whoever answered
// knew the value of this transfer's End challenge — so the answer is not a
// stale or premature one, which no local timing can tell. It does not show
// that every framing byte was consumed by a stream receiver, nor that the
// receiver verified, installed or stored anything; the size and hash it names
// are its own claim. That is the same trust v1 push places in its receiver.
//
// On success the caller closes t normally; on error it must not wait for the
// peer (t was already aborted).
func SendStream(ctx context.Context, t StreamTransport, name string, start func() (StreamSource, error), o StreamSendOpts) (StreamReport, error) {
	s := &streamSender{
		ctx:      ctx,
		t:        t,
		name:     name,
		start:    start,
		o:        o,
		evCh:     make(chan streamEvent, 8),
		stop:     make(chan struct{}),
		accepted: make(chan struct{}),
		dataCh:   make(chan []byte, 1),
		freeCh:   make(chan []byte, streamBuffers),
		endPhase: make(chan struct{}),
		wDone:    make(chan struct{}),
	}
	return s.run()
}

// streamBuffers is how many chunk buffers exist at once: one being filled by
// P, one queued, one being written by W.
const streamBuffers = 3

// streamFrameHeader is [type:1][len:4], as WriteFrame writes it.
const streamFrameHeader = 5

type streamEventKind int

const (
	evAccept    streamEventKind = iota // R: StreamAccept
	evResult                           // R: StreamResult
	evPeerError                        // R: MsgError, EOF, a read error or an unexpected frame
	evWriteErr                         // W: a write to t failed
	evSourceErr                        // P: the source failed (not io.EOF)
)

type streamEvent struct {
	kind streamEventKind
	res  StreamResult
	err  error
}

type streamSender struct {
	ctx   context.Context
	t     StreamTransport
	name  string
	start func() (StreamSource, error)
	o     StreamSendOpts

	evCh     chan streamEvent
	stop     chan struct{} // closed by teardown: every goroutine leaves any channel wait
	accepted chan struct{} // closed by the supervisor once P runs: W may frame data
	dataCh   chan []byte   // P -> W, buffers with streamFrameHeader bytes of room in front
	freeCh   chan []byte   // W -> P, emptied buffers
	endPhase chan struct{} // closed by W immediately before it attempts to write End
	wDone    chan struct{} // closed when W returned

	chunk int // min(StreamAccept.ChunkMax, StreamChunkMax); written by R before evAccept

	// Guarded by phaseMu: W enters the End phase only while not frozen; the
	// supervisor freezes before it judges a failure's stage, so a stage it
	// judged cannot be overtaken by an End written afterwards.
	phaseMu sync.Mutex
	frozen  bool
	// Written by W before close(endPhase); read by others only after a
	// receive from endPhase.
	endSize      int64
	endSum       string
	endChallenge string
	// Written by W before close(wDone).
	endErr error

	src    StreamSource // set by the supervisor only
	wg     sync.WaitGroup
	tdOnce sync.Once
	notes  []string
}

func (s *streamSender) event(e streamEvent) { s.evCh <- e } // never blocks: at most 4 events exist

func (s *streamSender) note(format string, a ...any) {
	s.notes = append(s.notes, termtext.Safe(fmt.Sprintf(format, a...)))
}

func (s *streamSender) run() (StreamReport, error) {
	s.wg.Add(2)
	go s.writer()
	go s.reader()

	var drain <-chan time.Time // armed after a write failure
	var writeErr error
	for {
		select {
		case ev := <-s.evCh:
			switch ev.kind {
			case evAccept:
				if writeErr != nil {
					// Sending already failed: the transfer cannot proceed,
					// so the input is not touched.
					continue
				}
				src, err := s.start()
				if err != nil {
					return s.fail(fmt.Errorf("starting the stdin reader: %w", err))
				}
				s.src = src
				s.wg.Add(1)
				go s.pump(src)
				close(s.accepted)
			case evResult:
				return s.onResult(ev.res)
			case evPeerError:
				if writeErr != nil {
					var re *RemoteError
					if !errors.As(ev.err, &re) {
						return s.fail(writeErr)
					}
				}
				return s.fail(ev.err)
			case evWriteErr:
				// Stop reading the input at once; give the receiver a bounded
				// moment to say why (its MsgError is the better message).
				writeErr = fmt.Errorf("sending to the receiver failed: %w", ev.err)
				if s.src != nil {
					if err := s.src.Stop(); err != nil {
						s.note("%v", err)
					}
				}
				drain = time.After(streamErrDrainGrace)
			case evSourceErr:
				if writeErr != nil {
					// The source failed because the write failure stopped it;
					// the write failure (or the receiver's word) is the cause.
					continue
				}
				return s.fail(ev.err)
			}
		case <-drain:
			return s.fail(writeErr)
		case <-s.ctx.Done():
			return s.fail(fmt.Errorf("%w: %v", ErrStreamCancelled, context.Cause(s.ctx)))
		}
	}
}

// fail freezes the End phase, judges the stage, tears everything down and
// returns the error.
func (s *streamSender) fail(cause error) (StreamReport, error) {
	s.phaseMu.Lock()
	s.frozen = true
	stage := StreamBeforeAccept
	if s.src != nil {
		stage = StreamSending
	}
	select {
	case <-s.endPhase:
		stage = StreamEndAttempted
	default:
	}
	s.phaseMu.Unlock()
	s.teardown()
	return StreamReport{Notes: s.notes}, &StreamSendError{Stage: stage, Name: s.name, Err: cause}
}

// teardown: stop the source (ends the helper, releases P's Read), release
// every channel wait, Abort the transport (releases W's Write and R's Read),
// then join. No step waits for the peer, for the input, or for a write to
// finish before Abort.
func (s *streamSender) teardown() {
	s.tdOnce.Do(func() {
		if s.src != nil {
			if err := s.src.Stop(); err != nil {
				s.note("%v", err)
			}
		}
		close(s.stop)
		_ = s.t.Abort()
		s.wg.Wait()
	})
}

// finish is the healthy end: every goroutine has finished or is about to, so
// nothing is aborted. The source's Stop only reaps its helper (bounded).
func (s *streamSender) finish() {
	s.tdOnce.Do(func() {
		if err := s.src.Stop(); err != nil {
			s.note("%v", err)
		}
		close(s.stop)
		s.wg.Wait()
	})
}

func (s *streamSender) onResult(r StreamResult) (StreamReport, error) {
	var want string
	var size int64
	var sum string
	select {
	case <-s.endPhase: // happens-after W's stores of the three fields
		want, size, sum = s.endChallenge, s.endSize, s.endSum
	default:
	}
	switch {
	case want == "":
		return s.fail(fmt.Errorf("%w: the receiver answered before the end of input was sent", ErrStreamUnconfirmed))
	case len(r.Challenge) != StreamChallengeLen ||
		subtle.ConstantTimeCompare([]byte(r.Challenge), []byte(want)) != 1:
		return s.fail(fmt.Errorf("%w: the receiver's confirmation does not belong to this transfer's end", ErrStreamUnconfirmed))
	case r.Size != size || r.SHA256 != sum:
		return s.fail(fmt.Errorf("%w: it reports %d bytes, %d were sent", ErrStreamDifferentBytes, r.Size, size))
	}

	// Verdict decided: the answer echoes this transfer's End challenge and
	// claims exactly these bytes. What remains is to end the local End write
	// in bounded time.
	rep := StreamReport{Bytes: size, SHA256: sum}
	timer := time.NewTimer(streamEndGrace)
	defer timer.Stop()
	select {
	case <-s.wDone:
		s.finish()
		if s.endErr != nil {
			s.note("the receiver confirmed %s, but ending the local write reported: %v", s.name, s.endErr)
		}
	case <-timer.C:
		s.note("the end-of-stream write did not complete locally after the receiver confirmed %s; transport aborted", s.name)
		s.teardown()
	case <-s.ctx.Done():
		s.note("cancelled after the receiver confirmed %s; transport aborted", s.name)
		s.teardown()
	}
	rep.Notes = s.notes
	return rep, nil
}

// writer is W: the only writer to t.
func (s *streamSender) writer() {
	defer s.wg.Done()
	defer close(s.wDone)

	if err := s.writeJSON(MsgHello, Hello{Version: WireVersion, Mode: "push", Stream: true}); err != nil {
		s.event(streamEvent{kind: evWriteErr, err: err})
		return
	}
	if err := s.writeJSON(MsgManifest, Manifest{Files: []FileEntry{{Path: s.name, Size: -1}}}); err != nil {
		s.event(streamEvent{kind: evWriteErr, err: err})
		return
	}
	select {
	case <-s.accepted:
	case <-s.stop:
		return
	}

	h := sha256.New()
	var sent int64
	keepalive := time.NewTimer(streamKeepalive)
	defer keepalive.Stop()
	for {
		select {
		case buf, ok := <-s.dataCh:
			if !ok {
				s.writeEnd(sent, hex.EncodeToString(h.Sum(nil)))
				return
			}
			payload := buf[streamFrameHeader:]
			h.Write(payload)
			sent += int64(len(payload))
			buf[0] = byte(MsgStreamData)
			binary.BigEndian.PutUint32(buf[1:streamFrameHeader], uint32(len(payload)))
			err := writeAll(s.t, buf)
			s.freeCh <- buf[:cap(buf)]
			if err != nil {
				s.event(streamEvent{kind: evWriteErr, err: err})
				return
			}
			if s.o.Progress != nil {
				s.o.Progress(sent)
			}
			if !keepalive.Stop() {
				select {
				case <-keepalive.C:
				default:
				}
			}
			keepalive.Reset(streamKeepalive)
		case <-keepalive.C:
			if err := writeAll(s.t, []byte{byte(MsgStreamData), 0, 0, 0, 0}); err != nil {
				s.event(streamEvent{kind: evWriteErr, err: err})
				return
			}
			keepalive.Reset(streamKeepalive)
		case <-s.stop:
			return
		}
	}
}

// writeEnd creates the challenge, enters the End phase and writes End. The
// challenge is created here, after the body is complete, and nowhere else.
func (s *streamSender) writeEnd(size int64, sum string) {
	s.phaseMu.Lock()
	if s.frozen {
		s.phaseMu.Unlock()
		return
	}
	s.endSize, s.endSum, s.endChallenge = size, sum, newStreamChallenge()
	close(s.endPhase) // the End phase begins BEFORE the write is attempted
	s.phaseMu.Unlock()
	s.endErr = s.writeJSON(MsgStreamEnd, StreamEnd{Size: size, SHA256: sum, Challenge: s.endChallenge})
	if s.endErr != nil {
		s.event(streamEvent{kind: evWriteErr, err: s.endErr})
	}
}

// writeJSON writes one control frame with a single Write.
func (s *streamSender) writeJSON(t MsgType, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeAll(s.t, appendFrame(nil, t, b))
}

func appendFrame(dst []byte, t MsgType, payload []byte) []byte {
	var hdr [streamFrameHeader]byte
	hdr[0] = byte(t)
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	return append(append(dst, hdr[:]...), payload...)
}

func writeAll(w io.Writer, b []byte) error {
	n, err := w.Write(b)
	if err == nil && n < len(b) {
		err = io.ErrShortWrite
	}
	return err
}

// reader is R: the only reader of t. It reports StreamAccept, then exactly one
// more event, and returns.
func (s *streamSender) reader() {
	defer s.wg.Done()
	var acc StreamAccept
	switch t, payload, err := readStreamControl(s.t); {
	case err != nil:
		s.event(streamEvent{kind: evPeerError, err: fmt.Errorf("%w: %v", ErrStreamNotAccepted, describeReadErr(err))})
		return
	case t == MsgError:
		s.event(streamEvent{kind: evPeerError, err: decodeRemoteError(payload)})
		return
	case t == MsgResume:
		s.event(streamEvent{kind: evPeerError, err: fmt.Errorf("%w: it answered as a receiver that predates `push -`", ErrStreamNotAccepted)})
		return
	case t != MsgStreamAccept:
		s.event(streamEvent{kind: evPeerError, err: fmt.Errorf("%w: protocol error: expected message type %d, got %d", ErrStreamNotAccepted, MsgStreamAccept, t)})
		return
	default:
		if err := json.Unmarshal(payload, &acc); err != nil || acc.ChunkMax < 1 {
			s.event(streamEvent{kind: evPeerError, err: fmt.Errorf("%w: protocol error: malformed stream accept", ErrStreamNotAccepted)})
			return
		}
	}
	s.chunk = min(acc.ChunkMax, StreamChunkMax)
	s.event(streamEvent{kind: evAccept})

	var res StreamResult
	switch t, payload, err := readStreamControl(s.t); {
	case err != nil:
		s.event(streamEvent{kind: evPeerError, err: fmt.Errorf("the receiver's connection ended before it confirmed the file: %v", describeReadErr(err))})
	case t == MsgError:
		s.event(streamEvent{kind: evPeerError, err: decodeRemoteError(payload)})
	case t == MsgResult:
		// A v1 verdict where a stream confirmation belongs: an answer, but not
		// one that can confirm this transfer.
		s.event(streamEvent{kind: evPeerError, err: fmt.Errorf("%w: the receiver answered with a v1 result, not a stream confirmation", ErrStreamUnconfirmed)})
	case t != MsgStreamResult:
		s.event(streamEvent{kind: evPeerError, err: fmt.Errorf("protocol error: expected message type %d, got %d", MsgStreamResult, t)})
	default:
		if err := json.Unmarshal(payload, &res); err != nil {
			s.event(streamEvent{kind: evPeerError, err: errors.New("protocol error: malformed stream result")})
			return
		}
		s.event(streamEvent{kind: evResult, res: res})
	}
}

// pump is P: the only reader of the source.
func (s *streamSender) pump(src StreamSource) {
	defer s.wg.Done()
	allocated := 0
	for {
		var buf []byte
		select {
		case buf = <-s.freeCh:
		default:
			if allocated < streamBuffers {
				buf = make([]byte, streamFrameHeader+StreamChunkMax)
				allocated++
			} else {
				select {
				case buf = <-s.freeCh:
				case <-s.stop:
					return
				}
			}
		}
		n, err := src.Read(buf[streamFrameHeader : streamFrameHeader+s.chunk])
		if n > 0 {
			select {
			case s.dataCh <- buf[:streamFrameHeader+n]:
			case <-s.stop:
				return
			}
		} else {
			s.freeCh <- buf
		}
		if errors.Is(err, io.EOF) {
			close(s.dataCh)
			return
		}
		if err != nil {
			s.event(streamEvent{kind: evSourceErr, err: err})
			return
		}
	}
}

// maxStreamControl bounds a control frame the stream protocol reads; every
// one is a small JSON object.
const maxStreamControl = 64 << 10

// readStreamControl reads one frame whose payload is at most maxStreamControl
// bytes, refusing a larger one before allocating it.
func readStreamControl(r io.Reader) (MsgType, []byte, error) {
	var hdr [streamFrameHeader]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > maxStreamControl {
		return 0, nil, fmt.Errorf("protocol error: control frame of %d bytes", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return MsgType(hdr[0]), payload, nil
}

func decodeRemoteError(payload []byte) error {
	var we WireError
	if err := json.Unmarshal(payload, &we); err != nil {
		return errors.New("receiver refused the transfer (unreadable error frame)")
	}
	return &RemoteError{Code: we.Code, Msg: we.Msg}
}

func describeReadErr(err error) string {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "the connection was closed"
	}
	return termtext.Safe(err.Error())
}

// newStreamChallenge returns 16 bytes from crypto/rand as 32 lowercase hex
// characters. crypto/rand.Read never fails on supported platforms; if the
// system's source were ever unusable it crashes the program before End, and a
// receiver installs nothing without End.
func newStreamChallenge() string {
	var b [StreamChallengeLen / 2]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// validStreamChallenge: exactly StreamChallengeLen characters of [0-9a-f].
func validStreamChallenge(c string) bool {
	if len(c) != StreamChallengeLen {
		return false
	}
	for i := 0; i < len(c); i++ {
		if !('0' <= c[i] && c[i] <= '9' || 'a' <= c[i] && c[i] <= 'f') {
			return false
		}
	}
	return true
}
