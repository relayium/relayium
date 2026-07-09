package storage

import "testing"

// TestDiskUsage is a smoke test against a real filesystem: total must be
// positive, used must never exceed total, and a valid path must not error.
func TestDiskUsage(t *testing.T) {
	used, total, err := DiskUsage(t.TempDir())
	if err != nil {
		t.Fatalf("DiskUsage: %v", err)
	}
	if total == 0 {
		t.Fatalf("total = 0, want > 0")
	}
	if used > total {
		t.Fatalf("used %d > total %d", used, total)
	}
}
