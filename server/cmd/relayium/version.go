package main

import (
	"fmt"
	"io"
)

// version is the CLI release version. goreleaser overrides it at build time via
// -ldflags "-X main.version=<tag>"; source builds report "dev".
var version = "dev"

func runVersion(stdout io.Writer) int {
	fmt.Fprintln(stdout, version)
	return 0
}
