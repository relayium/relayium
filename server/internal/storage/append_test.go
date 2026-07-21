package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestDiskStoreAppend(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// offset 0 creates; subsequent offsets extend.
	if n, err := d.Append(ctx, "k", 0, strings.NewReader("abc")); err != nil || n != 3 {
		t.Fatalf("append#1: n=%d err=%v", n, err)
	}
	if n, err := d.Append(ctx, "k", 3, strings.NewReader("defg")); err != nil || n != 7 {
		t.Fatalf("append#2: n=%d err=%v", n, err)
	}
	rc, _ := d.Get(ctx, "k")
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "abcdefg" {
		t.Fatalf("assembled = %q", got)
	}

	// A stale/duplicate offset is refused with the real size, not silently
	// overwritten.
	n, err := d.Append(ctx, "k", 3, strings.NewReader("XX"))
	if !errors.Is(err, ErrOffsetMismatch) {
		t.Fatalf("stale offset: want ErrOffsetMismatch, got %v", err)
	}
	if n != 7 {
		t.Fatalf("mismatch should report the real size 7, got %d", n)
	}
	// And a gap (offset past the end) is refused too.
	if _, err := d.Append(ctx, "k", 100, strings.NewReader("Y")); !errors.Is(err, ErrOffsetMismatch) {
		t.Fatalf("gap offset: want ErrOffsetMismatch, got %v", err)
	}
}

func TestRemoteAppend(t *testing.T) {
	// A node-like server that appends by offset, returning {"size":N} or 409.
	var stored []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		off, _ := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
		if off != int64(len(stored)) {
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"size":`+itoa(len(stored))+`}`)
			return
		}
		b, _ := io.ReadAll(r.Body)
		stored = append(stored, b...)
		_, _ = io.WriteString(w, `{"size":`+itoa(len(stored))+`}`)
	}))
	defer srv.Close()

	rbs := NewRemoteBlobStore(srv.URL, "s", "", srv.Client())
	ctx := context.Background()
	if n, err := rbs.Append(ctx, "k", 0, strings.NewReader("hello")); err != nil || n != 5 {
		t.Fatalf("append#1: n=%d err=%v", n, err)
	}
	if n, err := rbs.Append(ctx, "k", 5, strings.NewReader(" world")); err != nil || n != 11 {
		t.Fatalf("append#2: n=%d err=%v", n, err)
	}
	if string(stored) != "hello world" {
		t.Fatalf("stored = %q", stored)
	}
	// Offset mismatch surfaces ErrOffsetMismatch with the node's real size.
	n, err := rbs.Append(ctx, "k", 3, strings.NewReader("x"))
	if !errors.Is(err, ErrOffsetMismatch) || n != 11 {
		t.Fatalf("mismatch: n=%d err=%v", n, err)
	}
}
