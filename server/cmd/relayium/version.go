package main

import (
	"fmt"
	"io"

	"github.com/relayium/relayium/internal/cloud"
)

// version is the CLI release version. goreleaser overrides it at build time via
// -ldflags "-X main.version=<tag>"; source builds report "dev".
var version = "dev"

// The cloud client sends this version (plus OS/architecture) as its User-Agent,
// so the browser approval page can describe what is asking for account access.
// Done in init rather than in Run so every path that reaches the network —
// including a test that calls a cloud helper directly — carries it.
func init() { cloud.SetClientVersion(version) }

func runVersion(stdout io.Writer) int {
	fmt.Fprintln(stdout, version)
	return 0
}
