package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storecrypto"
)

// resumableBlobServer serves /meta and a Range-capable /blob backed by `blob`,
// but the FIRST /blob request drops the connection after `cut` bytes (declaring
// the full length via ServeContent's Content-Length, so the client sees a short
// read). Subsequent requests — including the Range-resumed one — serve normally.
func resumableBlobServer(t *testing.T, encManifest, blob []byte, cut int) *httptest.Server {
	t.Helper()
	var firstBlob = true
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/meta"):
			writeJSONTest(w, map[string]any{
				"encManifest": base64.StdEncoding.EncodeToString(encManifest),
				"size":        len(blob),
			})
		case strings.HasSuffix(r.URL.Path, "/blob"):
			if firstBlob {
				firstBlob = false
				// Declare the full length, then send only `cut` bytes and hang up
				// → the client detects a short body and resumes.
				w.Header().Set("Content-Length", strconv.Itoa(len(blob)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(blob[:cut])
				return
			}
			// Range-capable for the resume: ServeContent honours the header.
			http.ServeContent(w, r, "blob", time.Time{}, bytes.NewReader(blob))
		default:
			http.NotFound(w, r)
		}
	}))
}

// TestDownloadResumesAfterMidStreamDrop is the core resume test: the first blob
// fetch dies partway through a multi-frame stream, and Download reconnects with
// a Range request and completes the files correctly.
func TestDownloadResumesAfterMidStreamDrop(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	// Two files so the plaintext spans several frames and a file boundary.
	c1 := strings.Repeat("A", 100)
	c2 := strings.Repeat("B", 100)
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"a.txt", c1}, {"b.txt", c2}})

	// Cut inside the first frame so ConsumedCipher stays 0 on the drop, forcing
	// the resume path to still recover cleanly from the frame boundary.
	srv := resumableBlobServer(t, encManifest, blob, 20)
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {} // no real backoff in tests
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatalf("resumed download failed: %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("paths = %v", paths)
	}
	got1, _ := os.ReadFile(filepath.Join(dest, "a.txt"))
	got2, _ := os.ReadFile(filepath.Join(dest, "b.txt"))
	if string(got1) != c1 || string(got2) != c2 {
		t.Fatalf("resumed content mismatch: a=%q b=%q", got1, got2)
	}
}

// TestDownloadResumesAcrossFrameBoundary cuts AFTER the first whole frame so the
// resume actually issues a Range request from a nonzero offset.
func TestDownloadResumesAcrossFrameBoundary(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	f1, _ := storecrypto.FrameChunk(raw, 1, []byte(strings.Repeat("A", 50)))
	f2, _ := storecrypto.FrameChunk(raw, 2, []byte(strings.Repeat("B", 50)))
	blob := append(append([]byte{}, f1...), f2...)
	m := storecrypto.Manifest{Files: []storecrypto.FileEntry{{Name: "big.txt", Size: 100}}}
	encManifest, err := storecrypto.EncryptManifest(raw, m)
	if err != nil {
		t.Fatal(err)
	}

	// Cut a few bytes into frame 2: frame 1 is fully consumed (ConsumedCipher =
	// len(f1)), so the resume Range starts at a nonzero, frame-aligned offset.
	srv := resumableBlobServer(t, encManifest, blob, len(f1)+5)
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	if _, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest); err != nil {
		t.Fatalf("download: %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(dest, "big.txt"))
	if string(got) != strings.Repeat("A", 50)+strings.Repeat("B", 50) {
		t.Fatalf("content = %q", got)
	}
}

// TestDownloadRecoversFromStalledBody: the first blob response starts streaming
// then freezes mid-body (no bytes, connection held open). The idle-timeout must
// detect the stall, drop the dead body, and let the resume loop reconnect and
// finish — rather than hanging forever, which is what removing the blanket
// Client.Timeout would otherwise allow.
func TestDownloadRecoversFromStalledBody(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	c1 := strings.Repeat("A", 100)
	c2 := strings.Repeat("B", 100)
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"a.txt", c1}, {"b.txt", c2}})

	firstBlob := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/meta"):
			writeJSONTest(w, map[string]any{
				"encManifest": base64.StdEncoding.EncodeToString(encManifest),
				"size":        len(blob),
			})
		case strings.HasSuffix(r.URL.Path, "/blob"):
			if firstBlob {
				firstBlob = false
				w.Header().Set("Content-Length", strconv.Itoa(len(blob)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(blob[:20])
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
				<-r.Context().Done() // freeze until the client abandons this body
				return
			}
			http.ServeContent(w, r, "blob", time.Time{}, bytes.NewReader(blob))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	c.idleTimeout = 100 * time.Millisecond // trip the stall guard quickly
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatalf("stalled download should recover via resume: %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("paths = %v", paths)
	}
	got1, _ := os.ReadFile(filepath.Join(dest, "a.txt"))
	got2, _ := os.ReadFile(filepath.Join(dest, "b.txt"))
	if string(got1) != c1 || string(got2) != c2 {
		t.Fatalf("recovered content mismatch: a=%q b=%q", got1, got2)
	}
}

// TestDownloadRetriesNodeTokenReuse: storage nodes now spend a download token on
// first use, so a duplicated request lands on a 403. That must be retried (the
// retry re-enters central and gets a fresh token), not reported as a fatal
// download failure the way every other 4xx is.
func TestDownloadRetriesNodeTokenReuse(t *testing.T) {
	raw, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	content := strings.Repeat("A", 100)
	encManifest, blob := blobStreamFromFiles(t, raw, []struct {
		name    string
		content string
	}{{"a.txt", content}})

	firstBlob := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/meta"):
			writeJSONTest(w, map[string]any{
				"encManifest": base64.StdEncoding.EncodeToString(encManifest),
				"size":        len(blob),
			})
		case strings.HasSuffix(r.URL.Path, "/blob"):
			if firstBlob {
				firstBlob = false
				http.Error(w, "this download link was already used", http.StatusForbidden)
				return
			}
			http.ServeContent(w, r, "blob", time.Time{}, bytes.NewReader(blob))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	dest := t.TempDir()
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	paths, err := c.Download(context.Background(), "abc", storecrypto.EncodeKey(raw), dest)
	if err != nil {
		t.Fatalf("a 403 on the first blob fetch must be retried, got: %v", err)
	}
	if len(paths) != 1 {
		t.Fatalf("paths = %v", paths)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "a.txt")); string(got) != content {
		t.Fatalf("content mismatch after retry: %q", got)
	}
}
