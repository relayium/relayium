package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
)

// installCert writes a dl.key + dl.crt pair into dir. It self-signs, which is
// not what production does (Cloudflare Origin CA signs there), but the loader
// validates the leaf's own properties -- algorithm, validity window, SAN, and
// that the key matches -- none of which depend on who signed it.
func installCert(t *testing.T, dir, host string, notBefore, notAfter time.Time, ed25519Key bool) {
	t.Helper()
	var (
		pub  any
		priv any
		der  []byte
		err  error
	)
	if ed25519Key {
		pub, priv, err = ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
	} else {
		key, kerr := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if kerr != nil {
			t.Fatal(kerr)
		}
		pub, priv = &key.PublicKey, key
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err = x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, dlKeyName), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600)
	writeFile(t, filepath.Join(dir, dlCrtName), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
}

func writeFile(t *testing.T, path string, data []byte, perm os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatal(err)
	}
}

func TestResolveDownloadFaceAcceptsInstalledCert(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	installCert(t, dir, "node7.relayium.com", now.Add(-time.Hour), now.AddDate(15, 0, 0), false)

	face, why := resolveDownloadFace(dir, "https://node7.relayium.com", ":2053", now)
	if face == nil {
		t.Fatalf("refused a valid certificate: %s", why)
	}
	if why != "" {
		t.Fatalf("accepted but reported a reason: %s", why)
	}
	if face.Host != "node7.relayium.com" || face.URL != "https://node7.relayium.com" || face.Addr != ":2053" {
		t.Fatalf("face = %+v", face)
	}
}

// Direct download simply not configured is not an error and must not log a
// scary reason -- most nodes run this way.
func TestResolveDownloadFaceSilentWhenUnconfigured(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	for _, tc := range []struct{ url, addr string }{
		{"", ":2053"},
		{"https://node7.relayium.com", ""},
		{"", ""},
	} {
		face, why := resolveDownloadFace(dir, tc.url, tc.addr, now)
		if face != nil {
			t.Fatalf("url=%q addr=%q: got a face with no certificate installed", tc.url, tc.addr)
		}
		if why != "" {
			t.Fatalf("url=%q addr=%q: unconfigured should be silent, got %q", tc.url, tc.addr, why)
		}
	}
}

// Every refusal must produce nil AND a reason. nil is what keeps central
// proxying; the reason is the only thing that will tell an operator why the
// node went quiet.
func TestResolveDownloadFaceRefusals(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	const host = "node7.relayium.com"
	const url = "https://node7.relayium.com"

	cases := []struct {
		name  string
		setup func(t *testing.T, dir string)
	}{
		{"no certificate installed", func(t *testing.T, dir string) {}},
		{"expired", func(t *testing.T, dir string) {
			installCert(t, dir, host, now.AddDate(-2, 0, 0), now.AddDate(-1, 0, 0), false)
		}},
		{"not yet valid", func(t *testing.T, dir string) {
			installCert(t, dir, host, now.AddDate(1, 0, 0), now.AddDate(2, 0, 0), false)
		}},
		{"SAN does not cover the host", func(t *testing.T, dir string) {
			installCert(t, dir, "node3.relayium.com", now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
		}},
		{"Ed25519 certificate", func(t *testing.T, dir string) {
			installCert(t, dir, host, now.Add(-time.Hour), now.AddDate(15, 0, 0), true)
		}},
		{"key does not match certificate", func(t *testing.T, dir string) {
			installCert(t, dir, host, now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
			other := t.TempDir()
			installCert(t, other, host, now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
			raw, err := os.ReadFile(filepath.Join(other, dlKeyName))
			if err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(dir, dlKeyName), raw, 0o600)
		}},
		{"world-readable key", func(t *testing.T, dir string) {
			if runtime.GOOS == "windows" {
				t.Skip("permission bits are not meaningful on Windows")
			}
			installCert(t, dir, host, now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
			if err := os.Chmod(filepath.Join(dir, dlKeyName), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			tc.setup(t, dir)
			face, why := resolveDownloadFace(dir, url, ":2053", now)
			if face != nil {
				t.Fatal("served a certificate that should have been refused; central would stop proxying and every download would 526")
			}
			if why == "" {
				t.Fatal("refused silently — an operator would have no way to find out why direct download is off")
			}
		})
	}
}

// The window between `dl-csr` and the signed certificate coming back leaves the
// key on disk with no dl.crt beside it. That is the state an operator is most
// likely to be looking at, so it must produce the instruction, not a raw
// LoadX509KeyPair "no such file".
func TestResolveDownloadFaceExplainsMissingCertWithKeyPresent(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if _, err := loadOrCreateDownloadKey(dir); err != nil {
		t.Fatal(err)
	}
	face, why := resolveDownloadFace(dir, "https://node7.relayium.com", ":2053", now)
	if face != nil {
		t.Fatal("served a face with no certificate on disk")
	}
	if !strings.Contains(why, "dl-csr") {
		t.Fatalf("reason %q does not tell the operator what to run", why)
	}
}

// The listener and the advertised URL come from one call, so they cannot be
// decided separately. Nil face: no server AND no URL. Real face: both.
func TestStartDownloadFaceTiesListenerToAdvertisement(t *testing.T) {
	srv, ln, url, err := startDownloadFace(nil, http.NewServeMux())
	if err != nil {
		t.Fatalf("nil face is not an error: %v", err)
	}
	if srv != nil || ln != nil || url != "" {
		t.Fatalf("nil face produced srv=%v ln=%v url=%q; central must keep proxying", srv, ln, url)
	}

	dir := t.TempDir()
	now := time.Now()
	installCert(t, dir, "node7.relayium.com", now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
	face, why := resolveDownloadFace(dir, "https://node7.relayium.com", "127.0.0.1:0", now)
	if face == nil {
		t.Fatalf("setup: %s", why)
	}
	srv, ln, url, err = startDownloadFace(face, http.NewServeMux())
	if err != nil {
		t.Fatalf("valid face failed to bind: %v", err)
	}
	defer ln.Close()
	if srv == nil || ln == nil || url != "https://node7.relayium.com" {
		t.Fatalf("valid face produced srv=%v ln=%v url=%q", srv, ln, url)
	}
	if srv.Addr != "127.0.0.1:0" {
		t.Fatalf("Addr = %q, want the configured download address", srv.Addr)
	}
	if srv.TLSConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("MinVersion = %x, want TLS 1.2 for CF-origin compatibility", srv.TLSConfig.MinVersion)
	}
}

// A bind failure must leave the advertised URL empty. If it did not, central
// would route every download at a node with no listener: the same unrecoverable
// state as a rejected certificate, and just as invisible — the reachability
// prober watches the blob-WRITE direction, not this one.
func TestStartDownloadFaceBindFailureAdvertisesNothing(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()

	dir := t.TempDir()
	now := time.Now()
	installCert(t, dir, "node7.relayium.com", now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
	face, why := resolveDownloadFace(dir, "https://node7.relayium.com", busy.Addr().String(), now)
	if face == nil {
		t.Fatalf("setup: %s", why)
	}

	srv, ln, url, err := startDownloadFace(face, http.NewServeMux())
	if err == nil {
		if ln != nil {
			ln.Close()
		}
		t.Fatal("bound a port that was already taken")
	}
	if url != "" {
		t.Fatalf("bind failed but advertised %q; central would stop proxying and every download would fail", url)
	}
	if srv != nil || ln != nil {
		t.Fatalf("bind failed but returned srv=%v ln=%v", srv, ln)
	}
}

// Holds the WIRING through a real handshake, not just TLSConfig inspection:
// the certificate a client actually receives must be the one on disk.
func TestStartDownloadFaceServesTheInstalledCert(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	installCert(t, dir, "node7.relayium.com", now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
	face, why := resolveDownloadFace(dir, "https://node7.relayium.com", "127.0.0.1:0", now)
	if face == nil {
		t.Fatalf("setup: %s", why)
	}
	srv, ln, _, err := startDownloadFace(face, http.NewServeMux())
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	defer ln.Close()
	go srv.ServeTLS(ln, "", "")
	defer srv.Close()

	conn, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{
		InsecureSkipVerify: true, // the test CA is not in any trust store; we check the leaf ourselves
		ServerName:         "node7.relayium.com",
	})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	defer conn.Close()

	served := conn.ConnectionState().PeerCertificates[0]
	if served.PublicKeyAlgorithm != x509.ECDSA {
		t.Fatalf("served %v, want ECDSA (Cloudflare cannot handshake with Ed25519)", served.PublicKeyAlgorithm)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, dlCrtName))
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(onDisk)
	if blk == nil {
		t.Fatalf("%s does not contain a PEM block", filepath.Join(dir, dlCrtName))
	}
	if !bytes.Equal(served.Raw, blk.Bytes) {
		t.Fatal("the certificate served is not the one installed on disk")
	}
}

// Central pins the identity certificate's fingerprint for the storage channel.
// A key pinning depends on must not also be handed to every downloader.
func TestDownloadCertIsNotTheIdentityCert(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	installCert(t, dir, "node7.relayium.com", now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
	id, err := secure.LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	face, why := resolveDownloadFace(dir, "https://node7.relayium.com", ":2053", now)
	if face == nil {
		t.Fatalf("setup failed OR the identity cert got wired onto the download face and was rejected as Ed25519: %s", why)
	}
	if bytes.Equal(face.Cert.Certificate[0], id.TLSCert.Certificate[0]) {
		t.Fatal("the public download listener is serving the pinned identity certificate")
	}
}
