//go:build windows

// The fixed child executable Electron launches for one receive lease.
//
// ## Deliberately argument-free
//
// This program accepts NO command-line arguments. The destination root, the
// manifest and every byte arrive over stdin. Nothing that identifies a user, a
// device, a path or an account may appear in argv, where it would be visible to
// every process on the machine, nor in an environment variable inherited by
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
)

func main() {
	// An argument means the launcher is not the launcher this protocol
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
