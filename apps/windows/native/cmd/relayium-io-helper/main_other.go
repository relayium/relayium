//go:build !windows

// The helper is a Windows executable. This stub exists so the module builds on a
// development machine without pretending the program is portable: it refuses to
// run rather than offering a degraded implementation whose green result would
// mean nothing.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "relayium-io-helper is a Windows-only executable")
	os.Exit(4)
}
