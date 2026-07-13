package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// tarGzWith builds a gzip+tar archive containing a single regular file named
// "relayium" with the given content — the shape goreleaser produces for the
// Unix archives.
func tarGzWith(t *testing.T, content string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte(content)
	if err := tw.WriteHeader(&tar.Header{Name: "relayium", Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sha256hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// fakeRelease serves a GitHub-shaped release: the releases/latest API plus the
// per-tag download assets. checksumOverride, when non-empty, replaces the real
// archive digest in checksums.txt so a mismatch can be exercised.
type fakeRelease struct {
	tag             string
	asset           string
	archive         []byte
	checksumOverride string
	assetStatus     int // 0 → 200
}

func (f *fakeRelease) server(t *testing.T) *httptest.Server {
	t.Helper()
	sum := f.checksumOverride
	if sum == "" {
		sum = sha256hex(f.archive)
	}
	checksums := fmt.Sprintf("%s  %s\n", sum, f.asset)
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/relayium/relayium/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"tag_name":%q}`, f.tag)
	})
	base := "/relayium/relayium/releases/download/" + f.tag
	mux.HandleFunc(base+"/"+f.asset, func(w http.ResponseWriter, r *http.Request) {
		if f.assetStatus != 0 {
			w.WriteHeader(f.assetStatus)
			return
		}
		w.Write(f.archive)
	})
	mux.HandleFunc(base+"/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, checksums)
	})
	// sig/pem intentionally 404 (default mux) — cosign is absent in tests, so
	// Update takes the checksum-only path.
	return httptest.NewServer(mux)
}

func baseOpts(srv *httptest.Server, target string) Options {
	return Options{
		Repo:           "relayium/relayium",
		CurrentVersion: "v0.0.1",
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		TargetPath:     target,
		APIBase:        srv.URL,
		DownloadBase:   srv.URL,
	}
}

func writeTarget(t *testing.T, content string) string {
	t.Helper()
	// The replacement rename must be same-filesystem as the target, and the
	// impl writes its temp file into the target's dir, so a plain temp file
	// (whose dir is writable) exercises the real path.
	p := filepath.Join(t.TempDir(), "relayium")
	if err := os.WriteFile(p, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestUpdateHappyPath(t *testing.T) {
	newBin := "NEW-BINARY-v9.9.9"
	fr := &fakeRelease{tag: "v9.9.9", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, newBin)}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	from, to, changed, err := Update(context.Background(), baseOpts(srv, target), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || from != "v0.0.1" || to != "v9.9.9" {
		t.Fatalf("from=%q to=%q changed=%v", from, to, changed)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != newBin {
		t.Fatalf("target content = %q, want %q", got, newBin)
	}
	if info, _ := os.Stat(target); info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("replaced binary is not executable: %v", info.Mode())
	}
}

func TestUpdateAlreadyLatest(t *testing.T) {
	fr := &fakeRelease{tag: "v9.9.9", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "NEW")}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	o := baseOpts(srv, target)
	o.CurrentVersion = "v9.9.9"

	_, to, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if changed || to != "v9.9.9" {
		t.Fatalf("expected no change; to=%q changed=%v", to, changed)
	}
	if got, _ := os.ReadFile(target); string(got) != "OLD" {
		t.Fatalf("target was touched: %q", got)
	}

	// --force installs even when already on the latest tag.
	o.Force = true
	_, _, changed, err = Update(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("--force should have reinstalled")
	}
	if got, _ := os.ReadFile(target); string(got) != "NEW" {
		t.Fatalf("force update did not replace: %q", got)
	}
}

func TestUpdateChecksumMismatch(t *testing.T) {
	fr := &fakeRelease{
		tag:              "v9.9.9",
		asset:            AssetName(runtime.GOOS, runtime.GOARCH),
		archive:          tarGzWith(t, "NEW"),
		checksumOverride: strings.Repeat("0", 64),
	}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	_, _, changed, err := Update(context.Background(), baseOpts(srv, target), io.Discard)
	if err == nil {
		t.Fatal("expected a checksum-mismatch error")
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("error = %v, want checksum mismatch", err)
	}
	if changed {
		t.Fatal("changed should be false on failure")
	}
	if got, _ := os.ReadFile(target); string(got) != "OLD" {
		t.Fatalf("target must be untouched on a failed verify, got %q", got)
	}
}

func TestUpdateAssetNotFound(t *testing.T) {
	fr := &fakeRelease{
		tag:         "v9.9.9",
		asset:       AssetName(runtime.GOOS, runtime.GOARCH),
		archive:     tarGzWith(t, "NEW"),
		assetStatus: http.StatusNotFound,
	}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	_, _, _, err := Update(context.Background(), baseOpts(srv, target), io.Discard)
	if err == nil {
		t.Fatal("expected a download error for a missing asset")
	}
	if got, _ := os.ReadFile(target); string(got) != "OLD" {
		t.Fatalf("target must be untouched, got %q", got)
	}
}

// TestUpdateAlreadyLatestPrefixNormalized guards the v-prefix mismatch:
// goreleaser sets main.version to {{.Version}} (no leading "v", e.g. "0.3.1")
// while the release tag_name is "v0.3.1". A naive == would re-download every
// run; already-latest detection must normalize the prefix.
func TestUpdateAlreadyLatestPrefixNormalized(t *testing.T) {
	fr := &fakeRelease{tag: "v0.3.1", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "NEW")}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	o := baseOpts(srv, target)
	o.CurrentVersion = "0.3.1" // no "v", as an installed release build reports

	_, _, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("0.3.1 vs tag v0.3.1 must be treated as already up to date")
	}
	if got, _ := os.ReadFile(target); string(got) != "OLD" {
		t.Fatalf("target must be untouched, got %q", got)
	}

	if !SameVersion("0.3.1", "v0.3.1") || !SameVersion("v1.2.3", "1.2.3") {
		t.Fatal("SameVersion should ignore a leading v")
	}
	if SameVersion("dev", "v0.3.1") {
		t.Fatal("a dev build is never equal to a release tag")
	}
}

func TestLatestTag(t *testing.T) {
	fr := &fakeRelease{tag: "v1.2.3", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "x")}
	srv := fr.server(t)
	defer srv.Close()
	tag, err := LatestTag(context.Background(), baseOpts(srv, ""))
	if err != nil {
		t.Fatal(err)
	}
	if tag != "v1.2.3" {
		t.Fatalf("tag = %q, want v1.2.3", tag)
	}
}

func TestAssetName(t *testing.T) {
	if got := AssetName("darwin", "arm64"); got != "relayium_darwin_arm64.tar.gz" {
		t.Fatalf("AssetName = %q", got)
	}
}
