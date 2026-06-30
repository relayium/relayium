package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
