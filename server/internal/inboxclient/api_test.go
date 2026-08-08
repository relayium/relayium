package inboxclient

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/inbox"
)

// Authorization tests.
//
// The two credentials are not interchangeable and neither is optional: the
// device BEARER says "this machine", and the CLAIM TOKEN says "this machine's
// current worker". The protocol requires both on every ciphertext read and every
// progress report (§15), and these assert the client actually sends them — a
// client that quietly dropped either would still pass every happy-path test
// against a permissive server, and would fail against the real one only in
// production.

// TestClientSendsTheDeviceBearerOnEveryCall walks the whole device-side surface
// and requires an Authorization header on each. Mutation check: deleting the
// header line in Client.do or Client.Blob turns every subcase red.
func TestClientSendsTheDeviceBearerOnEveryCall(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret-token" {
			seen = append(seen, "MISSING BEARER on "+r.URL.Path)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		seen = append(seen, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"devices":[],"keys":[],"tasks":[],"task":{},"key":{},"inbox":{}}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "secret-token")
	c.DeviceID = "dev-1"
	c.HTTP = srv.Client()
	ctx := context.Background()

	_, _ = c.CurrentDevice(ctx)
	_, _ = c.Enrol(ctx, EnrolRequest{})
	_, _ = c.RegisterKey(ctx, inbox.KeyAlgX25519SealedBoxV1, "pub", "")
	_, _ = c.ListKeys(ctx)
	_, _ = c.Heartbeat(ctx, true)
	_ = c.Offline(ctx)
	_, _ = c.Pending(ctx, 4)
	_, _, _ = c.Claim(ctx, 4)
	_, _ = c.Report(ctx, "t1", "claim", inbox.TaskVerifying, "", false)
	_, _ = c.Accept(ctx, "t1", true)
	_ = c.ClearInbox(ctx)
	if resp, err := c.Blob(ctx, "t1", "claim", 0); err == nil {
		resp.Body.Close()
	}

	for _, s := range seen {
		if strings.HasPrefix(s, "MISSING BEARER") {
			t.Fatalf("%s", s)
		}
	}
	if len(seen) != 12 {
		t.Fatalf("observed %d authorized calls, want 12: %v", len(seen), seen)
	}
}

// TestBlobSendsTheClaimToken is the second credential. Central rejects a
// ciphertext read without it (`stale_claim`), and it must travel in a HEADER,
// not the URL: a query parameter would end up in proxy logs and browser history.
func TestBlobSendsTheClaimToken(t *testing.T) {
	var gotHeader, gotQuery, gotRange string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get(ClaimTokenHeader)
		gotQuery = r.URL.RawQuery
		gotRange = r.Header.Get("Range")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, "tail")
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "tok")
	c.DeviceID = "dev-1"
	c.HTTP = srv.Client()
	resp, err := c.Blob(context.Background(), "task-1", "the-claim-token", 4096)
	if err != nil {
		t.Fatalf("blob: %v", err)
	}
	defer resp.Body.Close()
	if gotHeader != "the-claim-token" {
		t.Fatalf("claim token header = %q, want it sent on every ciphertext read", gotHeader)
	}
	if strings.Contains(gotQuery, "the-claim-token") {
		t.Fatalf("the claim token appeared in the URL query %q; it must stay in a header", gotQuery)
	}
	if gotRange != "bytes=4096-" {
		t.Fatalf("Range header = %q, want bytes=4096-", gotRange)
	}
	if !resp.Partial {
		t.Fatal("a 206 response was not reported as partial; a resumed stream would be spliced")
	}
}

// TestBlobReportsAnIgnoredRange: a resume answered with a full 200 is NOT a
// tail. Treating it as one would splice the start of the object into the middle
// of the stream and produce authenticated-looking garbage.
func TestBlobReportsAnIgnoredRange(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "whole object")
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "tok")
	c.DeviceID = "dev-1"
	c.HTTP = srv.Client()
	resp, err := c.Blob(context.Background(), "task-1", "tok", 10)
	if err != nil {
		t.Fatalf("blob: %v", err)
	}
	defer resp.Body.Close()
	if resp.Partial {
		t.Fatal("a 200 answer to a Range request was reported as partial")
	}
}

// TestAPIErrorsCarryTheMachineReadableCode: the worker's decisions (stop, retry,
// abandon, re-key) are all made from these tokens, so they have to survive the
// transport layer intact.
func TestAPIErrorsCarryTheMachineReadableCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"stale_claim"}`)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "tok")
	c.DeviceID = "dev-1"
	c.HTTP = srv.Client()

	_, err := c.Report(context.Background(), "t", "claim", inbox.TaskVerifying, "", false)
	if ErrorCode(err) != "stale_claim" {
		t.Fatalf("ErrorCode = %q, want stale_claim (from %v)", ErrorCode(err), err)
	}
	if ErrorStatus(err) != http.StatusConflict {
		t.Fatalf("ErrorStatus = %d, want 409", ErrorStatus(err))
	}
}

// TestAPIErrorTextCarriesNoServerBody: a rejection body is remote input on a
// path that ends at an operator's terminal or journal. Only the status and the
// closed token may propagate.
func TestAPIErrorTextCarriesNoServerBody(t *testing.T) {
	secret := strings.Repeat("LEAKED-SERVER-TEXT ", 500)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, secret)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "tok")
	c.DeviceID = "dev-1"
	c.HTTP = srv.Client()
	_, err := c.Heartbeat(context.Background(), true)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "LEAKED-SERVER-TEXT") {
		t.Fatalf("the error carries the server's response body: %v", err)
	}
	if len(redact(err)) > 320 {
		t.Fatalf("redact did not bound the message: %d chars", len(redact(err)))
	}
}

// TestCurrentDeviceRefusesWhenNoRowIsOurs: without a Current row this credential
// is not device-bound, and every device-self call would 404. Failing here with a
// specific error is what turns an endless retry loop into an actionable message.
func TestCurrentDeviceRefusesWhenNoRowIsOurs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"devices":[{"ID":"other","Current":false}]}`)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "tok")
	c.HTTP = srv.Client()
	if _, err := c.CurrentDevice(context.Background()); err != ErrNoCurrentDevice {
		t.Fatalf("err = %v, want ErrNoCurrentDevice", err)
	}
}
