package secure

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestIdentityCreationFailureLeavesNoOrphanKey pins CLI-5: createIdentity used
// to write id.key first and id.crt second, non-atomically. If the certificate
// write failed (or the process died between the two), id.key existed without a
// certificate, and every later LoadOrCreateIdentity failed to load it instead
// of regenerating — the host was stuck until someone deleted the key by hand.
func TestIdentityCreationFailureLeavesNoOrphanKey(t *testing.T) {
	dir := t.TempDir()
	crt := filepath.Join(dir, "id.crt")
	// A non-empty directory where the certificate belongs: no file write or
	// rename can land there.
	if err := os.MkdirAll(filepath.Join(crt, "blocker"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateIdentity(dir); err == nil {
		t.Fatal("want an error while id.crt cannot be written")
	}
	if _, err := os.Stat(filepath.Join(dir, "id.key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("id.key exists after a failed creation (stat err=%v): the identity is now unloadable", err)
	}
	// The obstacle goes away: the next run must simply create a working pair.
	if err := os.RemoveAll(crt); err != nil {
		t.Fatal(err)
	}
	id, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatalf("recovery after a failed creation: %v", err)
	}
	again, err := LoadOrCreateIdentity(dir)
	if err != nil || again.Fingerprint != id.Fingerprint {
		t.Fatalf("reload after recovery: err=%v fp %s vs %s", err, again.Fingerprint, id.Fingerprint)
	}
	assertNoTempLeft(t, dir)
}

// A failed fsync must abort before anything is published under the real name.
func TestIdentityCreationFsyncFailurePublishesNothing(t *testing.T) {
	dir := t.TempDir()
	orig := fsyncFile
	fsyncFile = func(*os.File) error { return errors.New("injected fsync failure") }
	defer func() { fsyncFile = orig }()
	if _, err := LoadOrCreateIdentity(dir); err == nil {
		t.Fatal("want the injected fsync error")
	}
	for _, name := range []string{"id.key", "id.crt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s published although its fsync failed (stat err=%v)", name, err)
		}
	}
	assertNoTempLeft(t, dir)
}

func TestCreatedCertIs0644(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits")
	}
	dir := t.TempDir()
	if _, err := LoadOrCreateIdentity(dir); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "id.crt"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Fatalf("id.crt perm = %04o, want 0644", perm)
	}
}

func assertNoTempLeft(t *testing.T, dir string) {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if len(e.Name()) > 0 && e.Name()[0] == '.' {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}
