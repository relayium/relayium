package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

func TestWhoamiNotLoggedIn(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir) // resolveConfigDir uses this
	var out bytes.Buffer
	code := runWhoami(nil, &out, &out)
	if code == 0 || !strings.Contains(out.String(), "not logged in") {
		t.Fatalf("want not-logged-in, code=%d out=%q", code, out.String())
	}
}

func TestWhoamiAfterSave(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	cfgDir, _ := resolveConfigDir("")
	_ = cloud.Save(cfgDir, cloud.Creds{Server: "https://relayium.com", AccountEmail: "a@example.com", AccessToken: "t"})
	var out bytes.Buffer
	if code := runWhoami(nil, &out, &out); code != 0 || !strings.Contains(out.String(), "a@example.com") {
		t.Fatalf("want email, code=%d out=%q", code, out.String())
	}
}

// TestRunLoginHappyPath drives runLogin end-to-end against a stub device-code
// server (approves on the first poll, interval=0 so cloud.Client's floor
// keeps the single sleep short) and checks it prints the verification
// prompt, reports the bound email, and persists credentials that whoami
// then reads back.
func TestRunLoginHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/cli/device/start":
			json.NewEncoder(w).Encode(map[string]any{
				"user_code": "AAAA-BBBB", "device_code": "dc",
				"verification_uri": "http://x/device", "interval": 0, "expires_in": 60,
			})
		case "/api/cli/device/poll":
			json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "access_token": "rlm_cli_t", "account_email": "login@example.com",
			})
		}
	}))
	defer srv.Close()

	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	var out, errOut bytes.Buffer
	code := runLogin([]string{"--server", srv.URL}, &out, &errOut)
	if code != 0 {
		t.Fatalf("runLogin code=%d stdout=%q stderr=%q", code, out.String(), errOut.String())
	}
	if !strings.Contains(errOut.String(), "AAAA-BBBB") {
		t.Fatalf("stderr should show the user code, got %q", errOut.String())
	}
	if !strings.Contains(out.String(), "login@example.com") {
		t.Fatalf("stdout should show the bound email, got %q", out.String())
	}

	var who bytes.Buffer
	if code := runWhoami(nil, &who, &who); code != 0 || !strings.Contains(who.String(), "login@example.com") {
		t.Fatalf("whoami after login: code=%d out=%q", code, who.String())
	}
}
