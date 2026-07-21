package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A RemoteBlobStore built with a fingerprint must speak TLS to the node and
// accept ONLY the pinned self-signed cert — closing the plaintext-HTTP hole
// where the bearer secret and blob traffic could be sniffed/tampered on-path.
func TestRemoteBlobStorePinsTLS(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		b, _ := io.ReadAll(r.Body)
		_, _ = io.WriteString(w, `{"size":`+itoa(len(b))+`}`)
	}))
	defer srv.Close()

	sum := sha256.Sum256(srv.Certificate().Raw)
	fp := hex.EncodeToString(sum[:])
	ctx := context.Background()

	// Correct pin → the TLS handshake succeeds and the PUT goes through.
	good := NewRemoteBlobStore(srv.URL, "s", fp, srv.Client())
	if n, err := good.Put(ctx, "k", bytes.NewReader([]byte("abc"))); err != nil || n != 3 {
		t.Fatalf("pinned PUT with correct fingerprint: n=%d err=%v", n, err)
	}

	// Wrong pin → the handshake is rejected, so no bytes ever leave.
	bad := NewRemoteBlobStore(srv.URL, "s", "00deadbeef00", srv.Client())
	if _, err := bad.Put(ctx, "k", bytes.NewReader([]byte("abc"))); err == nil {
		t.Fatal("SECURITY: PUT succeeded against a node whose TLS cert did not match the pinned fingerprint")
	}
}
