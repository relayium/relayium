package selfupdate

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
)

// TestInstallersFailClosedWithoutOpenssl pins CLI-1 / A-L8: both installer
// scripts embed the release public key, but when openssl was missing they
// printed a note and installed after a checksum-only check — so on such a host
// a tampered checksums.txt (a compromised release host) went undetected. They
// must refuse unless RELAYIUM_ALLOW_UNSIGNED=1 is set explicitly.
//
// Each script runs against a local file:// release with a PATH that has every
// tool it needs except openssl, and installs into a scratch directory.
func TestInstallersFailClosedWithoutOpenssl(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell installers")
	}
	arch := map[string]string{"amd64": "amd64", "arm64": "arm64"}[runtime.GOARCH]
	if arch == "" || (runtime.GOOS != "linux" && runtime.GOOS != "darwin") {
		t.Skipf("installers do not support %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	stub := stubPathWithoutOpenssl(t)

	for _, tc := range []struct {
		script, asset, binary string
		env                   []string
	}{
		{"install.sh", "relayium_%s_%s.tar.gz", "relayium", nil},
		{"install-node.sh", "relayium-node_%s_%s.tar.gz", "relayium-node", []string{
			"RELAYIUM_CENTRAL_URL=https://central.invalid", "RELAYIUM_NODE_TOKEN=t",
		}},
	} {
		tc := tc
		t.Run(tc.script, func(t *testing.T) {
			script, err := filepath.Abs(filepath.Join("..", "..", "web", "public", tc.script))
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			rel := filepath.Join(root, "release")
			if err := os.MkdirAll(rel, 0o755); err != nil {
				t.Fatal(err)
			}
			asset := fmt.Sprintf(tc.asset, runtime.GOOS, arch)
			archive := tarGzNamed(t, tc.binary, "#!/bin/sh\necho stub\n")
			if err := os.WriteFile(filepath.Join(rel, asset), archive, 0o644); err != nil {
				t.Fatal(err)
			}
			sums := fmt.Sprintf("%s  %s\n", sha256hex(archive), asset)
			if err := os.WriteFile(filepath.Join(rel, "checksums.txt"), []byte(sums), 0o644); err != nil {
				t.Fatal(err)
			}

			run := func(extra ...string) (int, string, string) {
				bin := filepath.Join(root, "bin")
				if err := os.MkdirAll(bin, 0o755); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(sh, script)
				cmd.Env = append([]string{
					"PATH=" + stub,
					"HOME=" + root,
					"TMPDIR=" + root,
					"RELAYIUM_BASE_URL=file://" + rel,
					"RELAYIUM_INSTALL_DIR=" + bin,
					"RELAYIUM_NODE_PREFIX=" + filepath.Join(root, "prefix"),
				}, append(tc.env, extra...)...)
				var out, errb bytes.Buffer
				cmd.Stdout, cmd.Stderr = &out, &errb
				err := cmd.Run()
				var ee *exec.ExitError
				switch {
				case err == nil:
					return 0, out.String(), errb.String()
				case errors.As(err, &ee):
					return ee.ExitCode(), out.String(), errb.String()
				default:
					t.Fatal(err)
					return -1, "", ""
				}
			}
			installed := filepath.Join(root, "bin", tc.binary)

			rc, out, stderr := run()
			if rc == 0 {
				t.Fatalf("installed without openssl and without RELAYIUM_ALLOW_UNSIGNED=1\nstdout: %s\nstderr: %s", out, stderr)
			}
			if !strings.Contains(stderr, "openssl not found") || !strings.Contains(stderr, "RELAYIUM_ALLOW_UNSIGNED=1") {
				t.Errorf("refusal does not name the cause and the override:\n%s", stderr)
			}
			if _, err := os.Stat(installed); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("%s was installed despite the refusal (stat err=%v)", installed, err)
			}

			rc, out, stderr = run("RELAYIUM_ALLOW_UNSIGNED=1")
			if rc != 0 {
				t.Fatalf("explicit RELAYIUM_ALLOW_UNSIGNED=1: rc=%d\nstdout: %s\nstderr: %s", rc, out, stderr)
			}
			if !strings.Contains(stderr, "WARNING") {
				t.Errorf("checksum-only install did not warn:\n%s", stderr)
			}
			if _, err := os.Stat(installed); err != nil {
				t.Fatalf("override did not install: %v", err)
			}
		})
	}
}

// stubPathWithoutOpenssl links every tool the installers call into one
// directory, deliberately leaving openssl out, and returns it for use as PATH.
func stubPathWithoutOpenssl(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	tools := []string{"uname", "curl", "mktemp", "rm", "grep", "awk", "tar", "gzip",
		"mkdir", "cp", "chmod", "mv", "cat", "install", "dirname", "sed", "sha256sum", "shasum"}
	for _, tool := range tools {
		p, err := exec.LookPath(tool)
		if err != nil {
			continue // optional (sha256sum vs shasum, gzip); a missing hard need fails the run loudly
		}
		if err := os.Symlink(p, filepath.Join(dir, tool)); err != nil {
			t.Fatal(err)
		}
	}
	// A non-root `id`, so install-node.sh never reaches its systemd branch even
	// when the test itself runs as root.
	if err := os.WriteFile(filepath.Join(dir, "id"), []byte("#!/bin/sh\necho 1000\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("openssl"); err == nil {
		if _, err := os.Stat(filepath.Join(dir, "openssl")); err == nil {
			t.Fatal("stub PATH unexpectedly contains openssl")
		}
	}
	return dir
}
