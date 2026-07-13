package cloud

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storecrypto"
)

// TestDownloadReportsProgress checks that Download drives the Progress callback
// and that the final report reaches (total, total) with the plaintext size.
func TestDownloadReportsProgress(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	content := strings.Repeat("x", 5000)
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"big.txt", content}})
	srv := fakeCloudServer(encManifest, blob)
	defer srv.Close()

	var calls int
	var lastDone, lastTotal int64
	c := NewClient(srv.URL)
	c.Progress = func(done, total int64) { calls++; lastDone, lastTotal = done, total }

	if _, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if calls == 0 {
		t.Fatal("Progress was never called")
	}
	if lastTotal != int64(len(content)) {
		t.Fatalf("final total = %d, want %d", lastTotal, len(content))
	}
	if lastDone != lastTotal {
		t.Fatalf("final done = %d, want total %d", lastDone, lastTotal)
	}
}

// TestUploadReportsProgress checks the same for Upload: the callback fires and
// ends at (total, total) with the summed source-file size.
func TestUploadReportsProgress(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		writeJSONTest(w, map[string]any{"id": "x", "expiresAt": 1})
	}))
	defer srv.Close()

	p := filepath.Join(t.TempDir(), "f.bin")
	if err := os.WriteFile(p, []byte(strings.Repeat("y", 4096)), 0o644); err != nil {
		t.Fatal(err)
	}

	var calls int
	var lastDone, lastTotal int64
	c := NewClient(srv.URL)
	c.Token = "t"
	c.Progress = func(done, total int64) { calls++; lastDone, lastTotal = done, total }

	if _, _, err := c.Upload(context.Background(), []string{p}, UploadOpts{}); err != nil {
		t.Fatal(err)
	}
	if calls == 0 {
		t.Fatal("Progress was never called")
	}
	if lastTotal != 4096 {
		t.Fatalf("final total = %d, want 4096", lastTotal)
	}
	if lastDone != 4096 {
		t.Fatalf("final done = %d, want 4096", lastDone)
	}
}
