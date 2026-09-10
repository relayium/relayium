// The request loop: strictly sequential, bounded, and platform-free.
//
// Everything that touches Windows lives behind `Custody`, so this file — the
// admission, the ordering, the refusals — is testable on any host. The Windows
// implementation is in `custody_windows.go` and is the only thing that cannot be.
//
// ## One request at a time, and no read-ahead
//
// The loop reads a frame, answers it, then reads the next. Nothing is queued and
// nothing is buffered beyond the frame being handled, so a client that pipelines
// simply blocks on the pipe once the OS buffer fills — there is no queue here to
// overflow and no reply to reorder. `custody.write` is the one two-frame request,
// and its payload frame must arrive IMMEDIATELY after its header.
//
// ## The scope is captured once
//
// `scope.open` may be sent exactly once per session. A second one is refused
// rather than replacing the held scope: the handles a later request acts through
// must be the ones its authority was established against.
package updio

import (
	"errors"
	"io"
)

// Custody is everything the platform provides. One session holds one scope.
type Custody interface {
	// Open captures the app-owned root and the staging component beneath it.
	Open(root, component string) error
	// CreateExclusive returns a handle id and the created object's identity.
	CreateExclusive(name string) (handle uint32, receipt string, err error)
	Write(handle uint32, chunk []byte) error
	Sync(handle uint32) error
	// Release closes the OS handle WITHOUT deleting: the object stays and its
	// receipt stays valid, so the host can still remove it later by name and
	// receipt. Distinct from Discard, which is the deletion.
	Release(handle uint32) error
	// Commit publishes the handle's file as `to`, through that same handle.
	Commit(handle uint32, to string) error
	// Discard deletes the handle's object if it is still that object.
	Discard(handle uint32) (gone bool, err error)
	// Identity reports what is at `name` now; present=false means nothing is.
	Identity(name string) (receipt string, present bool, err error)
	// Remove deletes `name` only while it is still `receipt`.
	Remove(name, receipt string) (gone bool, err error)
	// ReadBounded reads `name` whole, refusing anything over max BEFORE reading
	// it. `present` false means nothing is there; an oversized or unreadable
	// file is an error, never an absence.
	ReadBounded(name string, max int) (content []byte, present bool, err error)
	// HashOwned digests `name` while it is still `receipt` and `size` long.
	HashOwned(name, receipt string, size int64) (sha256 string, present bool, err error)
	// VerifyInstaller verifies size, digest and Authenticode through a held
	// handle and RETURNS. It never creates a process.
	VerifyInstaller(name, receipt, sha256, publisher string, size int64) (verdict string, err error)
	// RunInstaller does everything VerifyInstaller does and then launches the
	// still-held file.
	RunInstaller(name, receipt, sha256, publisher string, size int64) (verdict string, err error)
	// Close releases every handle this session holds.
	Close() error
}

// Fault is an error carrying one closed-set code.
type Fault struct{ Code string }

func (f *Fault) Error() string { return "updio: " + f.Code }

// Errf builds a Fault.
func Errf(code string) error { return &Fault{Code: code} }

// IsCode reports whether err is a Fault carrying exactly this code.
func IsCode(err error, code string) bool {
	var fault *Fault
	return errors.As(err, &fault) && fault.Code == code
}

func codeOf(err error) string {
	var fault *Fault
	if errors.As(err, &fault) {
		return fault.Code
	}
	// An unrecognised error becomes `io` rather than leaking its text.
	return CodeIO
}

// MaxOpenHandles bounds what one session may hold at once.
//
// The host holds a staged artifact and a journal temp; four leaves room for a
// retry overlapping a commit and nothing more. Repeated downloads and repeated
// journal writes therefore cannot accumulate handles: each must be released
// before another is issued.
const MaxOpenHandles = 4

type session struct {
	opened  bool
	handles map[uint32]struct{}
}

// Serve runs the session until the peer closes or a protocol error ends it.
//
// A protocol error is terminal: a stream whose framing is not understood cannot
// be resynchronised, and continuing would answer requests that were never sent.
//
// Every exit — clean close, protocol error, cancelled read — runs the custody's
// own Close, which releases every handle the session still holds.
func Serve(in io.Reader, out io.Writer, custody Custody) error {
	defer func() { _ = custody.Close() }()
	state := &session{handles: map[uint32]struct{}{}}
	for {
		kind, payload, err := ReadFrame(in, MaxControlBytes)
		if err != nil {
			if errors.Is(err, ErrClosed) {
				return nil
			}
			return err
		}
		if kind != KindJSON {
			return Errf(CodeProtocol)
		}
		req, err := decodeRequest(payload)
		if err != nil {
			_ = WriteJSON(out, fail(CodeProtocol))
			return err
		}
		reply, payload, fatal := dispatch(in, custody, req, state)
		if err := WriteJSON(out, reply); err != nil {
			return err
		}
		// The payload frame follows its control frame immediately, so the host
		// never has to guess whether one is coming: `Bytes` says.
		if payload != nil {
			if err := WriteFrame(out, KindBytes, payload); err != nil {
				return err
			}
		}
		if fatal != nil {
			return fatal
		}
	}
}
