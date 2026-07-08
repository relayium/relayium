package trust

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKnownHostsFirstWriteMatchDiffer(t *testing.T) {
	dir := t.TempDir()
	const host = "example.com:9031"
	const fp = "abc123"

	// First state: absent.
	if _, found, err := LookupHost(dir, host); err != nil || found {
		t.Fatalf("absent lookup: found=%v err=%v", found, err)
	}

	// TOFU first-write.
	if err := AddHost(dir, host, fp); err != nil {
		t.Fatal(err)
	}

	// Match.
	got, found, err := LookupHost(dir, host)
	if err != nil || !found {
		t.Fatalf("post-write lookup: found=%v err=%v", found, err)
	}
	if got != fp {
		t.Fatalf("stored fp = %q, want %q", got, fp)
	}

	// Differ is the caller's job (compare got != presented); confirm a second
	// distinct host is isolated.
	if _, found, _ := LookupHost(dir, "other:9031"); found {
		t.Fatal("unrelated host reported as found")
	}
}

func TestKnownHostsCaseInsensitiveFingerprint(t *testing.T) {
	dir := t.TempDir()
	if err := AddHost(dir, "h:1", "ABCDEF"); err != nil {
		t.Fatal(err)
	}
	got, _, _ := LookupHost(dir, "h:1")
	if got != "abcdef" {
		t.Fatalf("fp = %q, want lowercased abcdef", got)
	}
}

func TestLoadAuthorizedParsing(t *testing.T) {
	dir := t.TempDir()
	content := `# a comment line
aaa111
bbb222  # trailing comment

ccc333 with extra fields
# another comment
DDD444
`
	if err := os.WriteFile(filepath.Join(dir, authorizedFile), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	set, err := LoadAuthorized(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"aaa111", "bbb222", "ccc333", "ddd444"}
	if len(set) != len(want) {
		t.Fatalf("set = %v, want %d entries", set, len(want))
	}
	for _, fp := range want {
		if !set[fp] {
			t.Errorf("missing %q in %v", fp, set)
		}
	}
}

func TestAddAuthorizedAppendsAndDedups(t *testing.T) {
	dir := t.TempDir()
	if err := AddAuthorized(dir, "AAA111"); err != nil {
		t.Fatal(err)
	}
	// Adding again (any case, with whitespace) is a no-op.
	if err := AddAuthorized(dir, "  aaa111  "); err != nil {
		t.Fatal(err)
	}
	if err := AddAuthorized(dir, "bbb222"); err != nil {
		t.Fatal(err)
	}
	set, err := LoadAuthorized(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 2 || !set["aaa111"] || !set["bbb222"] {
		t.Fatalf("set = %v, want {aaa111, bbb222}", set)
	}
	if err := AddAuthorized(dir, ""); err == nil {
		t.Fatal("empty fingerprint should error")
	}
}

func TestLoadAuthorizedMissingFileEmpty(t *testing.T) {
	set, err := LoadAuthorized(t.TempDir())
	if err != nil {
		t.Fatalf("missing file should be empty, not error: %v", err)
	}
	if len(set) != 0 {
		t.Fatalf("expected empty set, got %v", set)
	}
}
