package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"time"
)

// downloadTLSCert makes the certificate the PUBLIC download listener presents.
//
// It deliberately does NOT reuse the node identity cert (secure.Identity), even
// though both are self-signed and neither is validated by name. The identity
// cert is Ed25519, and **Cloudflare's origin connection does not support
// Ed25519** — the handshake fails and every download comes back as a 525 with
// nothing in the node's own logs to explain it. (That is exactly how the first
// v0.10.0 canary failed: origin curl fine, through the proxy 525.) ECDSA P-256
// is what CF accepts, and it costs nothing here.
//
// Reusing the identity cert would also be wrong for a second reason: central
// PINS that cert's fingerprint for the storage channel. A key that pinning
// depends on should not also be handed to every downloader on the internet.
//
// The cert is generated per process start and never written to disk: nothing
// pins it, Cloudflare (in Full mode) does not verify it, and a key that lives
// only in memory is one less secret on the node's disk. host is used for the
// SAN when it is a name or an IP, purely so the cert reads sensibly in a
// debugger — nothing validates it.
func downloadTLSCert(host string) (tls.Certificate, error) {
	return newDownloadCert(host)
}

// downloadServer builds the public download listener. It exists so the cert
// choice and the server that serves it are wired together in ONE place that a
// test can hold: the first attempt at this fix shipped downloadTLSCert without
// actually connecting it to the listener, the unit test passed (it called the
// helper directly), and the live node kept serving the Ed25519 identity cert.
func downloadServer(addr, host string, h http.Handler) (*http.Server, error) {
	cert, err := downloadTLSCert(host)
	if err != nil {
		return nil, err
	}
	return &http.Server{
		Addr:      addr,
		Handler:   h,
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}, nil
}

func newDownloadCert(host string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "relayium-node-download"},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else if host != "" {
		tmpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}
