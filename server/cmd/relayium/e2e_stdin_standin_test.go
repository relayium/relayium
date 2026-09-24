package main

// SSH retirement: this file retains shared/legacy fixture helpers only; former
// SSH transfer E2E cases are recoverable from d0c414087. They are not current
// acceptance evidence. See ssh_retirement_test.go and docs/CLI-SSH-RETIREMENT.md.


// `push -` through an SSH STAND-IN, on every platform (the only form the
// hosted Windows job can run; it runs on macOS/Linux too).
//
// What is real here: the built relayium CLI (or, for the cases that must
// inject a cancel or observe the pump's PID, the real runPush in this
// process), the real sshx.Session pipes, Abort and reap, the real
// `__pump-stdin` helper process, and the real `relayium __recv --stream-file`
// receiver writing to the real filesystem.
//
// What is NOT real: ssh. `ssh` on PATH is a copy of this test binary
// (TestMain's "ssh" role, standinSSH) that answers `command -v relayium`
// and runs the POSIX-quoted remote command locally over its own stdio. No
// network, no authentication, no host keys, no sshd, no OpenSSH channel
// semantics are exercised. The real-OpenSSH tests are in e2e_stdin_test.go.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/stdinpump"
	"github.com/relayium/relayium/internal/xfer"
)

const (
	standinRelayiumEnv = "RELAYIUM_STANDIN_RELAYIUM" // the "remote" relayium; empty = not installed
	standinLogEnv      = "RELAYIUM_STANDIN_LOG"      // one line per remote command
	standinModeEnv     = "RELAYIUM_STANDIN_MODE"     // "" = run it; "hold" = accept, then never read
	standinReleaseEnv  = "RELAYIUM_STANDIN_RELEASE"  // hold ends when this file exists
)

// standinSSH is the ssh stand-in: `ssh [-i F] [-p N] -- host 'remote command'`.
func standinSSH(args []string) int {
	i := 0
	for i < len(args) && args[i] != "--" {
		if args[i] == "-i" || args[i] == "-p" {
			i++
		}
		i++
	}
	if i+2 >= len(args) {
		fmt.Fprintf(os.Stderr, "ssh stand-in: unexpected argv %q\n", args)
		return 255
	}
	remoteCmd := args[i+2]
	if p := os.Getenv(standinLogEnv); p != "" {
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err == nil {
			fmt.Fprintln(f, remoteCmd)
			f.Close()
		}
	}
	remote := os.Getenv(standinRelayiumEnv)
	if remoteCmd == "command -v relayium" {
		if remote == "" {
			return 1
		}
		fmt.Println(remote)
		return 0
	}
	words, err := posixWords(remoteCmd)
	if err != nil || len(words) == 0 || words[0] != "relayium" || remote == "" {
		fmt.Fprintf(os.Stderr, "sh: %s: not found (%v)\n", remoteCmd, err)
		return 127
	}
	if os.Getenv(standinModeEnv) == "hold" {
		// A remote that accepts and then never reads or answers, ignoring
		// every signal it can: only the sender's Abort (a kill) ends it.
		signal.Ignore(os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGPIPE)
		_ = xfer.WriteJSON(os.Stdout, xfer.MsgStreamAccept, xfer.StreamAccept{ChunkMax: xfer.StreamChunkMax})
		release := os.Getenv(standinReleaseEnv)
		for n := 0; n < 1200; n++ {
			if _, err := os.Stat(release); err == nil {
				return 0
			}
			time.Sleep(100 * time.Millisecond)
		}
		return 0
	}
	c := exec.Command(remote, words[1:]...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		return 127
	}
	return 0
}

// posixWords splits a /bin/sh command line of plain words, single-quoted
// strings and backslash escapes — the forms sshx.ShellQuote produces.
func posixWords(s string) ([]string, error) {
	var words []string
	var cur strings.Builder
	in := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\'':
			in = true
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, errors.New("unterminated quote")
			}
			cur.WriteString(s[i+1 : i+1+j])
			i += j + 1
		case c == '\\' && i+1 < len(s):
			in = true
			cur.WriteByte(s[i+1])
			i++
		case c == ' ' || c == '\t':
			if in {
				words = append(words, cur.String())
				cur.Reset()
				in = false
			}
		default:
			in = true
			cur.WriteByte(c)
		}
	}
	if in {
		words = append(words, cur.String())
	}
	return words, nil
}

func TestStandinPosixWordsUndoShellQuote(t *testing.T) {
	for _, p := range []string{"a", "it's", "sp ace", "-dash", `back\slash`, "C:/x/y", "''", "\"q\""} {
		got, err := posixWords("relayium __recv --stream-file -- " + sshx.ShellQuote(p))
		if err != nil || len(got) != 5 || got[4] != p {
			t.Errorf("%q -> %q (%v)", p, got, err)
		}
	}
}

func exeName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// buildCLIExe builds the CLI with the platform's executable suffix.
func buildCLIExe(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "bin", exeName("relayium"))
	out, errOut, code := runBounded(t, e2eBuildTimeout, "go", []string{"build", "-o", bin, "."}, "", nil)
	if code != 0 {
		t.Fatalf("build CLI: exit %d\n%s%s", code, out, errOut)
	}
	return bin
}

// standinDir puts a copy of this test binary named ssh(.exe) in a new dir.
func standinDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "standin")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, exeName("ssh")), string(b), 0o700)
	return dir
}

func standinEnv(sshDir, remote, log string, extra ...string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k := strings.ToUpper(strings.SplitN(kv, "=", 2)[0])
		if k == "PATH" || strings.HasPrefix(k, "RELAYIUM_") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "PATH="+sshDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		standinRelayiumEnv+"="+remote, standinLogEnv+"="+log)
	return append(env, extra...)
}

// runWithStdin runs argv with stdin as the given *os.File itself (the child
// inherits the descriptor/handle; nothing is copied), bounded.
func runWithStdin(t *testing.T, timeout time.Duration, argv, env []string, stdin *os.File) (stdout, stderr string, code int) {
	t.Helper()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Stdin = stdin
	var o, e bytes.Buffer
	cmd.Stdout, cmd.Stderr = &o, &e
	cmd.WaitDelay = e2eWaitDelay
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return o.String(), e.String(), ee.ExitCode()
		}
		if err != nil {
			t.Fatalf("%q: %v", argv, err)
		}
		return o.String(), e.String(), 0
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		<-done
		t.Fatalf("%q timed out after %v\nstdout:\n%s\nstderr:\n%s", argv, timeout, o.String(), e.String())
	}
	return
}

// fileOffset is the shared file position of f (the child inherited the same
// open file description / file object): 0 means nobody read it.
func fileOffset(t *testing.T, f *os.File) int64 {
	t.Helper()
	off, err := f.Seek(0, io.SeekCurrent)
	if err != nil {
		t.Fatal(err)
	}
	return off
}

func stdinFile(t *testing.T, body []byte) *os.File {
	t.Helper()
	p := filepath.Join(t.TempDir(), "stdin.bin")
	writeFile(t, p, string(body), 0o600)
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// waitDirNames waits (bounded) until dir holds exactly names: the remote
// receiver may still be removing its staging after the sender returned.
func waitDirNames(t *testing.T, dir string, names ...string) {
	t.Helper()
	deadline := time.Now().Add(e2eCleanupTimeout)
	for {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, e := range entries {
			got = append(got, e.Name())
		}
		if strings.Join(got, "\x00") == strings.Join(names, "\x00") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s holds %q, want %q", dir, got, names)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// pumpWatch observes the helper an in-process `push -` started.
type pumpWatch struct {
	p       *stdinpump.Pump
	started chan *stdinpump.Pump
}

func (w *pumpWatch) assertReaped(t *testing.T) {
	t.Helper()
	select {
	case p := <-w.started:
		w.p = p
	default:
	}
	if w.p == nil {
		t.Fatal("the pump was never started")
	}
	if !w.p.Exited() {
		t.Fatalf("pump pid %d not reaped when push returned", w.p.Pid())
	}
}
