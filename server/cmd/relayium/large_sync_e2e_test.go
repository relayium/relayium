package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/secure"
)

func TestLargeDirectorySyncOverDaemon(t *testing.T) {
	sender, receiver, dest := t.TempDir(), t.TempDir(), t.TempDir()
	src := filepath.Join(t.TempDir(), "service")
	id, err := secure.LoadOrCreateIdentity(sender)
	if err != nil {
		t.Fatal(err)
	}

	const files = 1001
	names := make([]string, files)
	for i := range names {
		names[i] = filepath.Join(fmt.Sprintf("folder-%02d", i/100), fmt.Sprintf("%04d.txt", i))
		p := filepath.Join(src, names[i])
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(names[i]), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	p := filepath.Join(dest, "service", names[len(names)-1])
	// A directory in the way of the last file causes a real install failure.
	// Mirror deletion must leave other files alone until that is fixed.
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dest, "service", "stale.txt")
	if err := os.WriteFile(stale, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}

	run := func(wantExit int, wantText string) {
		t.Helper()
		port, done := daemonServe(t, receiver, dest, map[string]bool{id.Fingerprint: true}, nil, true)
		var out, stderr bytes.Buffer
		code := Run([]string{"sync", "--checksum", "--delete", "--strict-delete", "--config-dir", sender, src, daemonTarget(port)}, &out, &stderr)
		if code != wantExit || !strings.Contains(stderr.String(), wantText) {
			t.Fatalf("sync returned %d, expected %d and %q:\n%s", code, wantExit, wantText, stderr.String())
		}
		if serveCode := waitCode(t, done); serveCode != wantExit {
			t.Fatalf("receiver returned %d, expected %d", serveCode, wantExit)
		}
	}
	run(1, filepath.ToSlash(names[len(names)-1]))
	if _, err := os.Stat(stale); err != nil {
		t.Fatalf("stale file was removed after an install failure: %v", err)
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}

	run(0, "1 sent, 1000 unchanged")
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale file should have been removed: %v", err)
	}
	for _, name := range names {
		body, err := os.ReadFile(filepath.Join(dest, "service", name))
		if err != nil || string(body) != name {
			t.Fatalf("file %s = %q, %v", name, body, err)
		}
	}
	run(0, "0 sent, 1001 unchanged")
}
