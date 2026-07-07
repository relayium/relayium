// Package secure builds the CLI's end-to-end secure channel: an ephemeral
// self-signed TLS identity, a commit-then-reveal fingerprint exchange that pins
// the peer's cert through an untrusted rendezvous, and a 6-digit SAS for
// out-of-band human verification.
package secure

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"math/big"
	"sort"
	"time"
)

const NonceLen = 32

type Identity struct {
	TLSCert     tls.Certificate
	Fingerprint string
}

// NewIdentity generates a fresh Ed25519 self-signed certificate for one transfer.
func NewIdentity() (*Identity, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "relayium-cli"},
		NotBefore:    time.Unix(0, 0),
		NotAfter:     time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC), // ephemeral; validity window is irrelevant under pinning

	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return &Identity{
		TLSCert:     tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv},
		Fingerprint: hex.EncodeToString(sum[:]),
	}, nil
}

func NewNonce() ([]byte, error) {
	n := make([]byte, NonceLen)
	_, err := rand.Read(n)
	return n, err
}

// Commit is SHA256(fingerprint-bytes ‖ nonce).
func Commit(fingerprint string, nonce []byte) []byte {
	h := sha256.New()
	h.Write([]byte(fingerprint))
	h.Write(nonce)
	return h.Sum(nil)
}

func VerifyCommit(commit []byte, fingerprint string, nonce []byte) bool {
	return subtle.ConstantTimeCompare(commit, Commit(fingerprint, nonce)) == 1
}

// SAS derives an order-independent 6-digit short authentication string from the
// two peers' cert fingerprints.
func SAS(fpA, fpB string) string {
	pair := []string{fpA, fpB}
	sort.Strings(pair)
	h := sha256.New()
	h.Write([]byte(pair[0]))
	h.Write([]byte(pair[1]))
	d := h.Sum(nil)
	n := binary.BigEndian.Uint32(d[0:4]) ^ binary.BigEndian.Uint32(d[4:8])
	s := make([]byte, 6)
	v := n % 1_000_000
	for i := 5; i >= 0; i-- {
		s[i] = byte('0' + v%10)
		v /= 10
	}
	return string(s)
}
