package storage

import (
	"net/http"
	"testing"
)

// NewRemoteBlobStore is called per blob request — including once per
// resumable-upload PATCH chunk. Building a fresh *http.Transport each time leaks
// its keep-alive idle connections + goroutines forever (no idle timeout is set
// on either end), exhausting FDs under normal traffic. The pinned client must be
// cached per (base client, fingerprint) so the connection pool is reused.
func TestPinnedClientReusedAcrossStores(t *testing.T) {
	base := &http.Client{Transport: &http.Transport{}}
	const fp = "abc123"

	a := NewRemoteBlobStore("https://node.example/x", "secret", fp, base)
	b := NewRemoteBlobStore("https://node.example/y", "secret", fp, base)
	if a.hc != b.hc {
		t.Fatal("same base+fingerprint must reuse ONE pinned client (else per-request transport leaks connections)")
	}
	if a.hc.Transport == base.Transport {
		t.Fatal("pinned client must not mutate the shared base transport")
	}

	// A different fingerprint is a genuinely different node → its own client.
	c := NewRemoteBlobStore("https://other.example/z", "secret", "def456", base)
	if c.hc == a.hc {
		t.Fatal("different fingerprints must get distinct pinned clients")
	}

	// No fingerprint (legacy plaintext node) uses the base client unchanged.
	d := NewRemoteBlobStore("http://legacy.example/w", "secret", "", base)
	if d.hc != base {
		t.Fatal("a fingerprint-less node must use the base client as-is")
	}
}
