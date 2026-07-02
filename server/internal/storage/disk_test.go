package storage

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A representative blob key: 64 lowercase hex chars, as minted by crypto/rand.
const testKey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

func TestDiskStorePutGetDeleteRoundtrip(t *testing.T) {
	d, err := NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx := context.Background()
	key := testKey
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
	key := "ffee112233ffee112233ffee112233ffee112233ffee112233ffee112233ffee"
	if _, err := d.Put(context.Background(), key, bytes.NewReader([]byte("x"))); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ff", key)); err != nil {
		t.Fatalf("expected sharded file <dir>/ff/%s: %v", key, err)
	}
}

func TestDiskStoreMissingKeyIsErrNotFound(t *testing.T) {
	d, _ := NewDiskStore(t.TempDir())
	if _, err := d.Get(context.Background(), testKey); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	// Delete of a missing (but valid) key is a no-op (idempotent GC).
	if err := d.Delete(context.Background(), testKey); err != nil {
		t.Fatalf("delete missing should be nil, got %v", err)
	}
}

// Blob keys outside the safe character set are rejected before touching the
// filesystem, so filepath.Join can never be steered out of the store dir.
func TestDiskStoreRejectsUnsafeKeys(t *testing.T) {
	d, _ := NewDiskStore(t.TempDir())
	ctx := context.Background()
	bad := []string{
		"",                            // empty
		"../etc/passwd",               // traversal
		"../../../../etc/passwd",      // deeper traversal
		"a/b",                         // embedded slash
		testKey + "/../../etc/passwd", // slash + traversal
		testKey[:63] + ".",            // dot
		"key with space",              // whitespace
	}
	for _, key := range bad {
		if _, err := d.Put(ctx, key, bytes.NewReader([]byte("x"))); err != ErrInvalidKey {
			t.Errorf("Put(%q): want ErrInvalidKey, got %v", key, err)
		}
		if _, err := d.Get(ctx, key); err != ErrInvalidKey {
			t.Errorf("Get(%q): want ErrInvalidKey, got %v", key, err)
		}
		if err := d.Delete(ctx, key); err != ErrInvalidKey {
			t.Errorf("Delete(%q): want ErrInvalidKey, got %v", key, err)
		}
	}
}

// CleanupTemp reaps stale orphan temp files left by a crash mid-Put, but leaves
// committed blobs and freshly written temp files alone.
func TestDiskStoreCleanupTemp(t *testing.T) {
	dir := t.TempDir()
	d, _ := NewDiskStore(dir)
	ctx := context.Background()

	// A committed blob that must survive cleanup.
	if _, err := d.Put(ctx, testKey, bytes.NewReader([]byte("keep"))); err != nil {
		t.Fatalf("put: %v", err)
	}

	shardDir := filepath.Join(dir, testKey[:2])
	// An old orphan temp file (simulated crash) — should be removed.
	oldTmp := filepath.Join(shardDir, ".tmp-orphan-old")
	if err := os.WriteFile(oldTmp, []byte("half"), 0o644); err != nil {
		t.Fatalf("write old tmp: %v", err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(oldTmp, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	// A recent temp file (an in-flight Put) — must be preserved.
	newTmp := filepath.Join(shardDir, ".tmp-orphan-new")
	if err := os.WriteFile(newTmp, []byte("wip"), 0o644); err != nil {
		t.Fatalf("write new tmp: %v", err)
	}

	removed, err := d.CleanupTemp(time.Hour)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := os.Stat(oldTmp); !os.IsNotExist(err) {
		t.Fatalf("old temp should be deleted, stat err = %v", err)
	}
	if _, err := os.Stat(newTmp); err != nil {
		t.Fatalf("recent temp must be kept: %v", err)
	}
	if _, err := os.Stat(filepath.Join(shardDir, testKey)); err != nil {
		t.Fatalf("committed blob must be kept: %v", err)
	}
}
