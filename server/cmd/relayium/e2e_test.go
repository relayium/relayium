package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func sshLocalhostAvailable(t *testing.T) {
	t.Helper()
	if os.Getenv("RELAYIUM_E2E_SSH") != "1" {
		t.Skip("set RELAYIUM_E2E_SSH=1 and ensure `ssh localhost` works to run this")
	}
	if err := exec.Command("ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "localhost", "true").Run(); err != nil {
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

	// The PATH scrub only affects which local `ssh` binary is exec'd; it does NOT
	// force zero-dep mode, because RemoteHasRelayium runs `command -v relayium` on
	// the REMOTE shell, whose PATH resolution is unaffected by cmd.Env. Zero-dep
	// mode is instead guaranteed here because the freshly built binary lives only
	// in a temp dir, so the remote `command -v` won't find `relayium` on its PATH —
	// and we assert the stdout marker below to fail loudly if full mode ever runs.
	cmd := exec.Command(bin, "push", filepath.Join(src, "hello.txt"), "localhost:"+dst)
	cmd.Env = append(os.Environ(), "PATH=/usr/bin:/bin")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("push: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "zero-dependency mode") {
		t.Fatalf("expected zero-dependency mode, got output: %s", out)
	}

	got, err := os.ReadFile(filepath.Join(dst, "hello.txt"))
	if err != nil || string(got) != "over-ssh" {
		t.Fatalf("received = %q err=%v", got, err)
	}
}
