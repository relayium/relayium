//go:build windows

// The fixed child executable Electron launches, in one of two modes.
//
// ## Exactly one argument, and it selects a mode
//
// This program accepts NO argument except the fixed literal `--source-mode`.
// With no argument it serves one receive lease, exactly as before. With that one
// literal it serves read-only source reads instead. Anything else is refused
// loudly rather than ignored.
//
// The mode is an argument rather than a frame because the two protocols must not
// be reachable from one another: a helper started for reading can never be
// talked into writing, whatever arrives on stdin, because the receive dispatcher
// is not constructed at all.
//
// Nothing else may appear in argv. The destination root, the manifest, every
// byte and every SOURCE PATH arrive over stdin. Nothing that identifies a user,
// a device, a path or an account may appear in argv, where it would be visible
// to every process on the machine, nor in an environment variable inherited by
// children.
//
// It opens no socket and listens on no port. The only channels are the three
// standard handles it inherits.
//
// stderr carries codes and indices only. Never a path, never a filename.
package main

import (
	"fmt"
	"os"

	"github.com/relayium/relayium/apps/windows/native/internal/serve"
	"github.com/relayium/relayium/apps/windows/native/internal/sourceserve"
	"github.com/relayium/relayium/apps/windows/native/internal/winio"
)

// SourceModeArg is the one literal this program accepts. It is fixed, carries no
// value, and is compared exactly: a prefix match would let `--source-mode=...`
// smuggle a payload into argv.
const SourceModeArg = "--source-mode"

// sourceOpener adapts the Windows walker to the transport loop.
//
// The adapter lives here, in the only file that is already Windows-only and
// already wires a dispatcher, so `sourceserve` stays platform-independent and
// its protocol and ownership accounting remain testable off Windows.
type sourceOpener struct{}

func (sourceOpener) Open(path string) (sourceserve.Source, error) {
	// The error return is taken FIRST and returns a nil interface. Returning the
	// concrete pointer alongside an error would hand the caller a non-nil
	// interface holding a nil pointer, which reads as success.
	src, err := winio.OpenSource(path)
	if err != nil {
		return nil, err
	}
	return src, nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == SourceModeArg {
		os.Exit(sourceserve.Serve(sourceserve.Options{
			In:        os.Stdin,
			Out:       os.Stdout,
			Log:       os.Stderr,
			Opener:    sourceOpener{},
			ForceExit: os.Exit,
		}))
	}
	// Any other argument means the launcher is not the launcher either protocol
	// describes, which is worth refusing loudly rather than ignoring.
	if len(os.Args) > 1 {
		fmt.Fprintln(os.Stderr, "E_PROTOCOL unexpected arguments")
		os.Exit(serve.ExitProtocol)
	}
	// ForceExit is passed explicitly even though serve defaults it, so the
	// shutdown bound is visible at the one place that ships.
	os.Exit(serve.Serve(serve.Options{
		In:        os.Stdin,
		Out:       os.Stdout,
		Log:       os.Stderr,
		Sink:      newSink(),
		ForceExit: os.Exit,
	}))
}
