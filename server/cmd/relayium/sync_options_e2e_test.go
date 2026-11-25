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

func TestSyncCheckLargeReceiverLeavesDestinationUntouched(t *testing.T) {
	sender, receiver, dest, src := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	id, err := secure.LoadOrCreateIdentity(sender)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1001; i++ {
		p := filepath.Join(src, fmt.Sprintf("%04d.txt", i))
		if err := os.WriteFile(p, []byte("source"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	target := filepath.Join(dest, filepath.Base(src))
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(target, "existing.txt")
	if err := os.WriteFile(stale, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	port, done := daemonServe(t, receiver, dest, map[string]bool{id.Fingerprint: true}, nil, true)
	var output bytes.Buffer
	args := []string{"sync", "--check", "--delete", "--strict-delete", "--config-dir", sender, src, daemonTarget(port)}
	if code := Run(args, &output, &output); code != 0 {
		t.Fatalf("sync check exited %d:\n%s", code, &output)
	}
	if err := waitCode(t, done); err != 0 {
		t.Fatalf("serve --once returned %d", err)
	}
	if !strings.Contains(output.String(), "1001 source files checked; no file data sent") ||
		strings.Contains(output.String(), "Checking SHA-256") {
		t.Fatalf("incorrect sync check output:\n%s", &output)
	}
	files, err := os.ReadDir(target)
	if err != nil || len(files) != 1 || files[0].Name() != "existing.txt" {
		t.Fatalf("destination changed: %v, %v", files, err)
	}
	if content, err := os.ReadFile(stale); err != nil || string(content) != "keep" {
		t.Fatalf("existing file changed: %q, %v", content, err)
	}
}

func TestSyncExcludeUsesOnlyExplicitPatterns(t *testing.T) {
	sender, receiver, dest, src := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	id, err := secure.LoadOrCreateIdentity(sender)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".venv/keep.txt", "node_modules/skip.txt", "data/skip.log", "data/keep.bin"} {
		p := filepath.Join(src, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	port, done := daemonServe(t, receiver, dest, map[string]bool{id.Fingerprint: true}, nil, false)
	var output bytes.Buffer
	args := []string{"sync", "--config-dir", sender, "--exclude", "node_modules", "--exclude", "*.log", src, daemonTarget(port)}
	if code := Run(args, &output, &output); code != 0 {
		t.Fatalf("filtered sync exited %d:\n%s", code, &output)
	}
	if code := waitCode(t, done); code != 0 {
		t.Fatalf("serve returned %d", code)
	}
	log := output.String()
	for _, want := range []string{
		"Excluded by your rules: 1 files, 1 directory trees",
		"Checking SHA-256", "Sending", "Waiting for receiver confirmation", "2 sent, 0 unchanged",
	} {
		if !strings.Contains(log, want) {
			t.Fatalf("missing %q:\n%s", want, log)
		}
	}
	received := filepath.Join(dest, filepath.Base(src))
	for _, name := range []string{".venv/keep.txt", "data/keep.bin"} {
		if b, err := os.ReadFile(filepath.Join(received, filepath.FromSlash(name))); err != nil || string(b) != name {
			t.Fatalf("accepted file %s = %q, %v", name, b, err)
		}
	}
	for _, name := range []string{"node_modules", "data/skip.log"} {
		if _, err := os.Stat(filepath.Join(received, filepath.FromSlash(name))); !os.IsNotExist(err) {
			t.Fatalf("excluded path %s was touched: %v", name, err)
		}
	}

	output.Reset()
	if code := Run(append([]string{"sync", "--delete"}, args[1:]...), &output, &output); code != 2 {
		t.Fatalf("unsafe flags accepted or dial attempted: code %d:\n%s", code, &output)
	}
	if !strings.Contains(output.String(), "receiver") && !strings.Contains(output.String(), "receiving side") {
		t.Fatalf("exclusion/deletion conflict not explained:\n%s", &output)
	}
}
