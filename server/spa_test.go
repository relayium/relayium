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
	// A path segment that only ever holds articles: /compare/croc/ is a page,
	// /compare/ itself is not, and no index.html is generated for it.
	writeFile(t, filepath.Join(dir, "compare", "croc", "index.html"), "CROC")
	// Per-route SPA shells emitted by the web build (vite-plugin-route-shells).
	writeFile(t, filepath.Join(dir, "cross-network.html"), "CROSS")
	writeFile(t, filepath.Join(dir, "d.html"), "DOWNLOAD")
	writeFile(t, filepath.Join(dir, "404.html"), "NOTFOUND")

	h := spaHandler(dir)

	cases := []struct {
		name, path, wantBody string
		wantCode             int
		wantLoc              string
	}{
		{"root serves index", "/", "INDEX", 200, ""},
		// The route's own shell, NOT index.html: that is the whole point — the
		// bare HTML at /cross-network has to describe /cross-network.
		{"app route serves its shell", "/cross-network", "CROSS", 200, ""},
		{"real asset served", "/assets/app.js", "JS", 200, ""},
		{"missing asset 404s", "/assets/missing.js", "NOTFOUND", 404, ""},
		{"directory with index served", "/privacy/", "PRIVACY", 200, ""},
		// The soft-404 fix: an unknown extensionless path must NOT answer 200
		// with the homepage. A typo'd article, a deleted page and a random
		// string were all indexable duplicates of "/" before this.
		{"unknown route is a real 404", "/compare/typo", "NOTFOUND", 404, ""},
		{"unknown top-level route is a real 404", "/definitely-not-a-page", "NOTFOUND", 404, ""},
		// /d/<id> is dynamic, so every id shares the one noindex shell.
		{"download link serves the download shell", "/d/abc123", "DOWNLOAD", 200, ""},
		// Every generated page is written to <slug>/index.html, so /privacy/index.html
		// serves the same bytes as /privacy/ and canonicals at it — a duplicate URL
		// for all ~400 pages. http.FileServer redirects it for us; the assertion is
		// here so a future rewrite of this handler can't quietly drop that (nginx
		// did NOT do it, and Search Console filed the twins under "Alternate page
		// with proper canonical tag").
		{"index.html redirects to the directory", "/privacy/index.html", "", 301, ""},
		{"root index.html redirects to /", "/index.html", "", 301, ""},
		// path.Clean strips the trailing slash, so /cross-network/ used to answer
		// 200 with the very shell that canonicals at /cross-network — a duplicate
		// URL for every SPA route, and the one URL shape a reader would guess
		// given every generated page IS slashed. Redirect instead.
		{"slashed app route redirects to its canonical", "/cross-network/", "", 301, "/cross-network"},
		{"slashed app route keeps the query", "/cross-network/?a=1", "", 301, "/cross-network?a=1"},
		// nginx answers 403 here (its `$uri/` arm finds the directory, `index`
		// finds no index.html, autoindex is off). This handler is the reference
		// for that rule, so pin the status the config has to match.
		{"directory without an index.html is a real 404", "/compare/", "NOTFOUND", 404, ""},
		{"article under it still serves", "/compare/croc/", "CROC", 200, ""},
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
			if c.wantLoc != "" && rec.Header().Get("Location") != c.wantLoc {
				t.Fatalf("%s: Location = %q, want %q", c.path, rec.Header().Get("Location"), c.wantLoc)
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
