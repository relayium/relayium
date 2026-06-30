package storage

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestDiskStorePutGetDeleteRoundtrip(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	key := "abcdef0123456789"
	payload := []byte("zero-knowledge ciphertext bytes")
	n, err := d.Put(ctx, key, bytes.NewReader(payload))
	if err != nil || n != int64(len(payload)) {
		t.Fatalf("put: n=%d err=%v", n, err)
	}
	rc, err := d.Get(ctx, key)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(got, payload) {
		t.Fatalf("roundtrip mismatch: %q", got)
	}
	if err := d.Delete(ctx, key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := d.Get(ctx, key); err != ErrNotFound {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
}

func TestDiskStoreShardsByPrefix(t *testing.T) {
	dir := t.TempDir()
	d, _ := NewDiskStore(dir)
	key := "ffee112233"
	if _, err := d.Put(context.Background(), key, bytes.NewReader([]byte("x"))); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ff", key)); err != nil {
		t.Fatalf("expected sharded file <dir>/ff/%s: %v", key, err)
	}
}

func TestDiskStoreMissingKeyIsErrNotFound(t *testing.T) {
	d, _ := NewDiskStore(t.TempDir())
	if _, err := d.Get(context.Background(), "nope"); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	// Delete of a missing key is a no-op (idempotent GC).
	if err := d.Delete(context.Background(), "nope"); err != nil {
		t.Fatalf("delete missing should be nil, got %v", err)
	}
}
