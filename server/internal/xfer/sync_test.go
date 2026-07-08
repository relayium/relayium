package xfer

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFileMtime(t *testing.T, path, body string, mtime int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	tm := time.Unix(mtime, 0)
	if err := os.Chtimes(path, tm, tm); err != nil {
		t.Fatal(err)
	}
}

func TestSyncStateForSkipsUnchanged(t *testing.T) {
	dst := t.TempDir()
	// Manifest declares three files.
	m := Manifest{Files: []FileEntry{
		{Path: "a.txt", Size: 5, ModTime: 1000}, // identical on disk → skip
		{Path: "b.txt", Size: 9, ModTime: 2000}, // different content/size → send
		{Path: "c.txt", Size: 4, ModTime: 3000}, // absent on disk → send
	}}
	writeFileMtime(t, filepath.Join(dst, "a.txt"), "hello", 1000) // size 5, mtime 1000 → match
	writeFileMtime(t, filepath.Join(dst, "b.txt"), "old", 1500)   // size 3 != 9 → send

	rs := syncStateFor(dst, m)
	if len(rs.Skip) != 1 || rs.Skip[0] != 0 {
		t.Fatalf("Skip = %v, want [0] (a.txt unchanged)", rs.Skip)
	}
}
