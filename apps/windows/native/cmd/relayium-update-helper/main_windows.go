//go:build windows

// The fixed child executable that owns update staging.
//
// ## Deliberately argument-free
//
// This program accepts NO command-line arguments. The operation and its operands
// arrive over stdin. Nothing identifying may appear in argv, where every process
// on the machine can read it, nor in an environment variable inherited by
// children.
//
// It opens no port and reads no environment variable. The only channels are the
// three standard handles it inherits, and the only directory it will ever touch
// is the one the first `scope.open` names.
//
// stderr carries nothing. A helper that narrates what it saw is a helper that
// leaks what it saw; every diagnosis the host is allowed to have is a closed-set
// code in the reply.
package main

import (
	"os"

	"github.com/relayium/relayium/apps/windows/native/internal/updio"
)

func main() {
	// An argument means the launcher is not the launcher this protocol
	// describes, which is worth refusing loudly rather than ignoring.
	if len(os.Args) > 1 {
		os.Exit(2)
	}
	custody := updio.NewWindowsCustody()
	if err := updio.Serve(os.Stdin, os.Stdout, custody); err != nil {
		// The session ended on a protocol fault. The exit code is the whole
		// report; the reason stays inside.
		os.Exit(1)
	}
}
