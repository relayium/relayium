package selfupdate

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// updateAgainst runs Update against a stand-in release host and returns the
// error. TargetTag is set so LatestTag is never called.
func updateAgainst(t *testing.T, h http.Handler) error {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	target := filepath.Join(dir, "relayium")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := Update(context.Background(), Options{
		Repo: "relayium/relayium", TargetTag: "v9.9.9",
		CurrentVersion: "v0.0.1", TargetPath: target,
		GOOS: "linux", GOARCH: "amd64",
		DownloadBase: srv.URL, APIBase: srv.URL,
		HTTP: srv.Client(),
	}, io.Discard)
	if err == nil {
		t.Fatal("expected Update to fail")
	}
	return err
}

// A host that cannot serve the asset is a FETCH failure, and 404 counts: a
// mirror may simply not carry the file. The node refuses to install either
// way; only the fleet's reaction differs.
func TestUpdateClassifiesMissingAssetAsFetch(t *testing.T) {
	err := updateAgainst(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("err = %v, want ErrFetch", err)
	}
	if errors.Is(err, ErrVerify) {
		t.Fatalf("a missing asset must not read as a verification failure: %v", err)
	}
}

// The signature file is downloaded too, so a host that cannot serve IT is also
// a fetch failure. Getting this wrong is the whole bug: an unreachable node
// would keep halting the fleet through the signature path.
//
// Exercised against verifyReleaseSignature directly rather than through Update.
// Reaching that step via Update would require serving a real archive AND a
// checksums.txt whose hash matches it, because verifyChecksum runs first —
// setup that tests the harness rather than the classification.
//
// A key must be embedded for this test to exercise anything: TestMain zeroes
// releaseSigningPubKeyPEM package-wide (see selfupdate_test.go), and with no
// key embedded verifyReleaseSignature takes its checksum-only early return
// without ever attempting the download this test means to classify.
func TestVerifyReleaseSignatureClassifiesAMissingSigAsFetch(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	withEmbeddedKey(t, pubPEM(t, key))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()
	tmp := t.TempDir()
	sums := filepath.Join(tmp, "checksums.txt")
	if err := os.WriteFile(sums, []byte("whatever\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o := Options{Repo: "relayium/relayium", DownloadBase: srv.URL, HTTP: srv.Client()}
	err := verifyReleaseSignature(context.Background(), o, srv.URL, tmp, sums, io.Discard)
	if err == nil {
		t.Fatal("expected a missing signature to be an error")
	}
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("err = %v, want ErrFetch — an unreachable host must not read as a verification failure", err)
	}
	if errors.Is(err, ErrVerify) {
		t.Fatalf("a signature that could not be downloaded is not a failed verification: %v", err)
	}
}

// Bytes that arrived but do not match checksums.txt are a VERIFY failure --
// the category that must still halt the fleet.
func TestUpdateClassifiesBadChecksumAsVerify(t *testing.T) {
	err := updateAgainst(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if filepath.Base(r.URL.Path) == "checksums.txt" {
			w.Write([]byte("0000000000000000000000000000000000000000000000000000000000000000  relayium_linux_amd64.tar.gz\n"))
			return
		}
		w.Write([]byte("not the archive those bytes hash to"))
	}))
	if !errors.Is(err, ErrVerify) {
		t.Fatalf("err = %v, want ErrVerify", err)
	}
	if errors.Is(err, ErrFetch) {
		t.Fatalf("a checksum mismatch must not read as a fetch failure: %v", err)
	}
}

// The two sentinels must be distinguishable from each other, or every caller's
// switch collapses.
func TestFetchAndVerifyAreDistinct(t *testing.T) {
	if errors.Is(ErrFetch, ErrVerify) || errors.Is(ErrVerify, ErrFetch) {
		t.Fatal("ErrFetch and ErrVerify must not match each other")
	}
}
