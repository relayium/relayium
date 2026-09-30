package selfupdate

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestReplaceFromArchiveFsyncFailureLeavesTargetUntouched pins CLI-5: the new
// binary was renamed over the running one without being flushed, so a crash
// before writeback could leave a truncated executable under the real name.
func TestReplaceFromArchiveFsyncFailureLeavesTargetUntouched(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tar.gz")
	if err := os.WriteFile(archive, tarGzWith(t, "NEW"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "relayium")
	if err := os.WriteFile(target, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	var synced int
	orig := fsyncFile
	fsyncFile = func(*os.File) error { synced++; return errors.New("injected fsync failure") }
	defer func() { fsyncFile = orig }()

	if err := replaceFromArchive(archive, "relayium", target, nil); err == nil {
		t.Fatal("replaceFromArchive succeeded although its fsync failed")
	}
	if synced == 0 {
		t.Fatal("the new binary was never flushed before the rename")
	}
	if b, _ := os.ReadFile(target); string(b) != "OLD" {
		t.Fatalf("target changed despite the failed flush: %q", b)
	}
	fsyncFile = orig
	if err := replaceFromArchive(archive, "relayium", target, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(target); string(b) != "NEW" {
		t.Fatalf("target = %q after a successful replace", b)
	}
}

// TestInstallerScriptsEmbedTheSameReleaseKey pins R1: the release public key is
// written out three times — here (what `relayium update` and relayium-node
// verify against) and in both installer scripts (what a first install verifies
// against). Rotating it in one place and not the others would make installs
// or updates reject every genuine release, or keep trusting a retired key.
func TestInstallerScriptsEmbedTheSameReleaseKey(t *testing.T) {
	want := normalizePEM(embeddedKeyAtStartup) // TestMain blanks the live var
	if want == "" {
		t.Fatal("release_pubkey.go embeds no key")
	}
	re := regexp.MustCompile(`(?s)RELEASE_PUBKEY='([^']*)'`)
	for _, script := range []string{"install.sh", "install-node.sh"} {
		path := filepath.Join("..", "..", "web", "public", script)
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		m := re.FindAllSubmatch(b, -1)
		if len(m) != 1 {
			t.Fatalf("%s: found %d RELEASE_PUBKEY assignments, want exactly 1", script, len(m))
		}
		if got := normalizePEM(string(m[0][1])); got != want {
			t.Errorf("%s embeds a different release key than selfupdate/release_pubkey.go:\n got: %s\nwant: %s", script, got, want)
		}
	}
}

func normalizePEM(s string) string {
	return strings.Join(strings.Fields(s), "\n")
}
