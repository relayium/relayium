package main

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"
)

const nodeReadHeaderTimeout = 10 * time.Second
const nodeIdleTimeout = 120 * time.Second
const nodeMaxHeaderBytes = 1 << 20

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
		Addr:              addr,
		Handler:           h,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: nodeReadHeaderTimeout,
		IdleTimeout:       nodeIdleTimeout,
		MaxHeaderBytes:    nodeMaxHeaderBytes,
	}
}

// startDownloadFace BINDS the public download listener and returns it together
// with the URL to advertise to central. Both outputs come from the same face
// and from the same successful bind, so a node cannot listen without
// advertising or advertise without listening.
//
// The bind is explicit, and synchronous, on purpose. ListenAndServeTLS binds
// inside the goroutine that serves, so a port conflict there is only ever a log
// line — by which time the URL has already been handed to rp.register and
// central believes this node serves downloads directly. Every download then
// fails and nothing pulls the traffic back: exactly the unrecoverable state
// resolveDownloadFace exists to prevent, differing from the 526 case only in
// status code. On a bind error the caller gets no server and no URL, and
// central keeps proxying.
func startDownloadFace(face *downloadFace, h http.Handler) (*http.Server, net.Listener, string, error) {
	if face == nil {
		return nil, nil, "", nil
	}
	ln, err := net.Listen("tcp", face.Addr)
	if err != nil {
		return nil, nil, "", fmt.Errorf("bind download listener on %s: %w", face.Addr, err)
	}
	return downloadServer(face.Addr, face.Cert, h), ln, face.URL, nil
}
