package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
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
			installCert(t, dir, "node9.relayium.com", now.Add(-time.Hour), now.AddDate(15, 0, 0), false)
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
