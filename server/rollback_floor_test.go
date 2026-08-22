package main

// The guards for server/ROLLBACK-FLOOR: the record that names the oldest server
// binary a current database must still run.
//
// Two things are checked here, and they are deliberately separate tests.
//
//  1. PARSING. The record's whole job is to be unambiguous, so the reader
//     refuses everything that is not exactly one `commit <40 lowercase hex>`
//     line. There is no default, no "first line wins" and no case folding: a
//     malformed floor must fail the build rather than silently become some
//     other commit. This test needs nothing but the file.
//
//  2. REACHABILITY. A syntactically perfect floor naming an object this
//     repository does not have — or one that is not an ancestor of HEAD, or one
//     with no server/ tree — cannot be built, so the rollback harness could
//     never run against it. This test shells out to the LOCAL git repository
//     and never touches the network.
//
// Reachability is skipped, not failed, when the objects are absent: `go test
// ./...` runs in CI under a depth-1 checkout, which by construction does not
// contain an ancestor commit, and a unit test that goes red on a shallow clone
// teaches everyone to ignore it. RELAYIUM_ROLLBACK_FLOOR_STRICT=1 turns every
// skip into a failure, and the rollback job in .github/workflows/go.yml sets it
// alongside fetch-depth: 0 — so the check is genuinely enforced in exactly the
// one place that has the objects to enforce it with.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const rollbackFloorFile = "ROLLBACK-FLOOR"

// rollbackFloorStrictEnv turns this file's skips into failures. Set by the CI
// job that checks out full history for exactly that purpose.
const rollbackFloorStrictEnv = "RELAYIUM_ROLLBACK_FLOOR_STRICT"

// rollbackFloorCommitLine is anchored on both ends and admits no leading or
// trailing whitespace. `(?m)` is deliberately NOT used: the reader splits lines
// itself so it can count them, and a multi-line match would let a second commit
// hide behind the first.
var rollbackFloorCommitLine = regexp.MustCompile(`^commit ([0-9a-f]{40})$`)

var errNoRollbackFloor = errors.New("rollback floor: no `commit <sha>` line")

// parseRollbackFloor returns the single floor commit named by the record.
//
// Every failure is an error and none of them is recoverable by guessing. In
// particular an EMPTY file is an error rather than "no floor configured": a
// truncated record must not read as permission to skip the rollback gate.
//
// scripts/test/db-rollback-harness.sh implements the same rule independently in
// shell. That duplication is intentional — the harness must be able to reject a
// bad floor before it spends two builds on it, and two readers that disagree
// are caught by the harness and this test both running in the same CI job.
func parseRollbackFloor(data []byte) (string, error) {
	if len(data) == 0 {
		return "", fmt.Errorf("rollback floor: empty record")
	}
	// A CR that survived a Windows checkout would otherwise defeat the `$`
	// anchor and read as "no commit line", which is a confusing way to report a
	// line-ending problem. Rejecting it by name is clearer than tolerating it:
	// this file is compared byte for byte by the harness too.
	if strings.ContainsRune(string(data), '\r') {
		return "", fmt.Errorf("rollback floor: CR in record; the file must use LF line endings")
	}
	found := ""
	for i, line := range strings.Split(string(data), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		m := rollbackFloorCommitLine.FindStringSubmatch(line)
		if m == nil {
			return "", fmt.Errorf("rollback floor: line %d is neither a comment nor `commit <40 lowercase hex>`: %q", i+1, line)
		}
		if found != "" {
			return "", fmt.Errorf("rollback floor: line %d is a second commit line (%s and %s); the floor is exactly one commit", i+1, found, m[1])
		}
		found = m[1]
	}
	if found == "" {
		return "", errNoRollbackFloor
	}
	return found, nil
}

func TestParseRollbackFloorFailsClosed(t *testing.T) {
	// Each case is a record somebody could plausibly write or a corruption a
	// tool could plausibly introduce. None of them may produce a commit: the
	// point of the record is that an unreadable floor stops the gate rather
	// than quietly lowering it.
	cases := []struct {
		name string
		in   string
	}{
		{"empty", ""},
		{"only comments", "# nothing here\n# still nothing\n"},
		{"only blank lines", "\n\n\n"},
		{"missing keyword", "7b3c6f4973e19ade7cd7bfa1699c745b60accf86\n"},
		{"wrong keyword", "sha 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\n"},
		{"uppercase hex", "commit 7B3C6F4973E19ADE7CD7BFA1699C745B60ACCF86\n"},
		{"abbreviated sha", "commit 7b3c6f49\n"},
		{"one digit short", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf8\n"},
		{"one digit long", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf861\n"},
		{"non-hex digit", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accfzz\n"},
		{"leading space", " commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\n"},
		{"trailing space", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86 \n"},
		{"tab separator", "commit\t7b3c6f4973e19ade7cd7bfa1699c745b60accf86\n"},
		{"two spaces", "commit  7b3c6f4973e19ade7cd7bfa1699c745b60accf86\n"},
		{"trailing junk", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86 # production\n"},
		{"two commits", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\ncommit 0000000000000000000000000000000000000000\n"},
		{"same commit twice", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\ncommit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\n"},
		{"unknown key alongside", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\nbranch main\n"},
		{"indented comment", "  # an indented comment is not a comment here\ncommit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\n"},
		{"CRLF", "commit 7b3c6f4973e19ade7cd7bfa1699c745b60accf86\r\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseRollbackFloor([]byte(tc.in))
			if err == nil {
				t.Fatalf("parseRollbackFloor(%q) = %q, want an error — an unreadable floor must "+
					"stop the rollback gate, never lower it", tc.in, got)
			}
			if got != "" {
				t.Fatalf("parseRollbackFloor(%q) returned commit %q alongside error %v; a failed "+
					"parse must yield no commit at all", tc.in, got, err)
			}
		})
	}
}

func TestParseRollbackFloorAcceptsTheRecordShape(t *testing.T) {
	const want = "7b3c6f4973e19ade7cd7bfa1699c745b60accf86"
	cases := []struct {
		name string
		in   string
	}{
		{"bare", "commit " + want + "\n"},
		{"no trailing newline", "commit " + want},
		{"comments above and below", "# why\ncommit " + want + "\n# more\n"},
		{"blank lines around", "\n\ncommit " + want + "\n\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseRollbackFloor([]byte(tc.in))
			if err != nil {
				t.Fatalf("parseRollbackFloor(%q) failed: %v", tc.in, err)
			}
			if got != want {
				t.Fatalf("parseRollbackFloor(%q) = %q, want %q", tc.in, got, want)
			}
		})
	}
}

func TestRollbackFloorRecordIsReadable(t *testing.T) {
	data, err := os.ReadFile(rollbackFloorFile)
	if err != nil {
		t.Fatalf("read %s: %v", rollbackFloorFile, err)
	}
	commit, err := parseRollbackFloor(data)
	if err != nil {
		t.Fatalf("%s does not parse: %v", rollbackFloorFile, err)
	}
	t.Logf("rollback floor commit: %s", commit)
}

// rollbackFloorSkip reports a reachability check that could not run. It is a
// skip locally and on a shallow CI checkout, and a failure under
// RELAYIUM_ROLLBACK_FLOOR_STRICT=1 — the CI job that fetches full history.
func rollbackFloorSkip(t *testing.T, format string, args ...any) {
	t.Helper()
	msg := fmt.Sprintf(format, args...)
	if os.Getenv(rollbackFloorStrictEnv) == "1" {
		t.Fatalf("%s (%s=1, so this is a failure: the job that sets it fetches full history "+
			"precisely so this check can run)", msg, rollbackFloorStrictEnv)
	}
	t.Skipf("%s (set %s=1 to make this a failure)", msg, rollbackFloorStrictEnv)
}

// gitInRepo runs a read-only git command against this repository. Every caller
// below is a local object query: nothing here fetches, and nothing here needs a
// network.
func gitInRepo(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("git", args...)
	// Run from the module directory rather than a discovered root: `go test`
	// already sets it, and it keeps the command inside the tree under test.
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func TestRollbackFloorIsReachableAndBuildable(t *testing.T) {
	data, err := os.ReadFile(rollbackFloorFile)
	if err != nil {
		t.Fatalf("read %s: %v", rollbackFloorFile, err)
	}
	floor, err := parseRollbackFloor(data)
	if err != nil {
		t.Fatalf("%s does not parse: %v", rollbackFloorFile, err)
	}

	if _, err := exec.LookPath("git"); err != nil {
		rollbackFloorSkip(t, "git is not on PATH, so the floor's objects cannot be inspected")
		return
	}
	if out, err := gitInRepo(t, "rev-parse", "--is-inside-work-tree"); err != nil || out != "true" {
		rollbackFloorSkip(t, "not inside a git work tree (%q, %v)", out, err)
		return
	}
	if out, _ := gitInRepo(t, "rev-parse", "--is-shallow-repository"); out == "true" {
		rollbackFloorSkip(t, "shallow clone: an ancestor commit's objects are absent by construction")
		return
	}
	if _, err := gitInRepo(t, "cat-file", "-e", floor); err != nil {
		rollbackFloorSkip(t, "floor object %s is not present locally", floor)
		return
	}

	// From here on the objects exist, so every remaining failure is a real
	// defect in the record rather than a property of the checkout.
	typ, err := gitInRepo(t, "cat-file", "-t", floor)
	if err != nil {
		t.Fatalf("git cat-file -t %s: %v (%s)", floor, err, typ)
	}
	if typ != "commit" {
		t.Fatalf("floor %s is a %s, not a commit. A tag or tree cannot be checked out and built as "+
			"the binary an operator rolls back to", floor, typ)
	}

	if _, err := gitInRepo(t, "merge-base", "--is-ancestor", floor, "HEAD"); err != nil {
		t.Fatalf("floor %s is not an ancestor of HEAD. A floor off this history is not a rollback "+
			"target: the database under test was never written by anything that descends from it", floor)
	}

	// A commit whose server/ tree cannot be built is a floor the harness can
	// never produce a binary from, which would turn the rollback gate into a
	// build error nobody can act on. Checking one required file is enough to
	// catch the realistic mistake (a floor from before the server existed, or
	// from an unrelated subtree) without paying for a build here.
	for _, want := range []string{"server/main.go", "server/go.mod", "server/account/sqlite.go"} {
		if _, err := gitInRepo(t, "cat-file", "-e", floor+":"+want); err != nil {
			t.Fatalf("floor %s has no %s, so scripts/test/db-rollback-harness.sh could not build a "+
				"server binary from it", floor, want)
		}
	}

	behind, err := gitInRepo(t, "rev-list", "--count", floor+"..HEAD")
	if err != nil {
		t.Fatalf("git rev-list: %v (%s)", err, behind)
	}
	t.Logf("rollback floor %s is %s commits behind HEAD", floor, behind)
}

// TestRollbackFloorIsTheHarnessesOnlySourceOfTruth stops the record and the
// harness from drifting apart in the one way that is invisible: the harness
// growing its own hard-coded commit. If that happened, editing ROLLBACK-FLOOR
// would change nothing, the gate would keep passing against a commit nobody
// chose, and every other check in this file would still be green.
func TestRollbackFloorIsTheHarnessesOnlySourceOfTruth(t *testing.T) {
	const harness = "../scripts/test/db-rollback-harness.sh"
	data, err := os.ReadFile(harness)
	if err != nil {
		if os.IsNotExist(err) {
			// The server module is occasionally built from a subtree export
			// that carries no scripts/. Nothing to check, and nothing broken.
			t.Skipf("%s is absent from this checkout", filepath.Clean(harness))
		}
		t.Fatalf("read %s: %v", harness, err)
	}
	text := string(data)
	if !strings.Contains(text, rollbackFloorFile) {
		t.Fatalf("%s never mentions %s, so the floor record no longer decides which binary the "+
			"rollback gate builds", harness, rollbackFloorFile)
	}
	// Any 40-hex run in the harness is a commit-shaped literal. There must be
	// none: the harness reads the one in the record instead.
	if m := regexp.MustCompile(`\b[0-9a-f]{40}\b`).FindString(text); m != "" {
		t.Fatalf("%s contains the commit-shaped literal %s. The floor must come from %s alone, or "+
			"the record stops being the thing that chooses the rollback target", harness, m, rollbackFloorFile)
	}
}
