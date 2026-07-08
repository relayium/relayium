package secure

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// LoadOrCreateIdentity returns a persistent self-signed identity stored in dir
// as id.key (0600) + id.crt. On first use it generates one; on later use it
// loads the same key so the fingerprint is stable across sessions. It refuses to
// load a key whose permissions are not exactly 0600 (SSH behaviour), returning a
// chmod hint, so a world-readable private key is never trusted.
func LoadOrCreateIdentity(dir string) (*Identity, error) {
	keyPath := filepath.Join(dir, "id.key")
	crtPath := filepath.Join(dir, "id.crt")

	info, err := os.Stat(keyPath)
	switch {
	case err == nil:
		if perm := info.Mode().Perm(); perm != 0o600 {
			return nil, fmt.Errorf("secure: %s has insecure permissions %04o; run: chmod 600 %s", keyPath, perm, keyPath)
		}
		return loadIdentity(keyPath, crtPath)
	case errors.Is(err, os.ErrNotExist):
		return createIdentity(dir, keyPath, crtPath)
	default:
		return nil, err
	}
}

// createIdentity generates a fresh Ed25519 self-signed cert and persists it,
// writing the private key at 0600.
func createIdentity(dir, keyPath, crtPath string) (*Identity, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "relayium-cli"},
		NotBefore:    time.Unix(0, 0),
		NotAfter:     time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC), // validity window is irrelevant under pinning
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	crtPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})

	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, err
	}
	// Guarantee 0600 regardless of umask so the load-time perm check passes.
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(crtPath, crtPEM, 0o644); err != nil {
		return nil, err
	}

	sum := sha256.Sum256(der)
	return &Identity{
		TLSCert:     tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv},
		Fingerprint: hex.EncodeToString(sum[:]),
	}, nil
}

func loadIdentity(keyPath, crtPath string) (*Identity, error) {
	cert, err := tls.LoadX509KeyPair(crtPath, keyPath)
	if err != nil {
		return nil, err
	}
	if len(cert.Certificate) == 0 {
		return nil, errors.New("secure: certificate file has no certificate")
	}
	sum := sha256.Sum256(cert.Certificate[0])
	return &Identity{TLSCert: cert, Fingerprint: hex.EncodeToString(sum[:])}, nil
}

// ServerAny completes a TLS 1.3 server handshake, requiring a client cert but
// accepting any, and reports the peer's fingerprint. Authorization is the
// caller's decision — allow-list membership, or interactive approval — made
// after the handshake and before any file data is read.
func ServerAny(conn net.Conn, id *Identity) (*tls.Conn, string, error) {
	var peerFP string
	cfg := &tls.Config{
		Certificates: []tls.Certificate{id.TLSCert},
		MinVersion:   tls.VersionTLS13,
		ClientAuth:   tls.RequireAnyClientCert,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("secure: peer sent no certificate")
			}
			sum := sha256.Sum256(rawCerts[0])
			peerFP = hex.EncodeToString(sum[:])
			return nil
		},
	}
	c := tls.Server(conn, cfg)
	if err := c.Handshake(); err != nil {
		return nil, peerFP, err
	}
	return c, peerFP, nil
}

// ClientAny completes a TLS 1.3 client handshake accepting whatever certificate
// the server presents, and reports its fingerprint. It is the TOFU / key-learning
// primitive: the caller decides whether the reported fingerprint is trusted
// (first-connect write, or comparison against a pinned known_hosts entry) BEFORE
// sending any application data over the returned connection.
func ClientAny(conn net.Conn, id *Identity) (*tls.Conn, string, error) {
	var peerFP string
	cfg := &tls.Config{
		Certificates:       []tls.Certificate{id.TLSCert},
		InsecureSkipVerify: true, // fingerprint reporting replaces CA verification
		MinVersion:         tls.VersionTLS13,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("secure: peer sent no certificate")
			}
			sum := sha256.Sum256(rawCerts[0])
			peerFP = hex.EncodeToString(sum[:])
			return nil
		},
	}
	c := tls.Client(conn, cfg)
	if err := c.Handshake(); err != nil {
		return nil, "", err
	}
	return c, peerFP, nil
}
