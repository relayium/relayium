// One request, one process.
//
// ## Why there is no loop
//
// A resident secret service would hold plaintext across operations and would
// need a session model to bound it. This process reads one frame, answers it,
// and exits, so the longest a plaintext byte exists is one operation — and the
// buffers holding it are zeroed before the process ends rather than left to the
// allocator.
//
// ## What the parent owns
//
// The parent writes one frame, CLOSES stdin, and owns a deadline and a kill.
// This process guarantees it does bounded work on bounded input; it does not
// guarantee it can return if the parent never closes the pipe. That is the same
// division the file-IO helper settled on, for the same reason.
package secretserve

import (
	"errors"
	"fmt"
	"io"

	"github.com/relayium/relayium/apps/windows/native/internal/secretframe"
)

// Exit codes. Root fixed the mapping; this is the only place it is written.
const (
	ExitOK       = 0
	ExitProtocol = 2
	ExitRefused  = 3
	ExitInternal = 4
)

// ExitFor maps a response status to the process exit code.
func ExitFor(status byte) int {
	switch status {
	case secretframe.StatusOK:
		return ExitOK
	case secretframe.StatusProtocol:
		return ExitProtocol
	case secretframe.StatusRefused:
		return ExitRefused
	default:
		return ExitInternal
	}
}

// Protector is the platform half. The only production implementation is
// internal/secretprotect and it is Windows-only.
type Protector interface {
	// Seal protects plaintext. Implementations must not retain it.
	Seal(plaintext []byte) ([]byte, error)
	// Open unprotects and verifies. A failure is never partial output.
	Open(blob []byte) ([]byte, error)
}

type Options struct {
	In        io.Reader
	Out       io.Writer
	Log       io.Writer
	Protector Protector
}

// Serve handles one request and returns the process exit code.
func Serve(opts Options) int {
	status, payload := answer(opts)
	// The payload is framed and written, then wiped. It is either a blob or the
	// caller's own plaintext coming back out; neither is left in a live buffer.
	frame, err := secretframe.EncodeResponse(status, payload)
	secretframe.Zero(payload)
	if err != nil {
		logf(opts.Log, "encode")
		return ExitInternal
	}
	writeErr := writeAll(opts.Out, frame)
	secretframe.Zero(frame)
	if writeErr != nil {
		// The answer never reached the parent. Reported as internal rather than
		// as the operation's own status, which would claim a delivery that did
		// not happen.
		logf(opts.Log, "write")
		return ExitInternal
	}
	return ExitFor(status)
}

// answer produces the status and payload for one request.
//
// Diagnostics are closed reason words. Nothing derived from the request — no
// plaintext, no blob, no length, no op literal — reaches the log, because this
// process handles secrets and stderr is a crash surface that ships.
func answer(opts Options) (byte, []byte) {
	request, err := secretframe.ReadRequest(opts.In)
	if err != nil {
		switch {
		case errors.Is(err, secretframe.ErrTooLarge):
			logf(opts.Log, "oversize")
		case errors.Is(err, secretframe.ErrTrailing):
			logf(opts.Log, "trailing")
		default:
			logf(opts.Log, "protocol")
		}
		return secretframe.StatusProtocol, nil
	}

	var out []byte
	var opErr error
	switch request.Op {
	case secretframe.OpSeal:
		out, opErr = opts.Protector.Seal(request.Payload)
	case secretframe.OpOpen:
		out, opErr = opts.Protector.Open(request.Payload)
	default:
		// Unreachable: ReadRequest refuses an unknown op. Kept so the dispatcher
		// assumes nothing about its caller.
		logf(opts.Log, "protocol")
		return secretframe.StatusProtocol, nil
	}
	// The request payload has held plaintext (seal) or a blob (open); neither
	// needs to outlive the call.
	secretframe.Zero(request.Payload)

	if opErr != nil {
		// Every protector failure is REFUSED, with no distinction between a
		// wrong user, a tampered blob and a foreign blob. Reporting which one
		// would describe the protected bytes to a caller that could not
		// otherwise learn it, and this process cannot reliably tell them apart
		// anyway — CryptUnprotectData's own documentation says its failure codes
		// vary.
		secretframe.Zero(out)
		logf(opts.Log, "refused")
		return secretframe.StatusRefused, nil
	}

	bound, known := secretframe.ResponseBound(request.Op)
	if !known || len(out) > bound {
		secretframe.Zero(out)
		logf(opts.Log, "oversize")
		return secretframe.StatusInternal, nil
	}
	return secretframe.StatusOK, out
}

func writeAll(w io.Writer, buf []byte) error {
	for off := 0; off < len(buf); {
		n, err := w.Write(buf[off:])
		if err != nil {
			return err
		}
		if n <= 0 {
			return fmt.Errorf("secretserve: writer accepted no bytes")
		}
		off += n
	}
	return nil
}

func logf(w io.Writer, reason string) {
	if w == nil {
		return
	}
	// A closed set of words, written whole. There is no format argument, so
	// there is nothing a caller could interpolate.
	_, _ = io.WriteString(w, "secret-helper: "+reason+"\n")
}
