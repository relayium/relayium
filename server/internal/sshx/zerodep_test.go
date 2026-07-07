package sshx

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
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
