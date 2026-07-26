package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

func TestAPIBase(t *testing.T) {
	cases := map[string]string{
		"wss://relayium.com":    "https://relayium.com",
		"ws://localhost:8080":   "http://localhost:8080",
		"https://relayium.com/": "https://relayium.com",
	}
	for in, want := range cases {
		got, err := apiBase(in)
		if err != nil {
			t.Fatalf("apiBase(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("apiBase(%q) = %q, want %q", in, got, want)
		}
	}
}

// Minting needs an account, and on a server there is no browser to bounce
// through — so this must fail fast and say what to run, never start a login.
func TestMintCodeNotLoggedIn(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var errb bytes.Buffer
	_, err := mintCode(context.Background(), "wss://relayium.com", &errb)
	if err == nil {
		t.Fatal("want an error when not logged in")
	}
	for _, want := range []string{"relayium login", "relayium up"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestMintCodePrintsHandoffBlock(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rlm_cli_abc" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"code":"K7M4XR","expiresAt":4102444800}`))
	}))
	defer srv.Close()

	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccessToken: "rlm_cli_abc", AccountEmail: "a@example.com"}); err != nil {
		t.Fatal(err)
	}

	var errb bytes.Buffer
	code, err := mintCode(context.Background(), srv.URL, &errb)
	if err != nil {
		t.Fatalf("mintCode: %v", err)
	}
	if code != "K7M4XR" {
		t.Fatalf("code = %q", code)
	}
	out := errb.String()
	for _, want := range []string{"K7M4XR", "relayium receive K7M4XR", "waiting for the receiver"} {
		if !strings.Contains(out, want) {
			t.Errorf("block %q does not contain %q", out, want)
		}
	}
	// The install one-liner is first-party only: a self-hosted origin has no
	// install.sh, and this test server is one.
	if strings.Contains(out, "install.sh") {
		t.Errorf("install line should be omitted for a non-default server: %q", out)
	}
}

// The access token authenticates to the server that issued it and nowhere else.
func TestMintCodeRefusesForeignServer(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: "https://relayium.com", AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	_, err = mintCode(context.Background(), "wss://someone-elses-host.example", &errb)
	if err == nil || !strings.Contains(err.Error(), "logged in to https://relayium.com") {
		t.Fatalf("want a server-mismatch refusal, got %v", err)
	}
}
