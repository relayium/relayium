package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestAppleDomainAssociation(t *testing.T) {
	// Unset → 404.
	rec := httptest.NewRecorder()
	appleDomainAssociation("")(rec, httptest.NewRequest("GET", "/.well-known/apple-developer-domain-association.txt", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unset: want 404, got %d", rec.Code)
	}

	// Set → serves file bytes as text/plain.
	dir := t.TempDir()
	p := filepath.Join(dir, "assoc.txt")
	if err := os.WriteFile(p, []byte("apple-domain-proof"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	appleDomainAssociation(p)(rec, httptest.NewRequest("GET", "/.well-known/apple-developer-domain-association.txt", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("set: want 200, got %d", rec.Code)
	}
	if rec.Body.String() != "apple-domain-proof" {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("content-type = %q", ct)
	}
}
