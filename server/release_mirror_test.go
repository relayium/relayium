package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestReleaseMirrorAllowlist: the mirror must serve this project's release
// artifacts and nothing else. Without the allowlist, central becomes an open
// proxy to any github.com path — a far worse problem than the reachability one
// the mirror exists to solve.
func TestReleaseMirrorAllowlist(t *testing.T) {
	allowed := []string{
		"relayium/relayium/releases/download/v0.10.2/relayium-node_linux_amd64.tar.gz",
		"relayium/relayium/releases/download/v0.10.2/relayium-node_darwin_arm64.tar.gz",
		"relayium/relayium/releases/download/v0.10.2/relayium_windows_amd64.zip",
		"relayium/relayium/releases/download/v0.10.2/checksums.txt",
		"relayium/relayium/releases/download/v0.10.2/checksums.txt.sig",
	}
	for _, p := range allowed {
		if !mirrorPath.MatchString(p) {
			t.Errorf("mirror should serve %q", p)
		}
	}
	denied := []string{
		"someoneelse/evil/releases/download/v1.0.0/relayium-node_linux_amd64.tar.gz",
		"relayium/relayium/releases/download/v0.10.2/../../../etc/passwd",
		"relayium/relayium/releases/download/latest/relayium-node_linux_amd64.tar.gz",
		"relayium/relayium/archive/refs/heads/main.tar.gz",
		"relayium/relayium/releases/download/v0.10.2/install-node.sh",
		"relayium/relayium/releases/download/v0.10.2/relayium-node_linux_amd64.tar.gz?x=1",
		"", "..", "relayium/relayium/releases/download/v0.10.2/",
	}
	for _, p := range denied {
		if mirrorPath.MatchString(p) {
			t.Errorf("mirror must NOT serve %q", p)
		}
	}
}

// TestReleaseMirror404sUnknownPaths drives the handler itself, so a future
// refactor that forgets to consult the allowlist fails here too.
func TestReleaseMirror404sUnknownPaths(t *testing.T) {
	req := httptest.NewRequest("GET", mirrorPrefix+"relayium/relayium/archive/main.tar.gz", nil)
	rr := httptest.NewRecorder()
	handleReleaseMirror(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

// TestReleaseMirrorStreamsUpstream checks the happy path end to end against a
// stand-in upstream, including the immutable caching header (a release tag
// never changes what it points at).
func TestReleaseMirrorStreamsUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/relayium/relayium/releases/download/v0.10.2/checksums.txt" {
			http.Error(w, "no", http.StatusNotFound)
			return
		}
		io.WriteString(w, "deadbeef  relayium-node_linux_amd64.tar.gz\n")
	}))
	defer up.Close()
	old := mirrorUpstreamFor
	mirrorUpstreamFor = up.URL
	defer func() { mirrorUpstreamFor = old }()

	req := httptest.NewRequest("GET", mirrorPrefix+"relayium/relayium/releases/download/v0.10.2/checksums.txt", nil)
	rr := httptest.NewRecorder()
	handleReleaseMirror(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "deadbeef") {
		t.Fatalf("body = %q", rr.Body.String())
	}
	if cc := rr.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("Cache-Control = %q, want immutable", cc)
	}
}
