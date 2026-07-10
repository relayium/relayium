package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateGeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := loadState(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(st.TURNSecret) != 64 {
		t.Fatalf("expected 64-hex secret, got %q", st.TURNSecret)
	}
	if st.NodeID != "" {
		t.Fatalf("fresh state should have empty NodeID")
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json")); err != nil {
		t.Fatalf("state.json not written: %v", err)
	}
	// A second load returns the SAME secret (persistence).
	st2, err := loadState(dir)
	if err != nil {
		t.Fatalf("load2: %v", err)
	}
	if st2.TURNSecret != st.TURNSecret {
		t.Fatalf("secret not stable across loads")
	}
	// saveState round-trips an assigned NodeID.
	st2.NodeID = "assigned-id"
	if err := saveState(dir, st2); err != nil {
		t.Fatalf("save: %v", err)
	}
	st3, _ := loadState(dir)
	if st3.NodeID != "assigned-id" {
		t.Fatalf("NodeID not persisted, got %q", st3.NodeID)
	}
}
