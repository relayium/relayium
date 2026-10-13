//go:build !windows

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/cloud"
)

// Recovery through a reverse proxy.
//
// A proxy in front of central (nginx with request buffering off is the common
// shape) answers the client's "Expect: 100-continue" ITSELF, as soon as it
// starts streaming the body upstream, and does not forward the Expect header.
// The probe therefore sees an early 100 Continue that says nothing about the
// origin; it keeps the connection open without sending a byte and waits for
// the origin's real answer.
//
// The origin answers a known key without reading the body and marks that
// answer "Connection: close" (account answerUploadOperation), which stops
// net/http from first draining up to 256 KiB of the unread body -- before
// that, a probe for an upload of at most 256 KiB never got its answer through
// such a proxy. Every size below must now recover.

// recordWire is a CLI recovery run's observable result through a proxy.
func recoverThroughProxy(t *testing.T, e *upEnv, proxyURL string, tr *http.Transport) (int, upDoc, int64) {
	t.Helper()
	prior := http.DefaultTransport
	http.DefaultTransport = tr
	t.Cleanup(func() { tr.CloseIdleConnections(); http.DefaultTransport = prior })
	if err := cloud.Save(e.cfgDir, cloud.Creds{Server: proxyURL, AccessToken: e.token, AccountEmail: "up@example.com"}); err != nil {
		t.Fatal(err)
	}
	e.fault.setMode("commit-502")
	code, stdout, stderr := e.up("--json", e.src)
	if code != exitUpUnknown || e.objects() != 1 {
		t.Fatalf("initial lost answer not established: code %d objects %d\n%s\n%s", code, e.objects(), stdout, stderr)
	}
	op := decodeUpDoc(t, stdout).Operation
	metered := e.uploadedBytes()
	e.fault.setMode("")
	wire0 := e.wire.Load()
	code, stdout, stderr = e.up("--recover", op, "--json")
	sent := e.wire.Load() - wire0
	if after := e.uploadedBytes(); after != metered {
		t.Fatalf("recovery changed the account's metered upload bytes: %d -> %d", metered, after)
	}
	d := decodeUpDoc(t, stdout)
	e.assertNoSecret(stderr, op)
	return code, d, sent
}

// goEarlyContinueProxy is a portable stand-in for such a proxy: Go's own
// server answers 100 Continue the moment the proxy starts reading the body to
// forward it, and the Director drops Expect, as nginx does.
func goEarlyContinueProxy(t *testing.T, upstream string) *httptest.Server {
	t.Helper()
	u, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}
	rp := httputil.NewSingleHostReverseProxy(u)
	base := rp.Director
	rp.Director = func(r *http.Request) {
		base(r)
		r.Header.Del("Expect")
	}
	rp.Transport = &http.Transport{ResponseHeaderTimeout: 3 * time.Second}
	ts := httptest.NewServer(rp)
	t.Cleanup(ts.Close)
	return ts
}

// recoverSizes are the upload sizes every proxy case covers, as source-file
// line counts of 18 bytes: all-empty, tiny, ~90 KB (under net/http's 256 KiB
// drain limit) and ~360 KB (over it).
var recoverSizes = []int{0, 1, 5000, 20000}

func assertRecovered(t *testing.T, e *upEnv, code int, d upDoc, sent int64) {
	t.Helper()
	if code != 0 || d.Status != "uploaded" {
		t.Fatalf("recover through proxy: code %d doc %+v", code, d)
	}
	if sent > maxProbeWire || e.objects() != 1 || e.records() != 0 {
		t.Fatalf("sent=%d objects=%d records=%d", sent, e.objects(), e.records())
	}
	if got := e.download(d.Link); got != e.body {
		t.Fatalf("recovered link opened %d bytes, want %d", len(got), len(e.body))
	}
}

func TestUpRecoverThroughEarlyContinueProxyE2E(t *testing.T) {
	recoverTimeoutForTest(t, 5*time.Second)
	for _, lines := range recoverSizes {
		t.Run(fmt.Sprintf("lines_%d", lines), func(t *testing.T) {
			e := newUpEnvSize(t, lines)
			p := goEarlyContinueProxy(t, e.ts.URL)
			code, d, sent := recoverThroughProxy(t, e, p.URL, http.DefaultTransport.(*http.Transport).Clone())
			assertRecovered(t, e, code, d, sent)
		})
	}
}

func recoverTimeoutForTest(t *testing.T, d time.Duration) time.Duration {
	t.Helper()
	old := cloud.SetRecoverTimeoutForTest(d)
	t.Cleanup(func() { cloud.SetRecoverTimeoutForTest(old) })
	return old
}

// The same through a REAL nginx (the generic directives a production /api
// proxy uses: HTTP/1.1 upstream, request and response buffering off), on a
// verified TLS front end in HTTP/1.1 and HTTP/2 modes. Runs when
// RELAYIUM_TEST_NGINX names an nginx binary; the nginx process, its prefix,
// pid, logs and temp paths are private to the test and on loopback.
func TestUpRecoverThroughNginxE2E(t *testing.T) {
	bin := os.Getenv("RELAYIUM_TEST_NGINX")
	if bin == "" {
		t.Skip("set RELAYIUM_TEST_NGINX=/path/to/nginx to run the real-proxy recovery case")
	}
	recoverTimeoutForTest(t, 8*time.Second)
	for _, h2 := range []bool{false, true} {
		for _, lines := range recoverSizes {
			name := fmt.Sprintf("front_h2_%t/lines_%d", h2, lines)
			t.Run(name, func(t *testing.T) {
				e := newUpEnvSize(t, lines)
				proxy, tr := ownedNginx(t, bin, e.ts.URL, h2)
				code, d, sent := recoverThroughProxy(t, e, proxy, tr)
				t.Logf("%s: recover code %d status %s sent %d bytes objects %d records %d", name, code, d.Status, sent, e.objects(), e.records())
				assertRecovered(t, e, code, d, sent)
			})
		}
	}
}

// ownedNginx starts a private nginx (foreground, own prefix/pid/logs/temp,
// loopback) proxying /api/ to upstream, with a fresh self-signed certificate
// the returned transport trusts through RootCAs -- verification stays on.
func ownedNginx(t *testing.T, bin, upstream string, h2 bool) (string, *http.Transport) {
	t.Helper()
	dir := t.TempDir()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: "cli-recover-fixture"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	_ = os.WriteFile(filepath.Join(dir, "cert.pem"), certPEM, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{RootCAs: pool}
	tr.ForceAttemptHTTP2 = h2
	if !h2 {
		tr.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
		tr.TLSClientConfig.NextProtos = []string{"http/1.1"}
	}
	http2 := ""
	if h2 {
		http2 = "http2 on;"
	}
	marker := filepath.Base(dir)
	conf := fmt.Sprintf(`pid nginx.pid;
error_log error.log notice;
events { worker_connections 64; }
http {
 access_log off;
 client_body_temp_path client-body;
 proxy_temp_path proxy-body;
 server {
  listen 127.0.0.1:%d ssl;
  %s
  ssl_certificate cert.pem;
  ssl_certificate_key key.pem;
  location = /fixture-ready { add_header X-Fixture "%s"; return 204; }
  location /api/ {
   proxy_pass %s;
   proxy_http_version 1.1;
   proxy_set_header Connection "";
   proxy_set_header Host $host;
   proxy_request_buffering off;
   proxy_buffering off;
   proxy_read_timeout 3s;
   proxy_send_timeout 3s;
  }
 }
}
`, port, http2, marker, upstream)
	if err := os.WriteFile(filepath.Join(dir, "nginx.conf"), []byte(conf), 0o600); err != nil {
		t.Fatal(err)
	}
	logf, err := os.Create(filepath.Join(dir, "launch.log"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "-p", dir+"/", "-c", "nginx.conf", "-g", "daemon off; master_process off;")
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		logf.Close()
	})
	base := fmt.Sprintf("https://127.0.0.1:%d", port)
	client := &http.Client{Transport: tr, Timeout: time.Second}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := client.Get(base + "/fixture-ready")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 204 && resp.Header.Get("X-Fixture") == marker {
				want := 1
				if h2 {
					want = 2
				}
				if resp.ProtoMajor != want {
					t.Fatalf("front-end protocol %s, want major %d", resp.Proto, want)
				}
				return base, tr
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "launch.log"))
	t.Fatalf("owned nginx did not become ready: %s", b)
	return "", nil
}
