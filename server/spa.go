package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
)

// contentSecurityPolicy is tuned for the Relayium SPA: the page carries an
// inline theme script and per-page ld+json, its bundle and assets are all
// same-origin, and it talks to the signalling WebSocket (wss:) and the API /
// blob endpoints (https:). WebRTC data channels need no getUserMedia, so
// camera/mic are disabled via Permissions-Policy below. frame-ancestors 'none'
// is the clickjacking defense for the transfer-accept / SAS / delete UIs.
const contentSecurityPolicy = "default-src 'self'; " +
	"base-uri 'self'; " +
	"object-src 'none'; " +
	"frame-ancestors 'none'; " +
	"form-action 'self'; " +
	"img-src 'self' data: blob:; " +
	"style-src 'self' 'unsafe-inline'; " +
	"script-src 'self' 'unsafe-inline'; " +
	"connect-src 'self' https: wss:; " +
	"font-src 'self' data:; " +
	"worker-src 'self'; " +
	"manifest-src 'self'"

// securityHeaders wraps the whole mux with baseline hardening headers. They are
// safe on every response (JSON API, WebSocket upgrade, static HTML alike); the
// CSP's script/style/connect sources are widened just enough for the SPA.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
		next.ServeHTTP(w, r)
	})
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
