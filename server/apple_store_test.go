package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
)

// What startup does with the App Store configuration, and — the part that
// matters for every deployment that exists today — what it does NOT do when
// there is no configuration at all.
//
// The file format's own adversarial cases (malformed JSON, junk PEM, an
// unreadable or oversized trust file, an app identity that cannot be an
// identity) live next to the reader that refuses them, in
// server/account/apple_store_config_test.go. What is tested here is the wiring:
// absent means untouched, broken means refused, complete means installed.

// fakeAppleSink records what main would have done to the account service.
type fakeAppleSink struct {
	calls int
	got   *account.AppleTransactionVerifier
}

func (f *fakeAppleSink) SetAppleTransactionVerifier(v *account.AppleTransactionVerifier) {
	f.calls++
	f.got = v
}

// No configuration is the shipping default: no verifier is built, and the
// account service is never touched — so POST /api/billing/apple/transaction
// keeps answering 503 from the service's own untouched nil.
func TestLoadAppleStoreAbsentIsInert(t *testing.T) {
	for _, path := range []string{"", "   ", "\t\n"} {
		setup, err := loadAppleStore(path)
		if err != nil {
			t.Fatalf("empty path %q should not be an error: %v", path, err)
		}
		if setup.verifier != nil {
			t.Fatalf("empty path %q built a verifier", path)
		}
		var sink fakeAppleSink
		setup.install(&sink)
		if sink.calls != 0 {
			t.Fatalf("empty path %q touched the account service (%d calls)", path, sink.calls)
		}
	}
}

// A path that names nothing is the typo case: startup fails rather than falling
// back to the inert state, where the mistake would be indistinguishable from a
// deployment that never sold anything.
func TestLoadAppleStoreBrokenConfigIsRefused(t *testing.T) {
	dir := t.TempDir()
	partial := filepath.Join(dir, "partial.json")
	if err := os.WriteFile(partial, []byte(`{"environment":"Sandbox"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, path string }{
		{"missing file", filepath.Join(dir, "does-not-exist.json")},
		{"a directory", dir},
		{"partial configuration", partial},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setup, err := loadAppleStore(tc.path)
			if err == nil {
				t.Fatal("startup accepted a configuration it should have refused")
			}
			if setup.verifier != nil {
				t.Fatal("a refused configuration still produced a verifier")
			}
			// And the refusal is inert on its own: nothing reaches the service.
			var sink fakeAppleSink
			setup.install(&sink)
			if sink.calls != 0 {
				t.Fatalf("a refused configuration touched the account service (%d calls)", sink.calls)
			}
		})
	}
}

// A complete configuration is installed — once, and as itself. The verifier's
// behaviour (that it accepts exactly the fixture transaction, and refuses one
// anchored on a root the file does not name) is proven against a live endpoint
// in server/account/apple_store_config_test.go.
func TestLoadAppleStoreInstallsTheConfiguredVerifier(t *testing.T) {
	dir := t.TempDir()
	roots := filepath.Join(dir, "roots.pem")
	if err := os.WriteFile(roots, appleTestRootPEM(t), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "apple-store.json")
	body := fmt.Sprintf(`{"environment":"Production","rootCertsFile":%q,"apps":[
		{"bundleId":"com.example.app","appAppleId":1234567890},
		{"bundleId":"com.example.mac","appAppleId":1234567891}
	]}`, roots)
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	setup, err := loadAppleStore(cfg)
	if err != nil {
		t.Fatalf("a complete configuration was refused: %v", err)
	}
	if setup.verifier == nil {
		t.Fatal("a complete configuration produced no verifier")
	}
	if setup.env != "Production" || setup.apps != 2 {
		t.Fatalf("boot summary does not describe the file: env=%q apps=%d", setup.env, setup.apps)
	}

	var sink fakeAppleSink
	setup.install(&sink)
	if sink.calls != 1 {
		t.Fatalf("install made %d calls, want exactly 1", sink.calls)
	}
	if sink.got != setup.verifier {
		t.Fatal("the service received something other than the configured verifier")
	}
}

// appleTestRootPEM is a throwaway self-signed CA: the shape of a trust anchor,
// with nothing Apple about it. No real Apple root is committed to this
// repository, and the verifier never falls back to the host's root store.
func appleTestRootPEM(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Root CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
