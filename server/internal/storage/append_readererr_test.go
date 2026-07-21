package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Append must surface the SOURCE reader's error verbatim (so the resumable
// handler can map cappedReader's errTooLarge to 413) instead of letting the HTTP
// transport mask it as a generic error and return a bogus size that clobbers the
// session offset. (Uses erroringReader from remote_test.go: yields `after` bytes
// then fails with err.)
func TestRemoteAppendSurfacesSourceReaderError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, `{"size":0}`)
	}))
	defer srv.Close()

	rbs := NewRemoteBlobStore(srv.URL, "s", "", srv.Client())
	sentinel := errors.New("too large")
	_, err := rbs.Append(context.Background(), "k", 0, &erroringReader{after: 4, err: sentinel})
	if !errors.Is(err, sentinel) {
		t.Fatalf("Append must return the source reader's error verbatim, got %v", err)
	}
}
