package cloud

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type boundaryResponseBody struct {
	io.Reader
	release func()
}

func (b boundaryResponseBody) Close() error { b.release(); return nil }

// Central commits Content-Length while the producer is still inside its final
// progress callback. The outcome must not depend on that callback returning.
func TestRecordedUploadFinalProgressCannotHideCommittedBody(t *testing.T) {
	fc := newFaultCentral(t)
	c := fc.client(fc.env.TS.URL)
	p, err := PrepareUpload([]string{writeFaultFile(t, 4096)}, UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	entered, released := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(released) }) }
	defer release()
	c.Progress = func(done, total int64) {
		if done == total && total > 0 {
			close(entered)
			<-released
		}
	}
	c.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := make([]byte, r.ContentLength)
		if _, err := io.ReadFull(r.Body, body); err != nil {
			release()
			return nil, err
		}
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			release()
			t.Error("final progress did not block")
		}
		forwarded := r.Clone(r.Context())
		forwarded.Body = io.NopCloser(bytes.NewReader(body))
		resp, err := http.DefaultTransport.RoundTrip(forwarded)
		if err != nil {
			release()
			return nil, err
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			release()
			t.Errorf("central status %d", resp.StatusCode)
		}
		// Classification precedes deferred Close, which releases the producer.
		return &http.Response{StatusCode: 502, Header: make(http.Header), Body: boundaryResponseBody{strings.NewReader("gateway"), release}, Request: r}, nil
	})}
	const op = "relayium-up.0123456789abcdef0123456789abcdef"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _, err = c.UploadPrepared(ctx, p, op)
	if fc.posts() != 1 || fc.stored(t) != 1 || fc.env.QuotaBytes(fc.uid) != 64<<10 {
		t.Fatal("expected one committed upload and one 64KiB minimum debit")
	}
	assertUnknownOutcome(t, err)
	result, err := fc.client(fc.env.TS.URL).RecoverUpload(ctx, op, UploadOpts{}, p.BodyLength)
	if err != nil || result.State != RecoveredCommitted || result.ID == "" {
		t.Fatalf("recover: %+v %v", result, err)
	}
	if fc.stored(t) != 1 {
		t.Fatal("recovery created an extra object")
	}
	fs, _ := fc.env.Store.ListStoredFilesByUser(context.Background(), fc.uid)
	if fc.env.QuotaBytes(fc.uid) != max(fs[0].Size, 64<<10) {
		t.Fatal("recovery debited a second body")
	}
}
