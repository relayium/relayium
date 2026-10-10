package cloud

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// The outcome boundary of the single-shot upload (F1/F2). Once the WHOLE body
// has been handed to the transport, an answer that is lost, cut short,
// unreadable, or a gateway's 5xx in place of central's own answer cannot tell
// the client whether central stored the upload — and here it provably did. Such
// an outcome is reported as *UploadUnconfirmedError ("nothing was retried; it may
// have arrived; check before sending again"), never as a definite failure. A
// body that never fully left, and central's own exact refusals, stay definite.
//
// These tests use only API that existed before the fix, so they compile — and
// fail — against the unfixed source.

// assertUnknownOutcome: the error says the upload may have arrived, that
// nothing was retried, and to check before sending again.
func assertUnknownOutcome(t *testing.T, err error) {
	t.Helper()
	var unconfirmed *UploadUnconfirmedError
	if !errors.As(err, &unconfirmed) {
		t.Fatalf("err = %v; a completed body without a usable answer is an UNKNOWN outcome (*UploadUnconfirmedError)", err)
	}
	for _, want := range []string{"nothing was retried", "did arrive after all", "account page"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the message must say %q: %q", want, err)
		}
	}
}

// assertOneCommittedUpload: central saw one POST and holds exactly one object,
// debited exactly once.
func (fc *faultCentral) assertOneCommittedUpload(t *testing.T) {
	t.Helper()
	if n := fc.posts(); n != 1 {
		t.Fatalf("central saw %d upload POSTs; want exactly one (nothing may be retried)", n)
	}
	fs, err := fc.env.Store.ListStoredFilesByUser(context.Background(), fc.uid)
	if err != nil || len(fs) != 1 {
		t.Fatalf("stored objects = %d, %v; the upload provably arrived once", len(fs), err)
	}
	if q := fc.env.QuotaBytes(fc.uid); q != fs[0].Size {
		t.Fatalf("daily quota %d; want exactly one debit of the object's %d bytes", q, fs[0].Size)
	}
}

// gatewayTo is a real httputil.ReverseProxy in front of central; modify, when
// set, rewrites central's answer to the upload POST only.
func gatewayTo(t *testing.T, origin string, modify func(*http.Response) error) *httptest.Server {
	t.Helper()
	u, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	rp := httputil.NewSingleHostReverseProxy(u)
	rp.ModifyResponse = func(r *http.Response) error {
		if modify != nil && r.Request.Method == http.MethodPost && r.Request.URL.Path == "/api/files" {
			return modify(r)
		}
		return nil
	}
	gw := httptest.NewServer(rp)
	t.Cleanup(gw.Close)
	return gw
}

func replaceBody(r *http.Response, status int, body io.Reader, length int64) {
	_ = r.Body.Close()
	r.StatusCode, r.Status = status, strconv.Itoa(status)+" "+http.StatusText(status)
	r.Body = io.NopCloser(body)
	r.Header.Del("Content-Length")
	r.ContentLength = length
	if length >= 0 {
		r.Header.Set("Content-Length", strconv.FormatInt(length, 10))
	}
}

// F1: central commits; the connection closes before any answer.
func TestUploadConnectionEndedAfterTheWholeBodyIsUnknown(t *testing.T) {
	fc := newFaultCentral(t)
	r := atUploadPOST
	r.Action = sendtest.DropResponse
	fc.env.Faults.Add(&r)
	c := fc.client(fc.env.TS.URL)
	var h hookWatch
	h.install(c)
	id, err := h.upload(c, context.Background(), writeFaultFile(t, 3<<20+5))
	if id != "" {
		t.Fatalf("id = %q", id)
	}
	assertUnknownOutcome(t, err)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("err = %v; the underlying transport error must stay reachable (errors.Is io.EOF)", err)
	}
	fc.assertOneCommittedUpload(t)
	h.assertQuiescent(t)
	t.Logf("F1 message: %s", err)
}

// F2: a real gateway answers 502/504 AFTER central committed the upload.
func TestUploadGatewayErrorAfterCentralCommittedIsUnknown(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		modify func(*http.Response) error
	}{
		// The proxy cannot use the origin's answer: its default error handler
		// answers 502 Bad Gateway.
		{"502 from the proxy's error handler", http.StatusBadGateway, func(*http.Response) error {
			return errors.New("upstream answer unusable")
		}},
		{"504 in place of the origin's 200", http.StatusGatewayTimeout, func(r *http.Response) error {
			replaceBody(r, http.StatusGatewayTimeout, strings.NewReader("gateway timeout"), int64(len("gateway timeout")))
			return nil
		}},
		// The client cannot tell who chose a status: an intermediary may answer
		// 507 after central committed exactly as it may answer 502 or 504.
		{"507 in place of the origin's 200", http.StatusInsufficientStorage, func(r *http.Response) error {
			replaceBody(r, http.StatusInsufficientStorage, strings.NewReader("insufficient storage"), int64(len("insufficient storage")))
			return nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fc := newFaultCentral(t)
			gw := gatewayTo(t, fc.env.TS.URL, tc.modify)
			c := fc.client(gw.URL)
			var h hookWatch
			h.install(c)
			id, err := h.upload(c, context.Background(), writeFaultFile(t, 3<<20))
			if id != "" {
				t.Fatalf("id = %q", id)
			}
			fc.assertOneCommittedUpload(t)
			assertUnknownOutcome(t, err)
			if !strings.Contains(err.Error(), strconv.Itoa(tc.status)) {
				t.Fatalf("the message should name the gateway's HTTP %d: %q", tc.status, err)
			}
			h.assertQuiescent(t)
		})
	}
}

// A 2xx whose confirmation is malformed, truncated or carries no usable id
// cannot be turned into a link. Central stored the upload; the client must
// say "unknown", never print a broken link or a definite failure.
func TestUploadUnusableConfirmationAfterCentralCommittedIsUnknown(t *testing.T) {
	body := func(s string) func(*http.Response) error {
		return func(r *http.Response) error {
			replaceBody(r, http.StatusOK, strings.NewReader(s), int64(len(s)))
			return nil
		}
	}
	for _, tc := range []struct {
		name   string
		modify func(*http.Response) error
	}{
		{"truncated JSON", body(`{"id":"0123456789abcdef`)},
		{"no id", body(`{"expiresAt":1}`)},
		{"empty id", body(`{"id":"","expiresAt":1}`)},
		{"id that is not an inert path segment", body(`{"id":"../../d/evil","expiresAt":1}`)},
		{"not JSON", body(`<html>sign in to this network</html>`)},
		{"connection ends inside the answer", func(r *http.Response) error {
			_ = r.Body.Close()
			r.Body = io.NopCloser(io.MultiReader(strings.NewReader(`{"id":"`), errReader{}))
			r.Header.Del("Content-Length")
			r.ContentLength = -1
			return nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fc := newFaultCentral(t)
			gw := gatewayTo(t, fc.env.TS.URL, tc.modify)
			c := fc.client(gw.URL)
			var h hookWatch
			h.install(c)
			id, err := h.upload(c, context.Background(), writeFaultFile(t, 1<<20))
			if err == nil {
				t.Fatalf("Upload succeeded with id %q from an unusable confirmation", id)
			}
			fc.assertOneCommittedUpload(t)
			assertUnknownOutcome(t, err)
			h.assertQuiescent(t)
		})
	}

	t.Run("control: the unmodified answer through the same gateway", func(t *testing.T) {
		fc := newFaultCentral(t)
		gw := gatewayTo(t, fc.env.TS.URL, nil)
		c := fc.client(gw.URL)
		id, _, _, err := c.Upload(context.Background(), []string{writeFaultFile(t, 1<<20)}, UploadOpts{})
		if err != nil {
			t.Fatalf("upload through the gateway: %v", err)
		}
		fc.assertOneCommittedUpload(t)
		fs, _ := fc.env.Store.ListStoredFilesByUser(context.Background(), fc.uid)
		if id != fs[0].ID {
			t.Fatalf("id = %q, central stored %q", id, fs[0].ID)
		}
	})
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("connection reset mid-answer") }

// A gateway that refuses BEFORE the body was sent — it never reads it — is a
// definite failure: no one received the whole upload. It must not be widened
// into "unknown".
func TestUploadGatewayRefusalBeforeTheBodyLeftStaysDefinite(t *testing.T) {
	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		http.Error(w, "bad gateway", http.StatusBadGateway) // body never read
	}))
	t.Cleanup(srv.Close)
	c := newClientWith(srv.URL, http.DefaultTransport.(*http.Transport), clientTimeouts{
		responseHeader: 10 * time.Second, confirmBase: time.Second, confirmMinRate: 1 << 30,
	})
	c.Token = "t"
	var h hookWatch
	h.install(c)
	_, err := h.upload(c, context.Background(), writeFaultFile(t, 48<<20))
	if err == nil {
		t.Fatal("success")
	}
	var unconfirmed *UploadUnconfirmedError
	if errors.As(err, &unconfirmed) {
		t.Fatalf("err = %v; the body never fully left, so the failure is definite", err)
	}
	if !strings.Contains(err.Error(), "502") {
		t.Fatalf("err = %v; want the status named", err)
	}
	if h.confirming.Load() != 0 {
		t.Fatal("Confirming was called for a body that never fully left")
	}
	if posts.Load() != 1 {
		t.Fatalf("%d POSTs", posts.Load())
	}
	h.assertQuiescent(t)
}

// Central's own refusals after reading the whole body keep their exact,
// actionable messages: they are definite (central dropped the blob).
func TestUploadExactRefusalsAfterTheWholeBodyStayDefinite(t *testing.T) {
	for status, want := range map[int]string{
		http.StatusUnauthorized:          "session expired, run `relayium login` again",
		http.StatusRequestEntityTooLarge: "file exceeds server max size",
		http.StatusTooManyRequests:       "daily quota exceeded",
	} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				http.Error(w, "refused", status)
			}))
			t.Cleanup(srv.Close)
			c := newClientWith(srv.URL, http.DefaultTransport.(*http.Transport), clientTimeouts{
				responseHeader: 10 * time.Second, confirmBase: time.Second, confirmMinRate: 1 << 30,
			})
			c.Token = "t"
			var h hookWatch
			h.install(c)
			_, err := h.upload(c, context.Background(), writeFaultFile(t, 2<<20))
			if err == nil || err.Error() != want {
				t.Fatalf("err = %v; want exactly %q", err, want)
			}
			h.assertQuiescent(t)
		})
	}
}
