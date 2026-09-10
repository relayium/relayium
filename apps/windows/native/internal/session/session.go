// The receive state machine: one process, one lease, one chosen folder.
//
// ## The process IS the lease
//
// `Open` is accepted exactly once per session and a second one is a protocol
// error. That is what makes handle ownership tractable: there is no cross-lease
// handle table to get wrong, and parent EOF means "clean up everything" without
// qualification.
//
// ## What is portable and what is not
//
// This package owns ordering, length accounting and the truthful shape of the
// publish receipt. It owns no filesystem primitive: every real operation goes
// through Sink, whose only production implementation is internal/winio and is
// Windows-only.
//
// That split is a testing hazard as much as a design convenience, so it is
// stated plainly here and repeated in every portable test file: exercising this
// package against an in-memory Sink proves ordering and protocol, and proves
// NOTHING about no-replace publication, reparse refusal, handle pinning or
// cleanup. Those invariants live in Sink and are provable only on Windows.
package session

import (
	"fmt"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// Sink is the filesystem side of a lease.
//
// Every method may be called only in the order the state machine allows, so
// implementations do not repeat sequencing checks. What they must not assume is
// that Cleanup follows a successful call: it runs after any failure too.
type Sink interface {
	// Open pins the destination root and creates the staging directory this
	// sink exclusively owns. Implementations must reject a root they cannot
	// hold for the whole session.
	Open(root string, plan *nameguard.Plan) error

	// BeginFile creates the staged object for index and retains its handle.
	BeginFile(index int) error

	// WriteChunk appends to the currently open staged file and returns the byte
	// count the operating system actually took.
	WriteChunk(index int, p []byte) (int, error)

	// FinishFile flushes and retains the staged handle for publication.
	FinishFile(index int) error

	// PublishOne moves the staged object for index to its destination without
	// replacing anything. It must fail rather than overwrite.
	PublishOne(index int) error

	// Cleanup removes only objects this sink owns and reports what it could not
	// remove. It must be safe to call more than once.
	Cleanup() (Residue, error)
}

// Residue is what cleanup left on the user's disk.
type Residue struct {
	RemovedFiles int
	// Left is true when bytes remain. It is surfaced to the host rather than
	// swallowed: a lease that could not clean up has left data behind and the UI
	// must be able to say so.
	Left bool
}

type state int

const (
	stateNew state = iota
	stateReady
	stateWriting
	stateComplete
	stateTerminal
)

func (s state) String() string {
	switch s {
	case stateNew:
		return "new"
	case stateReady:
		return "ready"
	case stateWriting:
		return "writing"
	case stateComplete:
		return "complete"
	default:
		return "terminal"
	}
}

// abandon makes the session terminal and returns the error that caused it.
//
// ## The rule this encodes
//
// A request rejected BEFORE the sink is called leaves the session usable: the
// disk was never touched, so nothing about it is in doubt. An error REPORTED BY
// THE SINK is terminal, because from here the state of the staged object is
// unknown, and the only safe thing to do with an object of unknown length is to
// never publish it.
//
// stateTerminal is absorbing: only FinishFile reaches stateComplete and it
// requires stateWriting, so no later call can walk the session back into a state
// Publish will act on.
func (s *Session) abandon(err error) error {
	s.state = stateTerminal
	return err
}

// Session drives one receive lease. It is not safe for concurrent use; the serve
// loop calls it from a single goroutine by construction.
type Session struct {
	sink Sink
	plan *nameguard.Plan

	state     state
	nextIndex int
	current   int   // index of the open file while writing, else -1
	written   int64 // bytes accepted for the open file

	published int
	cleaned   bool
	residue   Residue
}

func New(sink Sink) *Session {
	return &Session{sink: sink, state: stateNew, current: -1}
}

// Open validates the manifest independently and pins the destination.
func (s *Session) Open(root string, entries []wire.ManifestEntry) (wire.OpenResult, error) {
	if s.state != stateNew {
		return wire.OpenResult{}, wire.Errf(wire.CodeSequence, "open in state "+s.state.String())
	}
	if root == "" {
		return wire.OpenResult{}, wire.Errf(wire.CodeRoot, "empty root")
	}

	planEntries := make([]nameguard.Entry, len(entries))
	for i, e := range entries {
		planEntries[i] = nameguard.Entry{Name: e.Name, Size: e.Size}
	}
	plan, failure := nameguard.BuildPlan(planEntries)
	if failure != nil {
		// The offending name is never echoed: this detail reaches stderr, and a
		// filename is user content.
		detail := string(failure.Kind)
		if failure.Reason != "" {
			detail += "/" + string(failure.Reason)
		}
		if failure.Index >= 0 {
			detail += fmt.Sprintf(" at %d", failure.Index)
		}
		return wire.OpenResult{}, wire.Errf(wire.CodeManifest, detail)
	}

	if err := s.sink.Open(root, plan); err != nil {
		// Terminal, unlike the manifest refusal above. That one is decided before
		// the sink is touched and leaves the session usable for a corrected
		// manifest; this one means the root or the staging directory reached an
		// unknown state, and a second attempt would be a second lease.
		return wire.OpenResult{}, s.abandon(err)
	}
	s.plan = plan
	s.state = stateReady
	if len(plan.Files) == 0 {
		s.state = stateComplete
	}
	return wire.OpenResult{
		Files:       len(plan.Files),
		Directories: len(plan.Directories),
		LongPath:    s.mayExceedLegacyPathLimit(),
	}, nil
}

// mayExceedLegacyPathLimit reports whether any destination could exceed the
// legacy 260-character MAX_PATH.
//
// Creating it is fine — everything here is handle-relative, so MAX_PATH does not
// apply — but some Win32 applications still cannot open the result, so the host
// is told rather than left to discover it. This is advisory and never a refusal;
// the root's own length is unknown here, so only the relative part is measured.
func (s *Session) mayExceedLegacyPathLimit() bool {
	for _, f := range s.plan.Files {
		n := 0
		for _, seg := range f.Segments {
			n += len(seg) + 1
		}
		if n > 200 {
			return true
		}
	}
	return false
}

// BeginFile opens the staged object for index.
//
// Sequential order is required rather than arbitrary indices because interleaved
// files have no coherent definition of "declared length satisfied so far", and
// that counter is the only thing standing between a short transfer and a file
// reported as complete.
func (s *Session) BeginFile(index int) error {
	if s.state != stateReady {
		return wire.Errf(wire.CodeSequence, "begin in state "+s.state.String())
	}
	if index != s.nextIndex {
		return wire.Errf(wire.CodeSequence, fmt.Sprintf("expected index %d, got %d", s.nextIndex, index))
	}
	if index < 0 || index >= len(s.plan.Files) {
		return wire.Errf(wire.CodeSequence, "index out of range")
	}
	if err := s.sink.BeginFile(index); err != nil {
		// Terminal. A staged object may have been created before the failure and
		// this process no longer holds its handle, so a retry would either
		// collide with an object it cannot clean up or stage a second object for
		// the same index. Neither outcome is one the receipt could describe.
		return s.abandon(err)
	}
	s.state = stateWriting
	s.current = index
	s.written = 0
	return nil
}

// WriteChunk appends bounded bytes and accounts for what the OS actually took.
func (s *Session) WriteChunk(index int, p []byte) (wire.ChunkResult, error) {
	if s.state != stateWriting {
		return wire.ChunkResult{}, wire.Errf(wire.CodeSequence, "chunk in state "+s.state.String())
	}
	if index != s.current {
		return wire.ChunkResult{}, wire.Errf(wire.CodeSequence, "chunk for a file that is not open")
	}
	if len(p) > wire.MaxChunkBytes {
		return wire.ChunkResult{}, wire.Errf(wire.CodeProtocol, "chunk exceeds maximum")
	}
	declared := s.plan.Files[index].Size
	if s.written+int64(len(p)) > declared {
		return wire.ChunkResult{}, wire.Errf(wire.CodeLengthExceeded, "chunk would exceed declared length")
	}

	for off := 0; off < len(p); {
		n, err := s.sink.WriteChunk(index, p[off:])

		// The count is inspected BEFORE the error is acted on. A write that
		// fails may still have moved bytes, and that count is the only evidence
		// of how far the staged file advanced. Reporting a failed write as
		// having moved nothing is what made a retry able to append the same
		// bytes twice.
		if n < 0 || n > len(p)-off {
			// Not a short write. A count outside the range that was offered
			// means the sink is not describing its own behaviour, so the length
			// of the staged file is unknowable from here.
			return wire.ChunkResult{}, s.abandon(wire.Errf(wire.CodeShortWrite,
				fmt.Sprintf("sink reported %d of %d offered bytes", n, len(p)-off)))
		}
		off += n
		s.written += int64(n)

		if err != nil {
			// TERMINAL, and this is the load-bearing line.
			//
			// A failed write leaves the staged file at a length this process
			// cannot establish: the sink may have moved all, some or none of the
			// bytes, and no count it returns alongside an error is trustworthy
			// enough to resume from. Leaving the file writable would let the
			// host resend the same chunk, and the second attempt would append
			// rather than overwrite — the staged file ends up LONGER than
			// declared while `written` counts each byte once, so it satisfies
			// the exact-length check in FinishFile and publishes as complete.
			// Root's independent review demonstrated exactly that: two bytes
			// written, an error, a four-byte retry, six bytes on disk, published
			// as a complete four-byte file.
			//
			// The bytes already accounted for are kept because they are the
			// truthful record of what the sink claimed, and they are safe to
			// keep only because the session can never write or publish again.
			return wire.ChunkResult{}, s.abandon(err)
		}
		if n == 0 {
			// A write that moves nothing will never move anything; looping would
			// spin forever. It is also a broken sink rather than a short write:
			// io.Writer requires a non-nil error with a partial count, so zero
			// progress without an error means the file's length is no longer
			// something this process can vouch for either.
			return wire.ChunkResult{}, s.abandon(wire.Errf(wire.CodeShortWrite, "sink accepted zero bytes"))
		}
	}
	return wire.ChunkResult{Written: s.written, Declared: declared}, nil
}

// FinishFile requires the staged file to be exactly as long as declared, and
// reports the count this process actually accounted for.
//
// The count is echoed rather than assumed by the caller: it is the accumulation
// of what the sink reported taking, so a host comparing it against its own total
// is checking two independently derived numbers.
func (s *Session) FinishFile(index int) (wire.FinishResult, error) {
	if s.state != stateWriting {
		return wire.FinishResult{}, wire.Errf(wire.CodeSequence, "finish in state "+s.state.String())
	}
	if index != s.current {
		return wire.FinishResult{}, wire.Errf(wire.CodeSequence, "finish for a file that is not open")
	}
	declared := s.plan.Files[index].Size
	if s.written != declared {
		// Terminal for the session: the sender and this process disagree about
		// the transfer, and continuing would publish a file nobody can vouch for.
		s.state = stateTerminal
		return wire.FinishResult{}, wire.Errf(wire.CodeLengthShort, fmt.Sprintf("%d of %d bytes", s.written, declared))
	}
	if err := s.sink.FinishFile(index); err != nil {
		// Terminal. Finishing is where the staged bytes are made durable, so a
		// failure here means the file may be short or torn no matter how the
		// length accounting adds up. Retrying the flush until it succeeds would
		// publish a file whose contents this process never confirmed.
		return wire.FinishResult{}, s.abandon(err)
	}
	bytes := s.written
	s.current = -1
	s.nextIndex++
	if s.nextIndex == len(s.plan.Files) {
		s.state = stateComplete
	} else {
		s.state = stateReady
	}
	return wire.FinishResult{Bytes: bytes}, nil
}

// Publish moves every staged file to its destination, in manifest order,
// stopping at the first failure.
//
// The receipt is O(1) in the manifest size because publication is ordered and
// halts on failure, so the published set is always the prefix
// `0..PublishedCount-1`. That is what lets wire.MaxResponseBytes be enforced
// rather than hoped for.
//
// Completed outputs are kept. Rolling them back would destroy bytes the user
// already has in order to tidy up a conflict the receipt already reports.
func (s *Session) Publish() (wire.PublishResult, error) {
	if s.state != stateComplete {
		return wire.PublishResult{}, wire.Errf(wire.CodeSequence, "publish in state "+s.state.String())
	}
	// One terminal publisher: the state moves before the first rename, so a
	// second publish cannot find a complete session to act on.
	s.state = stateTerminal

	total := len(s.plan.Files)
	for i := 0; i < total; i++ {
		if err := s.sink.PublishOne(i); err != nil {
			result := wire.PublishResult{
				Status:         "partial",
				PublishedCount: s.published,
				Total:          total,
				Failed: &wire.PublishFailure{
					Index:  i,
					Code:   wire.CodeOf(err),
					Detail: wire.DetailOf(err),
				},
				Unattempted: &wire.Unattempted{From: i + 1, To: total - 1},
			}
			return result, wire.Errf(wire.CodePartialPublication, fmt.Sprintf("%d of %d published", s.published, total))
		}
		s.published++
	}
	return wire.PublishResult{Status: "complete", PublishedCount: s.published, Total: total}, nil
}

// Cleanup removes owned staged objects. Idempotent: every caller gets the same
// settled report rather than racing a second teardown.
func (s *Session) Cleanup() wire.CancelResult {
	if s.cleaned {
		return wire.CancelResult{RemovedFiles: s.residue.RemovedFiles, Residue: s.residue.Left}
	}
	s.cleaned = true
	s.state = stateTerminal
	residue, err := s.sink.Cleanup()
	if err != nil {
		residue.Left = true
	}
	s.residue = residue
	return wire.CancelResult{RemovedFiles: residue.RemovedFiles, Residue: residue.Left}
}

// PublishedCount is the number of destinations that exist because of this
// session. Used by the serve loop to report truthfully after a late failure.
func (s *Session) PublishedCount() int { return s.published }
