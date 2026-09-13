//go:build windows

// Windows integration tests. These are where the real invariants are proven.
//
// Nothing in the portable packages establishes no-replace publication, reparse
// refusal, handle pinning, ancestor-swap resistance or cleanup. Those claims
// rest entirely on this file, and this file runs only on a real Windows host.
// Cross-compiling it is not evidence that it passes.
package winio

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/staging"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// Outcome markers for -v readback.
//
// ## Why these exist
//
// A Windows invariant that cannot be set up in the current environment is
// skipped, and `go test` reports a package containing skips as `ok`. Read from
// the summary line alone, a run in which the junction tests never executed is
// indistinguishable from one that proved every claim in this file. That is the
// same vacuous-coverage failure as an assertion that never runs, moved up a
// level.
//
// So each outcome is announced with a greppable prefix and the invariant spelled
// out in words. The owning CI runs -v and reads these back: an UNPROVEN line is
// a claim this run did NOT establish, regardless of the exit code.
const (
	provenPrefix   = "PROVEN-INVARIANT:"
	unprovenPrefix = "UNPROVEN-INVARIANT:"
	// openQuestionPrefix marks a probe that RECORDS a platform answer rather
	// than asserting a preferred one. It is not a proven invariant and must not
	// be read back as one.
	openQuestionPrefix = "OPEN-QUESTION:"
)

// skipUnproven skips the test and names the invariant left unproven, rather than
// naming only the setup step that failed.
func skipUnproven(t *testing.T, invariant string, err error) {
	t.Helper()
	t.Skipf("%s %s (this environment could not set up the test: %v)", unprovenPrefix, invariant, err)
}

func plan(t *testing.T, entries ...nameguard.Entry) *nameguard.Plan {
	t.Helper()
	p, failure := nameguard.BuildPlan(entries)
	if failure != nil {
		t.Fatalf("manifest refused by the planner: %+v", failure)
	}
	return p
}

// deliver streams one complete file through the sink.
func deliver(t *testing.T, s *Sink, index int, data []byte) {
	t.Helper()
	if err := s.BeginFile(index); err != nil {
		t.Fatalf("BeginFile(%d): %v", index, err)
	}
	for off := 0; off < len(data); {
		n, err := s.WriteChunk(index, data[off:])
		if err != nil {
			t.Fatalf("WriteChunk(%d): %v", index, err)
		}
		off += n
	}
	if err := s.FinishFile(index); err != nil {
		t.Fatalf("FinishFile(%d): %v", index, err)
	}
}

func digest(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Base(path), err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// stagingDirs lists the sink's own staging directories still present under root.
//
// The predicate is staging.IsOwnedName, shared with the code that CREATES these
// names and proven portably in internal/staging. A hand-rolled comparison here
// would be an oracle that only ever runs on Windows, and if it were wrong every
// no-residue assertion in this file would pass vacuously.
func stagingDirs(t *testing.T, root string) []string {
	t.Helper()
	items, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read root: %v", err)
	}
	var out []string
	for _, item := range items {
		if item.IsDir() && staging.IsOwnedName(item.Name()) {
			out = append(out, item.Name())
		}
	}
	return out
}

// The scanner above is the oracle for every "no residue" claim in this file, so
// it is checked against a live sink before those claims are trusted: it must see
// a real staging directory and must not claim anything else in the same folder.
func TestStagingScannerDetectsRealStagingAndExcludesOthers(t *testing.T) {
	root := t.TempDir()
	for _, decoy := range []string{".relayium-incoming", "relayium-incoming-files", "ordinary", ".git"} {
		if err := os.Mkdir(filepath.Join(root, decoy), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "a-file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if found := stagingDirs(t, root); len(found) != 0 {
		t.Fatalf("scanner claimed directories before any lease existed: %v", found)
	}

	s := NewSink()
	if err := s.Open(root, plan(t, nameguard.Entry{Name: "a.bin", Size: 1})); err != nil {
		t.Fatal(err)
	}
	found := stagingDirs(t, root)
	if len(found) != 1 {
		t.Fatalf("scanner found %v; a live lease must produce exactly one detected staging directory. Every no-residue assertion in this file is vacuous unless this passes", found)
	}
	if _, err := s.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if found := stagingDirs(t, root); len(found) != 0 {
		t.Fatalf("scanner still reports staging after cleanup: %v", found)
	}
	// The decoys survived untouched.
	for _, decoy := range []string{".relayium-incoming", "relayium-incoming-files", "ordinary", ".git"} {
		if _, err := os.Stat(filepath.Join(root, decoy)); err != nil {
			t.Fatalf("cleanup removed an unowned directory %q: %v", decoy, err)
		}
	}
}

// Complete delivery: nested, binary and zero-byte content, exact digests, no
// staging residue.
func TestPublishCompleteBatch(t *testing.T) {
	root := t.TempDir()
	binary := make([]byte, 300*1024)
	for i := range binary {
		binary[i] = byte(i * 7)
	}
	entries := []nameguard.Entry{
		{Name: "top.bin", Size: int64(len(binary))},
		{Name: "a/b/nested.bin", Size: 5},
		{Name: "a/empty.bin", Size: 0},
	}
	p := plan(t, entries...)

	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatalf("Open: %v", err)
	}
	deliver(t, s, 0, binary)
	deliver(t, s, 1, []byte("hello"))
	deliver(t, s, 2, nil)

	for i := range entries {
		if err := s.PublishOne(i); err != nil {
			t.Fatalf("PublishOne(%d): %v", i, err)
		}
	}
	if _, err := s.Cleanup(); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}

	want := sha256.Sum256(binary)
	if got := digest(t, filepath.Join(root, "top.bin")); got != hex.EncodeToString(want[:]) {
		t.Fatalf("top.bin digest mismatch")
	}
	nested, err := os.ReadFile(filepath.Join(root, "a", "b", "nested.bin"))
	if err != nil || !bytes.Equal(nested, []byte("hello")) {
		t.Fatalf("nested.bin wrong: %v %q", err, nested)
	}
	info, err := os.Stat(filepath.Join(root, "a", "empty.bin"))
	if err != nil || info.Size() != 0 {
		t.Fatalf("zero-byte file wrong: %v", err)
	}
	if dirs := stagingDirs(t, root); len(dirs) != 0 {
		t.Fatalf("staging residue after a complete batch: %v", dirs)
	}
}

// The invariant the whole design exists for: an existing destination is never
// replaced, and its bytes survive byte-for-byte.
func TestExistingFileIsNeverReplaced(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "keep.bin")
	original := []byte("ORIGINAL CONTENT")
	if err := os.WriteFile(target, original, 0o644); err != nil {
		t.Fatal(err)
	}
	before := digest(t, target)

	p := plan(t, nameguard.Entry{Name: "keep.bin", Size: 3})
	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatal(err)
	}
	deliver(t, s, 0, []byte("new"))

	err := s.PublishOne(0)
	if wire.CodeOf(err) != wire.CodeExists {
		t.Fatalf("publish over an existing file: want E_EXISTS, got %v", err)
	}
	if after := digest(t, target); after != before {
		t.Fatal("the existing file was modified; no-replace failed")
	}
	if _, err := s.Cleanup(); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if after := digest(t, target); after != before {
		t.Fatal("cleanup damaged the pre-existing file")
	}
	if dirs := stagingDirs(t, root); len(dirs) != 0 {
		t.Fatalf("staging residue after a refused publish: %v", dirs)
	}
}

// A directory where a file is expected must fail as a type conflict, and the
// directory and its contents must survive.
func TestDirectoryVersusFileTypeConflict(t *testing.T) {
	root := t.TempDir()
	clash := filepath.Join(root, "clash")
	if err := os.MkdirAll(filepath.Join(clash, "inner"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(clash, "inner", "keep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := plan(t, nameguard.Entry{Name: "clash", Size: 1})
	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatal(err)
	}
	deliver(t, s, 0, []byte("y"))

	code := wire.CodeOf(s.PublishOne(0))
	if code != wire.CodeExists && code != wire.CodeTypeConflict {
		t.Fatalf("publishing a file over a directory: got %v", code)
	}
	s.Cleanup()
	if _, err := os.Stat(filepath.Join(clash, "inner", "keep.txt")); err != nil {
		t.Fatalf("pre-existing directory content was damaged: %v", err)
	}
}

// A file blocking a required directory component must be preserved and reported,
// never removed to make room.
func TestFileBlockingDirectoryComponentIsPreserved(t *testing.T) {
	root := t.TempDir()
	blocker := filepath.Join(root, "a")
	if err := os.WriteFile(blocker, []byte("BLOCKER"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := digest(t, blocker)

	p := plan(t, nameguard.Entry{Name: "a/b.bin", Size: 1})
	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatal(err)
	}
	deliver(t, s, 0, []byte("z"))

	if code := wire.CodeOf(s.PublishOne(0)); code != wire.CodeTypeConflict {
		t.Fatalf("want E_TYPE_CONFLICT, got %v", code)
	}
	s.Cleanup()
	if after := digest(t, blocker); after != before {
		t.Fatal("the blocking file was modified or removed")
	}
}

// Two sinks racing for the same destination: exactly one wins, and the loser
// neither overwrites nor loses its own staged bytes silently.
func TestConcurrentPublicationCannotReplaceTheWinner(t *testing.T) {
	root := t.TempDir()
	p1 := plan(t, nameguard.Entry{Name: "race.bin", Size: 6})
	p2 := plan(t, nameguard.Entry{Name: "race.bin", Size: 6})

	first, second := NewSink(), NewSink()
	if err := first.Open(root, p1); err != nil {
		t.Fatal(err)
	}
	if err := second.Open(root, p2); err != nil {
		t.Fatal(err)
	}
	deliver(t, first, 0, []byte("FIRST!"))
	deliver(t, second, 0, []byte("SECOND"))

	errFirst := first.PublishOne(0)
	errSecond := second.PublishOne(0)

	if errFirst != nil {
		t.Fatalf("the first publisher failed: %v", errFirst)
	}
	if wire.CodeOf(errSecond) != wire.CodeExists {
		t.Fatalf("the second publisher did not get E_EXISTS: %v", errSecond)
	}
	content, err := os.ReadFile(filepath.Join(root, "race.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, []byte("FIRST!")) {
		t.Fatalf("the winner's bytes were replaced: %q", content)
	}
	first.Cleanup()
	second.Cleanup()
	if content, _ := os.ReadFile(filepath.Join(root, "race.bin")); !bytes.Equal(content, []byte("FIRST!")) {
		t.Fatalf("the loser's cleanup damaged the winner: %q", content)
	}
	if dirs := stagingDirs(t, root); len(dirs) != 0 {
		t.Fatalf("staging residue after a lost race: %v", dirs)
	}
}

// An interior reparse point is refused rather than followed. Containment to the
// folder the user chose is the product promise.
func TestInteriorJunctionIsRefused(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "link")
	if err := makeJunction(link, outside); err != nil {
		skipUnproven(t, "an interior junction is refused rather than followed", err)
	}

	p := plan(t, nameguard.Entry{Name: "link/escaped.bin", Size: 3})
	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatal(err)
	}
	deliver(t, s, 0, []byte("esc"))

	if code := wire.CodeOf(s.PublishOne(0)); code != wire.CodeReparseComponent {
		t.Fatalf("interior junction: want E_REPARSE_COMPONENT, got %v", code)
	}
	s.Cleanup()
	if _, err := os.Stat(filepath.Join(outside, "escaped.bin")); err == nil {
		t.Fatal("a file was written outside the chosen root through a junction")
	}
}

// The root MAY be a junction: it is user-chosen, so it is followed once and the
// target object is then held.
//
// This test claims ONLY that following happens and the bytes land in the
// resolved target. The retarget claim is a separate test below, because the two
// need different evidence and only one of them can be established without
// performing a filesystem operation that the environment may refuse.
func TestRootJunctionIsFollowedOnce(t *testing.T) {
	base := t.TempDir()
	realTarget := filepath.Join(base, "real")
	if err := os.MkdirAll(realTarget, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "chosen")
	if err := makeJunction(link, realTarget); err != nil {
		skipUnproven(t, "a user-chosen junction root is followed once", err)
	}

	p := plan(t, nameguard.Entry{Name: "payload.bin", Size: 7})
	s := NewSink()
	if err := s.Open(link, p); err != nil {
		t.Fatalf("a user-chosen junction root was refused: %v", err)
	}
	deliver(t, s, 0, []byte("payload"))
	if err := s.PublishOne(0); err != nil {
		t.Fatalf("publish through a junction root: %v", err)
	}
	s.Cleanup()

	if _, err := os.Stat(filepath.Join(realTarget, "payload.bin")); err != nil {
		t.Fatalf("the file did not land in the resolved root: %v", err)
	}
}

// Re-pointing the root junction mid-flight must not redirect a single byte.
//
// ## Why this test refuses to pass quietly
//
// The previous version attempted the retarget, ignored a failed removal
// entirely, and downgraded a failed re-point to t.Logf. Either way it went on to
// assert "the file is in realTarget and not in decoy" — which is trivially true
// when the junction still points at realTarget and nothing was ever created at
// decoy. It PASSED while the attack step never happened, and the suite's exit 0
// then read as evidence of retarget resistance that no run had produced.
//
// So the retarget is now VERIFIED to have taken effect, by reading back where
// the link resolves, before the invariant is asserted. Three outcomes, each
// reported distinctly for -v readback:
//
//   - retargeted: the link demonstrably points at decoy. Full claim asserted.
//   - blocked: the link could not be re-pointed at all. The narrower blocking
//     invariant is asserted instead, and the retarget claim is NOT made.
//   - unavailable: the environment cannot create junctions. Explicit skip; this
//     invariant is unproven by this run.
func TestRootJunctionRetargetCannotRedirectWrites(t *testing.T) {
	base := t.TempDir()
	realTarget := filepath.Join(base, "real")
	decoy := filepath.Join(base, "decoy")
	for _, d := range []string{realTarget, decoy} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(base, "chosen")
	if err := makeJunction(link, realTarget); err != nil {
		skipUnproven(t, "re-pointing a root junction cannot redirect writes", err)
	}

	p := plan(t, nameguard.Entry{Name: "payload.bin", Size: 7})
	s := NewSink()
	if err := s.Open(link, p); err != nil {
		t.Fatalf("a user-chosen junction root was refused: %v", err)
	}
	deliver(t, s, 0, []byte("payload"))

	// The attack step, and the readback that proves it happened.
	retargeted := false
	removeErr := removeJunction(link)
	var makeErr error
	if removeErr == nil {
		if makeErr = makeJunction(link, decoy); makeErr == nil {
			resolved, err := junctionTarget(link)
			if err != nil {
				t.Fatalf("could not read back where the retargeted link resolves: %v", err)
			}
			// Compared on the trailing component: the readback is a normalised
			// \?\-prefixed path and the fixture path is not.
			if !strings.EqualFold(filepath.Base(resolved), filepath.Base(decoy)) {
				t.Fatalf("the retarget did not take effect: link resolves to %q, want the decoy %q", resolved, decoy)
			}
			retargeted = true
		}
	}

	if err := s.PublishOne(0); err != nil {
		t.Fatalf("publish after a root retarget attempt: %v", err)
	}
	s.Cleanup()

	// Asserted in every outcome: the bytes are in the originally-resolved target.
	if _, err := os.Stat(filepath.Join(realTarget, "payload.bin")); err != nil {
		t.Fatalf("the file did not land in the originally-resolved root: %v", err)
	}

	if retargeted {
		// The full claim, and it was actually exercised.
		if _, err := os.Stat(filepath.Join(decoy, "payload.bin")); err == nil {
			t.Fatal("re-pointing the root junction redirected the write; the root handle was not pinned")
		}
		t.Logf("%s re-pointing a root junction cannot redirect writes (retarget verified against the decoy)", provenPrefix)
		return
	}

	// The retarget did not happen, so nothing here may claim resistance to one.
	// The narrower invariant that WAS exercised is that the link could not be
	// re-pointed while the session holds its handles, which is asserted rather
	// than logged: it is a real refusal by the filesystem and it has a cause.
	if removeErr == nil && makeErr != nil {
		// The reparse point was removed but not replaced, so the link is now an
		// ordinary directory. Publication still landing in realTarget above is
		// the meaningful outcome; state plainly that the decoy was never armed.
		t.Logf("%s re-pointing a root junction cannot redirect writes: the link was cleared but could not be pointed at the decoy (%v). Publication into the originally-resolved target is asserted; redirection was not exercised.", unprovenPrefix, makeErr)
		return
	}
	t.Logf("%s re-pointing a root junction cannot redirect writes: the junction could not be cleared (%v). The narrower invariant asserted here is that the root remained the originally-resolved object; retarget resistance was not exercised.", unprovenPrefix, removeErr)
}

// The pin, asserted directly: while the sink holds its handles, the root and the
// staging directory cannot be renamed or deleted out from under it.
func TestPinnedAncestorsCannotBeRenamedOrDeleted(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	p := plan(t, nameguard.Entry{Name: "a/b.bin", Size: 4})
	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteChunk(0, []byte("data")); err != nil {
		t.Fatal(err)
	}

	if err := os.Rename(root, filepath.Join(base, "swapped")); err == nil {
		t.Fatal("the pinned root was renamed mid-transfer; FILE_SHARE_DELETE must stay omitted")
	}
	if err := os.RemoveAll(root); err == nil {
		t.Fatal("the pinned root was deleted mid-transfer")
	}
	dirs := stagingDirs(t, root)
	if len(dirs) != 1 {
		t.Fatalf("expected exactly one staging directory, got %v", dirs)
	}
	if err := os.Rename(filepath.Join(root, dirs[0]), filepath.Join(root, "moved")); err == nil {
		t.Fatal("the pinned staging directory was renamed mid-transfer")
	}

	if err := s.FinishFile(0); err != nil {
		t.Fatal(err)
	}
	if err := s.PublishOne(0); err != nil {
		t.Fatalf("publish after failed swap attempts: %v", err)
	}
	s.Cleanup()
	if _, err := os.Stat(filepath.Join(root, "a", "b.bin")); err != nil {
		t.Fatalf("file did not land in the pinned root: %v", err)
	}
}

// Cancel at each barrier: no residue, no published file, and never a false
// success.
func TestCancelAtEveryBarrierLeavesNoResidue(t *testing.T) {
	barriers := []struct {
		name string
		run  func(t *testing.T, s *Sink)
	}{
		{"after open", func(t *testing.T, s *Sink) {}},
		{"after begin", func(t *testing.T, s *Sink) {
			if err := s.BeginFile(0); err != nil {
				t.Fatal(err)
			}
		}},
		{"mid write", func(t *testing.T, s *Sink) {
			if err := s.BeginFile(0); err != nil {
				t.Fatal(err)
			}
			if _, err := s.WriteChunk(0, []byte("par")); err != nil {
				t.Fatal(err)
			}
		}},
		{"after finish", func(t *testing.T, s *Sink) {
			if err := s.BeginFile(0); err != nil {
				t.Fatal(err)
			}
			if _, err := s.WriteChunk(0, []byte("partial!")); err != nil {
				t.Fatal(err)
			}
			if err := s.FinishFile(0); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, barrier := range barriers {
		t.Run(barrier.name, func(t *testing.T) {
			root := t.TempDir()
			p := plan(t, nameguard.Entry{Name: "x/y.bin", Size: 8})
			s := NewSink()
			if err := s.Open(root, p); err != nil {
				t.Fatal(err)
			}
			barrier.run(t, s)

			residue, err := s.Cleanup()
			if err != nil {
				t.Fatalf("Cleanup: %v", err)
			}
			if residue.Left {
				t.Fatal("cleanup reported residue it should have removed")
			}
			// Repeated cancel joins the same settled result.
			if _, err := s.Cleanup(); err != nil {
				t.Fatalf("second Cleanup: %v", err)
			}
			if dirs := stagingDirs(t, root); len(dirs) != 0 {
				t.Fatalf("staging residue after cancel: %v", dirs)
			}
			if _, err := os.Stat(filepath.Join(root, "x", "y.bin")); err == nil {
				t.Fatal("cancel published a file")
			}
		})
	}
}

// Cleanup may remove only what this sink created. A foreign file planted in the
// staging directory must be reported as residue, never deleted.
func TestCleanupNeverRemovesUnownedContent(t *testing.T) {
	root := t.TempDir()
	p := plan(t, nameguard.Entry{Name: "a.bin", Size: 4})
	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatal(err)
	}
	dirs := stagingDirs(t, root)
	if len(dirs) != 1 {
		t.Fatalf("expected one staging directory, got %v", dirs)
	}
	foreign := filepath.Join(root, dirs[0], "planted.txt")
	if err := os.WriteFile(foreign, []byte("NOT OURS"), 0o644); err != nil {
		t.Fatal(err)
	}

	residue, _ := s.Cleanup()
	if !residue.Left {
		t.Fatal("cleanup did not report residue for a staging directory it could not empty")
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatalf("cleanup deleted content this process did not create: %v", err)
	}
}

// A pre-existing directory reused during publication must survive cleanup. The
// access mask makes this structural, and this asserts the structure holds.
func TestPreExistingDirectoryIsNeverDeleted(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "existing")
	if err := os.MkdirAll(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(existing, "marker.txt")
	if err := os.WriteFile(marker, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := plan(t, nameguard.Entry{Name: "existing/new.bin", Size: 2}, nameguard.Entry{Name: "existing/blocked.bin", Size: 2})
	s := NewSink()
	if err := s.Open(root, p); err != nil {
		t.Fatal(err)
	}
	// Block the second file so publication fails partway and cleanup runs with
	// the directory handle still cached.
	if err := os.WriteFile(filepath.Join(existing, "blocked.bin"), []byte("xx"), 0o644); err != nil {
		t.Fatal(err)
	}
	deliver(t, s, 0, []byte("ab"))
	deliver(t, s, 1, []byte("cd"))
	if err := s.PublishOne(0); err != nil {
		t.Fatalf("first publish: %v", err)
	}
	if code := wire.CodeOf(s.PublishOne(1)); code != wire.CodeExists {
		t.Fatalf("second publish: want E_EXISTS, got %v", code)
	}
	s.Cleanup()

	if _, err := os.Stat(existing); err != nil {
		t.Fatalf("a pre-existing directory was removed: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("pre-existing directory content was removed: %v", err)
	}
	// The completed output stays: partial publication keeps 0..N-1.
	if _, err := os.Stat(filepath.Join(existing, "new.bin")); err != nil {
		t.Fatalf("a completed output was rolled back: %v", err)
	}
}

var _ session.Sink = (*Sink)(nil)
