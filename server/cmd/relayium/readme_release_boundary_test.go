package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── README vs. the installer ────────────────────────────────────────────────
//
// README.md is public the moment it lands on main, but the CLI a reader
// installs is the last published tag. This batch's direct-server safety and
// help changes are in the source and NOT in that tag, so the CLI section has to
// say which one it is describing. Without the note a reader runs `relayium
// serve` expecting a bind check and a live authorize reload that their binary
// does not have.
//
// This reads the file; it makes no network request and asks GitHub nothing. The
// marker is what the release PR deletes.
const readmeReleaseBoundaryMarker = "CLI-RELEASE-BOUNDARY"

func readRepoREADME(t *testing.T) string {
	t.Helper()
	// server/cmd/relayium → repo root.
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "README.md"))
	if err != nil {
		t.Fatalf("reading README.md: %v", err)
	}
	return string(raw)
}

func TestREADMEMarksTheSourceVsInstallerBoundary(t *testing.T) {
	readme := readRepoREADME(t)

	idx := strings.Index(readme, readmeReleaseBoundaryMarker)
	if idx < 0 {
		t.Fatalf("README.md has no %s block. While the CLI section documents behavior that is not in "+
			"the published tag, it must say so; delete this test in the same commit that deletes the "+
			"block, once a release makes the section true again.", readmeReleaseBoundaryMarker)
	}

	// The note must be in the CLI section, not buried at the bottom.
	cli := strings.Index(readme, "## Command-line client (CLI)")
	if cli < 0 {
		t.Fatal("README.md has no CLI section heading")
	}
	if idx < cli {
		t.Errorf("the %s block is above the CLI section", readmeReleaseBoundaryMarker)
	}
	if next := strings.Index(readme[cli+1:], "\n## "); next >= 0 && idx > cli+1+next {
		t.Errorf("the %s block is outside the CLI section it qualifies", readmeReleaseBoundaryMarker)
	}

	block := readme[idx:min(idx+1400, len(readme))]
	for _, n := range []string{
		"v0.23.0",                    // the version a reader actually gets
		"latest published CLI relea", // said as a fact about the release, not the source
		"not in v0.23.0",             // and the boundary stated plainly
		"relayium version",           // how to check which one they have
	} {
		if !strings.Contains(block, n) {
			t.Errorf("the %s block omits %q:\n%s", readmeReleaseBoundaryMarker, n, block)
		}
	}

	// The unreleased version must not be announced anywhere in the README: a
	// version number in public copy is read as "go install it".
	for _, claimed := range []string{"v0.24.0", "0.24.0"} {
		if strings.Contains(readme, claimed) {
			t.Errorf("README.md names %q; no such CLI release exists yet", claimed)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
