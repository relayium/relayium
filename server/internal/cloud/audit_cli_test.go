package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// TestLoginAndUploadRefuseCleartextServers pins CLI-4: `relayium login` and
// `relayium up` used to accept any http:// server, so the access token crossed
// the network in cleartext (received by the device poll, sent as the upload's
// bearer). Plain http stays allowed only for loopback hosts (tests, local dev).
func TestLoginAndUploadRefuseCleartextServers(t *testing.T) {
	src := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(src, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, server := range []string{
		"http://relayium.example.com",
		"http://192.168.1.9:8080",
		"ftp://relayium.example.com",
	} {
		c := NewClient(server)
		c.Token = "rlm_cli_secret"
		if _, err := c.Login(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "https") {
			t.Errorf("Login(%s): err = %v, want a refusal naming https", server, err)
		}
		if _, _, _, err := c.Upload(context.Background(), []string{src}, UploadOpts{}); err == nil || !strings.Contains(err.Error(), "https") {
			t.Errorf("Upload(%s): err = %v, want a refusal naming https", server, err)
		}
	}
}

func TestCheckSecureServerAllowsHTTPSAndLoopback(t *testing.T) {
	for _, ok := range []string{
		"https://relayium.com", "https://relayium.example.com:8443",
		"http://localhost:8080", "http://127.0.0.1:9", "http://[::1]:8080",
	} {
		if err := checkSecureServer(ok); err != nil {
			t.Errorf("checkSecureServer(%q) = %v, want nil", ok, err)
		}
	}
	// A loopback-looking name that is not loopback must not pass.
	for _, bad := range []string{"http://localhost.evil.example", "http://127.0.0.1.nip.io", ""} {
		if err := checkSecureServer(bad); err == nil {
			t.Errorf("checkSecureServer(%q) = nil, want an error", bad)
		}
	}
}

// The refusal happens before any request: a non-loopback http server never
// receives the bearer token. (httptest listens on 127.0.0.1, so this drives the
// loopback-allowed path and proves the request still flows there.)
func TestLoopbackHTTPStillReachesServer(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "no", http.StatusTeapot)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, err := c.Login(context.Background(), nil); err == nil {
		t.Fatal("want the teapot error")
	}
	if hits.Load() == 0 {
		t.Fatal("loopback http server was never contacted")
	}
}

// TestParseClaimErrorsRedactTheKey pins the audit nit: a malformed claim's
// error used to quote the whole input, "#k=<key>" and all, so the decryption
// key landed in terminal scrollback and pasted bug reports.
func TestParseClaimErrorsRedactTheKey(t *testing.T) {
	const secret = "SUPERSECRETKEYMATERIAL"
	for _, s := range []string{
		"https://relayium.com/x/abc#k=" + secret, // not a /d/ link
		"#k=" + secret,                           // missing id
		"https://relayium.com/d/abc#q=" + secret, // wrong fragment
	} {
		_, _, _, err := ParseClaim(s)
		if err == nil {
			t.Fatalf("ParseClaim(%q): want an error", s)
		}
		if strings.Contains(err.Error(), secret) {
			t.Errorf("ParseClaim error repeats the key: %v", err)
		}
	}
}
