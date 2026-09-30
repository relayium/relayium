package cloud

import (
	"errors"
	"os"
	"testing"
)

// TestSaveFsyncFailureKeepsPreviousCredential pins CLI-5: Save renamed the new
// credential into place without flushing it first, so a crash soon after could
// leave an empty or torn credentials file. The flush must happen before the
// rename, and a failed flush must leave the previous login untouched.
func TestSaveFsyncFailureKeepsPreviousCredential(t *testing.T) {
	dir := t.TempDir()
	old := Creds{Server: "https://relayium.com", AccessToken: "old", AccountEmail: "a@example.com"}
	if err := Save(dir, old); err != nil {
		t.Fatal(err)
	}
	var synced int
	orig := fsyncFile
	fsyncFile = func(f *os.File) error { synced++; return errors.New("injected fsync failure") }
	defer func() { fsyncFile = orig }()

	if err := Save(dir, Creds{Server: "https://relayium.com", AccessToken: "new"}); err == nil {
		t.Fatal("Save succeeded although its fsync failed")
	}
	if synced == 0 {
		t.Fatal("Save never flushed the new credential before publishing it")
	}
	got, ok, err := Load(dir)
	if err != nil || !ok || got != old {
		t.Fatalf("previous credential not preserved: %+v ok=%v err=%v", got, ok, err)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Fatalf("temp file left behind: %v", ents)
	}
}
