package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// Private finite body/transport fixture; admission deadline support is not under test.
type p0DeadlineRecorder struct {
	*httptest.ResponseRecorder
	interrupt func()
}

func (r *p0DeadlineRecorder) SetReadDeadline(d time.Time) error {
	if !d.IsZero() && !d.After(time.Now()) {
		r.interrupt()
	}
	return nil
}

type p0LegalRoundTripper func(*http.Request) (*http.Response, error)

func (f p0LegalRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type p0LateBody struct {
	calls   atomic.Int64
	started chan struct{}
	release chan struct{}
}

func (b *p0LateBody) Read(p []byte) (int, error) {
	n := b.calls.Add(1)
	if n == 1 {
		close(b.started)
		<-b.release
		return copy(p, []byte("AAAA")), nil
	}
	if n == 2 {
		return copy(p, []byte("BBBB")), io.EOF
	}
	return 0, io.EOF
}
func TestRemoteAppendDoesNotReuseOwnedRequestBody(t *testing.T) {
	h := newDurHarness(t)
	dir := t.TempDir()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	body := &p0LateBody{started: make(chan struct{}), release: make(chan struct{})}
	oldDone := make(chan struct{})
	var releaseOnce sync.Once
	releaseBody := func() { releaseOnce.Do(func() { close(body.release) }) }
	defer releaseBody()
	var calls atomic.Int64
	transport := p0LegalRoundTripper(func(req *http.Request) (*http.Response, error) {
		call := calls.Add(1)
		key := filepath.Base(req.URL.Path)
		off, _ := strconv.ParseInt(req.Header.Get("X-Blob-Offset"), 10, 64)
		floor, _ := strconv.ParseInt(req.Header.Get(storage.SettledThroughHeader), 10, 64)
		var size int64
		var aerr error
		if call == 1 {
			size, aerr = ds.Append(storage.WithSettledThrough(context.Background(), floor), key, off, strings.NewReader(""))
			go func() { defer close(oldDone); buf := make([]byte, 4); _, _ = req.Body.Read(buf) }()
			<-body.started
		} else {
			size, aerr = ds.Append(storage.WithSettledThrough(context.Background(), floor), key, off, req.Body)
		}
		hdr := make(http.Header)
		hdr.Set(storage.AppendDurabilityHeader, storage.AppendDurabilityV1)
		status := 200
		var out any = map[string]int64{"size": size}
		var nd *storage.NotDurableError
		if errors.As(aerr, &nd) {
			status = 500
			out = storage.NotDurableBody{NotDurable: true, Durable: nd.Durable, Physical: nd.Physical, Written: nd.Written}
		} else if aerr != nil {
			return nil, aerr
		}
		enc, _ := json.Marshal(out)
		return &http.Response{StatusCode: status, Header: hdr, Body: io.NopCloser(bytes.NewReader(enc)), Request: req}, nil
	})
	h.svc.SetBlobStore(storage.NewRemoteBlobStore("http://p0-private-node.invalid", "s", "", &http.Client{Transport: transport}))
	id := initUpload(t, h.ts, h.cookie, []byte("opaque"), 512, 0)
	key := h.row(t, id).BlobKey
	shard := filepath.Join(dir, key[:2])
	if err = os.MkdirAll(shard, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(shard, key)
	if err = os.WriteFile(path, []byte("old-tail"), 0600); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("PATCH", h.ts.URL+"/api/uploads/"+id, body)
	req.ContentLength = 8
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Range", "bytes 0-7/512")
	req.AddCookie(h.cookie)
	rec := &p0DeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), interrupt: releaseBody}
	h.ts.Config.Handler.ServeHTTP(rec, req)
	releaseBody()
	if calls.Load() > 0 {
		select {
		case <-oldDone:
		case <-time.After(time.Second):
			t.Fatal("HARNESS old reader did not exit")
		}
	} else {
		t.Fatal("HARNESS request never reached remote append")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	row := h.row(t, id)
	t.Logf("REMOTE_BODY_OWNERSHIP nodePATCHes%d HTTP%d durable%d metered%d physical%q response%s", calls.Load(), rec.Code, row.Received, row.Metered, got, rec.Body.String())
	if calls.Load() != 1 {
		t.Fatalf("BODY_OWNERSHIP_ASSERTION: one client PATCH made %d node PATCHes; the body must never be retried in-request", calls.Load())
	}
	if rec.Code != 500 || row.Received != 0 || row.Metered != 8 || string(got) != "old-tail" {
		t.Fatalf("unsafe refusal: HTTP%d row%+v blob%q", rec.Code, row, got)
	}
	code, _ := patchChunk(t, h.ts, h.cookie, id, []byte("old-tail"), 0, 8, 512)
	if code != 200 {
		t.Fatalf("fresh retained-body replay HTTP%d", code)
	}
	got, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	row = h.row(t, id)
	if row.Received != 8 || row.Metered != 8 || string(got) != "old-tail" {
		t.Fatalf("fresh replay mismatch row%+v blob%q", row, got)
	}
}
