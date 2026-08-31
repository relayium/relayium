package xfer

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// mirror runs one sync+delete transfer from srcRoots into dst and returns the
// receiver's report, so each scope test exercises the real wire path rather
// than deleteExtras alone.
func mirror(t *testing.T, dst string, allowDelete bool, srcRoots ...string) Report {
	t.Helper()
	m, srcs, err := BuildManifest(srcRoots)
	if err != nil {
		t.Fatal(err)
	}
	c1, c2 := net.Pipe()
	var wg sync.WaitGroup
	wg.Add(1)
	var recvErr error
	var rep Report
	go func() {
		defer wg.Done()
		rep, recvErr = Receive(c2, dst, RecvOpts{AllowDelete: allowDelete})
		c2.Close()
	}()
	_, serr := Send(c1, m, srcs, SendOpts{Sync: true, Delete: true})
	c1.Close()
	wg.Wait()
	if serr != nil || recvErr != nil {
		t.Fatalf("send=%v recv=%v", serr, recvErr)
	}
	return rep
}

func mustExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("%s must survive the mirror delete: %v", path, err)
	}
}

func mustNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("%s should have been deleted (err=%v)", path, err)
	}
}

// The core data-loss boundary. A serve --dir is a receiving area that may hold
// unrelated things — another project's tree, an operator's own files. Mirroring
// ./site into it may prune stale files inside site/, and must leave every one of
// those alone. Before the scope existed, this one push emptied the directory.
func TestMirrorDeleteSparesUnrelatedRoots(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFileMtime(t, filepath.Join(src, "site", "index.html"), "new", 1000)

	// Unrelated content the receiving host owns.
	writeFileMtime(t, filepath.Join(dst, "backups", "db.sql"), "precious", 1000)
	writeFileMtime(t, filepath.Join(dst, "notes.txt"), "mine", 1000)
	if err := os.MkdirAll(filepath.Join(dst, "empty-on-purpose"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A stale file inside the mirrored root: this one SHOULD go.
	writeFileMtime(t, filepath.Join(dst, "site", "old.html"), "stale", 1000)

	rep := mirror(t, dst, true, filepath.Join(src, "site"))
	if rep.DeleteDenied {
		t.Fatalf("delete should have run: %s", rep.DeleteRefusedReason)
	}

	mustNotExist(t, filepath.Join(dst, "site", "old.html"))
	mustExist(t, filepath.Join(dst, "site", "index.html"))
	mustExist(t, filepath.Join(dst, "backups", "db.sql"))
	mustExist(t, filepath.Join(dst, "notes.txt"))
	// An empty directory outside the mirrored roots is not the mirror's business.
	mustExist(t, filepath.Join(dst, "empty-on-purpose"))
}

// Two source roots in one command mirror independently: neither may delete the
// other's files, and each still prunes its own stale content.
func TestMirrorDeleteTwoRootsDoNotDeleteEachOther(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFileMtime(t, filepath.Join(src, "a", "keep-a.txt"), "a", 1000)
	writeFileMtime(t, filepath.Join(src, "b", "keep-b.txt"), "b", 1000)
	writeFileMtime(t, filepath.Join(dst, "a", "stale-a.txt"), "x", 1000)
	writeFileMtime(t, filepath.Join(dst, "b", "stale-b.txt"), "x", 1000)
	writeFileMtime(t, filepath.Join(dst, "c", "untouched.txt"), "x", 1000)

	mirror(t, dst, true, filepath.Join(src, "a"), filepath.Join(src, "b"))

	mustExist(t, filepath.Join(dst, "a", "keep-a.txt"))
	mustExist(t, filepath.Join(dst, "b", "keep-b.txt"))
	mustNotExist(t, filepath.Join(dst, "a", "stale-a.txt"))
	mustNotExist(t, filepath.Join(dst, "b", "stale-b.txt"))
	mustExist(t, filepath.Join(dst, "c", "untouched.txt"))
}

// Pruning follows the same boundary as deletion: an emptied directory inside a
// mirrored root goes, one outside it stays — even though both are equally empty.
func TestMirrorDeletePrunesOnlyInsideRoots(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFileMtime(t, filepath.Join(src, "site", "index.html"), "new", 1000)
	writeFileMtime(t, filepath.Join(dst, "site", "old", "gone.html"), "stale", 1000)
	for _, d := range []string{"unrelated-empty", filepath.Join("backups", "nested-empty")} {
		if err := os.MkdirAll(filepath.Join(dst, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	mirror(t, dst, true, filepath.Join(src, "site"))

	mustNotExist(t, filepath.Join(dst, "site", "old"))  // emptied inside the root
	mustExist(t, filepath.Join(dst, "unrelated-empty")) // outside: not ours
	mustExist(t, filepath.Join(dst, "backups", "nested-empty"))
	mustExist(t, filepath.Join(dst, "site")) // the mirrored root itself is kept
}

// A single-file root scopes exactly that file. The manifest keeps it, so the
// mirror deletes nothing at all — it must not treat the whole receive directory
// as the file's "root".
func TestMirrorDeleteSingleFileRootDeletesNothing(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFileMtime(t, filepath.Join(src, "report.txt"), "fresh", 1000)
	writeFileMtime(t, filepath.Join(dst, "other.txt"), "mine", 1000)
	writeFileMtime(t, filepath.Join(dst, "tree", "deep.txt"), "mine", 1000)

	mirror(t, dst, true, filepath.Join(src, "report.txt"))

	mustExist(t, filepath.Join(dst, "report.txt"))
	mustExist(t, filepath.Join(dst, "other.txt"))
	mustExist(t, filepath.Join(dst, "tree", "deep.txt"))
}

// Deletion stays gated by the receiver's own --allow-delete: a correctly scoped
// request still removes nothing when the operator did not opt in.
func TestMirrorDeleteStillGatedByAllowDelete(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFileMtime(t, filepath.Join(src, "site", "index.html"), "new", 1000)
	writeFileMtime(t, filepath.Join(dst, "site", "old.html"), "stale", 1000)

	rep := mirror(t, dst, false, filepath.Join(src, "site"))
	if !rep.DeleteDenied {
		t.Fatal("DeleteDenied must be set when the listener has no --allow-delete")
	}
	mustExist(t, filepath.Join(dst, "site", "old.html"))
}

// "Refused" and "half-done" are different outcomes. A scope refusal deletes
// nothing and says so; a mid-way failure must not claim the same thing, or an
// operator reads "nothing was deleted" about files that are already gone.
func TestReceiveDistinguishesRefusalFromPartialDelete(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFileMtime(t, filepath.Join(src, "site", "index.html"), "new", 1000)
	writeFileMtime(t, filepath.Join(dst, "site", "stale.html"), "old", 1000)

	rep := mirror(t, dst, true, filepath.Join(src, "site"))
	if rep.DeleteRefusedReason != "" || rep.DeletePartial != "" {
		t.Fatalf("a clean mirror should report neither: refused=%q partial=%q",
			rep.DeleteRefusedReason, rep.DeletePartial)
	}

	// An empty manifest is the refusal case: nothing deleted, reason given.
	dst2 := t.TempDir()
	writeFileMtime(t, filepath.Join(dst2, "keep.txt"), "important", 1000)
	rep2 := mirror(t, dst2, true)
	if !rep2.DeleteDenied || rep2.DeleteRefusedReason == "" {
		t.Fatalf("an empty manifest must be refused with a reason, got %+v", rep2)
	}
	if rep2.DeletePartial != "" {
		t.Fatalf("a refusal must not be reported as a partial delete: %q", rep2.DeletePartial)
	}
	mustExist(t, filepath.Join(dst2, "keep.txt"))
}

// deleteScopeFor is fail-closed: anything it cannot resolve to concrete
// top-level roots must produce an error, never a scope that falls back to the
// whole receive directory.
func TestDeleteScopeForFailsClosed(t *testing.T) {
	bad := map[string]Manifest{
		"empty manifest":       {},
		"root-only path":       {Files: []FileEntry{{Path: "/"}}},
		"dot path":             {Files: []FileEntry{{Path: "."}}},
		"parent escape only":   {Files: []FileEntry{{Path: ".."}}},
		"file and dir collide": {Files: []FileEntry{{Path: "a"}, {Path: "a/b.txt"}}},
	}
	for name, m := range bad {
		if _, err := deleteScopeFor(m); err == nil {
			t.Errorf("%s: deleteScopeFor must fail closed, got a usable scope", name)
		}
	}
}

// The scope must be derived from the path the receiver would actually WRITE to,
// not the raw manifest string: safeJoin clamps "../x" to "x", so the scope has
// to clamp it identically or a file lands in a root the mirror then prunes.
func TestDeleteScopeNormalisesLikeSafeJoin(t *testing.T) {
	sc, err := deleteScopeFor(Manifest{Files: []FileEntry{{Path: "../site/index.html"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(sc.dirRoots) != 1 || sc.dirRoots[0] != "site" {
		t.Fatalf("dirRoots = %v, want [site]", sc.dirRoots)
	}
	if !sc.want[filepath.Join("site", "index.html")] {
		t.Fatalf("want set = %v, missing the clamped destination path", sc.want)
	}
}

// destKeyFold is the one place the mirror decides whether two spellings name the
// same file, so both branches are asserted here rather than only on whichever OS
// the suite happens to run on. The case-insensitive branch is the one that can
// delete a wanted file, and it must be executable on Linux CI too.
func TestDestKeyFoldBothBranches(t *testing.T) {
	mixed := filepath.Join("Site", "Index.HTML")
	lower := filepath.Join("site", "index.html")

	if got := destKeyFold(mixed, true); got != lower {
		t.Errorf("destKeyFold(%q, true) = %q, want %q", mixed, got, lower)
	}
	if got := destKeyFold(mixed, false); got != mixed {
		t.Errorf("destKeyFold(%q, false) = %q, want the spelling preserved", mixed, got)
	}
	// Folding and cleaning must both happen, in either mode: an uncleaned key
	// would miss the file it names just as surely as an unfolded one.
	messy := filepath.Join("Site", ".", "sub", "..", "Index.HTML")
	if got := destKeyFold(messy, true); got != lower {
		t.Errorf("destKeyFold(%q, true) = %q, want %q", messy, got, lower)
	}
	if got := destKeyFold(messy, false); got != mixed {
		t.Errorf("destKeyFold(%q, false) = %q, want %q", messy, got, mixed)
	}
	// Folding must apply to the whole path, not just its last element.
	if got := destKeyFold(filepath.Join("SITE", "sub", "A.txt"), true); got != filepath.Join("site", "sub", "a.txt") {
		t.Errorf("destKeyFold folded only part of the path: %q", got)
	}
	// The production wrapper must use the platform decision, not a hardcoded one.
	if got, want := destKey(mixed), destKeyFold(mixed, foldDestPaths); got != want {
		t.Errorf("destKey(%q) = %q, want %q", mixed, got, want)
	}
}

// The want set and the walked-disk paths must be compared through the SAME key
// function. Before this, want held the manifest's raw spelling while the walk
// produced the on-disk one, so on a case-insensitive filesystem a file the
// manifest explicitly keeps was classified stale and deleted.
func TestDeleteScopeKeysAreCanonical(t *testing.T) {
	sc, err := deleteScopeFor(Manifest{Files: []FileEntry{{Path: "Site/Index.HTML"}}})
	if err != nil {
		t.Fatal(err)
	}
	// However the platform folds, the key the walk would compute for the same
	// destination has to be present in want.
	if !sc.want[destKey(filepath.Join("Site", "Index.HTML"))] {
		t.Fatalf("want = %v, missing the manifest's own destination", sc.want)
	}
	// On a case-insensitive platform the other spelling names the same file, so
	// it must be recognised as wanted; on a case-sensitive one it must not.
	otherCase := sc.want[destKey(filepath.Join("site", "index.html"))]
	if otherCase != foldDestPaths {
		t.Fatalf("want[site/index.html] = %v, foldDestPaths = %v: the fold decision "+
			"is not reaching the want set", otherCase, foldDestPaths)
	}
	// The root keeps its manifest spelling, because it is joined onto a real path.
	if len(sc.dirRoots) != 1 || sc.dirRoots[0] != "Site" {
		t.Fatalf("dirRoots = %v, want the on-disk spelling [Site]", sc.dirRoots)
	}
}

// Two spellings of one root are one directory on a case-insensitive filesystem.
// Keyed raw they become two roots, and the second walk deletes files the first
// already removed — an os.Remove that fails and turns a clean mirror into a
// reported partial delete.
func TestDeleteScopeDedupesRootsPerPlatform(t *testing.T) {
	sc, err := deleteScopeFor(Manifest{Files: []FileEntry{
		{Path: "Site/a.txt"},
		{Path: "site/b.txt"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := 2
	if foldDestPaths {
		want = 1
	}
	if len(sc.dirRoots) != want {
		t.Fatalf("dirRoots = %v, want %d root(s) on this platform (fold=%v)", sc.dirRoots, want, foldDestPaths)
	}
	if foldDestPaths && sc.dirRoots[0] != "Site" {
		t.Fatalf("dirRoots = %v, want the first-seen spelling [Site]", sc.dirRoots)
	}
}

// A file root and a directory root that differ only in case cannot both exist on
// a case-insensitive filesystem, so the scope is ambiguous there and must be
// refused rather than guessed.
func TestDeleteScopeCaseCollidingRootsFailClosed(t *testing.T) {
	_, err := deleteScopeFor(Manifest{Files: []FileEntry{
		{Path: "Notes"},
		{Path: "notes/deep.txt"},
	}})
	if foldDestPaths {
		if err == nil {
			t.Fatal("a case-colliding file/dir root must fail closed on this platform")
		}
		if !strings.Contains(err.Error(), "both a file and a directory") {
			t.Fatalf("err = %v, want the ambiguity explained", err)
		}
		return
	}
	if err != nil {
		t.Fatalf("on a case-sensitive platform these are two distinct roots: %v", err)
	}
}

// The end-to-end regression, run only where the filesystem actually folds case:
// mirroring a manifest whose casing differs from what WalkDir reports must keep
// the file the transfer just wrote.
func TestMirrorDeleteKeepsWantedFileOnCaseInsensitiveFS(t *testing.T) {
	dst := t.TempDir()
	if !fsFoldsCase(t, dst) {
		t.Skip("this filesystem is case-sensitive; TestDestKeyFoldBothBranches covers the fold branch")
	}
	// On disk in one casing...
	writeFileMtime(t, filepath.Join(dst, "site", "index.html"), "live", 1000)
	// ...named by the manifest in another. Same file; it must survive.
	n, err := deleteExtras(dst, Manifest{Files: []FileEntry{{Path: "Site/INDEX.HTML"}}})
	if err != nil {
		t.Fatalf("deleteExtras: %v", err)
	}
	if n != 0 {
		t.Fatalf("deleted %d file(s); the manifest wants the only file present", n)
	}
	mustExist(t, filepath.Join(dst, "site", "index.html"))
}

// fsFoldsCase reports whether dir's filesystem treats two spellings of one name
// as the same file, decided by probing rather than by GOOS: a case-sensitive
// volume on macOS (or a mounted one on Linux) would otherwise be mis-detected.
func fsFoldsCase(t *testing.T, dir string) bool {
	t.Helper()
	probe := filepath.Join(dir, "CaseProbe")
	if err := os.WriteFile(probe, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(probe)
	_, err := os.Stat(filepath.Join(dir, "caseprobe"))
	return err == nil
}

// An unscopeable manifest reaching an --allow-delete listener must refuse the
// delete and say so locally, rather than deleting on a guessed scope.
func TestReceiveRefusesUnscopeableDelete(t *testing.T) {
	dst := t.TempDir()
	writeFileMtime(t, filepath.Join(dst, "keep.txt"), "important", 1000)

	// "a" as a file and "a/b" as a directory cannot both exist: ambiguous.
	m := Manifest{Files: []FileEntry{
		{Path: "a", Size: 0, ModTime: 1000},
		{Path: "a/b.txt", Size: 0, ModTime: 1000},
	}}
	c1, c2 := net.Pipe()
	var wg sync.WaitGroup
	wg.Add(1)
	var rep Report
	var recvErr error
	go func() {
		defer wg.Done()
		rep, recvErr = Receive(c2, dst, RecvOpts{AllowDelete: true})
		c2.Close()
	}()
	// Drive the sender by hand: BuildManifest cannot produce this shape.
	sendErr := func() error {
		if err := WriteJSON(c1, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, Delete: true}); err != nil {
			return err
		}
		if err := WriteJSON(c1, MsgManifest, m); err != nil {
			return err
		}
		var rs ResumeState
		if err := readExpect(c1, &rs); err != nil {
			return err
		}
		for i, f := range m.Files {
			if err := WriteJSON(c1, MsgFileStart, FileStart{Index: i}); err != nil {
				return err
			}
			// Zero-length bodies: only the hash frame follows.
			if err := WriteJSON(c1, MsgFileHash, FileHash{Index: i,
				SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}); err != nil {
				return err
			}
			_ = f
		}
		var res Result
		return readExpect(c1, &res)
	}()
	c1.Close()
	wg.Wait()
	if sendErr != nil || recvErr != nil {
		t.Fatalf("send=%v recv=%v", sendErr, recvErr)
	}
	if !rep.DeleteDenied {
		t.Fatal("an unscopeable manifest must refuse the mirror delete")
	}
	if !strings.Contains(rep.DeleteRefusedReason, "both a file and a directory") {
		t.Fatalf("DeleteRefusedReason = %q, want the ambiguity explained", rep.DeleteRefusedReason)
	}
	mustExist(t, filepath.Join(dst, "keep.txt"))
}
