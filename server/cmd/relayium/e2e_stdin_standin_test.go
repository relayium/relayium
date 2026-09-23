package main

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

// TestE2EPushStdinStandIn: the built CLI, a real pump, the real receiver, a
// stand-in ssh. See the file comment for what is not covered.
func TestE2EPushStdinStandIn(t *testing.T) {
	bin := buildCLIExe(t)
	sshDir := standinDir(t)
	body := e2eRandom(t, 5<<20+7)

	cli := func(t *testing.T, remote string, dest string, stdin *os.File) (string, string, int, []string) {
		log := filepath.Join(t.TempDir(), "remote.log")
		writeFile(t, log, "", 0o600)
		stdout, stderr, code := runWithStdin(t, e2ePushTimeout, []string{bin, "push", "-", "localhost:" + dest}, standinEnv(sshDir, remote, log), stdin)
		return stdout, stderr, code, readLines(t, log)
	}

	t.Run("happy", func(t *testing.T) {
		dir := t.TempDir()
		dest := filepath.ToSlash(filepath.Join(dir, "out.bin"))
		stdout, stderr, code, log := cli(t, bin, dest, stdinFile(t, body))
		if code != 0 || stdout != "" {
			t.Fatalf("exit %d stdout %d bytes\nstderr:\n%s", code, len(stdout), stderr)
		}
		got, err := os.ReadFile(filepath.Join(dir, "out.bin"))
		if err != nil || !bytes.Equal(got, body) {
			t.Fatalf("installed %d bytes (err %v), want %d", len(got), err, len(body))
		}
		waitDirNames(t, dir, "out.bin")
		want := []string{"command -v relayium", "relayium __recv --stream-file -- " + sshx.ShellQuote(dest)}
		if !equalLines(log, want) {
			t.Fatalf("remote commands %q, want %q", log, want)
		}
	})

	t.Run("empty", func(t *testing.T) {
		dir := t.TempDir()
		stdout, stderr, code, _ := cli(t, bin, filepath.ToSlash(filepath.Join(dir, "e")), stdinFile(t, nil))
		if code != 0 || stdout != "" {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		if fi, err := os.Stat(filepath.Join(dir, "e")); err != nil || fi.Size() != 0 {
			t.Fatalf("empty file: %v %v", fi, err)
		}
		waitDirNames(t, dir, "e")
	})

	t.Run("destination-exists-stdin-unread", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "f"), "ORIGINAL", 0o600)
		in := stdinFile(t, body)
		stdout, stderr, code, _ := cli(t, bin, filepath.ToSlash(filepath.Join(dir, "f")), in)
		if code != 1 || stdout != "" || !strings.Contains(stderr, "already exists") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		if off := fileOffset(t, in); off != 0 {
			t.Fatalf("stdin offset %d after a refusal, want 0 (unread)", off)
		}
		waitDirNames(t, dir, "f")
		if b, _ := os.ReadFile(filepath.Join(dir, "f")); string(b) != "ORIGINAL" {
			t.Fatalf("original changed: %q", b)
		}
	})

	t.Run("missing-directory-stdin-unread", func(t *testing.T) {
		dir := t.TempDir()
		in := stdinFile(t, body)
		stdout, stderr, code, _ := cli(t, bin, filepath.ToSlash(filepath.Join(dir, "nope", "f")), in)
		if code != 1 || stdout != "" || !strings.Contains(stderr, "does not exist") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		if off := fileOffset(t, in); off != 0 {
			t.Fatalf("stdin offset %d, want 0", off)
		}
		waitDirNames(t, dir)
	})

	t.Run("old-remote-stdin-unread", func(t *testing.T) {
		// The "remote relayium" is a process that exits 2 before reading,
		// exactly what every released `__recv` does with --stream-file.
		dir := t.TempDir()
		in := stdinFile(t, body)
		log := filepath.Join(t.TempDir(), "remote.log")
		writeFile(t, log, "", 0o600)
		env := standinEnv(sshDir, os.Args[0], log, "RELAYIUM_TEST_ROLE=exit", "RELAYIUM_TEST_EXIT=2")
		stdout, stderr, code := runWithStdin(t, e2ePushTimeout, []string{bin, "push", "-", "localhost:" + filepath.ToSlash(filepath.Join(dir, "f"))}, env, in)
		if code != 1 || stdout != "" || !strings.Contains(stderr, "predates") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		if off := fileOffset(t, in); off != 0 {
			t.Fatalf("stdin offset %d, want 0", off)
		}
		waitDirNames(t, dir)
	})

	t.Run("no-relayium-stdin-unread", func(t *testing.T) {
		dir := t.TempDir()
		in := stdinFile(t, body)
		stdout, stderr, code, log := cli(t, "", filepath.ToSlash(filepath.Join(dir, "f")), in)
		if code != 1 || stdout != "" || !strings.Contains(stderr, "no zero-dependency form") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		if off := fileOffset(t, in); off != 0 {
			t.Fatalf("stdin offset %d, want 0", off)
		}
		if !equalLines(log, []string{"command -v relayium"}) {
			t.Fatalf("remote commands %q", log)
		}
		waitDirNames(t, dir)
	})

	// The in-process cases run the real runPush with the real sshx.Dial (the
	// stand-in found on PATH), the real pump (this test binary re-executed as
	// `__pump-stdin`, dispatched by Run), and the real receiver (the built
	// CLI). In-process is what lets them deliver a cancel without an OS
	// signal (Windows cannot send os.Interrupt to one process) and see the
	// pump's PID.
	inProcess := func(t *testing.T, mode string, stdin *os.File) (*pumpWatch, chan<- os.Signal) {
		release := filepath.Join(t.TempDir(), "release")
		t.Cleanup(func() { writeFile(t, release, "", 0o600) })
		t.Setenv("PATH", sshDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		t.Setenv(standinRelayiumEnv, bin)
		t.Setenv(standinLogEnv, filepath.Join(t.TempDir(), "remote.log"))
		t.Setenv(standinModeEnv, mode)
		t.Setenv(standinReleaseEnv, release)
		w := &pumpWatch{started: make(chan *stdinpump.Pump, 1)}
		sigs := make(chan os.Signal, 1)
		oldStart, oldNotify, oldTerm := stdinPumpStart, pushStdinNotify, pushStdinIsTerminal
		t.Cleanup(func() { stdinPumpStart, pushStdinNotify, pushStdinIsTerminal = oldStart, oldNotify, oldTerm })
		pushStdinIsTerminal = func() bool { return false }
		stdinPumpStart = func() (xfer.StreamSource, error) {
			p, err := stdinpump.StartWith(stdinpump.Options{Stdin: stdin})
			if err != nil {
				return nil, err
			}
			w.p = p
			w.started <- p
			return p, nil
		}
		pushStdinNotify = func(c chan<- os.Signal) func() {
			go func() {
				if s, ok := <-sigs; ok {
					c <- s
				}
			}()
			return func() {}
		}
		return w, sigs
	}

	t.Run("cancel-while-streaming", func(t *testing.T) {
		dir := t.TempDir()
		pr, pw, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer pr.Close()
		defer pw.Close()
		w, sigs := inProcess(t, "", pr)
		go func() {
			p := <-w.started
			_ = p
			pw.Write(body[:1<<20])
			time.Sleep(300 * time.Millisecond) // stdin now silent and held open
			sigs <- os.Interrupt
		}()
		began := time.Now()
		stdout, stderr, code := runCLI("push", "-", "localhost:"+filepath.ToSlash(filepath.Join(dir, "x")))
		if code != 130 || stdout != "" || !strings.Contains(stderr, "nothing was installed") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		if el := time.Since(began); el > 12*time.Second {
			t.Fatalf("took %v", el)
		}
		w.assertReaped(t)
		waitDirNames(t, dir) // no destination, and the receiver removed its staging
	})

	t.Run("pump-killed", func(t *testing.T) {
		dir := t.TempDir()
		pr, pw, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer pr.Close()
		defer pw.Close()
		w, _ := inProcess(t, "", pr)
		go func() {
			p := <-w.started
			pw.Write(body[:1<<20])
			time.Sleep(300 * time.Millisecond)
			if proc, err := os.FindProcess(p.Pid()); err == nil {
				proc.Kill() // the exact PID; the parent never sees an end marker
			}
		}()
		stdout, stderr, code := runCLI("push", "-", "localhost:"+filepath.ToSlash(filepath.Join(dir, "x")))
		if code != 1 || stdout != "" || !strings.Contains(stderr, "stdin reader ended unexpectedly") || !strings.Contains(stderr, "nothing was installed") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		w.assertReaped(t)
		waitDirNames(t, dir)
	})

	t.Run("remote-holds-after-accept", func(t *testing.T) {
		dir := t.TempDir()
		pr, pw, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer pr.Close()
		defer pw.Close()
		w, sigs := inProcess(t, "hold", pr)
		go func() {
			// More than any pipe and buffer chain holds: the writer ends up
			// blocked on a remote that never reads. The writes stop when the
			// test closes pw.
			for i := 0; i < 16; i++ {
				if _, err := pw.Write(body[:1<<20]); err != nil {
					return
				}
			}
		}()
		go func() {
			<-w.started
			time.Sleep(time.Second)
			sigs <- os.Interrupt
		}()
		began := time.Now()
		stdout, stderr, code := runCLI("push", "-", "localhost:"+filepath.ToSlash(filepath.Join(dir, "x")))
		el := time.Since(began)
		if code != 130 || stdout != "" {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
		// Abort's bound: abortGrace + termGrace + killGrace (Windows has no
		// SIGTERM stage), healthy far below; 12 s is the healthy e2e bound.
		if el > 12*time.Second {
			t.Fatalf("took %v against a holding remote", el)
		}
		w.assertReaped(t)
		waitDirNames(t, dir)
	})
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
