package cloud

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCredsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, ok, _ := Load(dir); ok {
		t.Fatal("expected no creds initially")
	}
	c := Creds{Server: "https://relayium.com", AccessToken: "rlm_cli_x", AccountEmail: "a@example.com"}
	if err := Save(dir, c); err != nil {
		t.Fatal(err)
	}
	got, ok, err := Load(dir)
	if err != nil || !ok || got != c {
		t.Fatalf("round-trip: %v %v %+v", ok, err, got)
	}
	if err := Clear(dir); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := Load(dir); ok {
		t.Fatal("expected cleared")
	}
}

func TestSavePermissions(t *testing.T) {
	dir := t.TempDir()
	_ = Save(dir, Creds{Server: "s", AccessToken: "t"})
	fi, err := os.Stat(filepath.Join(dir, credsFile))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("want 0600, got %o", fi.Mode().Perm())
	}
}

// TestSaveTightensExistingPermissions verifies that Save enforces tight
// modes even when configDir and the credentials file already exist with
// looser permissions (e.g. backup restore, permissive umask, another tool).
// The credentials file holds an access token, so 0600/0700 must be a
// lifetime guarantee, not just a first-creation one.
func TestSaveTightensExistingPermissions(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, credsFile)

	// Pre-create the dir and file with loose permissions.
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Save(dir, Creds{Server: "s", AccessToken: "t"}); err != nil {
		t.Fatal(err)
	}

	dfi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dfi.Mode().Perm() != 0o700 {
		t.Fatalf("dir: want 0700, got %o", dfi.Mode().Perm())
	}
	ffi, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if ffi.Mode().Perm() != 0o600 {
		t.Fatalf("file: want 0600, got %o", ffi.Mode().Perm())
	}
}
