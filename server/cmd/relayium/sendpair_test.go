package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

// mintCodeWithCreds saves rlm_cli_abc creds pointed at srv, then calls
// mintCode against it. A small helper shared by the response-branch tests
// below so each one only has to state its handler and its assertion.
func mintCodeWithCreds(t *testing.T, srv *httptest.Server) (string, error, string) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	code, err := mintCode(context.Background(), srv.URL, &errb)
	return code, err, errb.String()
}

// A 401 from MintPair means the stored token is no longer good (expired /
// revoked server-side) — this must read exactly like the never-logged-in
// case, not a bare HTTP status.
func TestMintCodeUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "token expired", http.StatusUnauthorized)
	}))
	defer srv.Close()

	_, err, _ := mintCodeWithCreds(t, srv)
	if err == nil {
		t.Fatal("want an error on 401")
	}
	if !strings.Contains(err.Error(), "relayium login") {
		t.Errorf("401 should tell the user to log in again, got %q", err)
	}
}

// A 429 means "you're rate limited," not "you're logged out" — telling a
// rate-limited user to log in again is actively wrong (their credentials are
// fine) and would send them chasing a login flow that won't fix anything.
func TestMintCodeRateLimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err, _ := mintCodeWithCreds(t, srv)
	if err == nil {
		t.Fatal("want an error on 429")
	}
	msg := err.Error()
	if !strings.Contains(msg, "wait") {
		t.Errorf("429 should mention waiting/rate limiting, got %q", msg)
	}
	if strings.Contains(msg, "relayium login") {
		t.Errorf("429 must not tell the user to log in again, got %q", msg)
	}
}

// The TTL line is derived from the server's expiresAt, and Unix() flooring
// plus network latency means a naive "seconds / 60" truncates every
// 5-minute code down to "4 minutes". This pins the rounded, correct output
// for a normal mint so that regression can't silently return.
func TestMintCodeTTLLineForNormalExpiry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exp := time.Now().Add(300 * time.Second).Unix()
		fmt.Fprintf(w, `{"code":"K7M4XR","expiresAt":%d}`, exp)
	}))
	defer srv.Close()

	_, err, out := mintCodeWithCreds(t, srv)
	if err != nil {
		t.Fatalf("mintCode: %v", err)
	}
	if !strings.Contains(out, "Code: K7M4XR   (valid 5 minutes)") {
		t.Errorf("want a rounded 5-minute TTL line, got %q", out)
	}
}

// expiresAt == 0 means an older server that doesn't report an expiry at
// all (see cloud.go's truncatedTTLNotice). There is nothing to derive a
// minute count from, so the clause must be omitted rather than guessed —
// printing "valid 1 minutes" for a code that's actually good for five would
// be worse than saying nothing.
func TestMintCodeOmitsTTLClauseWhenServerDoesNotReportExpiry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":"K7M4XR"}`))
	}))
	defer srv.Close()

	_, err, out := mintCodeWithCreds(t, srv)
	if err != nil {
		t.Fatalf("mintCode: %v", err)
	}
	if strings.Contains(out, "valid") {
		t.Errorf("want no TTL clause when expiresAt is unreported, got %q", out)
	}
	if !strings.Contains(out, "Code: K7M4XR\n") {
		t.Errorf("want the bare code line, got %q", out)
	}
}

// Direct unit coverage of the rounding/singular/omission rules, without the
// network round trip — fast and exhaustive over edge cases the
// higher-level tests above don't each need to restate.
func TestTTLClause(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name      string
		expiresAt int64
		want      string
	}{
		{"zero means unreported, omit entirely", 0, ""},
		{"300s rounds to 5 minutes, not truncated to 4", now.Add(300 * time.Second).Unix(), "   (valid 5 minutes)"},
		{"under a minute clamps to a singular minute", now.Add(10 * time.Second).Unix(), "   (valid 1 minute)"},
		{"already expired still clamps to a singular minute", now.Add(-10 * time.Second).Unix(), "   (valid 1 minute)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ttlClause(tc.expiresAt); got != tc.want {
				t.Errorf("ttlClause(%d) = %q, want %q", tc.expiresAt, got, tc.want)
			}
		})
	}
}
