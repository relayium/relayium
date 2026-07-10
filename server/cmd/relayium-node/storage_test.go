package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

func TestBlobHandlerRoundTripAndAuth(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	h := newBlobHandler(ds, "nodesecret")
	srv := httptest.NewServer(h)
	defer srv.Close()

	put := func(auth string) int {
		req, _ := http.NewRequest("PUT", srv.URL+"/blob/abc123", bytes.NewReader([]byte("cipher")))
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if code := put(""); code != http.StatusUnauthorized {
		t.Fatalf("no auth: %d", code)
	}
	if code := put("Bearer wrong"); code != http.StatusUnauthorized {
		t.Fatalf("wrong auth: %d", code)
	}
	if code := put("Bearer nodesecret"); code != http.StatusOK {
		t.Fatalf("good auth put: %d", code)
	}

	req, _ := http.NewRequest("GET", srv.URL+"/blob/abc123", nil)
	req.Header.Set("Authorization", "Bearer nodesecret")
	resp, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "cipher" {
		t.Fatalf("get: %d %q", resp.StatusCode, body)
	}

	// Path-traversal / invalid key rejected (DiskStore.validKey).
	bad, _ := http.NewRequest("GET", srv.URL+"/blob/..%2f..%2fetc", nil)
	bad.Header.Set("Authorization", "Bearer nodesecret")
	br, _ := http.DefaultClient.Do(bad)
	br.Body.Close()
	if br.StatusCode == 200 {
		t.Fatalf("traversal key must not 200")
	}

	// DELETE is idempotent.
	del, _ := http.NewRequest("DELETE", srv.URL+"/blob/abc123", nil)
	del.Header.Set("Authorization", "Bearer nodesecret")
	dr, _ := http.DefaultClient.Do(del)
	dr.Body.Close()
	if dr.StatusCode != 204 {
		t.Fatalf("delete: %d", dr.StatusCode)
	}
	gone, _ := http.NewRequest("GET", srv.URL+"/blob/abc123", nil)
	gone.Header.Set("Authorization", "Bearer nodesecret")
	gr, _ := http.DefaultClient.Do(gone)
	gr.Body.Close()
	if gr.StatusCode != 404 {
		t.Fatalf("get after delete: %d", gr.StatusCode)
	}
}
