package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

func TestBlobHandlerRoundTripAndAuth(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	h := newBlobHandler(ds, "nodesecret", nil, nil, nil)
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

// TestBlobHandlerAppend verifies the node's PATCH /blob append (X-Blob-Offset)
// used by resumable uploads, including the offset-mismatch 409.
func TestBlobHandlerAppend(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newBlobHandler(ds, "s", nil, nil, nil))
	defer srv.Close()

	patch := func(offset int64, data string) (int, string) {
		req, _ := http.NewRequest("PATCH", srv.URL+"/blob/uploadkey", bytes.NewReader([]byte(data)))
		req.Header.Set("Authorization", "Bearer s")
		req.Header.Set("X-Blob-Offset", itoa64(offset))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(b)
	}

	if code, body := patch(0, "chunk1"); code != 200 || !strings.Contains(body, `"size":6`) {
		t.Fatalf("append#1: %d %s", code, body)
	}
	if code, body := patch(6, "chunk2"); code != 200 || !strings.Contains(body, `"size":12`) {
		t.Fatalf("append#2: %d %s", code, body)
	}
	// Stale offset → 409 with the real size.
	if code, body := patch(6, "dup"); code != http.StatusConflict || !strings.Contains(body, `"size":12`) {
		t.Fatalf("stale offset: %d %s", code, body)
	}

	// The assembled blob reads back whole.
	req, _ := http.NewRequest("GET", srv.URL+"/blob/uploadkey", nil)
	req.Header.Set("Authorization", "Bearer s")
	resp, _ := http.DefaultClient.Do(req)
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "chunk1chunk2" {
		t.Fatalf("assembled = %q", got)
	}
}

func itoa64(n int64) string {
	return itoa(int(n))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

// TestBlobHandlerRange verifies the node serves HTTP Range (206) so central can
// resume an interrupted download.
func TestBlobHandlerRange(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := newBlobHandler(ds, "s", nil, nil, nil)
	srv := httptest.NewServer(h)
	defer srv.Close()

	putReq, _ := http.NewRequest("PUT", srv.URL+"/blob/blobkey", bytes.NewReader([]byte("0123456789")))
	putReq.Header.Set("Authorization", "Bearer s")
	pr, _ := http.DefaultClient.Do(putReq)
	pr.Body.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/blob/blobkey", nil)
	req.Header.Set("Authorization", "Bearer s")
	req.Header.Set("Range", "bytes=4-")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d, want 206", resp.StatusCode)
	}
	if string(body) != "456789" {
		t.Fatalf("range body = %q, want %q", body, "456789")
	}
	if ar := resp.Header.Get("Accept-Ranges"); ar != "bytes" {
		t.Fatalf("Accept-Ranges = %q, want bytes", ar)
	}
}
