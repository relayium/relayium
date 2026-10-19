package cloud

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestInstallationConcurrentCreatorsAndOriginIsolation(t *testing.T) {
	dir := t.TempDir()
	const n = 20
	ids := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { ids[i], errs[i] = InstallationID(dir, "https://relayium.test/") })
	}
	wg.Wait()
	for i := range n {
		if errs[i] != nil || ids[i] != ids[0] || len(ids[i]) != 43 {
			t.Fatalf("creator %d disagreed or failed: %v", i, errs[i])
		}
	}
	same, err := InstallationID(dir, "https://RELAYIUM.test")
	if err != nil || same != ids[0] {
		t.Fatal("canonical server changed identity", err)
	}
	other, err := InstallationID(dir, "https://other.test")
	if err != nil || other == same {
		t.Fatal("identity shared across servers", err)
	}
	if err := Save(dir, Creds{Server: "https://relayium.test", AccessToken: "synthetic-token"}); err != nil {
		t.Fatal(err)
	}
	if err := Clear(dir); err != nil {
		t.Fatal(err)
	}
	after, err := InstallationID(dir, "https://relayium.test")
	if err != nil || after != same {
		t.Fatal("logout changed installation", err)
	}
}

func TestInstallationRefusesCorruptionAndUnsafePaths(t *testing.T) {
	for _, mode := range []string{"malformed", "oversized", "symlink", "permissions"} {
		t.Run(mode, func(t *testing.T) {
			if runtime.GOOS == "windows" && (mode == "permissions" || mode == "symlink") {
				t.Skip("Unix ownership/symlink fixture")
			}
			dir := t.TempDir()
			if _, err := InstallationID(dir, "https://relayium.test"); err != nil {
				t.Fatal(err)
			}
			files, err := os.ReadDir(filepath.Join(dir, "cli-installations"))
			if err != nil || len(files) != 1 {
				t.Fatal("identity publication not singular", err)
			}
			path := filepath.Join(dir, "cli-installations", files[0].Name())
			switch mode {
			case "malformed":
				err = os.WriteFile(path, []byte("not-canonical"), 0o600)
			case "oversized":
				err = os.WriteFile(path, []byte(strings.Repeat("a", 4096)), 0o600)
			case "permissions":
				err = os.Chmod(path, 0o644)
			case "symlink":
				target := filepath.Join(dir, "target")
				if err = os.Rename(path, target); err == nil {
					err = os.Symlink(target, path)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = InstallationID(dir, "https://relayium.test"); !errors.Is(err, ErrInstallationUnsafe) {
				t.Fatalf("unsafe identity accepted: %v", err)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("unsafe identity rewritten", err)
			}
		})
	}
}

func TestInstallationFlushFailurePublishesNothing(t *testing.T) {
	dir := t.TempDir()
	old := fsyncFile
	failure := errors.New("controlled identity flush failure")
	fsyncFile = func(*os.File) error { return failure }
	defer func() { fsyncFile = old }()
	if _, err := InstallationID(dir, "https://relayium.test"); !errors.Is(err, failure) {
		t.Fatalf("flush failure lost: %v", err)
	}
	files, err := os.ReadDir(filepath.Join(dir, "cli-installations"))
	if err != nil || len(files) != 0 {
		t.Fatal("failed flush left identity or temp", err)
	}
}

func TestInstallationProcessHelper(t *testing.T) {
	dir := os.Getenv("RELAYIUM_INSTALL_TEST_DIR")
	if dir == "" {
		return
	}
	if os.Getenv("RELAYIUM_INSTALL_TEST_MODE") == "lock" {
		lock, err := LockLogin(dir)
		if errors.Is(err, ErrUpOperationBusy) {
			os.Exit(0)
		}
		if lock != nil {
			lock.Release()
		}
		os.Exit(3)
	}
	id, err := InstallationID(dir, "https://relayium.test")
	if err != nil {
		os.Exit(2)
	}
	fmt.Print(id)
	os.Exit(0)
}

func TestInstallationCrossProcessAgreementAndLoginLock(t *testing.T) {
	dir := t.TempDir()
	var commands []*exec.Cmd
	for range 6 {
		cmd := exec.Command(os.Args[0], "-test.run=^TestInstallationProcessHelper$")
		cmd.Env = append(os.Environ(), "RELAYIUM_INSTALL_TEST_DIR="+dir)
		commands = append(commands, cmd)
	}
	ids := make([]string, len(commands))
	errs := make([]error, len(commands))
	var wg sync.WaitGroup
	for i, cmd := range commands {
		wg.Go(func() { var b []byte; b, errs[i] = cmd.Output(); ids[i] = string(b) })
	}
	wg.Wait()
	for i := range commands {
		if errs[i] != nil || len(ids[i]) != 43 || ids[i] != ids[0] {
			t.Fatalf("cross-process identity disagreement: process%d: %v", i, errs[i])
		}
	}
	lock, err := LockLogin(dir)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestInstallationProcessHelper$")
	cmd.Env = append(os.Environ(), "RELAYIUM_INSTALL_TEST_DIR="+dir, "RELAYIUM_INSTALL_TEST_MODE=lock")
	err = cmd.Run()
	lock.Release()
	if err != nil {
		t.Fatal("another process acquired login lock", err)
	}
	again, err := LockLogin(dir)
	if err != nil {
		t.Fatal("released login lock not reusable", err)
	}
	again.Release()
}
