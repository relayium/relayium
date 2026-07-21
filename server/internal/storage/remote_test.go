package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRemotePutGetDelete(t *testing.T) {
	var stored []byte
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		if key == "" {
			w.WriteHeader(400)
			return
		}
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			stored = b
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"size":`+itoa(len(b))+`}`)
		case http.MethodGet:
			if stored == nil {
				w.WriteHeader(404)
				return
			}
			_, _ = w.Write(stored)
		case http.MethodDelete:
			stored = nil
			w.WriteHeader(204)
		}
	}))
	defer srv.Close()

	rbs := NewRemoteBlobStore(srv.URL, "sekret", "", srv.Client())
	ctx := context.Background()

	n, err := rbs.Put(ctx, "abc123", bytes.NewReader([]byte("ciphertext!")))
	if err != nil || n != 11 {
		t.Fatalf("put: n=%d err=%v", n, err)
	}
	if gotAuth != "Bearer sekret" {
		t.Fatalf("auth=%q", gotAuth)
	}
	rc, err := rbs.Get(ctx, "abc123")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "ciphertext!" {
		t.Fatalf("got %q", got)
	}
	if err := rbs.Delete(ctx, "abc123"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := rbs.Get(ctx, "abc123"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
}

// A reader that errors mid-stream must surface that exact error from Put (so a
// wrapped cappedReader errTooLarge stays errors.Is-matchable across the proxy).
func TestRemotePutSurfacesReaderError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, `{"size":0}`)
	}))
	defer srv.Close()
	sentinel := errors.New("boom")
	rbs := NewRemoteBlobStore(srv.URL, "s", "", srv.Client())
	_, err := rbs.Put(context.Background(), "k", &erroringReader{after: 3, err: sentinel})
	if !errors.Is(err, sentinel) {
		t.Fatalf("want sentinel, got %v", err)
	}
}

type erroringReader struct {
	after int
	err   error
	n     int
}

func (e *erroringReader) Read(p []byte) (int, error) {
	if e.n >= e.after {
		return 0, e.err
	}
	e.n++
	p[0] = 'x'
	return 1, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
