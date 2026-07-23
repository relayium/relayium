package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestSecurityHeaders(t *testing.T) {
	spaHashes := []string{"'sha256-deadbeef'"}
	h := securityHeaders(spaHashes, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	want := map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "strict-origin-when-cross-origin",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	}
	for k, v := range want {
		if got := rr.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	csp := rr.Header().Get("Content-Security-Policy")
	for _, must := range []string{
		"frame-ancestors 'none'",
		"object-src 'none'",
		// Scoped to our own domain: apex + fleet node subdomains for direct
		// downloads, but no broad 'https:'/'wss:' exfil wildcard.
		"connect-src 'self' https://*.relayium.com https://*.relayium.com:2053",
		"'nonce-",           // per-request script nonce present
		"'sha256-deadbeef'", // SPA inline-script hash folded in
		// libsodium is WASM and WebAssembly.instantiate answers to script-src.
		// Drop this and every transfer breaks at startup — see buildCSP.
		"'wasm-unsafe-eval'",
	} {
		if !strings.Contains(csp, must) {
			t.Errorf("CSP missing %q; got %q", must, csp)
		}
	}
	// The XSS-containment win: script-src must not allow inline scripts, and
	// connect-src must not allow arbitrary-host exfiltration.
	if strings.Contains(csp, "'unsafe-inline'; connect") || strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Errorf("script-src must not allow 'unsafe-inline'; got %q", csp)
	}
	// 'wasm-unsafe-eval' must not be widened into full 'unsafe-eval'.
	if strings.Contains(csp, " 'unsafe-eval'") {
		t.Errorf("script-src must not allow 'unsafe-eval'; got %q", csp)
	}
	if strings.Contains(csp, "connect-src 'self' https:;") || strings.Contains(csp, "connect-src 'self' https: ") || strings.Contains(csp, "wss:") {
		t.Errorf("connect-src must not carry a broad https:/wss: exfil wildcard; got %q", csp)
	}
	// Each request must mint a distinct nonce.
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Header().Get("Content-Security-Policy") == rr2.Header().Get("Content-Security-Policy") {
		t.Error("CSP nonce must differ per request")
	}
	if rr.Header().Get("Permissions-Policy") == "" {
		t.Error("Permissions-Policy not set")
	}
}

func TestSPAScriptHashes(t *testing.T) {
	dir := t.TempDir()
	// An executable inline script (theme snippet), an ld+json block (not
	// executed), and an external script (governed by 'self') — only the first
	// should yield a hash.
	writeFile(t, filepath.Join(dir, "index.html"),
		`<script>var t=1;</script>`+
			`<script type="application/ld+json">{"@type":"WebPage"}</script>`+
			`<script type="module" src="/assets/app.js"></script>`)
	hashes := spaScriptHashes(dir)
	if len(hashes) != 1 {
		t.Fatalf("want exactly 1 inline-script hash, got %d: %v", len(hashes), hashes)
	}
	if !strings.HasPrefix(hashes[0], "'sha256-") {
		t.Fatalf("hash token malformed: %q", hashes[0])
	}
}

func TestSPAHandler(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "index.html"), "INDEX")
	writeFile(t, filepath.Join(dir, "assets", "app.js"), "JS")
	writeFile(t, filepath.Join(dir, "privacy", "index.html"), "PRIVACY")

	h := spaHandler(dir)

	cases := []struct {
		name, path, wantBody string
		wantCode             int
	}{
		{"root serves index", "/", "INDEX", 200},
		{"app route serves index", "/cross-network", "INDEX", 200},
		{"real asset served", "/assets/app.js", "JS", 200},
		{"missing asset 404s", "/assets/missing.js", "", 404},
		{"directory with index served", "/privacy/", "PRIVACY", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))
			if rec.Code != c.wantCode {
				t.Fatalf("%s: code = %d, want %d", c.path, rec.Code, c.wantCode)
			}
			if c.wantBody != "" && rec.Body.String() != c.wantBody {
				t.Fatalf("%s: body = %q, want %q", c.path, rec.Body.String(), c.wantBody)
			}
		})
	}
}

// TestCSPCoversEveryNodeDownloadPort: a CSP host-source with no port matches
// ONLY the scheme's default port, so a node on 2053 (the installer's default,
// because a node often shares a host with something already on 443) would be
// blocked by a bare https://*.relayium.com. The failure mode is invisible until
// direct download is switched on, and then it is every stored download.
func TestCSPCoversEveryNodeDownloadPort(t *testing.T) {
	csp := buildCSP("n", nil)
	for _, p := range nodeDownloadPorts {
		want := "https://*.relayium.com:" + strconv.Itoa(p)
		if !strings.Contains(csp, want) {
			t.Errorf("connect-src missing %q; got %q", want, csp)
		}
	}
	// The port-less source must remain: it is how 443 is allowed.
	if !strings.Contains(csp, "https://*.relayium.com ") {
		t.Errorf("connect-src lost the port-less (443) source; got %q", csp)
	}
	// Still scoped to our own zone.
	// (a bare "https:" scheme-source, not the "https://…" host-sources above)
	if strings.Contains(csp, "https://*:") || strings.Contains(csp, "connect-src 'self' https:;") ||
		strings.Contains(csp, "connect-src 'self' https: ") {
		t.Errorf("connect-src widened beyond our zone; got %q", csp)
	}
}
