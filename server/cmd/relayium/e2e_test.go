package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func sshLocalhostAvailable(t *testing.T) {
	t.Helper()
	if os.Getenv("RELAYIUM_E2E_SSH") != "1" {
		t.Skip("set RELAYIUM_E2E_SSH=1 and ensure `ssh localhost` works to run this")
	}
	if err := exec.Command("ssh", "-o", "BatchMode=yes", "localhost", "true").Run(); err != nil {
		t.Skipf("ssh localhost not usable: %v", err)
	}
}

func TestE2EZeroDepPushOverSSH(t *testing.T) {
	sshLocalhostAvailable(t)

	// Build the CLI binary.
	bin := filepath.Join(t.TempDir(), "relayium")
	if out, err := exec.Command("go", "build", "-o", bin, "./cmd/relayium").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "hello.txt"), []byte("over-ssh"), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()

	// Force zero-dep mode by ensuring the built binary is NOT on the remote PATH:
	// localhost shares our PATH, so run with a scrubbed PATH that still has tar/ssh.
	cmd := exec.Command(bin, "push", filepath.Join(src, "hello.txt"), "localhost:"+dst)
	cmd.Env = append(os.Environ(), "PATH=/usr/bin:/bin")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("push: %v\n%s", err, out)
	}

	got, err := os.ReadFile(filepath.Join(dst, "hello.txt"))
	if err != nil || string(got) != "over-ssh" {
		t.Fatalf("received = %q err=%v", got, err)
	}
}
