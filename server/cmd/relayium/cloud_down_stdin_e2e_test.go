//go:build !windows

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

// A link on standard input downloads exactly like the argument form, against
// a real account.Service: new files in the destination, the key never in argv
// and never repeated in output.
func TestDownStdinDownloadsLinkE2E(t *testing.T) {
	ts, svc, store := newE2EService(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "stdin@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	c := cloud.NewClient(ts.URL)
	c.Token = cliToken(t, ts, svc, u.ID)

	src := filepath.Join(t.TempDir(), "hello.txt")
	if err := os.WriteFile(src, []byte("hello over stdin"), 0o644); err != nil {
		t.Fatal(err)
	}
	id, key, _, err := c.Upload(ctx, []string{src}, cloud.UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	link := c.DownloadLink(ts.URL, id, key)

	// A destination that already holds the name is refused, never overwritten
	// (the downloader's existing collision rule, unchanged by stdin input).
	taken := t.TempDir()
	if err := os.WriteFile(filepath.Join(taken, "hello.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	withDownStdin(t, link, false)
	var out0, errOut0 bytes.Buffer
	if code := runDown([]string{"-", taken}, &out0, &errOut0); code == 0 {
		t.Fatalf("down - into an occupied name should fail, stdout=%q", out0.String())
	}
	if got, _ := os.ReadFile(filepath.Join(taken, "hello.txt")); string(got) != "mine" {
		t.Fatalf("existing file was overwritten: %q", got)
	}
	if strings.Contains(errOut0.String(), key) {
		t.Fatalf("collision error repeated the key: %q", errOut0.String())
	}

	dest := t.TempDir()
	withDownStdin(t, "  "+link+"\n", false)
	var out, errOut bytes.Buffer
	if code := runDown([]string{"-", dest}, &out, &errOut); code != 0 {
		t.Fatalf("down -: code=%d stderr=%q", code, errOut.String())
	}
	if got, err := os.ReadFile(filepath.Join(dest, "hello.txt")); err != nil || string(got) != "hello over stdin" {
		t.Fatalf("downloaded %q, %v", got, err)
	}
	if strings.Contains(errOut.String(), key) || strings.Contains(out.String(), key) {
		t.Fatalf("output repeated the key: stdout=%q stderr=%q", out.String(), errOut.String())
	}
}
