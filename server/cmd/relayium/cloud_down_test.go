package main

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storecrypto"
)

// downFakeServer serves /meta and /blob for id "abc123" from a single
// "hello.txt" -> "hello world" file, encrypted under raw.
func downFakeServer(t *testing.T) (srv *httptest.Server, raw []byte) {
	t.Helper()
	var err error
	raw, err = storecrypto.GenerateKey()
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
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/meta"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"encManifest":"` + base64.StdEncoding.EncodeToString(encManifest) + `","size":` + strconv.Itoa(len(frame)) + `}`))
		case strings.HasSuffix(r.URL.Path, "/blob"):
			_, _ = w.Write(frame)
		}
	}))
	return srv, raw
}

// TestRunDownHappyPathFullLink drives runDown end-to-end with a full claim
// link (server embedded in it, as `up` prints) — no --server flag and no
// login/credentials needed.
func TestRunDownHappyPathFullLink(t *testing.T) {
	srv, raw := downFakeServer(t)
	defer srv.Close()

	link := srv.URL + "/d/abc123#k=" + storecrypto.EncodeKey(raw)
	dest := t.TempDir()

	var out, errOut bytes.Buffer
	code := runDown([]string{link, dest}, &out, &errOut)
	if code != 0 {
		t.Fatalf("runDown code=%d stdout=%q stderr=%q", code, out.String(), errOut.String())
	}
	wantPath := filepath.Join(dest, "hello.txt")
	if !strings.Contains(out.String(), wantPath) {
		t.Fatalf("stdout %q should mention %q", out.String(), wantPath)
	}
	got, err := os.ReadFile(wantPath)
	if err != nil || string(got) != "hello world" {
		t.Fatalf("downloaded file: %q %v", got, err)
	}
}

// TestRunDownBareCodeUsesServerFlag drives runDown with a bare <id>#k=<key>
// code (no embedded server), requiring --server to resolve it.
func TestRunDownBareCodeUsesServerFlag(t *testing.T) {
	srv, raw := downFakeServer(t)
	defer srv.Close()

	code := "abc123#k=" + storecrypto.EncodeKey(raw)
	dest := t.TempDir()

	var out, errOut bytes.Buffer
	exit := runDown([]string{"--server", srv.URL, code, dest}, &out, &errOut)
	if exit != 0 {
		t.Fatalf("runDown code=%d stdout=%q stderr=%q", exit, out.String(), errOut.String())
	}
	got, err := os.ReadFile(filepath.Join(dest, "hello.txt"))
	if err != nil || string(got) != "hello world" {
		t.Fatalf("downloaded file: %q %v", got, err)
	}
}

// TestResolveDownServerPrecedence covers resolveDownServer's precedence
// rules in isolation (no network involved, unlike exercising the fallback
// to defaultCloudServer through runDown, which would mean hitting the real
// production server from a test).
func TestResolveDownServerPrecedence(t *testing.T) {
	cases := []struct {
		name              string
		claim, flag, want string
	}{
		{"bare code, no flag: falls back to default", "", "", defaultCloudServer},
		{"full link, no flag: uses the link's server", "https://self-hosted.example", "", "https://self-hosted.example"},
		{"bare code, flag set: uses the flag", "", "https://override.example", "https://override.example"},
		{"full link, flag set: flag wins", "https://link.example", "https://override.example", "https://override.example"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveDownServer(tc.claim, tc.flag); got != tc.want {
				t.Fatalf("resolveDownServer(%q, %q) = %q, want %q", tc.claim, tc.flag, got, tc.want)
			}
		})
	}
}

// TestRunDownDefaultDestDirIsCWD verifies the destDir positional arg is
// optional and defaults to the current directory.
func TestRunDownDefaultDestDirIsCWD(t *testing.T) {
	srv, raw := downFakeServer(t)
	defer srv.Close()

	link := srv.URL + "/d/abc123#k=" + storecrypto.EncodeKey(raw)
	cwd := t.TempDir()
	t.Chdir(cwd)

	var out, errOut bytes.Buffer
	code := runDown([]string{link}, &out, &errOut)
	if code != 0 {
		t.Fatalf("runDown code=%d stdout=%q stderr=%q", code, out.String(), errOut.String())
	}
	got, err := os.ReadFile(filepath.Join(cwd, "hello.txt"))
	if err != nil || string(got) != "hello world" {
		t.Fatalf("downloaded file: %q %v", got, err)
	}
}

// TestRunDownMalformedClaim verifies a malformed claim (no #k=<key>
// fragment) is rejected with a usage-style exit code, before any network
// call.
func TestRunDownMalformedClaim(t *testing.T) {
	var out, errOut bytes.Buffer
	code := runDown([]string{"not-a-claim"}, &out, &errOut)
	if code != 2 {
		t.Fatalf("code=%d, want 2 (usage error); stderr=%q", code, errOut.String())
	}
}
