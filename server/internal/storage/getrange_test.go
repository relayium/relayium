package storage

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDiskStoreGetRange(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := d.Put(ctx, "abcdef", strings.NewReader("0123456789")); err != nil {
		t.Fatal(err)
	}

	rc, err := d.GetRange(ctx, "abcdef", 4)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "456789" {
		t.Fatalf("GetRange(4) = %q, want %q", got, "456789")
	}

	rc0, err := d.GetRange(ctx, "abcdef", 0)
	if err != nil {
		t.Fatal(err)
	}
	got0, _ := io.ReadAll(rc0)
	rc0.Close()
	if string(got0) != "0123456789" {
		t.Fatalf("GetRange(0) = %q, want whole object", got0)
	}
}

func TestRemoteGetRangeHonored(t *testing.T) {
	content := []byte("0123456789ABCDEF")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ServeContent honours the Range header → 206 with the correct slice.
		http.ServeContent(w, r, "blob", time.Time{}, bytes.NewReader(content))
	}))
	defer srv.Close()

	rbs := NewRemoteBlobStore(srv.URL, "s", "", srv.Client())
	rc, err := rbs.GetRange(context.Background(), "k", 10)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "ABCDEF" {
		t.Fatalf("GetRange(10) = %q, want %q", got, "ABCDEF")
	}
}

// A node that ignores Range and returns the whole object (200) must still yield
// a reader positioned at `start`.
func TestRemoteGetRangeServerIgnoresRange(t *testing.T) {
	content := []byte("0123456789")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content) // ignores Range → 200 full object
	}))
	defer srv.Close()

	rbs := NewRemoteBlobStore(srv.URL, "s", "", srv.Client())
	rc, err := rbs.GetRange(context.Background(), "k", 3)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "3456789" {
		t.Fatalf("GetRange(3) with Range-ignoring server = %q, want %q", got, "3456789")
	}
}
