package cloud

import (
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storecrypto"
)

func TestUploadWireFormat(t *testing.T) {
	var body []byte
	var auth, query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		query = r.URL.RawQuery
		body, _ = io.ReadAll(r.Body)
		writeJSONTest(w, map[string]any{"id": "abc123", "expiresAt": 999})
	}))
	defer srv.Close()

	tmp := t.TempDir()
	p := filepath.Join(tmp, "hello.txt")
	_ = os.WriteFile(p, []byte("hello world"), 0o644)

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_t"
	id, key, err := c.Upload(context.Background(), []string{p}, UploadOpts{Burn: true})
	if err != nil || id != "abc123" || key == "" {
		t.Fatalf("upload: %v id=%q key=%q", err, id, key)
	}
	if auth != "Bearer rlm_cli_t" {
		t.Fatalf("auth header: %q", auth)
	}
	if !strings.Contains(query, "burnAfterRead=1") {
		t.Fatalf("query: %q", query)
	}
	// body must decrypt with the returned key: mlen || encManifest || frames
	raw, _ := storecrypto.DecodeKey(key)
	mlen := binary.BigEndian.Uint32(body[:4])
	m, err := storecrypto.DecryptManifest(raw, body[4:4+mlen])
	if err != nil || m.Files[0].Name != "hello.txt" || m.Files[0].Size != 11 {
		t.Fatalf("manifest: %v %+v", err, m)
	}
	dec := storecrypto.NewDecryptor(raw)
	var out []byte
	_ = dec.Push(body[4+mlen:], func(pt []byte) error { out = append(out, pt...); return nil })
	if string(out) != "hello world" {
		t.Fatalf("payload: %q", out)
	}
}
