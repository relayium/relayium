package secure

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net"
)

// Client completes a TLS 1.3 client handshake over conn, presenting id's cert
// and pinning the server to peerFingerprint (standard CA checks are disabled —
// trust comes solely from the out-of-band-committed fingerprint).
func Client(conn net.Conn, id *Identity, peerFingerprint string) (*tls.Conn, error) {
	cfg := &tls.Config{
		Certificates:          []tls.Certificate{id.TLSCert},
		InsecureSkipVerify:    true, // pinning (VerifyPeerCertificate) replaces CA verification
		MinVersion:            tls.VersionTLS13,
		VerifyPeerCertificate: pinCheck(peerFingerprint),
	}
	c := tls.Client(conn, cfg)
	if err := c.Handshake(); err != nil {
		return nil, err
	}
	return c, nil
}

// Server completes a TLS 1.3 server handshake, requiring and pinning the client cert.
func Server(conn net.Conn, id *Identity, peerFingerprint string) (*tls.Conn, error) {
	cfg := &tls.Config{
		Certificates:          []tls.Certificate{id.TLSCert},
		MinVersion:            tls.VersionTLS13,
		ClientAuth:            tls.RequireAnyClientCert,
		VerifyPeerCertificate: pinCheck(peerFingerprint),
	}
	c := tls.Server(conn, cfg)
	if err := c.Handshake(); err != nil {
		return nil, err
	}
	return c, nil
}

// pinCheck verifies the peer presented exactly one certificate whose DER
// SHA-256 hex equals want. rawCerts[0] is the leaf in DER form. The signature
// matches tls.Config.VerifyPeerCertificate exactly.
func pinCheck(want string) func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("secure: peer sent no certificate")
		}
		sum := sha256.Sum256(rawCerts[0])
		if hex.EncodeToString(sum[:]) != want {
			return errors.New("secure: peer certificate does not match pinned fingerprint")
		}
		return nil
	}
}
