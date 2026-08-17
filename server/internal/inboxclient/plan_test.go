package inboxclient

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/inboxmanifest"
)

func entries(names ...string) []inboxmanifest.Item {
	out := make([]inboxmanifest.Item, len(names))
	for i, n := range names {
		out[i] = inboxmanifest.Item{Kind: inboxmanifest.KindFile, Name: n, Size: 1}
	}
	return out
}

// TestPlanRejectsHostileNames is the traversal/confusable boundary. Each of
// these decrypts and authenticates perfectly — AEAD says only that the sender
// built it, and the sender is another machine. A name is an instruction to this
// filesystem, so each one has to be refused by NAME, before any path is built.
func TestPlanRejectsHostileNames(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name string
		why  string
	}{
		{"../escape.txt", "parent traversal"},
		{"a/../../escape.txt", "traversal after a legitimate component"},
		{"/etc/passwd", "absolute path"},
		{"//etc/passwd", "double-slash absolute"},
		{`C:\Windows\System32\drivers\etc\hosts`, "windows drive path"},
		{`sub\file.txt`, "backslash as a separator"},
		{"a//b.txt", "empty component"},
		{"./file.txt", "dot component"},
		{"a/./b.txt", "interior dot component"},
		{"file\x00.txt", "embedded NUL"},
		{"file\n.txt", "embedded newline"},
		{"trailing.", "component ending in a dot"},
		{"trailing ", "component ending in a space"},
		{"CON", "windows reserved device name"},
		{"nul.txt", "windows reserved device name with an extension"},
		{"COM1.log", "windows reserved device name, numbered"},
		{"", "empty name"},
		{strings.Repeat("a/", 40) + "deep.txt", "excessive nesting"},
		{strings.Repeat("x", inboxmanifest.MaxNameBytes+1), "over-long name"},
	}
	for _, tc := range cases {
		t.Run(tc.why, func(t *testing.T) {
			_, err := PlanDestinations(root, entries(tc.name), PathExists)
			if err == nil {
				t.Fatalf("planned a destination for %q (%s); it must be refused", tc.name, tc.why)
			}
			if !errors.Is(err, ErrUnsafeName) {
				t.Fatalf("%q rejected with %v, want ErrUnsafeName", tc.name, err)
			}
		})
	}
}

// TestPlanRejectsThisPackagesOwnEntries. Two names in the receive directory
// belong to the receiver, and a manifest naming either would be destroyed rather
// than delivered — silently, while reporting success:
//
//   - `.relayium-incoming/...` would place a file ON its own staged source, so
//     the commit links it to itself and then unlinks it. `saved`, and nothing
//     there.
//   - `.relayium-inbox-probe` would be deleted by the next readiness probe,
//     which removes a stale probe file it assumes it left behind.
//
// Neither is a traversal, and neither would be caught by any other rule.
func TestPlanRejectsThisPackagesOwnEntries(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{
		stagingDirName,
		stagingDirName + "/task-1/0.part",
		probeName,
	} {
		_, err := PlanDestinations(root, entries(name), PathExists)
		if !errors.Is(err, ErrUnsafeName) {
			t.Fatalf("PlanDestinations(%q) = %v, want ErrUnsafeName", name, err)
		}
	}
	// A name that merely LOOKS similar is still ordinary and must be delivered.
	if _, err := PlanDestinations(root, entries(".relayium-incoming-notes.txt"), PathExists); err != nil {
		t.Fatalf("a legitimate name resembling the reserved one was refused: %v", err)
	}
}

// TestPlanAcceptsOrdinaryNames guards against the rules above becoming so strict
// that real files stop arriving. A refusal that is too broad is a silent
// delivery failure, which is its own kind of wrong.
func TestPlanAcceptsOrdinaryNames(t *testing.T) {
	root := t.TempDir()
	names := []string{
		"notes.txt", "photos/2026/holiday.jpg", ".bashrc", "backup.tar.gz",
		"réunion — notes.md", "日本語のファイル.txt", "a.b.c.d", "file with spaces.pdf",
	}
	plan, err := PlanDestinations(root, entries(names...), PathExists)
	if err != nil {
		t.Fatalf("ordinary names were refused: %v", err)
	}
	if len(plan) != len(names) {
		t.Fatalf("planned %d entries, want %d", len(plan), len(names))
	}
	for i, e := range plan {
		if !strings.HasPrefix(e.Dest, root+string(filepath.Separator)) {
			t.Fatalf("entry %d destination %q is outside the receive directory", i, e.Dest)
		}
	}
}

// TestPlanRejectsDuplicateAndConfusableDestinations covers two entries that
// would land on one file. Exact duplicates are unambiguous; case-only
// differences are the interesting one, because on APFS/NTFS they silently
// collapse and one of the two files is lost with no error anywhere.
func TestPlanRejectsDuplicateAndConfusableDestinations(t *testing.T) {
	root := t.TempDir()
	if _, err := PlanDestinations(root, entries("a.txt", "a.txt"), PathExists); err == nil {
		t.Fatal("planned two entries onto one destination")
	}
	_, err := PlanDestinations(root, entries("Report.PDF", "report.pdf"), PathExists)
	if err == nil {
		t.Fatal("planned two case-only-different entries; a case-insensitive filesystem would lose one")
	}
	if !errors.Is(err, ErrUnsafeName) {
		t.Fatalf("case collision rejected with %v, want ErrUnsafeName", err)
	}
}

// TestPlanRenamesAroundExistingFiles is the PRD §9 automatic-collision rule.
// Existing user files are never candidates for overwrite; the plan walks a
// deterministic "name (2)", "name (3)" sequence around them.
func TestPlanRenamesAroundExistingFiles(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "report.pdf"), "existing")
	write(t, filepath.Join(root, "report (2).pdf"), "also existing")

	plan, err := PlanDestinations(root, entries("report.pdf"), PathExists)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	want := filepath.Join(root, "report (3).pdf")
	if plan[0].Dest != want {
		t.Fatalf("destination = %q, want %q", plan[0].Dest, want)
	}
	// Determinism: the same manifest against the same directory must produce the
	// same plan, or a resumed task cannot compare its journal against reality.
	again, err := PlanDestinations(root, entries("report.pdf"), PathExists)
	if err != nil || again[0].Dest != want {
		t.Fatalf("plan is not deterministic: %q then %q (%v)", plan[0].Dest, again[0].Dest, err)
	}
}

// TestPlanTreatsSymlinksAndSpecialFilesAsOccupied is the "never write through
// something that is not a plain file" rule. A dangling symlink is not a free
// name — following it is how a delivery ends up appending to ~/.ssh/authorized_keys.
func TestPlanTreatsSymlinksAndSpecialFilesAsOccupied(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	write(t, outside, "not to be touched")

	if err := os.Symlink(outside, filepath.Join(root, "link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// A DANGLING symlink is the sharper case: os.Stat says "not there".
	if err := os.Symlink(filepath.Join(root, "nowhere"), filepath.Join(root, "dangling.txt")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	plan, err := PlanDestinations(root, entries("link.txt", "dangling.txt"), PathExists)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	for _, e := range plan {
		if e.Dest == filepath.Join(root, e.Name) {
			t.Fatalf("entry %q was planned onto the existing symlink itself", e.Name)
		}
		if !strings.Contains(filepath.Base(e.Dest), " (2)") {
			t.Fatalf("entry %q was planned as %q; want a deterministic collision rename", e.Name, e.Dest)
		}
	}
	if got := read(t, outside); got != "not to be touched" {
		t.Fatalf("the symlink target was modified: %q", got)
	}
}

// TestCollisionNamePreservesExtension pins the rename shape. A "report (2)" that
// lost its ".pdf" stops opening in the right application and the user cannot
// tell what it is, so the extension is part of the requirement, not polish.
func TestCollisionNamePreservesExtension(t *testing.T) {
	cases := []struct{ in, want string }{
		{"report.pdf", "report (2).pdf"},
		{"notes", "notes (2)"},
		{".bashrc", ".bashrc (2)"},
		{"backup.tar.gz", "backup (2).tar.gz"},
		{"archive.tar.zst", "archive (2).tar.zst"},
		{"a.b.c", "a.b (2).c"},
		{"trailing.dot.", "trailing.dot. (2)"},
	}
	for _, tc := range cases {
		if got := collisionName(tc.in, 2); got != tc.want {
			t.Errorf("collisionName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestPlanFailsWhenEveryCandidateNameIsTaken proves the collision search is
// bounded and fails with the code a human can act on rather than scanning
// forever.
func TestPlanFailsWhenEveryCandidateNameIsTaken(t *testing.T) {
	root := t.TempDir()
	// A synthetic "everything exists" oracle: cheaper and more decisive than
	// creating a thousand real files, and it exercises the bound exactly.
	always := func(string) bool { return true }
	_, err := PlanDestinations(root, entries("busy.txt"), always)
	if !errors.Is(err, ErrNameConflict) {
		t.Fatalf("plan error = %v, want ErrNameConflict", err)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
