package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
)

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
