package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// The download listener's key and certificate live beside id.key/id.crt and
// state.json in StateDir. Fixed names, no new env var: same convention as the
// node identity, including the 0600 refusal on load.
const (
	dlKeyName = "dl.key"
	dlCrtName = "dl.crt"
)

type csrConfig struct {
	StateDir string
	Host     string
}

// parseCSRFlags resolves the hostname the certificate will be signed for.
//
// It is an explicit argument rather than being read from DOWNLOAD_URL, because
// the bootstrap order requires a CSR BEFORE DOWNLOAD_URL is set — the listener
// must not start until a certificate exists. On an already-installed node the
// argument may be omitted. A contradiction between the two is an error, not a
// preference: a certificate signed for the wrong name can never match the SNI
// Cloudflare presents, and the symptom would be a 526 with a valid-looking
// certificate sitting on disk.
func parseCSRFlags(args []string, stderr io.Writer) (csrConfig, error) {
	fs := flag.NewFlagSet("dl-csr", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cc csrConfig
	fs.StringVar(&cc.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", "/var/lib/relayium-node"),
		"directory holding dl.key")
	if err := fs.Parse(args); err != nil {
		return cc, err
	}
	cc.Host = fs.Arg(0)
	fromURL := urlHost(env("RELAYIUM_NODE_DOWNLOAD_URL", ""))
	switch {
	case cc.Host == "" && fromURL == "":
		return cc, errors.New("dl-csr: hostname required, e.g. `relayium-node dl-csr node7.relayium.com`")
	case cc.Host == "":
		cc.Host = fromURL
	case fromURL != "" && fromURL != cc.Host:
		return cc, fmt.Errorf("dl-csr: hostname %q contradicts RELAYIUM_NODE_DOWNLOAD_URL host %q; "+
			"a certificate signed for the wrong name can never match what Cloudflare connects to", cc.Host, fromURL)
	}
	return cc, nil
}

// loadOrCreateDownloadKey returns the node's persistent download key, creating
// an ECDSA P-256 key at 0600 on first use. P-256 is not a preference: Cloudflare
// cannot complete an origin handshake against an Ed25519 certificate.
func loadOrCreateDownloadKey(stateDir string) (*ecdsa.PrivateKey, error) {
	keyPath := filepath.Join(stateDir, dlKeyName)
	info, err := os.Stat(keyPath)
	switch {
	case err == nil:
		// Unix permission bits are not meaningful on Windows (Stat reports ~0666
		// regardless; access is governed by ACLs), so only enforce 0600 elsewhere.
		if perm := info.Mode().Perm(); runtime.GOOS != "windows" && perm != 0o600 {
			return nil, fmt.Errorf("%s has insecure permissions %04o; run: chmod 600 %s", keyPath, perm, keyPath)
		}
		return readDownloadKey(keyPath)
	case errors.Is(err, os.ErrNotExist):
		return createDownloadKey(stateDir, keyPath)
	default:
		return nil, err
	}
}

func readDownloadKey(keyPath string) (*ecdsa.PrivateKey, error) {
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(raw)
	if blk == nil {
		return nil, fmt.Errorf("%s: no PEM block", keyPath)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", keyPath, err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s holds a %T, want an ECDSA key "+
			"(Cloudflare cannot handshake with an Ed25519 origin certificate)", keyPath, parsed)
	}
	return key, nil
}

func createDownloadKey(stateDir, keyPath string) (*ecdsa.PrivateKey, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	// Guarantee 0600 regardless of umask so the load-time check passes.
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func runCSR(cc csrConfig, stdout, stderr io.Writer) int {
	key, err := loadOrCreateDownloadKey(cc.StateDir)
	if err != nil {
		fmt.Fprintf(stderr, "relayium-node: %v\n", err)
		return 1
	}
	tmpl := &x509.CertificateRequest{
		Subject:            pkix.Name{CommonName: cc.Host},
		DNSNames:           []string{cc.Host},
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
	if err != nil {
		fmt.Fprintf(stderr, "relayium-node: create CSR: %v\n", err)
		return 1
	}
	if err := pem.Encode(stdout, &pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}); err != nil {
		fmt.Fprintf(stderr, "relayium-node: write CSR: %v\n", err)
		return 1
	}
	return 0
}
