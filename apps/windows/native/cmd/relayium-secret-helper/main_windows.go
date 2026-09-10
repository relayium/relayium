//go:build windows

// The fixed child executable that seals and opens one secret.
//
// ## Deliberately argument-free
//
// This program accepts NO command-line arguments. The operation and its payload
// arrive over stdin. Nothing identifying may appear in argv, where every process
// on the machine can read it, nor in an environment variable inherited by
// children.
//
// It opens no file, listens on no port, and reads no environment variable. The
// only channels are the three standard handles it inherits.
//
// stderr carries a closed set of reason words. Never plaintext, never a blob,
// never a length, never a path.
package main

import (
	"fmt"
	"os"

	"github.com/relayium/relayium/apps/windows/native/internal/secretprotect"
	"github.com/relayium/relayium/apps/windows/native/internal/secretserve"
)

func main() {
	// An argument means the launcher is not the launcher this protocol
	// describes, which is worth refusing loudly rather than ignoring.
	if len(os.Args) > 1 {
		fmt.Fprintln(os.Stderr, "secret-helper: arguments")
		os.Exit(secretserve.ExitProtocol)
	}
	os.Exit(secretserve.Serve(secretserve.Options{
		In:        os.Stdin,
		Out:       os.Stdout,
		Log:       os.Stderr,
		Protector: secretprotect.New(),
	}))
}
