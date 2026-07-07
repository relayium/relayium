// Command relayium is the Relayium CLI. Phase 1 provides SSH-native push/pull
// to servers the user already has SSH access to; bytes travel over that SSH
// connection and never touch Relayium infrastructure.
package main

import (
	"os"
)

func main() {
	os.Exit(Run(os.Args[1:], os.Stdout, os.Stderr))
}
