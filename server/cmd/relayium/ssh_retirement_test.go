package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Exercise the installed-binary boundary, including former remote helpers.
// Missing input paths must never be read, and sync --watch must return promptly.
func TestSSHTransfersDisabled(t *testing.T) {
	bin := buildCLIExe(t)
	cfg := t.TempDir()
	// A private ssh executable records any attempted launch. Even a regression
	// cannot reach the developer's SSH configuration or the network.
	trap := t.TempDir()
	sshName := "ssh"
	if runtime.GOOS == "windows" {
		sshName += ".exe"
	}
	self, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(trap, sshName), self, 0o700); err != nil {
		t.Fatal(err)
	}
	attempts := filepath.Join(trap, "ssh-attempts")
	source := filepath.Join(trap, "source.txt")
	if err := os.WriteFile(source, []byte("local fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "HOME="+cfg, "XDG_CONFIG_HOME="+cfg,
		"PATH="+trap, standinLogEnv+"="+attempts, standinRelayiumEnv+"=")
	cases := [][]string{
		{"push", source, "user@host:dir"},
		{"sync", source, "host:dir"},
		{"push", "-", "host:file"},
		{"push", "-i", "missing-key", "missing-source", "host:dir"},
		{"push", "-p", "2222", "missing-source", "relayium://127.0.0.1:1"},
		{"push", "--", "missing-source", "host:dir"},
		{"sync", "missing-source", "host:dir", "--watch", "--delete"},
		{"sync", "-i", "missing-key", "missing-source", "relayium://127.0.0.1:1"},
		{"pull", "host:file", "-"},
		{"pull", "host:dir", filepath.Join(cfg, "not-created")},
		{"__recv", "--", filepath.Join(cfg, "not-created")},
		{"__recv", "--stream-file", "--", filepath.Join(cfg, "not-created")},
		{"__send", "missing-source"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			out, errout, code := runBounded(t, 5*time.Second, bin, args, "", env)
			if code != 2 || out != "" || !strings.Contains(errout, "SSH transfers are currently disabled") {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, out, errout)
			}
		})
	}
	if _, err := os.Stat(attempts); !os.IsNotExist(err) {
		t.Fatalf("retired command launched SSH: %v", err)
	}
	entries, err := os.ReadDir(cfg)
	if err != nil || len(entries) != 0 {
		t.Fatalf("retired commands wrote state: %v %v", entries, err)
	}
}

func TestSSHRetirementDoesNotConsumeStdin(t *testing.T) {
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer pr.Close()
	defer pw.Close()
	old := os.Stdin
	os.Stdin = pr
	defer func() { os.Stdin = old }()
	if _, err := pw.Write([]byte("untouched")); err != nil {
		t.Fatal(err)
	}
	var out, errout bytes.Buffer
	if code := Run([]string{"push", "-", "host:file"}, &out, &errout); code != 2 {
		t.Fatalf("exit=%d", code)
	}
	if err := pr.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 9)
	if _, err := io.ReadFull(pr, data); err != nil || string(data) != "untouched" {
		t.Fatalf("stdin consumed: %q %v", data, err)
	}
}
