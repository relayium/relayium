package cloud

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMintPairSendsBearerAndReturnsCode(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"483920","expiresAt":1900000000}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_abc"
	p, err := c.MintPair(context.Background())
	if err != nil {
		t.Fatalf("MintPair: %v", err)
	}
	if p.Code != "483920" || p.ExpiresAt != 1900000000 {
		t.Fatalf("pair = %+v", p)
	}
	if gotPath != "/api/pair" {
		t.Errorf("path = %q, want /api/pair", gotPath)
	}
	if gotAuth != "Bearer rlm_cli_abc" {
		t.Errorf("Authorization = %q", gotAuth)
	}
}

// The caller must be able to tell "log in again" from "slow down" — a bare
// string error would force it to parse prose.
func TestMintPairSurfacesStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_expired"
	_, err := c.MintPair(context.Background())
	var he *HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("err = %v, want *HTTPError", err)
	}
	if he.Status != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", he.Status)
	}
}

// The server explains a 503 ("could not mint a pairing code, try again" — the
// code space is full, see maxMintAttempts). That sentence is more useful than
// the status number, so it must survive into the error.
func TestMintPairKeepsServerMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "could not mint a pairing code, try again", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_abc"
	_, err := c.MintPair(context.Background())
	if err == nil || !strings.Contains(err.Error(), "could not mint a pairing code") {
		t.Fatalf("err = %v, want the server's sentence", err)
	}
}

// An empty code is a server bug, not a code: minting it into the UI would print
// a "code" nobody can join (see maxMintAttempts in signal/pair.go).
func TestMintPairRejectsEmptyCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":"","expiresAt":0}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_abc"
	if _, err := c.MintPair(context.Background()); err == nil {
		t.Fatal("empty code should be an error")
	}
}
