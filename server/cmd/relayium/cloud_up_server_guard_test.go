package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

// `up --server <other>` must NOT reuse the access token issued by the logged-in
// server: sending it to an arbitrary host leaks the account credential. runUp
// must refuse before making any request to the override server.
func TestRunUpRefusesTokenToDifferentServer(t *testing.T) {
	var evilHits int
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evilHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer evil.Close()

	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfgDir, _ := resolveConfigDir("")
	// Logged in to a DIFFERENT server than the --server override below.
	if err := cloud.Save(cfgDir, cloud.Creds{Server: "https://relayium.com", AccountEmail: "a@example.com", AccessToken: "secret-tok"}); err != nil {
		t.Fatal(err)
	}

	tmp := t.TempDir()
	p := filepath.Join(tmp, "f.txt")
	if err := os.WriteFile(p, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	code := runUp([]string{"--server", evil.URL, p}, &out, &errOut)
	if code == 0 {
		t.Fatalf("expected refusal, got success; stderr=%q", errOut.String())
	}
	if evilHits != 0 {
		t.Fatalf("token/request leaked to the override server (%d hits)", evilHits)
	}
	if !strings.Contains(errOut.String(), "login") {
		t.Fatalf("want a re-login hint, stderr=%q", errOut.String())
	}
}

// A matching --server (same host as the login) is allowed — the token goes only
// to its issuer.
func TestRunUpAllowsMatchingServer(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"up1","expiresAt":999}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfgDir, _ := resolveConfigDir("")
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccountEmail: "a@example.com", AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	p := filepath.Join(tmp, "f.txt")
	if err := os.WriteFile(p, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	// Pass the SAME server (with a trailing slash, to exercise normalization).
	if code := runUp([]string{"--server", srv.URL + "/", p}, &out, &errOut); code != 0 {
		t.Fatalf("matching --server must be allowed, code=%d stderr=%q", code, errOut.String())
	}
	if gotAuth != "Bearer tok" {
		t.Fatalf("token should reach its issuing server, auth=%q", gotAuth)
	}
}
