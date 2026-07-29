package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The key must be P-256 and 0600. Both are load-bearing: Cloudflare's origin
// connection cannot handshake with Ed25519 (the v0.10.0 canary), and the
// loader in Task 2 refuses any key whose permissions are not exactly 0600.
func TestCSRCreatesP256KeyAt0600(t *testing.T) {
	dir := t.TempDir()
	key, err := loadOrCreateDownloadKey(dir)
	if err != nil {
		t.Fatalf("loadOrCreateDownloadKey: %v", err)
	}
	if key.Curve != elliptic.P256() {
		t.Fatalf("curve = %v, want P-256 (Cloudflare origin requirement)", key.Curve)
	}
	info, err := os.Stat(filepath.Join(dir, dlKeyName))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); runtime.GOOS != "windows" && perm != 0o600 {
		t.Fatalf("dl.key perm = %04o, want 0600", perm)
	}
}

// Re-running dl-csr on an installed node must not silently invalidate the
// certificate already signed for the old key.
func TestCSRReusesExistingKey(t *testing.T) {
	dir := t.TempDir()
	first, err := loadOrCreateDownloadKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadOrCreateDownloadKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !first.PublicKey.Equal(&second.PublicKey) {
		t.Fatal("second call produced a different key; a certificate signed for the first would stop matching")
	}
}

func TestCSRRefusesInsecureKeyPerms(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits are not meaningful on Windows")
	}
	dir := t.TempDir()
	if _, err := loadOrCreateDownloadKey(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(dir, dlKeyName), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateDownloadKey(dir); err == nil {
		t.Fatal("loaded a world-readable private key; want a refusal with a chmod hint")
	}
}

// The CSR must carry the hostname Cloudflare will connect to, in the SAN —
// Task 2's loader calls VerifyHostname against exactly this name.
func TestRunCSREmitsCSRForHostname(t *testing.T) {
	dir := t.TempDir()
	var stdout, stderr bytes.Buffer
	if code := runCSR(csrConfig{StateDir: dir, Host: "node7.relayium.com"}, &stdout, &stderr); code != 0 {
		t.Fatalf("runCSR exit %d, stderr: %s", code, stderr.String())
	}
	blk, _ := pem.Decode(stdout.Bytes())
	if blk == nil || blk.Type != "CERTIFICATE REQUEST" {
		t.Fatalf("stdout is not a CSR PEM block: %q", stdout.String())
	}
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil {
		t.Fatalf("parse CSR: %v", err)
	}
	if err := csr.CheckSignature(); err != nil {
		t.Fatalf("CSR signature: %v", err)
	}
	if csr.Subject.CommonName != "node7.relayium.com" {
		t.Fatalf("CN = %q, want node7.relayium.com", csr.Subject.CommonName)
	}
	if len(csr.DNSNames) != 1 || csr.DNSNames[0] != "node7.relayium.com" {
		t.Fatalf("SAN = %v, want [node7.relayium.com]", csr.DNSNames)
	}
	if _, ok := csr.PublicKey.(*ecdsa.PublicKey); !ok {
		t.Fatalf("CSR public key %T is not ECDSA", csr.PublicKey)
	}
}

// A CSR signed for the wrong name produces a certificate that can never match
// what Cloudflare connects to, so a mismatch is an error rather than a
// silently-preferred value.
func TestParseCSRFlagsRejectsHostMismatch(t *testing.T) {
	t.Setenv("RELAYIUM_NODE_DOWNLOAD_URL", "https://node7.relayium.com")
	if _, err := parseCSRFlags([]string{"node9.relayium.com"}, &bytes.Buffer{}); err == nil {
		t.Fatal("accepted a hostname that contradicts RELAYIUM_NODE_DOWNLOAD_URL")
	}
}

func TestParseCSRFlagsFallsBackToDownloadURL(t *testing.T) {
	t.Setenv("RELAYIUM_NODE_DOWNLOAD_URL", "https://node7.relayium.com")
	cc, err := parseCSRFlags(nil, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if cc.Host != "node7.relayium.com" {
		t.Fatalf("Host = %q, want node7.relayium.com", cc.Host)
	}
}

func TestParseCSRFlagsRequiresHostname(t *testing.T) {
	t.Setenv("RELAYIUM_NODE_DOWNLOAD_URL", "")
	if _, err := parseCSRFlags(nil, &bytes.Buffer{}); err == nil {
		t.Fatal("accepted dl-csr with no hostname and no RELAYIUM_NODE_DOWNLOAD_URL")
	}
}
