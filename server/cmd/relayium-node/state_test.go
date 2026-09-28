package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// A state.json from before storageSecret existed must come back with a fresh,
// persisted secret, and the other fields must survive untouched.
func TestLoadStateBackfillsLegacyStorageSecret(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"nodeID":"n-legacy","turnSecret":"` + strings.Repeat("ab", 32) + `"}`
	if err := os.WriteFile(statePath(dir), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := loadState(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(st.StorageSecret) != 64 {
		t.Fatalf("want a 64-hex back-filled storage secret, got %q", st.StorageSecret)
	}
	if st.NodeID != "n-legacy" || st.TURNSecret != strings.Repeat("ab", 32) {
		t.Fatalf("back-fill clobbered the identity: %+v", st)
	}
	b, err := os.ReadFile(statePath(dir))
	if err != nil {
		t.Fatal(err)
	}
	var onDisk nodeState
	if err := json.Unmarshal(b, &onDisk); err != nil {
		t.Fatal(err)
	}
	if onDisk != st {
		t.Fatalf("back-filled secret not persisted: disk=%+v mem=%+v", onDisk, st)
	}
	if fi, _ := os.Stat(statePath(dir)); fi.Mode().Perm() != 0o600 {
		t.Fatalf("state.json mode = %v, want 0600", fi.Mode().Perm())
	}
	st2, err := loadState(dir)
	if err != nil || st2.StorageSecret != st.StorageSecret {
		t.Fatalf("secret not stable across loads: %q vs %q (%v)", st2.StorageSecret, st.StorageSecret, err)
	}
}
