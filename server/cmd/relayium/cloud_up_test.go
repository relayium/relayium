package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

func TestRunUpNotLoggedIn(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	var out, errOut bytes.Buffer
	code := runUp([]string{"somefile"}, &out, &errOut)
	if code == 0 || !strings.Contains(errOut.String(), "relayium login") {
		t.Fatalf("want login prompt, code=%d stderr=%q", code, errOut.String())
	}
}

// TestRunUpHappyPath drives runUp end-to-end against a stub /api/files
// server, using saved credentials the way `login` would leave them, and
// checks it prints a claim link built from the logged-in server + returned
// id + key.
func TestRunUpHappyPath(t *testing.T) {
	var gotAuth, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotQuery = r.URL.RawQuery
		_, _ = io.ReadAll(r.Body) // drain
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "up123", "expiresAt": 999})
	}))
	defer srv.Close()

	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfgDir, _ := resolveConfigDir("")
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccountEmail: "a@example.com", AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}

	tmp := t.TempDir()
	p := filepath.Join(tmp, "hello.txt")
	if err := os.WriteFile(p, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	code := runUp([]string{"--burn", p}, &out, &errOut)
	if code != 0 {
		t.Fatalf("runUp code=%d stdout=%q stderr=%q", code, out.String(), errOut.String())
	}
	if gotAuth != "Bearer tok" {
		t.Fatalf("auth header: %q", gotAuth)
	}
	if !strings.Contains(gotQuery, "burnAfterRead=1") {
		t.Fatalf("query: %q", gotQuery)
	}
	wantPrefix := srv.URL + "/d/up123#k="
	if !strings.HasPrefix(out.String(), wantPrefix) {
		t.Fatalf("want link prefix %q, got %q", wantPrefix, out.String())
	}
	link := strings.TrimSpace(out.String())
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("stdout must contain only the composable link, got %q", out.String())
	}
	wantHint := "relayium down '" + link + "'"
	if !strings.Contains(errOut.String(), wantHint) {
		t.Fatalf("want exact download command %q, got stderr %q", wantHint, errOut.String())
	}
	if strings.Contains(errOut.String(), "<link>") {
		t.Fatalf("hint left a placeholder for a value already known: %q", errOut.String())
	}
}
