package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
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

// TestMain forces the embedded release key empty by default so the download /
// replace-path tests exercise the checksum-only path deterministically,
// independent of whatever production key release_pubkey.go carries. Signature
// tests set releaseSigningPubKeyPEM themselves (and restore it).
func TestMain(m *testing.M) {
	releaseSigningPubKeyPEM = ""
	os.Exit(m.Run())
}

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
	// signKey, when set, serves a valid checksums.txt.sig (ECDSA over the served
	// checksums bytes), mirroring the release workflow's openssl signing step.
	signKey *ecdsa.PrivateKey
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
	if f.signKey != nil {
		h := sha256.Sum256([]byte(checksums))
		sig, err := ecdsa.SignASN1(rand.Reader, f.signKey, h[:])
		if err != nil {
			t.Fatal(err)
		}
		mux.HandleFunc(base+"/checksums.txt.sig", func(w http.ResponseWriter, r *http.Request) {
			w.Write(sig)
		})
	}
	// When signKey is nil, checksums.txt.sig 404s (default mux): with no embedded
	// key that's the checksum-only path; with a key embedded it's fail-closed.
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

// pubPEM returns k's public half as a PKIX PEM block (the format openssl emits
// and parseECDSAPublicKey/release_pubkey.go expect).
func pubPEM(t *testing.T, k *ecdsa.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

// withEmbeddedKey sets the package release verification key for one test.
func withEmbeddedKey(t *testing.T, pemStr string) {
	t.Helper()
	prev := releaseSigningPubKeyPEM
	releaseSigningPubKeyPEM = pemStr
	t.Cleanup(func() { releaseSigningPubKeyPEM = prev })
}

// With a key embedded and a valid signature served, the update verifies the
// signature (not just the checksum) and installs.
func TestUpdateVerifiesReleaseSignature(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	withEmbeddedKey(t, pubPEM(t, key))
	newBin := "SIGNED-v9.9.9"
	fr := &fakeRelease{tag: "v9.9.9", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, newBin), signKey: key}
	srv := fr.server(t)
	defer srv.Close()

	var out bytes.Buffer
	_, _, changed, err := Update(context.Background(), baseOpts(srv, writeTarget(t, "OLD")), &out)
	if err != nil || !changed {
		t.Fatalf("signed update should succeed: changed=%v err=%v", changed, err)
	}
	if !strings.Contains(out.String(), "Verified release signature") {
		t.Fatalf("expected a signature-verified message, got %q", out.String())
	}
}

// With a key embedded but NO signature served, the update fails closed — and the
// target binary is left untouched. RELAYIUM_UPDATE_ALLOW_UNSIGNED=1 overrides.
func TestUpdateFailsClosedWhenSignatureMissing(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	withEmbeddedKey(t, pubPEM(t, key))
	fr := &fakeRelease{tag: "v9.9.9", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "NEW")} // signKey nil → no .sig
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	if _, _, changed, err := Update(context.Background(), baseOpts(srv, target), io.Discard); err == nil || changed {
		t.Fatal("must fail closed when a key is embedded but the signature is missing")
	}
	if got, _ := os.ReadFile(target); string(got) != "OLD" {
		t.Fatalf("target must be untouched on failed verification, got %q", got)
	}
	t.Setenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED", "1")
	if _, _, changed, err := Update(context.Background(), baseOpts(srv, target), io.Discard); err != nil || !changed {
		t.Fatalf("RELAYIUM_UPDATE_ALLOW_UNSIGNED=1 should permit install: changed=%v err=%v", changed, err)
	}
}

// A signature made by a DIFFERENT key than the embedded one is rejected.
func TestUpdateRejectsWrongSignature(t *testing.T) {
	signer, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	withEmbeddedKey(t, pubPEM(t, other)) // embed other, but sign with signer
	fr := &fakeRelease{tag: "v9.9.9", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, "NEW"), signKey: signer}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "OLD")
	if _, _, changed, err := Update(context.Background(), baseOpts(srv, target), io.Discard); err == nil || changed {
		t.Fatal("must reject a signature that doesn't match the embedded key")
	}
	if got, _ := os.ReadFile(target); string(got) != "OLD" {
		t.Fatalf("target must be untouched on a bad signature, got %q", got)
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
