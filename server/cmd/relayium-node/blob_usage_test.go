package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// The gauge must read the blob directory's real size. This test targets the
// node's reporting semantics: it used to report the whole volume's statfs
// usage, so the admin dashboard counted unrelated data on the system disk as
// relayium storage.
func TestBlobUsageRefreshReadsRealSize(t *testing.T) {
	ds, err := storage.NewDiskStore(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}
	u := &blobUsage{}

	if got := u.get(); got != 0 {
		t.Fatalf("get() = %d before any refresh, want 0", got)
	}

	if _, err := ds.Put(context.Background(), "deadbeef", strings.NewReader(strings.Repeat("z", 777))); err != nil {
		t.Fatalf("Put: %v", err)
	}
	// Still the stale value before refresh: this is the caching semantics by
	// design, the heartbeat reads whatever the last refresh produced.
	if got := u.get(); got != 0 {
		t.Fatalf("get() = %d before refresh, want the stale 0", got)
	}

	u.refresh(ds)
	if got := u.get(); got != 777 {
		t.Fatalf("get() = %d after refresh, want 777", got)
	}
}
