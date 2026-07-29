package main

import (
	"crypto/tls"
	"net/http"
)

// downloadServer builds the public download listener from an already-validated
// certificate. It exists so the certificate choice and the server that serves it
// are wired together in ONE place a test can hold: the first attempt at the
// v0.10.0 fix shipped a cert helper without connecting it to the listener, the
// unit test passed because it called the helper directly, and the live node kept
// serving the Ed25519 identity certificate.
//
// There is no self-signed fallback any more. The zone runs Full (strict), where
// a self-signed origin certificate is not degraded service but a silent 526 --
// see resolveDownloadFace in dlface.go, which decides whether we serve at all.
//
// MinVersion stays at TLS 1.2 for Cloudflare origin compatibility.
func downloadServer(addr string, cert tls.Certificate, h http.Handler) *http.Server {
	return &http.Server{
		Addr:      addr,
		Handler:   h,
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}
}

// startDownloadFace builds the public download listener and returns the URL to
// advertise to central. Both outputs come from the same face, so a node cannot
// listen without advertising or advertise without listening.
func startDownloadFace(face *downloadFace, h http.Handler) (*http.Server, string) {
	if face == nil {
		return nil, ""
	}
	return downloadServer(face.Addr, face.Cert, h), face.URL
}
