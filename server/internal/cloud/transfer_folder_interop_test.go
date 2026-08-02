package cloud

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/relayium/relayium/internal/storecrypto"
)

// The stored manifest has no path field and never will — it is frozen, and its
// ciphertext is pinned by golden vectors shared with the web and the native
// apps. Folder hierarchy therefore rides inside FileEntry.Name as a
// forward-slash relative path, which is what walkUploadPaths has always
// produced and what safeJoin has always read back.
//
// The macOS app now produces the same shape (apps/RelayiumKit's
// expandSelection + stageCloudFiles). These tests pin the convention on this
// side so a change here has to break a test rather than break the other client:
// the literals below are duplicated, deliberately and by value, in
// FileSelectionTests.swift and StoredManifestTests.swift.

// TestWalkUploadPathsNamesMatchNativeConvention pins the naming rule the native
// client mirrors: relative to the PARENT of each selected root, so the selected
// folder's own name survives; a bare file is just its basename.
func TestWalkUploadPathsNamesMatchNativeConvention(t *testing.T) {
	root := t.TempDir()
	write := func(rel string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("trip/day1/a.txt")
	write("trip/b.txt")
	write("loose.txt")

	files, err := walkUploadPaths([]string{
		filepath.Join(root, "trip"),
		filepath.Join(root, "loose.txt"),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, len(files))
	for i, f := range files {
		got[i] = f.name
	}
	// Order matters: it becomes manifest order. WalkDir sorts each directory's
	// ENTRIES and descends where the subdirectory sorts, so "b.txt" precedes
	// "day1/a.txt". The native walk reproduces exactly this — see
	// FileSelectionTests.swift's testWalkOrderMatchesTheGoCLIConvention, which
	// asserts the same list for the same tree.
	want := []string{"trip/b.txt", "trip/day1/a.txt", "loose.txt"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

// TestNestedManifestJSONBytes is the byte-level half of the interop claim: a
// forward slash is NOT escaped by encoding/json, so a nested name serialises
// identically here, in JS's JSON.stringify, and in the native client's
// hand-written serialiser. The identical literal is asserted in
// StoredManifestTests.swift's testNestedManifestJSONMatchesTheGoAndWebBytes.
func TestNestedManifestJSONBytes(t *testing.T) {
	m := storecrypto.Manifest{Files: []storecrypto.FileEntry{
		{Name: "trip/day1/a.txt", Size: 3},
		{Name: "loose.txt", Size: 0},
	}}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"files":[{"name":"trip/day1/a.txt","size":3},{"name":"loose.txt","size":0}]}`
	if string(b) != want {
		t.Fatalf("manifest JSON drifted:\n got %s\nwant %s", b, want)
	}
}

// TestNativeFolderManifestLandsAsATree proves the other direction of the same
// claim: a manifest carrying the names the macOS app now emits is written by
// this client as a real directory tree, not as flattened or escaped files.
func TestNativeFolderManifestLandsAsATree(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	files := []struct {
		name    string
		content string
	}{
		{"trip/day1/a.txt", "first"},
		{"trip/day1/b.txt", "second"},
		{"trip/notes.md", "notes"},
	}
	encManifest, blob := blobStreamFromFiles(t, raw, files)

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	dest := t.TempDir()
	paths, err := NewClient(srv.URL).Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 3 {
		t.Fatalf("expected 3 paths, got %v", paths)
	}
	for _, f := range files {
		got, err := os.ReadFile(filepath.Join(dest, filepath.FromSlash(f.name)))
		if err != nil {
			t.Fatalf("read %s: %v", f.name, err)
		}
		if string(got) != f.content {
			t.Fatalf("%s: got %q want %q", f.name, got, f.content)
		}
	}
	// The tree, not a flattening: the leaf names collide across directories and
	// both survive.
	if _, err := os.Stat(filepath.Join(dest, "trip", "day1")); err != nil {
		t.Fatalf("nested directory missing: %v", err)
	}
}
