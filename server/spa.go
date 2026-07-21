package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/relayium/relayium/internal/account"
)

// buildCSP assembles the response CSP. script-src carries a per-request nonce
// (for the server-rendered admin/device pages) PLUS the SPA's inline-script
// hashes (the static theme snippet, which cannot receive a per-request nonce
// because index.html is served as a static file). A script is allowed if it
// matches EITHER, so both surfaces work with no 'unsafe-inline'. connect-src is
// 'self' only: every fetch/XHR and the signalling WebSocket are same-origin
// (wsURL builds wss://<same host>/ws), so the previous 'https: wss:' wildcard —
// which let any XSS foothold exfiltrate the zero-knowledge upload keys held in
// localStorage to an arbitrary host — is gone. style-src keeps 'unsafe-inline'
// for now (Svelte style attributes); the script/connect tightening is the
// XSS-containment win. frame-ancestors 'none' is the clickjacking defense.
func buildCSP(nonce string, spaScriptHashes []string) string {
	script := "script-src 'self' 'nonce-" + nonce + "'"
	for _, h := range spaScriptHashes {
		script += " " + h
	}
	return "default-src 'self'; " +
		"base-uri 'self'; " +
		"object-src 'none'; " +
		"frame-ancestors 'none'; " +
		"form-action 'self'; " +
		"img-src 'self' data: blob:; " +
		"style-src 'self' 'unsafe-inline'; " +
		script + "; " +
		"connect-src 'self'; " +
		"font-src 'self' data:; " +
		"worker-src 'self'; " +
		"manifest-src 'self'"
}

// securityHeaders wraps the whole mux with baseline hardening headers. spaHashes
// are the sha256 CSP tokens of the SPA's inline scripts (see spaScriptHashes),
// folded into every response's script-src so the static shell's theme snippet
// executes without 'unsafe-inline'. A fresh nonce is minted per request for the
// server-rendered pages.
func securityHeaders(spaHashes []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b [16]byte
		_, _ = rand.Read(b[:])
		nonce := base64.StdEncoding.EncodeToString(b[:])
		r = r.WithContext(account.WithCSPNonce(r.Context(), nonce))
		h := w.Header()
		h.Set("Content-Security-Policy", buildCSP(nonce, spaHashes))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
		next.ServeHTTP(w, r)
	})
}

// inlineScriptRe matches a <script>…</script> block. Attributes are captured so
// spaScriptHashes can skip the ones that don't execute inline JS (external src,
// or a non-JS type like application/ld+json).
var inlineScriptRe = regexp.MustCompile(`(?is)<script([^>]*)>(.*?)</script>`)

// spaScriptHashes scans every .html file under dir for inline (no-src) JavaScript
// <script> blocks and returns their unique 'sha256-…' CSP tokens. Computing them
// from the BUILT files at startup keeps the CSP correct across Vite rebuilds and
// template edits with zero manual maintenance — the class of silent CSP break a
// hardcoded hash invites. Non-JS scripts (ld+json) and external scripts (src=)
// are ignored: they need no script-src hash.
func spaScriptHashes(dir string) []string {
	seen := map[string]bool{}
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(p), ".html") {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		for _, m := range inlineScriptRe.FindAllStringSubmatch(string(data), -1) {
			attrs := strings.ToLower(m[1])
			if strings.Contains(attrs, "src=") {
				continue // external script — governed by 'self', no hash needed
			}
			if strings.Contains(attrs, "type=") && !strings.Contains(attrs, "text/javascript") && !strings.Contains(attrs, "module") {
				continue // e.g. application/ld+json — never executed
			}
			sum := sha256.Sum256([]byte(m[2]))
			tok := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
			if !seen[tok] {
				seen[tok] = true
				out = append(out, tok)
			}
		}
		return nil
	})
	return out
}

// spaHandler serves static files from dir, but falls back to index.html for
// extensionless paths that don't map to a real file or directory — these are
// client-side SPA routes (e.g. /cross-network). Real files, directories that
// carry their own index.html (e.g. /privacy), and missing assets (paths with an
// extension) keep the plain FileServer behaviour.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			fs.ServeHTTP(w, r)
			return
		}
		upath := path.Clean("/" + r.URL.Path) // collapses any ".." traversal
		full := filepath.Join(dir, filepath.FromSlash(upath))
		if st, err := os.Stat(full); err == nil {
			if !st.IsDir() {
				fs.ServeHTTP(w, r) // a real file
				return
			}
			if _, err := os.Stat(filepath.Join(full, "index.html")); err == nil {
				fs.ServeHTTP(w, r) // a directory that has its own index.html
				return
			}
		}
		if path.Ext(upath) != "" {
			fs.ServeHTTP(w, r) // unknown path with an extension → genuine 404
			return
		}
		http.ServeFile(w, r, index) // extensionless unknown path → SPA shell
	})
}
