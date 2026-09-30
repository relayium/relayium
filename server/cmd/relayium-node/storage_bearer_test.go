package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// The storage auth used strings.TrimPrefix(header, "Bearer "), so the bare
// secret with no scheme was accepted too. Central always sends "Bearer <secret>"
// (internal/storage.Remote); anything else must be refused.
func TestBlobHandlerRequiresBearerScheme(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newBlobHandler(ds, "nodesecret", nil, nil, nil, nil))
	defer srv.Close()
	put := func(auth string) int {
		req, _ := http.NewRequest("PUT", srv.URL+"/blob/abc123", bytes.NewReader([]byte("cipher")))
		req.Header.Set("Authorization", auth)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for _, bad := range []string{"nodesecret", "bearer nodesecret", "Basic nodesecret"} {
		if code := put(bad); code != http.StatusUnauthorized {
			t.Errorf("Authorization %q: status %d, want 401", bad, code)
		}
	}
	if code := put("Bearer nodesecret"); code != http.StatusOK {
		t.Fatalf("Bearer nodesecret: status %d, want 200", code)
	}
}
