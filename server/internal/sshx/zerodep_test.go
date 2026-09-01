package sshx

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/xfer"
)

func TestWriteTarStream(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("AA"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := xfer.BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if err := WriteTarStream(&buf, m, srcs); err != nil {
		t.Fatalf("WriteTarStream: %v", err)
	}

	tr := tar.NewReader(&buf)
	hdr, err := tr.Next()
	if err != nil {
		t.Fatalf("tar.Next: %v", err)
	}
	if hdr.Name != m.Files[0].Path {
		t.Fatalf("member name = %q, want %q", hdr.Name, m.Files[0].Path)
	}
	body, _ := io.ReadAll(tr)
	if string(body) != "AA" {
		t.Fatalf("member body = %q", body)
	}
}

func TestShellQuote(t *testing.T) {
	if got := ShellQuote(`a b'c`); got != `'a b'\''c'` {
		t.Fatalf("ShellQuote = %s", got)
	}
}

// The remote command is the whole safety mechanism for the zero-dependency
// path: -k is what keeps an existing receiver file, and the quoting is what
// keeps a destination path from becoming shell syntax. Pin the exact string —
// nothing else in the process can catch a dropped flag or a lost quote.
func TestRemoteUntarCmdKeepsExistingFilesAndQuotesTheDestination(t *testing.T) {
	if got, want := RemoteUntarCmd("/srv/in box"), `mkdir -p '/srv/in box' && tar -x -k -C '/srv/in box'`; got != want {
		t.Errorf("RemoteUntarCmd = %s, want %s", got, want)
	}
	// A path carrying a quote, a semicolon and a substitution must stay one
	// operand of mkdir and one of tar.
	got := RemoteUntarCmd(`/srv/it's; rm -rf $(pwd)`)
	want := `mkdir -p '/srv/it'\''s; rm -rf $(pwd)' && tar -x -k -C '/srv/it'\''s; rm -rf $(pwd)'`
	if got != want {
		t.Errorf("RemoteUntarCmd = %s, want %s", got, want)
	}
	if !strings.Contains(got, " tar -x -k -C ") {
		t.Errorf("extraction lost its keep-existing flag: %s", got)
	}
}

// Run the command we actually send, against the tar this machine has, through
// /bin/sh — the same evaluation the remote shell performs. It proves the two
// halves of the promise together: a file already on the receiver survives, and
// members that do not collide are still written.
//
// It also documents the honest limit. Extraction is in stream order, so the
// members before the collision are already on disk when it happens; a partially
// applied batch is the expected outcome, not a bug. Whether tar then exits
// non-zero is left unasserted on purpose: GNU tar reports the collision, bsdtar
// keeps the file and exits 0, and push must be truthful under both.
func TestRemoteUntarKeepsExistingFilesOnCollision(t *testing.T) {
	if _, err := exec.LookPath("tar"); err != nil {
		t.Skip("no tar on PATH")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh on PATH")
	}

	// Two members, in manifest order: the first is new on the receiver, the
	// second collides. So the collision is reached only after a new file landed.
	root := filepath.Join(t.TempDir(), "batch")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a-new.txt"), []byte("from the sender"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "b-existing.txt"), []byte("from the sender"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := xfer.BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 2 || !strings.HasSuffix(m.Files[0].Path, "a-new.txt") {
		t.Fatalf("manifest order is not new-then-colliding: %+v", m.Files)
	}

	dest := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dest, "batch"), 0o755); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(dest, "batch", "b-existing.txt")
	if err := os.WriteFile(existing, []byte("ALREADY ON THE RECEIVER"), 0o644); err != nil {
		t.Fatal(err)
	}

	var stream bytes.Buffer
	if err := WriteTarStream(&stream, m, srcs); err != nil {
		t.Fatalf("WriteTarStream: %v", err)
	}
	cmd := exec.Command("sh", "-c", RemoteUntarCmd(dest))
	cmd.Stdin = &stream
	var errOut bytes.Buffer
	cmd.Stderr = &errOut
	runErr := cmd.Run() // may be non-zero: GNU tar reports the collision

	if got, err := os.ReadFile(existing); err != nil || string(got) != "ALREADY ON THE RECEIVER" {
		t.Fatalf("an existing receiver file was overwritten: %q (err %v, tar %v: %s)", got, err, runErr, errOut.String())
	}
	added := filepath.Join(dest, "batch", "a-new.txt")
	if got, err := os.ReadFile(added); err != nil || string(got) != "from the sender" {
		t.Fatalf("the non-colliding member was not added: %q (err %v, tar %v: %s)", got, err, runErr, errOut.String())
	}
}

// The destination directory is created when it does not exist yet, so a first
// push into a fresh path works without the operator preparing it.
func TestRemoteUntarCreatesMissingDestination(t *testing.T) {
	if _, err := exec.LookPath("tar"); err != nil {
		t.Skip("no tar on PATH")
	}
	root := filepath.Join(t.TempDir(), "batch")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("AA"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := xfer.BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	var stream bytes.Buffer
	if err := WriteTarStream(&stream, m, srcs); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "not yet", "there")
	cmd := exec.Command("sh", "-c", RemoteUntarCmd(dest))
	cmd.Stdin = &stream
	var errOut bytes.Buffer
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		t.Fatalf("extract into a missing destination: %v: %s", err, errOut.String())
	}
	if got, err := os.ReadFile(filepath.Join(dest, "batch", "a.txt")); err != nil || string(got) != "AA" {
		t.Fatalf("file = %q, err = %v", got, err)
	}
}
