package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

func TestDownCollisionHintOnlyForLocalCollision(t *testing.T) {
	for _, err := range []error{nil, errors.New("destination already exists: remote text"), os.ErrPermission} {
		var out bytes.Buffer
		printDownCollisionHint(&out, err, ".", false)
		if out.Len() != 0 {
			t.Fatalf("hint for unrelated error %v: %q", err, out.String())
		}
	}
	var out bytes.Buffer
	printDownCollisionHint(&out, fmt.Errorf("wrapped: %w", &cloud.DestinationExistsError{Path: "/tmp/report.txt"}), ".", true)
	for _, want := range []string{"No files were downloaded or replaced", ".bak", "different, empty directory", "--server '<server-url>' '<link-or-code>'", "download-new"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in %q", want, out.String())
		}
	}
}

func TestDownCollisionHintUnsafePath(t *testing.T) {
	var out bytes.Buffer
	printDownCollisionHint(&out, &cloud.DestinationExistsError{Path: "/tmp/forged\ncommand\x1b[2J"}, "/tmp/dest\nforged", false)
	if strings.Contains(out.String(), "forged") || strings.Contains(out.String(), "\x1b") || strings.Contains(out.String(), "  mv ") || strings.Contains(out.String(), "  relayium down") {
		t.Fatalf("offered unsafe command: %q", out.String())
	}
	if !strings.Contains(out.String(), "rename") || !strings.Contains(out.String(), "empty directory") {
		t.Fatalf("missing manual recovery advice: %q", out.String())
	}
}

// Execute the offered backup command on owned files, including shell syntax
// inside the filename. This verifies the actual copy/paste behavior.
func TestDownCollisionHintBackupCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell command; Windows guidance uses PowerShell")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "a '$(touch INJECTED); $HOME`.env")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	printDownCollisionHint(&out, &cloud.DestinationExistsError{Path: path}, dir, false)
	var command string
	for _, line := range strings.Split(out.String(), "\n") {
		if strings.HasPrefix(line, "  mv -i ") {
			command = strings.TrimSpace(line)
		}
	}
	if command == "" {
		t.Fatalf("missing backup command: %s", &out)
	}
	cmd := exec.Command("sh", "-c", command)
	cmd.Dir = dir
	if got, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("backup command failed: %v: %s", err, got)
	}
	if got, err := os.ReadFile(path + ".bak"); err != nil || string(got) != "original" {
		t.Fatalf("backup = %q, %v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "INJECTED")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("shell interpreted filename: %v", err)
	}
}
