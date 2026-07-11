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
