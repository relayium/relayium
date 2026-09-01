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
// The transitional truth this pins, for as long as the block exists:
//
//	v0.23.0 is published and installable; v0.24.0 is intended and pending;
//	`relayium version` is the arbiter, not this README.
//
// So the pending number is allowed here — but only inside the marked block,
// where it is framed as pending. Loose anywhere else in the README, a version
// number reads as "go install it", which is exactly the claim that is false
// until publication finishes.
//
// This reads the file; it makes no network request and asks GitHub nothing. The
// marker is what the immediate post-publication cleanup PR deletes, together
// with this test file, once auto-release has published the tag.
const readmeReleaseBoundaryMarker = "CLI-RELEASE-BOUNDARY"

// pendingCLIVersion is the release the block is allowed to name as pending. The
// bare form also matches the `v`-prefixed one.
const pendingCLIVersion = "0.24.0"

func readRepoREADME(t *testing.T) string {
	t.Helper()
	// server/cmd/relayium → repo root.
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "README.md"))
	if err != nil {
		t.Fatalf("reading README.md: %v", err)
	}
	return string(raw)
}

// releaseBoundaryBlock returns the half-open bounds of the marked block: the
// whole marker comment line through the blockquote under it, ending at the
// first blank line. Deleting exactly that range is what the post-publication
// cleanup PR does.
func releaseBoundaryBlock(readme string) (start, end int, ok bool) {
	start = strings.Index(readme, readmeReleaseBoundaryMarker)
	if start < 0 {
		return 0, 0, false
	}
	if nl := strings.LastIndex(readme[:start], "\n"); nl >= 0 {
		start = nl + 1 // include the `<!--` opening the marker comment
	} else {
		start = 0
	}
	end = len(readme)
	if blank := strings.Index(readme[start:], "\n\n"); blank >= 0 {
		end = start + blank
	}
	return start, end, true
}

func TestREADMEMarksTheSourceVsInstallerBoundary(t *testing.T) {
	readme := readRepoREADME(t)

	start, end, ok := releaseBoundaryBlock(readme)
	if !ok {
		t.Fatalf("README.md has no %s block. While the CLI section documents behavior that is not in "+
			"the published tag, it must say so; delete this test file in the same commit that deletes "+
			"the block, once publishing v%s makes the section true again.",
			readmeReleaseBoundaryMarker, pendingCLIVersion)
	}

	// The note must be in the CLI section, not buried at the bottom.
	cli := strings.Index(readme, "## Command-line client (CLI)")
	if cli < 0 {
		t.Fatal("README.md has no CLI section heading")
	}
	if start < cli {
		t.Errorf("the %s block is above the CLI section", readmeReleaseBoundaryMarker)
	}
	if next := strings.Index(readme[cli+1:], "\n## "); next >= 0 && start > cli+1+next {
		t.Errorf("the %s block is outside the CLI section it qualifies", readmeReleaseBoundaryMarker)
	}

	// Each anchor pins one clause of the transitional truth, in order: the
	// version a reader actually gets; that this is a fact about the published
	// release rather than about the source; that it stays the installable one
	// until publication finishes; the boundary stated plainly; the pending tag
	// named as pending and never as available; how to check what you have; and
	// the answer to wait for before trusting the section.
	block := readme[start:end]
	for _, n := range []string{
		"v0.23.0",
		"latest published CLI relea",
		"latest installable",
		"not in v0.23.0",
		"v0.24.0 is the intended pending release",
		"relayium version",
		"until it reports **" + pendingCLIVersion,
	} {
		if !strings.Contains(block, n) {
			t.Errorf("the %s block omits %q:\n%s", readmeReleaseBoundaryMarker, n, block)
		}
	}

	// The block must keep saying it is temporary, so publishing removes it
	// rather than inheriting a permanently stale caveat.
	if !strings.Contains(block, "remove this whole block") {
		t.Errorf("the %s marker no longer tells the post-publication cleanup PR to remove the block:\n%s",
			readmeReleaseBoundaryMarker, block)
	}

	// The pending version is confined to the block. Elsewhere in the README it
	// would announce a release that nobody can install yet.
	for off := 0; ; {
		i := strings.Index(readme[off:], pendingCLIVersion)
		if i < 0 {
			break
		}
		at := off + i
		if at < start || at >= end {
			t.Errorf("README.md names %q at offset %d, outside the %s block; no such CLI release is "+
				"published yet:\n%s", pendingCLIVersion, at,
				readmeReleaseBoundaryMarker, readme[at:min(at+200, len(readme))])
		}
		off = at + len(pendingCLIVersion)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
