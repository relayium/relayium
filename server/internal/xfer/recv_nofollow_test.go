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

	_, err := writeFileBody(strings.NewReader("attacker"), dest, FileEntry{Size: 8, Mode: 0o644}, 0)
	if err == nil {
		t.Fatal("writeFileBody followed a pre-planted symlink; want refusal")
	}
	if got, _ := os.ReadFile(outside); string(got) != "original" {
		t.Fatalf("symlink target was overwritten: %q", got)
	}
}
