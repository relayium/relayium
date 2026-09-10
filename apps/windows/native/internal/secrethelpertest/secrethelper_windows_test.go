//go:build windows

// End-to-end tests against the REAL secret helper executable.
//
// The serve package proves dispatch against a fake protector and the protect
// package proves DPAPI in-process. Neither proves the SHIPPED binary behaves
// over real pipes, which is what the host depends on.
//
// ## The forced-kill test needs a real parent, and an earlier version had none
//
// The first version of the acceptance test killed the HELPER after it had
// already written its response and was exiting on its own. The helper runs one
// operation and exits; there was no parent to kill, and `Kill` raced a natural
// exit — it could report the process already done and still pass. It also read
// only until the header arrived, so a partial payload looked complete, and its
// deadline was checked between reads and so could not bound a blocking one.
//
// The scenario that matters is a PARENT killed outright while holding sealed
// material. So a test-only wrapper parent is used: this same test binary,
// re-entered in wrapper mode. It spawns the real helper, seals, joins the
// helper, hands the blob back, and then proves it is ALIVE by answering a ping
// before it is killed. The shipped helper gains no flag, no environment
// variable and no mode for any of this.
package secrethelpertest

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/secretframe"
	"github.com/relayium/relayium/apps/windows/native/internal/secretserve"
)

const (
	provenPrefix   = "PROVEN-INVARIANT:"
	unprovenPrefix = "UNPROVEN-INVARIANT:"

	// wrapperEnv puts this test binary into wrapper-parent mode. It carries the
	// helper's path and nothing secret, and it is read by the TEST binary — the
	// shipped helper reads no environment variable at all.
	wrapperEnv = "RELAYIUM_SECRET_TEST_WRAPPER_HELPER"

	// How long any real subprocess may take before the test gives up on it.
	processBudget = 60 * time.Second
)

// TestMain re-enters this binary as the wrapper parent when asked.
func TestMain(m *testing.M) {
	if helper := os.Getenv(wrapperEnv); helper != "" {
		os.Exit(wrapperMain(helper))
	}
	os.Exit(m.Run())
}

// wrapperMain is the test-only parent.
//
//	stdin   <hex plaintext>\n  then  PING\n
//	stdout  BLOB <hex>\n       then  PONG\n
//
// After PONG it blocks on stdin, which is what lets the test kill a process it
// has just proven to be alive.
func wrapperMain(helper string) int {
	in := bufio.NewReader(os.Stdin)
	line, err := in.ReadString('\n')
	if err != nil {
		return 90
	}
	plaintext, err := hex.DecodeString(strings.TrimSpace(line))
	if err != nil {
		return 91
	}
	request, err := secretframe.EncodeRequest(secretframe.OpSeal, plaintext)
	if err != nil {
		return 92
	}

	// Bounded like every other real subprocess in this file. Without this the
	// nested helper was the one child with no deadline of its own, which made
	// "every real subprocess is bounded and joined" not quite true.
	ctx, cancel := context.WithTimeout(context.Background(), processBudget)
	defer cancel()
	cmd := exec.CommandContext(ctx, helper)
	cmd.Stdin = bytes.NewReader(request)
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	// Run JOINS the helper: its own exit is complete before anything below, so
	// the kill this wrapper later receives cannot be confused with it.
	if err := cmd.Run(); err != nil {
		return 93
	}
	status, blob, err := secretframe.DecodeResponse(out.Bytes())
	if err != nil || status != secretframe.StatusOK {
		return 94
	}
	if _, err := fmt.Fprintf(os.Stdout, "BLOB %s\n", hex.EncodeToString(blob)); err != nil {
		return 95
	}

	// Liveness barrier: answering this proves the wrapper is running at that
	// instant, which a timer could never establish.
	ping, err := in.ReadString('\n')
	if err != nil || strings.TrimSpace(ping) != "PING" {
		return 96
	}
	if _, err := io.WriteString(os.Stdout, "PONG\n"); err != nil {
		return 97
	}
	// Block until killed. Reading a pipe the test holds open never returns.
	_, _ = in.ReadString('\n')
	return 98
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// internal/secrethelpertest -> module root
	return filepath.Dir(filepath.Dir(wd))
}

// buildHelper compiles the shipped secret helper, bounded and joined.
func buildHelper(t *testing.T) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), processBudget)
	defer cancel()
	out := filepath.Join(t.TempDir(), "relayium-secret-helper.exe")
	cmd := exec.CommandContext(ctx, "go", "build", "-o", out,
		"github.com/relayium/relayium/apps/windows/native/cmd/relayium-secret-helper")
	cmd.Dir = moduleRoot(t)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the secret helper failed: %v\n%s", err, output)
	}
	return out
}

type result struct {
	exit    int
	status  byte
	payload []byte
	stderr  string
}

// call runs ONE operation in ONE process, exactly as the host will.
//
// Bounded by a context and joined on every path through t.Cleanup, so a test
// that fails cannot leave a child behind.
func call(t *testing.T, helper string, request []byte) result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), processBudget)
	defer cancel()
	cmd := exec.CommandContext(ctx, helper)
	var stdout, stderr bytes.Buffer
	cmd.Stdin = bytes.NewReader(request)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exit := 0
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("running the helper: %v (stderr: %s)", err, stderr.String())
		}
		exit = exitErr.ExitCode()
	}
	res := result{exit: exit, stderr: stderr.String()}
	if stdout.Len() > 0 {
		status, payload, decodeErr := secretframe.DecodeResponse(stdout.Bytes())
		if decodeErr != nil {
			t.Fatalf("the helper's response did not decode: %v", decodeErr)
		}
		res.status = status
		res.payload = payload
	}
	return res
}

func sealRequest(t *testing.T, plaintext []byte) []byte {
	t.Helper()
	frame, err := secretframe.EncodeRequest(secretframe.OpSeal, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func openRequest(t *testing.T, blob []byte) []byte {
	t.Helper()
	frame, err := secretframe.EncodeRequest(secretframe.OpOpen, blob)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func TestRealExecutableSealsAndOpens(t *testing.T) {
	helper := buildHelper(t)
	plaintext := []byte("a device bearer token, or something equally worth protecting")

	sealed := call(t, helper, sealRequest(t, plaintext))
	if sealed.exit != secretserve.ExitOK || sealed.status != secretframe.StatusOK {
		t.Fatalf("seal: exit %d status %d (stderr: %s)", sealed.exit, sealed.status, sealed.stderr)
	}
	if bytes.Contains(sealed.payload, plaintext) {
		t.Fatal("the blob the helper returned contains its own plaintext")
	}

	opened := call(t, helper, openRequest(t, sealed.payload))
	if opened.exit != secretserve.ExitOK || opened.status != secretframe.StatusOK {
		t.Fatalf("open: exit %d status %d (stderr: %s)", opened.exit, opened.status, opened.stderr)
	}
	if !bytes.Equal(opened.payload, plaintext) {
		t.Fatal("the real executable did not return the secret it sealed")
	}
	t.Logf("%s the shipped executable seals and opens a secret over real pipes", provenPrefix)
}

// THE ACCEPTANCE CASE, with a real parent and a real liveness barrier.
//
// A wrapper parent seals through the real helper, joins it, hands the blob
// back, and PROVES IT IS ALIVE by answering a ping. Only then is it killed
// outright — so the kill cannot be racing a natural exit, which is exactly what
// invalidated the earlier version of this test. A fresh helper must then open
// the blob.
//
// This is the analogue of the case Electron's safeStorage fails: a parent
// killed while holding sealed material. It has no master key of its own to
// lose, so the blob must remain openable.
func TestSecretSurvivesAForcedKillOfTheSealingParent(t *testing.T) {
	helper := buildHelper(t)
	plaintext := []byte("survives-a-forced-kill-4f21")

	ctx, cancel := context.WithTimeout(context.Background(), processBudget)
	defer cancel()

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	wrapper := exec.CommandContext(ctx, self)
	wrapper.Env = append(os.Environ(), wrapperEnv+"="+helper)
	stdin, err := wrapper.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := wrapper.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := wrapper.Start(); err != nil {
		t.Fatalf("starting the wrapper parent: %v", err)
	}
	// Joined on every path, including a t.Fatal below.
	joined := false
	t.Cleanup(func() {
		if !joined && wrapper.Process != nil {
			_ = wrapper.Process.Kill()
			_ = wrapper.Wait()
		}
	})

	if _, err := fmt.Fprintf(stdin, "%s\n", hex.EncodeToString(plaintext)); err != nil {
		t.Fatalf("handing the plaintext to the wrapper: %v", err)
	}

	lines := bufio.NewReader(stdout)
	blobLine, err := lines.ReadString('\n')
	if err != nil {
		t.Fatalf("reading the wrapper's blob line: %v", err)
	}
	if !strings.HasPrefix(blobLine, "BLOB ") {
		t.Fatalf("unexpected wrapper output: %q", blobLine)
	}
	blob, err := hex.DecodeString(strings.TrimSpace(strings.TrimPrefix(blobLine, "BLOB ")))
	if err != nil {
		t.Fatalf("the wrapper's blob did not decode: %v", err)
	}
	if len(blob) == 0 {
		t.Fatal("the wrapper produced an empty blob")
	}

	// ALIVE BEFORE KILL, established by a round trip rather than by a timer.
	if _, err := io.WriteString(stdin, "PING\n"); err != nil {
		t.Fatalf("pinging the wrapper: %v", err)
	}
	pong, err := lines.ReadString('\n')
	if err != nil || strings.TrimSpace(pong) != "PONG" {
		t.Fatalf("the wrapper did not answer the liveness ping: %q (%v)", pong, err)
	}

	// Now kill a process that was provably running a moment ago.
	if err := wrapper.Process.Kill(); err != nil {
		t.Fatalf("killing the wrapper: %v", err)
	}
	waitErr := wrapper.Wait()
	joined = true
	var exitErr *exec.ExitError
	if !errors.As(waitErr, &exitErr) {
		// A clean exit here would mean the wrapper finished on its own and the
		// kill proved nothing — the defect this test was rewritten to remove.
		t.Fatalf("the wrapper exited cleanly (%v); the kill did not terminate a running parent", waitErr)
	}
	if exitErr.ExitCode() == 98 {
		t.Fatal("the wrapper returned its own end-of-input code; it was not killed while blocked")
	}

	// A completely fresh helper opens what the killed parent produced.
	opened := call(t, helper, openRequest(t, blob))
	if opened.exit != secretserve.ExitOK || opened.status != secretframe.StatusOK {
		t.Fatalf("a secret held by a killed parent did not open: exit %d status %d (stderr: %s)",
			opened.exit, opened.status, opened.stderr)
	}
	if !bytes.Equal(opened.payload, plaintext) {
		t.Fatal("the reopened secret is not the one that was sealed")
	}
	t.Logf("%s a secret sealed under a parent that was PROVEN ALIVE and then killed outright "+
		"reopens in a fresh process, with no Electron Local State on any path", provenPrefix)
}

func TestRealExecutableRefusesATamperedBlob(t *testing.T) {
	helper := buildHelper(t)
	sealed := call(t, helper, sealRequest(t, []byte("tamper-me")))
	if sealed.status != secretframe.StatusOK {
		t.Fatalf("seal failed: status %d", sealed.status)
	}
	corrupted := append([]byte{}, sealed.payload...)
	corrupted[len(corrupted)/2] ^= 0x01

	res := call(t, helper, openRequest(t, corrupted))
	if res.exit != secretserve.ExitRefused || res.status != secretframe.StatusRefused {
		t.Fatalf("a tampered blob gave exit %d status %d, want %d/refused",
			res.exit, res.status, secretserve.ExitRefused)
	}
	if len(res.payload) != 0 {
		t.Fatalf("a refusal carried %d payload bytes", len(res.payload))
	}
	t.Logf("%s the shipped executable refuses a tampered blob with exit 3 and no output", provenPrefix)
}

func TestRealExecutableRefusesArguments(t *testing.T) {
	// Nothing identifying may travel in argv, so an argument means the launcher
	// is not the one this protocol describes.
	ctx, cancel := context.WithTimeout(context.Background(), processBudget)
	defer cancel()
	cmd := exec.CommandContext(ctx, buildHelper(t), "--seal", "secret")
	if err := cmd.Run(); err == nil {
		t.Fatal("the helper accepted command-line arguments")
	}
}

func TestRealExecutableRefusesMalformedInput(t *testing.T) {
	helper := buildHelper(t)
	good := sealRequest(t, []byte("x"))
	cases := map[string][]byte{
		"empty":       {},
		"wrong magic": append([]byte("ZZZZ"), good[4:]...),
		"unknown op":  func() []byte { c := append([]byte{}, good...); c[5] = 9; return c }(),
		"two frames":  append(append([]byte{}, good...), good...),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			res := call(t, helper, raw)
			if res.exit != secretserve.ExitProtocol || res.status != secretframe.StatusProtocol {
				t.Fatalf("exit %d status %d, want %d/protocol", res.exit, res.status, secretserve.ExitProtocol)
			}
		})
	}
}

func TestStderrCarriesNoSecretMaterial(t *testing.T) {
	helper := buildHelper(t)
	secret := "SECRET-MARKER-9f3a"
	res := call(t, helper, openRequest(t, []byte(secret+strings.Repeat("x", 64))))
	if strings.Contains(res.stderr, secret) {
		t.Fatalf("stderr echoed request material: %q", res.stderr)
	}
	for _, line := range strings.Split(strings.TrimSpace(res.stderr), "\n") {
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "secret-helper: ") {
			t.Fatalf("unexpected diagnostic shape: %q", line)
		}
	}
}

func TestOversizeRequestIsRefusedByTheRealExecutable(t *testing.T) {
	helper := buildHelper(t)
	// A header declaring far more than the bound, with no payload behind it.
	frame := make([]byte, secretframe.HeaderBytes)
	copy(frame[0:4], []byte("RLSQ"))
	frame[4] = secretframe.Version
	frame[5] = secretframe.OpSeal
	frame[6], frame[7], frame[8], frame[9] = 0xFF, 0xFF, 0xFF, 0xFF
	res := call(t, helper, frame)
	if res.exit != secretserve.ExitProtocol {
		t.Fatalf("exit %d, want %d", res.exit, secretserve.ExitProtocol)
	}
	if !strings.Contains(res.stderr, "oversize") {
		t.Fatalf("stderr %q", res.stderr)
	}
}

func TestCrossUserRemainsUnproven(t *testing.T) {
	t.Logf("%s a blob sealed by another user cannot be opened here. This suite will not "+
		"create a second account, and inferring the property from the flags passed would "+
		"describe the request rather than test the outcome.", unprovenPrefix)
}
