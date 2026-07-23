package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"strconv"
	"testing"
)

// TestReplayGuardClaim covers the three properties the /dl route depends on:
// a token is claimable exactly once, distinct tokens don't interfere, and an
// entry stops blocking once the token it came from has expired.
func TestReplayGuardClaim(t *testing.T) {
	g := newReplayGuard()
	const now = 1000
	if !g.claim("a", now+60, now) {
		t.Fatal("first claim must succeed")
	}
	if g.claim("a", now+60, now) {
		t.Fatal("second claim of the same token must fail")
	}
	if !g.claim("b", now+60, now) {
		t.Fatal("a different token must be unaffected")
	}
	// Past the recorded expiry the entry is inert: that token can no longer be
	// presented anyway (Verify rejects it), so it must not pin memory or block a
	// later token that happens to reuse the id.
	if !g.claim("a", now+120, now+61) {
		t.Fatal("an expired entry must not block a new claim")
	}
}

// TestReplayGuardPrunes: the used-set is swept as it grows, so a long-running
// node doesn't accumulate an entry per download forever.
func TestReplayGuardPrunes(t *testing.T) {
	g := newReplayGuard()
	const now = 1000
	for i := 0; i < 4*minPruneAt; i++ {
		g.claim("k"+strconv.Itoa(i), now+10, now)
	}
	if len(g.used) < minPruneAt {
		t.Fatalf("unexpired entries were dropped: %d", len(g.used))
	}
	// Now that they're all expired, the next claim past the threshold sweeps them.
	before := len(g.used)
	for i := 0; i < 4*minPruneAt; i++ {
		g.claim("late"+strconv.Itoa(i), now+120, now+100)
	}
	if len(g.used) >= before+4*minPruneAt {
		t.Fatalf("used-set never pruned: %d entries after %d", len(g.used), before)
	}
}

// TestDownloadCertIsNotEd25519 pins the one property that made the first real
// v0.10.0 canary fail: the download listener presented the node's Ed25519
// identity certificate, Cloudflare could not complete a TLS handshake with it,
// and every proxied download came back 525 while the origin answered fine on
// localhost. ECDSA is what CF's origin connection accepts.
func TestDownloadCertIsNotEd25519(t *testing.T) {
	for _, host := range []string{"n5.relayium.com", "203.0.113.7", ""} {
		cert, err := downloadTLSCert(host)
		if err != nil {
			t.Fatalf("downloadTLSCert(%q): %v", host, err)
		}
		leaf, err := x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if leaf.PublicKeyAlgorithm != x509.ECDSA {
			t.Fatalf("download cert key algorithm = %v, want ECDSA (Cloudflare cannot handshake with Ed25519)",
				leaf.PublicKeyAlgorithm)
		}
		if _, ok := cert.PrivateKey.(*ecdsa.PrivateKey); !ok {
			t.Fatalf("private key %T is not ECDSA", cert.PrivateKey)
		}
	}
}

// The identity cert must NOT be what the public listener serves: central pins
// its fingerprint for the storage channel, so it stays off the public face.
func TestDownloadCertDiffersFromIdentity(t *testing.T) {
	a, err := downloadTLSCert("n5.relayium.com")
	if err != nil {
		t.Fatal(err)
	}
	b, err := downloadTLSCert("n5.relayium.com")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a.Certificate[0], b.Certificate[0]) {
		t.Fatal("two calls produced the same certificate — it should be per-process, not a stored key")
	}
}

// TestDownloadServerServesECDSA holds the WIRING, not just the helper: the
// listener that actually gets started must carry a non-Ed25519 certificate.
// The first attempt at this fix tested only the helper and shipped a node that
// still served the identity cert.
func TestDownloadServerServesECDSA(t *testing.T) {
	srv, err := downloadServer(":2053", "n5.relayium.com", nil)
	if err != nil {
		t.Fatalf("downloadServer: %v", err)
	}
	if srv.TLSConfig == nil || len(srv.TLSConfig.Certificates) != 1 {
		t.Fatal("download server has no certificate configured")
	}
	leaf, err := x509.ParseCertificate(srv.TLSConfig.Certificates[0].Certificate[0])
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if leaf.PublicKeyAlgorithm != x509.ECDSA {
		t.Fatalf("listener cert = %v, want ECDSA (Cloudflare cannot handshake with Ed25519)", leaf.PublicKeyAlgorithm)
	}
	if srv.TLSConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("MinVersion = %x, want TLS 1.2 for CF-origin compatibility", srv.TLSConfig.MinVersion)
	}
}
