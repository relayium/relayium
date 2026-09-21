package cloud

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// slowReaderServer is an HTTP/2 upload endpoint behind a slow link: it takes the
// body at `rate` bytes per second and answers the moment the last byte is in.
// Nothing about it is slow except the path -- which is the point.
func slowReaderServer(t *testing.T, rate int) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, rate/20)
		for {
			_, err := io.ReadFull(r.Body, buf)
			if err != nil {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		writeJSONTest(w, map[string]any{"id": "slow1", "expiresAt": 0})
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// Reported hands-on, 2026-09-21, from a cloud VM a long way from the server:
//
//	Post "https://relayium.com/api/files": http2: timeout awaiting response headers
//
// with the progress line already at 99% of 6.2 MB about a second in. The
// transport's ResponseHeaderTimeout starts when the body has been written
// LOCALLY -- into the socket buffer and the HTTP/2 window -- not when the server
// has it. On a path slower than the local write, the server is still receiving,
// steadily and healthily, when the client decides it has stopped answering.
//
// The header timeout here is scaled down with the link so the case runs in a
// couple of seconds; the proportions are the incident's.
func TestUploadSurvivesALinkSlowerThanTheLocalWrite(t *testing.T) {
	const rate = 1 << 20 // the path delivers 1 MiB/s
	srv := slowReaderServer(t, rate)

	p := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(p, make([]byte, 4<<20), 0o644); err != nil {
		t.Fatal(err)
	}

	c := newClientWith(srv.URL, srv.Client().Transport.(*http.Transport), clientTimeouts{
		responseHeader: 300 * time.Millisecond,
		confirmBase:    300 * time.Millisecond,
		confirmMinRate: rate / 4, // the slowest path we promise to wait out
	})
	c.Token = "t"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	id, _, _, err := c.Upload(ctx, []string{p}, UploadOpts{})
	if err != nil {
		t.Fatalf("a healthy upload over a slow link failed: %v", err)
	}
	if id != "slow1" {
		t.Fatalf("id = %q", id)
	}
}

// The other half of the bargain: taking the transport's header timeout off the
// upload must not leave it unbounded. A server that swallows the body and never
// answers ends the command, with an error that says the outcome is UNKNOWN --
// the POST is not idempotent, so nothing may be retried on the user's behalf.
func TestUploadToAServerThatNeverAnswersIsBounded(t *testing.T) {
	release := make(chan struct{})
	var posts atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		<-release
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })

	p := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(p, make([]byte, 64<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	c := newClientWith(srv.URL, srv.Client().Transport.(*http.Transport), clientTimeouts{
		responseHeader: time.Minute, // must play no part in the upload
		confirmBase:    200 * time.Millisecond,
		confirmMinRate: 1 << 20,
	})
	c.Token = "t"
	var confirming atomic.Int32
	c.Confirming = func() { confirming.Add(1) }

	start := time.Now()
	_, _, _, err := c.Upload(context.Background(), []string{p}, UploadOpts{})
	var unconfirmed *UploadUnconfirmedError
	if !errors.As(err, &unconfirmed) {
		t.Fatalf("err = %v, want *UploadUnconfirmedError", err)
	}
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("took %s; the wait is not bounded by confirmTimeout", el)
	}
	if !strings.Contains(err.Error(), "nothing was retried") {
		t.Fatalf("the message must say the outcome is unknown and nothing was retried: %q", err)
	}
	if n := posts.Load(); n != 1 {
		t.Fatalf("server saw %d POSTs; an upload is never retried", n)
	}
	if n := confirming.Load(); n != 1 {
		t.Fatalf("Confirming called %d times, want once", n)
	}
}

// Every request that is NOT the upload keeps the transport's bound on
// time-to-first-byte; only the upload trades it for confirmTimeout.
func TestOnlyTheUploadLosesTheHeaderTimeout(t *testing.T) {
	c := NewClient("https://example.invalid")
	std := c.HTTP.Transport.(*uaTransport).base.(*http.Transport)
	up := c.uploadHTTP.Transport.(*uaTransport).base.(*http.Transport)
	if std.ResponseHeaderTimeout != 30*time.Second {
		t.Fatalf("standard header timeout = %s", std.ResponseHeaderTimeout)
	}
	if up.ResponseHeaderTimeout != 0 {
		t.Fatalf("upload header timeout = %s, want none", up.ResponseHeaderTimeout)
	}
	if up.TLSHandshakeTimeout != std.TLSHandshakeTimeout || up.TLSHandshakeTimeout == 0 {
		t.Fatalf("the upload transport must keep the connect-phase bounds: %s vs %s",
			up.TLSHandshakeTimeout, std.TLSHandshakeTimeout)
	}
}

func TestConfirmTimeoutScalesWithTheUnconfirmedTail(t *testing.T) {
	c := NewClient("https://example.invalid")
	for _, tc := range []struct {
		body int64
		want time.Duration
	}{
		{0, 30 * time.Second},
		{-1, 30 * time.Second},
		{32 << 10, 31 * time.Second},
		{6400 << 10, 230 * time.Second}, // the reported upload's size: 200 s for the tail, not 0
		{16 << 20, 30*time.Second + 512*time.Second},
		{5 << 30, 30*time.Second + 512*time.Second}, // capped: in-flight data is bounded by buffers, not by file size
	} {
		if got := c.confirmTimeout(tc.body); got != tc.want {
			t.Errorf("confirmTimeout(%d) = %s, want %s", tc.body, got, tc.want)
		}
	}
}

// A caller that installed its own HTTP client is still obeyed for uploads.
func TestUploadHonoursAReplacedHTTPClient(t *testing.T) {
	var hit atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		writeJSONTest(w, map[string]any{"id": "x"})
	}))
	defer srv.Close()
	p := filepath.Join(t.TempDir(), "a")
	_ = os.WriteFile(p, []byte("a"), 0o644)

	c := NewClient(srv.URL)
	c.Token = "t"
	c.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		hit.Add(1)
		return http.DefaultTransport.RoundTrip(r)
	})}
	if _, _, _, err := c.Upload(context.Background(), []string{p}, UploadOpts{}); err != nil {
		t.Fatal(err)
	}
	if hit.Load() != 1 {
		t.Fatal("Upload bypassed the caller's HTTP client")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
