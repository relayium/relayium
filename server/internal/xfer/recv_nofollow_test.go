//go:build !windows

package xfer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A pre-planted symlink at the destination path must not be followed: the write
// is refused (O_NOFOLLOW) and the symlink's target is left untouched.
func TestWriteFileBodyRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "evil")
	if err := os.Symlink(outside, dest); err != nil {
		t.Fatal(err)
	}

	_, _, err := writeFileBody(strings.NewReader("attacker"), dir, dest, FileEntry{Size: 8, Mode: 0o644}, 0)
	if err == nil {
		t.Fatal("writeFileBody followed a pre-planted symlink; want refusal")
	}
	if got, _ := os.ReadFile(outside); string(got) != "original" {
		t.Fatalf("symlink target was overwritten: %q", got)
	}
}

// A pre-planted symlinked *directory* under destDir must not let a write escape:
// safeJoin's lexical check passes, but ensureWithin catches the resolved parent
// landing outside destDir.
func TestWriteFileBodyRefusesSymlinkedDir(t *testing.T) {
	destDir := t.TempDir()
	outside := t.TempDir() // an existing directory outside destDir
	// destDir/sub -> outside
	if err := os.Symlink(outside, filepath.Join(destDir, "sub")); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(destDir, "sub", "file.txt") // lexically inside destDir

	_, _, err := writeFileBody(strings.NewReader("attacker"), destDir, dest, FileEntry{Size: 8, Mode: 0o644}, 0)
	if err == nil {
		t.Fatal("write via a symlinked directory should be refused")
	}
	if _, statErr := os.Stat(filepath.Join(outside, "file.txt")); statErr == nil {
		t.Fatal("write escaped destDir into the symlink target")
	}
}

// A normal nested write within destDir must still succeed.
func TestWriteFileBodyAllowsNormalNested(t *testing.T) {
	destDir := t.TempDir()
	dest := filepath.Join(destDir, "a", "b", "file.txt")
	sum, staged, err := writeFileBody(strings.NewReader("hello"), destDir, dest, FileEntry{Size: 5, Mode: 0o644}, 0)
	if err != nil {
		t.Fatalf("normal nested write failed: %v", err)
	}
	if err := os.Rename(staged, dest); err != nil {
		t.Fatalf("install staged file: %v", err)
	}
	if got, _ := os.ReadFile(dest); string(got) != "hello" {
		t.Fatalf("content = %q, want hello (sum=%s)", got, sum)
	}
}
