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
	"strconv"
	"strings"

	"github.com/relayium/relayium/account"
)

// buildCSP assembles the response CSP. script-src carries a per-request nonce
// (for the server-rendered admin/device pages) PLUS the SPA's inline-script
// hashes (the static theme snippet, which cannot receive a per-request nonce
// because index.html is served as a static file). A script is allowed if it
// matches EITHER, so both surfaces work with no 'unsafe-inline'.
//
// connect-src is 'self' PLUS https://*.relayium.com on each port a node can
// serve on: the SPA fetches from the apex (API, signalling WebSocket via
// wsURL's wss://<same host>/ws) and, for decentralized stored downloads,
// follows a 302 to a fleet node subdomain (nodeN.relayium.com) to pull the
// ciphertext straight from the node. A CSP host-source with NO port matches
// only the scheme's default port, so listing just https://*.relayium.com would
// silently block every node that is not on 443 — and the node's default
// download port is 2053, because a node often shares a host with something
// that already owns 443. The port list is exactly the set install-node.sh
// accepts (Cloudflare's proxied HTTPS ports); the two must stay in sync, so
// nodeDownloadPorts is the single place either is written down. The
// wildcard is scoped to our OWN domain, so it does NOT reopen the broad
// exfiltration hole the previous 'https:' wildcard did — a foothold still can't
// POST the zero-knowledge keys to an arbitrary host, only to relayium.com
// subdomains we control (which accept no such data). style-src keeps
// 'unsafe-inline' for now (Svelte style attributes). frame-ancestors 'none' is
// the clickjacking defense.
// nodeDownloadPorts are the client-facing HTTPS ports a fleet node's download
// listener can be reached on — Cloudflare's proxied HTTPS ports, the same set
// install-node.sh refuses to configure outside of. 443 is expressed by the
// port-less source (which matches the default port and nothing else).
var nodeDownloadPorts = []int{2053, 2083, 2087, 2096, 8443}

// nodeConnectSrc renders the fleet-node half of connect-src.
func nodeConnectSrc() string {
	out := "https://*.relayium.com"
	for _, p := range nodeDownloadPorts {
		out += " https://*.relayium.com:" + strconv.Itoa(p)
	}
	return out
}

func buildCSP(nonce string, spaScriptHashes []string) string {
	// 'wasm-unsafe-eval' is required, not optional: libsodium is a WebAssembly
	// module, and WebAssembly.instantiate is governed by script-src. Without this
	// token the browser refuses to compile it, crypto.ready() rejects, and the app
	// never gets past "connecting to the signaling server" — i.e. NO transfer of
	// any kind works. Production has never hit it only because nginx serves the
	// SPA shell itself and this header never reaches those responses; anything
	// served by Go directly (local runs, a nginx-less deploy) was fully broken.
	// A regression test (TestSecurityHeaders) covers it directly; the real-browser
	// lane that loads this Go-served SPA (e2e/mixed-link.mjs) could not connect at all
	// without it.
	//
	// It is the narrow token, NOT 'unsafe-eval': it permits WebAssembly
	// compilation and nothing else — eval()/new Function() stay blocked.
	script := "script-src 'self' 'wasm-unsafe-eval' 'nonce-" + nonce + "'"
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
		"connect-src 'self' " + nodeConnectSrc() + "; " +
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
		// HSTS: pin HTTPS for a year across all relayium.com subdomains (the node
		// download subdomains are HTTPS via Cloudflare too). Browsers ignore this
		// header when it arrives over plain HTTP, so setting it unconditionally is
		// safe behind the TLS-terminating proxy. No 'preload' — that's an
		// irreversible commitment to the browser preload list.
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
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

// downloadPrefix is the stored-download route (/d/<id>). The id is dynamic, so
// it can't have a file of its own; it is served from d.html, the noindex SPA
// shell the web build emits for it. Must match DOWNLOAD_PREFIX in
// web/src/lib/transfer-link.ts.
const downloadPrefix = "/d/"

// spaHandler serves static files from dir, and resolves client-side SPA routes
// (e.g. /cross-network) to the per-route shell the web build emits for them —
// <route>.html, a copy of index.html whose <head> and <noscript> describe that
// route. Anything else is a genuine 404 with the static 404 page.
//
// The set of shell files IS the route whitelist, and it is the same whitelist
// nginx uses (`try_files $uri $uri.html $uri/ =404`; the production nginx
// config lives in the private relayium-ops repo, see docs/self-hosting.md
// for the self-hosting equivalent) — one list, generated, impossible to let
// drift. Before this, every extensionless unknown path answered 200 with the
// homepage: /compare/typo, a deleted article and any random string all rendered
// index.html, which is a soft 404 in Search Console's eyes and means a removed
// page never leaves the index.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	// Read once: the build output doesn't change under a running server (a
	// deploy swaps the directory and restarts the binary).
	notFoundPage, notFoundErr := os.ReadFile(filepath.Join(dir, "404.html"))
	notFound := func(w http.ResponseWriter, r *http.Request) {
		if notFoundErr != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		if r.Method != http.MethodHead {
			_, _ = w.Write(notFoundPage)
		}
	}
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
			notFound(w, r) // unknown path with an extension
			return
		}
		// A known SPA route: <route>.html next to index.html.
		if shell := full + ".html"; fileExists(shell) {
			// path.Clean above dropped any trailing slash, so /pricing/ would
			// otherwise answer 200 with the shell that canonicals at /pricing —
			// the same duplicate-URL bug the index.html twins had, and the shape
			// a reader is most likely to guess, since every *generated* page is
			// slashed. Send it to the canonical instead of serving it twice.
			if upath != "/" && strings.HasSuffix(r.URL.Path, "/") {
				target := upath
				if r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				http.Redirect(w, r, target, http.StatusMovedPermanently)
				return
			}
			http.ServeFile(w, r, shell)
			return
		}
		// /d/<id> — dynamic ids share one shell.
		if strings.HasPrefix(upath, downloadPrefix) {
			if shell := filepath.Join(dir, "d.html"); fileExists(shell) {
				http.ServeFile(w, r, shell)
				return
			}
		}
		notFound(w, r)
	})
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
