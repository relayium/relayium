package cloud

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storecrypto"
)

// blobStreamFromFiles builds the ciphertext blob a real upload would produce
// for files (name -> content), one global seq counter starting at 1 (seq 0
// is the manifest, per EncryptManifest/writeUploadBody), and the matching
// encrypted manifest — everything a fake meta/blob server needs to hand
// back to Download.
func blobStreamFromFiles(t *testing.T, key []byte, files []struct {
	name    string
	content string
}) (encManifest []byte, blob []byte) {
	t.Helper()
	m := storecrypto.Manifest{Files: make([]storecrypto.FileEntry, len(files))}
	for i, f := range files {
		m.Files[i] = storecrypto.FileEntry{Name: f.name, Size: int64(len(f.content))}
	}
	var err error
	encManifest, err = storecrypto.EncryptManifest(key, m)
	if err != nil {
		t.Fatal(err)
	}
	seq := uint64(1)
	for _, f := range files {
		if len(f.content) == 0 {
			continue // writeUploadBody emits no frame at all for an empty file
		}
		frame, err := storecrypto.FrameChunk(key, seq, []byte(f.content))
		if err != nil {
			t.Fatal(err)
		}
		seq++
		blob = append(blob, frame...)
	}
	return encManifest, blob
}

// fakeCloudServer serves /meta and /blob for a single fixed id from the given
// encManifest/blob bytes.
func fakeCloudServer(encManifest, blob []byte) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/meta"):
			writeJSONTest(w, map[string]any{
				"encManifest": base64.StdEncoding.EncodeToString(encManifest),
				"size":        len(blob),
			})
		case strings.HasSuffix(r.URL.Path, "/blob"):
			_, _ = w.Write(blob)
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestDownloadRoundTrip(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"hello.txt", "hello world"}})

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != filepath.Join(dest, "hello.txt") {
		t.Fatalf("paths: %v", paths)
	}
	got, err := os.ReadFile(filepath.Join(dest, "hello.txt"))
	if err != nil || string(got) != "hello world" {
		t.Fatalf("download: %q %v", got, err)
	}
}

// TestDownloadMultiFile exercises the byte router across a file boundary
// that falls in the middle of a single ciphertext frame's plaintext (the
// second file is smaller than storecrypto.ChunkSize, so both land in one
// frame), plus a zero-size file that gets no ciphertext frame at all — it
// must still be created as an empty file, both mid-stream (before the last
// file) and if it were trailing (covered by the "empty.txt" placement).
func TestDownloadMultiFile(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	files := []struct {
		name    string
		content string
	}{
		{"a.txt", "first file contents"},
		{"sub/empty.txt", ""},
		{"b/second.txt", "second file, in a subdirectory"},
	}
	encManifest, blob := blobStreamFromFiles(t, raw, files)

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
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
}

// TestDownloadTrailingEmptyFile covers a zero-size file as the LAST manifest
// entry: no Push call ever touches it (writeUploadBody emits no frame for an
// empty file), so it can only be created by the post-stream finish() flush.
func TestDownloadTrailingEmptyFile(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	files := []struct {
		name    string
		content string
	}{
		{"a.txt", "content"},
		{"trailing-empty.txt", ""},
	}
	encManifest, blob := blobStreamFromFiles(t, raw, files)

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 {
		t.Fatalf("expected 2 paths, got %v", paths)
	}
	info, err := os.Stat(filepath.Join(dest, "trailing-empty.txt"))
	if err != nil {
		t.Fatalf("trailing empty file was not created: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("trailing empty file: size %d, want 0", info.Size())
	}
}

// TestDownloadWrongKeyDistinctError verifies a decrypt/integrity failure
// (wrong key here) produces a message distinguishable from a network error —
// the CLI needs to tell the user "your link's key is wrong" apart from
// "your connection dropped".
func TestDownloadWrongKeyDistinctError(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	wrong, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"hello.txt", "hello world"}})

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	_, err = c.Download(context.Background(), "abc", storecrypto.EncodeKey(wrong), dest)
	if err == nil {
		t.Fatal("expected an error with the wrong key")
	}
	if !strings.Contains(err.Error(), "decrypt failed") {
		t.Fatalf("expected a decrypt-failure error, got: %v", err)
	}
	if strings.Contains(err.Error(), "network") {
		t.Fatalf("decrypt failure must not be reported as a network error: %v", err)
	}
}

// TestDownloadNetworkErrorDistinctFromDecrypt verifies a mid-stream network
// read failure is reported distinctly from a decrypt/integrity failure, even
// though both currently propagate through the same Decryptor.Push call in
// Download's read loop. The truncated bytes sent are a genuine PREFIX of a
// real frame (valid 4-byte length header + partial ciphertext) — Push just
// buffers an incomplete frame for that, no error — so the only way this can
// fail is via the deliberate Content-Length lie that makes net/http's
// transport report an unexpected-EOF read error.
func TestDownloadNetworkErrorDistinctFromDecrypt(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	m := storecrypto.Manifest{Files: []storecrypto.FileEntry{{Name: "hello.txt", Size: 11}}}
	encManifest, err := storecrypto.EncryptManifest(raw, m)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := storecrypto.FrameChunk(raw, 1, []byte("hello world"))
	if err != nil {
		t.Fatal(err)
	}
	truncated := frame[:10] // header + a few ciphertext bytes; a valid incomplete-frame prefix

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/meta"):
			writeJSONTest(w, map[string]any{
				"encManifest": base64.StdEncoding.EncodeToString(encManifest),
				"size":        len(frame),
			})
		case strings.HasSuffix(r.URL.Path, "/blob"):
			// Declare the full frame length via Content-Length, then only send
			// the truncated prefix and hang up: net/http's transport detects the
			// short body and surfaces a read error distinct from any GCM
			// auth/decrypt failure.
			w.Header().Set("Content-Length", strconv.Itoa(len(frame)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(truncated)
		}
	}))
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	_, err = c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err == nil {
		t.Fatal("expected a network error")
	}
	if !strings.Contains(err.Error(), "network error") {
		t.Fatalf("expected a network-error message, got: %v", err)
	}
	if strings.Contains(err.Error(), "decrypt failed") {
		t.Fatalf("network failure must not be reported as a decrypt failure: %v", err)
	}
}

// TestDownloadZipSlip verifies a malicious manifest entry that tries to
// escape destDir via ".." never writes outside destDir. Mirroring xfer's
// safeJoin (internal/xfer/recv.go), the escaping prefix is neutralized
// (filepath.Clean("/"+rel) clamps ".." at the root) rather than rejected
// outright, so the file lands inside destDir under its cleaned name instead
// of at destDir's parent — either way, nothing must land outside destDir.
func TestDownloadZipSlip(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	m := storecrypto.Manifest{Files: []storecrypto.FileEntry{{Name: "../../evil.txt", Size: 4}}}
	encManifest, err := storecrypto.EncryptManifest(raw, m)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := storecrypto.FrameChunk(raw, 1, []byte("evil"))
	if err != nil {
		t.Fatal(err)
	}

	srv := fakeCloudServer(encManifest, frame)
	defer srv.Close()

	parent := t.TempDir()
	dest := filepath.Join(parent, "dest")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}

	c := NewClient(srv.URL)
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(filepath.Join(parent, "evil.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("Zip-Slip: file escaped destDir into its parent: %v", statErr)
	}
	if len(paths) != 1 {
		t.Fatalf("expected exactly one written path, got %v", paths)
	}
	absDest, err := filepath.Abs(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(paths[0], absDest+string(filepath.Separator)) {
		t.Fatalf("Zip-Slip: written path %q escaped destDir %q", paths[0], absDest)
	}
	got, err := os.ReadFile(paths[0])
	if err != nil || string(got) != "evil" {
		t.Fatalf("clamped file: %q %v", got, err)
	}
}

// TestDownloadLeafSymlinkNotFollowed verifies that a symlink pre-planted in
// destDir at the exact name a manifest entry targets (notes.txt -> an outside
// file) is refused via O_NOFOLLOW, so the outside file is never overwritten
// with decrypted bytes. Mirrors the receive path's hardening (commit a4bc65d).
func TestDownloadLeafSymlinkNotFollowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("O_NOFOLLOW is a no-op on Windows")
	}
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"notes.txt", "hello world"}})

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	root := t.TempDir()
	dest := filepath.Join(root, "dest")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outside, []byte("ORIGINAL"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Pre-plant a leaf symlink at the manifest's target name.
	if err := os.Symlink(outside, filepath.Join(dest, "notes.txt")); err != nil {
		t.Fatal(err)
	}

	c := NewClient(srv.URL)
	_, err = c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err == nil {
		t.Fatal("expected Download to refuse the pre-planted leaf symlink")
	}
	got, rerr := os.ReadFile(outside)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if string(got) != "ORIGINAL" {
		t.Fatalf("outside file was overwritten through the symlink: %q", got)
	}
}

// TestDownloadParentSymlinkNotFollowed verifies that a symlinked *directory*
// pre-planted under destDir (cfg -> an outside dir) is refused via
// ensureWithin, so a manifest naming cfg/authorized_keys never writes into the
// outside directory.
func TestDownloadParentSymlinkNotFollowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink-based test not applicable on Windows")
	}
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"cfg/authorized_keys", "ssh-rsa PWNED"}})

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	root := t.TempDir()
	dest := filepath.Join(root, "dest")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	outsideDir := filepath.Join(root, "outsideDir")
	if err := os.Mkdir(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Pre-plant a symlinked directory under destDir.
	if err := os.Symlink(outsideDir, filepath.Join(dest, "cfg")); err != nil {
		t.Fatal(err)
	}

	c := NewClient(srv.URL)
	_, err = c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err == nil {
		t.Fatal("expected Download to refuse the symlinked parent directory")
	}
	if _, statErr := os.Stat(filepath.Join(outsideDir, "authorized_keys")); !os.IsNotExist(statErr) {
		t.Fatalf("file was written into the outside dir through the symlinked parent: %v", statErr)
	}
}

func TestParseClaim(t *testing.T) {
	srv, id, key, err := ParseClaim("https://relayium.com/d/abc123#k=deadbeef")
	if err != nil || srv != "https://relayium.com" || id != "abc123" || key != "deadbeef" {
		t.Fatalf("parse full link: %q %q %q %v", srv, id, key, err)
	}

	srv2, id2, key2, err2 := ParseClaim("abc123#k=deadbeef")
	if err2 != nil || srv2 != "" || id2 != "abc123" || key2 != "deadbeef" {
		t.Fatalf("parse bare code: %q %q %q %v", srv2, id2, key2, err2)
	}
}

func TestParseClaimRejectsMalformed(t *testing.T) {
	cases := []string{
		"",
		"abc123",                // no fragment at all
		"abc123#deadbeef",       // missing k= prefix
		"abc123#k=",             // empty key
		"https://x.com/d/#k=y",  // empty id in a full link
		"https://x.com/foo#k=y", // not a /d/ path
	}
	for _, s := range cases {
		if _, _, _, err := ParseClaim(s); err == nil {
			t.Errorf("ParseClaim(%q): expected an error, got none", s)
		}
	}
}

// TestDownloadWriteFailureDistinctFromDecrypt verifies a local filesystem
// write failure (here: destDir doesn't exist and can't be created because a
// same-named file is in the way) is not misreported as a decrypt/integrity
// failure.
func TestDownloadWriteFailureDistinctFromDecrypt(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"hello.txt", "hello world"}})

	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	parent := t.TempDir()
	// destDir's parent path component is a regular file, so MkdirAll under it
	// must fail — a plain local I/O error, not a crypto one.
	blocker := filepath.Join(parent, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(blocker, "dest")

	c := NewClient(srv.URL)
	_, err = c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err == nil {
		t.Fatal("expected a write error")
	}
	if strings.Contains(err.Error(), "decrypt failed") {
		t.Fatalf("write failure must not be reported as a decrypt failure: %v", err)
	}
	var pathErr *os.PathError
	if !errors.As(err, &pathErr) && !strings.Contains(err.Error(), "write file") {
		t.Fatalf("expected a write-file error, got: %v", err)
	}
}
