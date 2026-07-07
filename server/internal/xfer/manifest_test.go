package xfer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildManifestWalksDir(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("aaa"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "b.txt"), []byte("bb"), 0o644); err != nil {
		t.Fatal(err)
	}

	m, srcs, err := BuildManifest([]string{root})
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	if len(m.Files) != 2 || len(srcs) != 2 {
		t.Fatalf("want 2 files, got %d (srcs %d)", len(m.Files), len(srcs))
	}
	base := filepath.Base(root)
	byPath := map[string]FileEntry{}
	for _, f := range m.Files {
		byPath[f.Path] = f
	}
	if e, ok := byPath[base+"/a.txt"]; !ok || e.Size != 3 {
		t.Fatalf("a.txt entry wrong: %+v ok=%v", e, ok)
	}
	if _, ok := byPath[base+"/sub/b.txt"]; !ok {
		t.Fatalf("sub/b.txt missing; got %+v", m.Files)
	}
}
