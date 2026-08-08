package inboxclient

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

// Commit-layer tests. Everything here is about the two properties that cannot be
// recovered from if they are wrong: an existing file must never be replaced, and
// a crash must never produce either a duplicate delivery or a false `saved`.

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// commitFixture builds a receive directory with a staged, journalled task ready
// to commit, and returns the committer plus its journal.
func commitFixture(t *testing.T, names ...string) (*Committer, *Journal, string) {
	t.Helper()
	root := t.TempDir()
	state := t.TempDir()
	journals := NewJournalStore(filepath.Join(state, "tasks"))
	staging, err := PrepareStaging(root, "task1")
	if err != nil {
		t.Fatalf("staging: %v", err)
	}
	j := &Journal{TaskID: "task1", Root: root, Staging: staging}
	for i, n := range names {
		j.Plan = append(j.Plan, PlanEntry{Index: i, Name: n, Size: int64(len(n)), Dest: filepath.Join(root, n)})
		write(t, filepath.Join(staging, itoa(i)+".part"), n)
		if err := os.Chmod(filepath.Join(staging, itoa(i)+".part"), receivedFileMode); err != nil {
			t.Fatalf("chmod staged: %v", err)
		}
	}
	now := time.Unix(1_800_000_000, 0)
	if err := journals.Save(j, now); err != nil {
		t.Fatalf("journal: %v", err)
	}
	return &Committer{Store: journals, Root: root, Now: fixedClock(now), Staging: staging}, j, root
}

func itoa(i int) string { return string(rune('0' + i)) }

// TestCommitPlacesFilesWithoutExecutableBits is the happy path plus the PRD §9
// permission rule: a received file never gains an executable bit, whatever the
// process umask happens to be.
func TestCommitPlacesFilesWithoutExecutableBits(t *testing.T) {
	c, j, root := commitFixture(t, "a.txt", "sub/b.txt")
	if err := c.Commit(j); err != nil {
		t.Fatalf("commit: %v", err)
	}
	for _, e := range j.Plan {
		fi, err := os.Lstat(e.Dest)
		if err != nil {
			t.Fatalf("committed file %d missing: %v", e.Index, err)
		}
		if fi.Mode().Perm()&0o111 != 0 {
			t.Fatalf("committed file %d has mode %v; received files must never be executable", e.Index, fi.Mode())
		}
		if fi.Mode().Perm() != receivedFileMode.Perm() {
			t.Fatalf("committed file %d has mode %v, want %v", e.Index, fi.Mode().Perm(), receivedFileMode.Perm())
		}
	}
	if !j.Completed {
		t.Fatal("journal was not marked completed after a full commit")
	}
	if _, err := os.Stat(c.Staging); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging directory survived a completed commit: %v", err)
	}
	_ = root
}

// TestCommitNeverOverwritesAFilePlantedAfterPreflight is the check-then-rename
// race, made concrete. The plan was computed when the destination was free; a
// file appears while the download runs; the commit must refuse rather than
// destroy it.
//
// This is the assertion that would fail if commitOne ever used os.Rename.
func TestCommitNeverOverwritesAFilePlantedAfterPreflight(t *testing.T) {
	c, j, root := commitFixture(t, "victim.txt")
	// The user (or another program) creates the file after the plan was made.
	write(t, filepath.Join(root, "victim.txt"), "PRECIOUS USER DATA")

	err := c.Commit(j)
	if !errors.Is(err, ErrDestinationOccupied) {
		t.Fatalf("commit error = %v, want ErrDestinationOccupied", err)
	}
	if got := read(t, filepath.Join(root, "victim.txt")); got != "PRECIOUS USER DATA" {
		t.Fatalf("the planted file was modified: %q", got)
	}
	if j.Completed {
		t.Fatal("journal claims completed after a refused commit")
	}
	// And the failure maps to a state a human is told about, not a silent retry.
	f := classifyFS(err)
	if f == nil || f.State != "attention_required" || f.Code != "name_conflict" {
		t.Fatalf("classified as %+v, want attention_required/name_conflict", f)
	}
}

// TestCommitResumesAfterACrashBetweenLinkAndJournal is the load-bearing crash
// window. The link succeeded, the process died before recording it, and on
// restart the destination exists. The commit must recognise its OWN link
// (os.SameFile: a hard link shares an inode with its source) and finish, rather
// than either refusing or delivering a second copy.
func TestCommitResumesAfterACrashBetweenLinkAndJournal(t *testing.T) {
	c, j, root := commitFixture(t, "a.txt", "b.txt")

	// Simulate the crash: link the first entry by hand, leave the staged source
	// in place, and do NOT record it in the journal.
	if err := os.Link(filepath.Join(c.Staging, "0.part"), filepath.Join(root, "a.txt")); err != nil {
		t.Fatalf("simulate partial commit: %v", err)
	}
	if len(j.Committed) != 0 {
		t.Fatal("fixture already recorded a commit")
	}

	if err := c.Commit(j); err != nil {
		t.Fatalf("resumed commit: %v", err)
	}
	if len(j.Committed) != 2 {
		t.Fatalf("journal recorded %d commits, want 2", len(j.Committed))
	}
	// One task id, one local commit: exactly the planned names exist, with no
	// "a (2).txt" duplicate from a re-plan.
	assertDirContains(t, root, "a.txt", "b.txt")
	if got := read(t, filepath.Join(root, "a.txt")); got != "a.txt" {
		t.Fatalf("resumed file content = %q", got)
	}
}

// TestCommitSkipsAlreadyJournalledEntries covers the other side of that window:
// the journal recorded the commit, then the process died before unlinking the
// staged source. The entry must be skipped, not re-linked, and the stale staged
// file must be cleaned up.
func TestCommitSkipsAlreadyJournalledEntries(t *testing.T) {
	c, j, root := commitFixture(t, "a.txt")
	if err := os.Link(filepath.Join(c.Staging, "0.part"), filepath.Join(root, "a.txt")); err != nil {
		t.Fatalf("simulate: %v", err)
	}
	j.Committed = append(j.Committed, j.Plan[0].Dest)
	if err := c.Store.Save(j, time.Unix(1_800_000_000, 0)); err != nil {
		t.Fatalf("journal: %v", err)
	}
	if err := c.Commit(j); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if len(j.Committed) != 1 {
		t.Fatalf("journal recorded %d commits, want 1 (the entry must not be recorded twice)", len(j.Committed))
	}
	assertDirContains(t, root, "a.txt")
}

// TestCommitRefusesAForeignFileAtAnUnjournalledDestination is the ambiguity
// case: the destination exists but is NOT our staged inode. That is somebody
// else's file, and the honest answer is to stop.
func TestCommitRefusesAForeignFileAtAnUnjournalledDestination(t *testing.T) {
	c, j, root := commitFixture(t, "a.txt")
	write(t, filepath.Join(root, "a.txt"), "someone else's file")
	if err := c.Commit(j); !errors.Is(err, ErrDestinationOccupied) {
		t.Fatalf("commit error = %v, want ErrDestinationOccupied", err)
	}
	if got := read(t, filepath.Join(root, "a.txt")); got != "someone else's file" {
		t.Fatalf("foreign file was modified: %q", got)
	}
}

// TestCommitReportsPermissionLossAsAttentionRequired: the destination directory
// stopped being writable between the plan and the commit. Nothing may be
// written, and the outcome must be attention_required — only a human can restore
// permissions, and burning eight retries against them tells the sender nothing.
func TestCommitReportsPermissionLossAsAttentionRequired(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	c, j, root := commitFixture(t, "sub/locked.txt")
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Chmod(sub, 0o500); err != nil { // readable, not writable
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(sub, 0o700) })

	err := c.Commit(j)
	if err == nil {
		t.Fatal("committed into a directory this process cannot write")
	}
	f := classifyFS(err)
	if f == nil || f.State != "attention_required" || f.Code != "permission_denied" {
		t.Fatalf("classified as %+v, want attention_required/permission_denied", f)
	}
	if _, statErr := os.Stat(filepath.Join(sub, "locked.txt")); statErr == nil {
		t.Fatal("a file appeared in the unwritable directory")
	}
}

// TestFailureClassificationIsExplicit pins the retryable/terminal/attention
// split. Getting it wrong is worse than a wrong error code: a terminal
// misclassification silently drops a delivery, and a retryable one burns the
// attempt budget against a problem nobody was told about.
func TestFailureClassificationIsExplicit(t *testing.T) {
	// A retry of the same bytes cannot fix a bad manifest name.
	if f := classifyFS(ErrUnsafeName); f == nil || f.State != "failed_terminal" || f.Code != "verify_failed" {
		t.Fatalf("unsafe name -> %+v, want failed_terminal/verify_failed", f)
	}
	// A person must free space, restore permissions or resolve a name.
	for _, tc := range []struct{ err, wantCode any }{
		{ErrDestinationOccupied, "name_conflict"},
		{ErrNameConflict, "name_conflict"},
		{ErrDirectoryUnavailable, "directory_unavailable"},
	} {
		f := classifyFS(tc.err.(error))
		if f == nil || f.State != "attention_required" || f.Code != tc.wantCode {
			t.Fatalf("%v -> %+v, want attention_required/%v", tc.err, f, tc.wantCode)
		}
	}
	// AEAD rejection is terminal: the ciphertext on central does not change.
	if f := classifyCrypto(ErrUnseal); f == nil || f.State != "failed_terminal" || f.Code != "decrypt_failed" {
		t.Fatalf("unseal failure -> %+v, want failed_terminal/decrypt_failed", f)
	}
	if f := classifyCrypto(ErrDecryptFailed); f == nil || f.State != "failed_terminal" {
		t.Fatalf("frame decrypt failure -> %+v, want failed_terminal", f)
	}
	// A truncated stream is a transport symptom; the next attempt gets a fresh one.
	if f := classifyCrypto(ErrTruncatedStream); f == nil || f.State != "failed_retryable" || f.Code != "verify_failed" {
		t.Fatalf("truncated stream -> %+v, want failed_retryable/verify_failed", f)
	}
	// Every code the device may submit must be in central's closed set.
	for _, f := range []*Failure{
		classifyFS(ErrUnsafeName), classifyFS(ErrDestinationOccupied),
		classifyFS(ErrDirectoryUnavailable), classifyCrypto(ErrUnseal),
		classifyCrypto(ErrTruncatedStream), classifyTransport(errors.New("boom")),
		retryable("internal", nil),
	} {
		if err := inbox.ValidateDeviceErrorCode(f.Code); err != nil {
			t.Fatalf("classifier produced %q, which central refuses: %v", f.Code, err)
		}
		if !inbox.IsDeviceReportableState(f.State) {
			t.Fatalf("classifier produced state %q, which a device may not report", f.State)
		}
	}
}

// TestEnsureDirWithinRefusesSymlinkedParents is the parent-directory attack.
// os.MkdirAll would follow `photos -> /tmp/elsewhere` and create the tree over
// there; per-component Lstat sees the symlink and stops.
func TestEnsureDirWithinRefusesSymlinkedParents(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "photos")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	err := ensureDirWithin(root, filepath.Join(root, "photos", "2026"))
	if !errors.Is(err, ErrDirectoryUnavailable) {
		t.Fatalf("ensureDirWithin error = %v, want ErrDirectoryUnavailable", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "2026")); err == nil {
		t.Fatal("a directory was created through the symlink, outside the receive directory")
	}
}

// TestEnsureDirWithinRefusesNonDirectoryComponents covers a plain file — and a
// FIFO, which is the special-file case: opening one blocks forever, so it must
// be refused as a path component rather than traversed.
func TestEnsureDirWithinRefusesNonDirectoryComponents(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "photos"), "actually a file")
	err := ensureDirWithin(root, filepath.Join(root, "photos", "2026"))
	if !errors.Is(err, ErrDirectoryUnavailable) {
		t.Fatalf("ensureDirWithin over a file = %v, want ErrDirectoryUnavailable", err)
	}

	fifo := filepath.Join(root, "pipe")
	if err := makeFIFO(fifo); err != nil {
		t.Skipf("cannot create a FIFO here: %v", err)
	}
	err = ensureDirWithin(root, filepath.Join(root, "pipe", "sub"))
	if !errors.Is(err, ErrDirectoryUnavailable) {
		t.Fatalf("ensureDirWithin over a FIFO = %v, want ErrDirectoryUnavailable", err)
	}
}

// TestEnsureDirWithinRefusesEscape is the lexical backstop.
func TestEnsureDirWithinRefusesEscape(t *testing.T) {
	root := t.TempDir()
	if err := ensureDirWithin(root, filepath.Join(root, "..", "elsewhere")); !errors.Is(err, ErrDirectoryUnavailable) {
		t.Fatalf("ensureDirWithin outside root = %v, want ErrDirectoryUnavailable", err)
	}
}

// TestPrepareStagingDiscardsAnEarlierAttempt: staged bytes are only meaningful
// as a whole, verified stream. Reusing a previous attempt's partial output would
// be exactly the "apparently complete unverified file" this design prevents.
func TestPrepareStagingDiscardsAnEarlierAttempt(t *testing.T) {
	root := t.TempDir()
	first, err := PrepareStaging(root, "task1")
	if err != nil {
		t.Fatalf("staging: %v", err)
	}
	write(t, filepath.Join(first, "0.part"), "half a file from a dead attempt")
	second, err := PrepareStaging(root, "task1")
	if err != nil {
		t.Fatalf("staging again: %v", err)
	}
	if second != first {
		t.Fatalf("staging path changed between attempts: %q then %q", first, second)
	}
	if _, err := os.Stat(filepath.Join(second, "0.part")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the previous attempt's partial output survived into a fresh staging area")
	}
	fi, err := os.Stat(second)
	if err != nil {
		t.Fatalf("stat staging: %v", err)
	}
	if fi.Mode().Perm() != receivedDirMode.Perm() {
		t.Fatalf("staging mode = %v, want %v (unverified bytes must not be world-readable)", fi.Mode().Perm(), receivedDirMode.Perm())
	}
}

func TestCommitStopsBeforeAnotherFileWhenLeaseGuardFails(t *testing.T) {
	root := t.TempDir()
	staging, err := PrepareStaging(root, "task-lease")
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(staging, "0.part"), "first")
	write(t, filepath.Join(staging, "1.part"), "second")
	store := NewJournalStore(filepath.Join(t.TempDir(), "tasks"))
	j := Journal{TaskID: "task-lease", Root: root, Staging: staging, Plan: []PlanEntry{
		{Index: 0, Dest: filepath.Join(root, "first.txt")},
		{Index: 1, Dest: filepath.Join(root, "second.txt")},
	}}
	if err := store.Save(&j, time.Now()); err != nil {
		t.Fatal(err)
	}
	calls := 0
	c := Committer{Store: store, Root: root, Staging: staging, Now: time.Now, BeforeEach: func() error {
		calls++
		if calls == 2 {
			return ErrAbandon
		}
		return nil
	}}
	if err := c.Commit(&j); !errors.Is(err, ErrAbandon) {
		t.Fatalf("commit error = %v, want ErrAbandon", err)
	}
	if got := read(t, filepath.Join(root, "first.txt")); got != "first" {
		t.Fatalf("first committed file = %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "second.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("second file was committed after lease loss: %v", err)
	}
}

// TestCheckReceiveDirProbesRatherThanInspectingBits: `receiveDirReady` decides
// whether a sender is told their file will land, so it has to be a real write.
func TestCheckReceiveDirProbesRatherThanInspectingBits(t *testing.T) {
	root := t.TempDir()
	if err := CheckReceiveDir(root); err != nil {
		t.Fatalf("a fresh temp dir was reported unusable: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, probeName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the probe file was left behind")
	}

	missing := filepath.Join(root, "gone")
	if err := CheckReceiveDir(missing); !errors.Is(err, ErrDirectoryUnavailable) {
		t.Fatalf("missing dir = %v, want ErrDirectoryUnavailable", err)
	}

	notADir := filepath.Join(root, "file")
	write(t, notADir, "x")
	if err := CheckReceiveDir(notADir); !errors.Is(err, ErrDirectoryUnavailable) {
		t.Fatalf("file-as-dir = %v, want ErrDirectoryUnavailable", err)
	}

	// A read-only directory has perfectly reasonable-looking mode bits for the
	// owner in some configurations; only an actual create tells the truth.
	ro := filepath.Join(root, "readonly")
	if err := os.Mkdir(ro, 0o500); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if os.Geteuid() == 0 {
		t.Log("running as root: skipping the read-only probe, which root bypasses")
		return
	}
	if err := CheckReceiveDir(ro); err == nil {
		t.Fatal("a directory this process cannot write was reported usable")
	}
}

func assertDirContains(t *testing.T, root string, want ...string) {
	t.Helper()
	got := map[string]bool{}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		got[filepath.ToSlash(rel)] = true
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	for _, w := range want {
		if !got[w] {
			t.Fatalf("expected %q under the receive directory; found %v", w, keys(got))
		}
		delete(got, w)
	}
	if len(got) != 0 {
		t.Fatalf("unexpected extra files under the receive directory: %v", keys(got))
	}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
