package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// downloadFace is the verdict of ONE predicate. Both halves of direct download
// read it and nothing else: the listener that serves /dl, and the DownloadURL
// advertised to central.
//
// They used to be two separate conditions, and the moment they can disagree you
// get the failure this whole change exists to prevent -- a listener up with a
// certificate Cloudflare rejects, while central believes the node serves
// directly. Every stored download on that node then 526s with nothing pulling
// the traffic back to central: the reachability prober added 2026-07-28 tests
// the blob-WRITE direction, not the download direction.
type downloadFace struct {
	Cert tls.Certificate
	Host string
	URL  string
	Addr string
}

// resolveDownloadFace decides whether this node serves direct downloads at all.
//
// A nil face with an empty reason means direct download is simply not
// configured, which is the normal case. A nil face WITH a reason means it was
// configured but cannot be served safely; the caller logs the reason and
// central keeps proxying. The degraded path is slow, not broken.
//
// There is deliberately no self-signed fallback. Under the zone's
// full (strict) SSL mode a self-signed origin certificate is not degraded
// service, it is a silent 526.
func resolveDownloadFace(stateDir, downloadURL, downloadAddr string, now time.Time) (*downloadFace, string) {
	if downloadURL == "" || downloadAddr == "" {
		return nil, ""
	}
	host := urlHost(downloadURL)
	if host == "" {
		return nil, fmt.Sprintf("download URL %q has no host", downloadURL)
	}
	cert, err := loadDownloadCert(stateDir, host, now)
	if err != nil {
		return nil, err.Error()
	}
	return &downloadFace{Cert: cert, Host: host, URL: downloadURL, Addr: downloadAddr}, ""
}

// loadDownloadCert loads the Cloudflare Origin CA certificate installed for this
// node's download hostname, refusing anything Cloudflare would reject at the
// origin handshake -- so the refusal happens here, loudly, at startup, rather
// than silently on every download.
func loadDownloadCert(stateDir, host string, now time.Time) (tls.Certificate, error) {
	keyPath := filepath.Join(stateDir, dlKeyName)
	crtPath := filepath.Join(stateDir, dlCrtName)

	// Both files, not just the key: between `dl-csr` and the signed certificate
	// coming back there is a window where the key exists and dl.crt does not,
	// and that is precisely when an operator most needs to be told what the
	// remaining step is — a raw LoadX509KeyPair "no such file" would not.
	info, err := os.Stat(keyPath)
	if err != nil || !fileExists(crtPath) {
		return tls.Certificate{}, fmt.Errorf("no download certificate installed: run `relayium-node dl-csr %s`, "+
			"have the CSR signed by Cloudflare Origin CA, and write the certificate to %s", host, crtPath)
	}
	// Unix permission bits are not meaningful on Windows (Stat reports ~0666
	// regardless; access is governed by ACLs), so only enforce 0600 elsewhere.
	if perm := info.Mode().Perm(); runtime.GOOS != "windows" && perm != 0o600 {
		return tls.Certificate{}, fmt.Errorf("%s has insecure permissions %04o; run: chmod 600 %s", keyPath, perm, keyPath)
	}
	// LoadX509KeyPair fails when the private key does not match the certificate.
	cert, err := tls.LoadX509KeyPair(crtPath, keyPath)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("load %s + %s: %w", crtPath, keyPath, err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse %s: %w", crtPath, err)
	}
	if leaf.PublicKeyAlgorithm != x509.ECDSA {
		return tls.Certificate{}, fmt.Errorf("%s is %v, want ECDSA: Cloudflare's origin connection cannot "+
			"complete a handshake with it, and the failure is invisible from the node (origin fine, proxy 525)",
			crtPath, leaf.PublicKeyAlgorithm)
	}
	if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		return tls.Certificate{}, fmt.Errorf("%s is valid %s..%s, outside it now (%s)",
			crtPath, leaf.NotBefore.Format(time.RFC3339), leaf.NotAfter.Format(time.RFC3339), now.Format(time.RFC3339))
	}
	if err := leaf.VerifyHostname(host); err != nil {
		return tls.Certificate{}, fmt.Errorf("%s does not cover %s (SAN %v): Cloudflare connects with that name "+
			"in SNI and strict mode checks it", crtPath, host, leaf.DNSNames)
	}
	cert.Leaf = leaf
	return cert, nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
