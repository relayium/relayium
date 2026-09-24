//go:build !windows

package main

// SSH retirement: this file retains shared/legacy fixture helpers only; former
// SSH transfer E2E cases are recoverable from d0c414087. They are not current
// acceptance evidence. See ssh_retirement_test.go and docs/CLI-SSH-RETIREMENT.md.


// `relayium push - host:file` over a REAL OpenSSH client and the private
// loopback sshd of e2e_test.go (RELAYIUM_E2E_SSH=1; see that file for how the
// fixture is isolated). The CLI is the built binary; its stdin is handed to it
// as an *os.File (a regular file, whose shared offset shows whether anything
// read it, or a pipe the test holds). The remote is the built binary too,
// behind a shim that pins its umask, unless a test names a stand-in: those are
// the only cases where the remote is not the real receiver, and each says so.
//
// Processes are found by exact PID only: the CLI's is known, the pump helper is
// the CLI's child whose argv names `__pump-stdin`, ssh's PID comes from a shim
// that records `$$` before exec. Nothing is ever signalled by name.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

// e2eStreamBound is the healthy bound on how long `push -` takes to return
// after a failure it must notice (a remote write failure, a killed helper, a
// signal): teardown's own bounds are Abort's 2 s + 2 s (+5 s only for a
// kernel-stuck child) and the pump's reap, plus connection setup. It is the
// design's 12 s healthy e2e bound, not the configured worst case.
const e2eStreamBound = 12 * time.Second

type pushProc struct {
	cmd            *exec.Cmd
	stdout, stderr *lockedBuffer
	done           chan struct{}
	err            error
	began          time.Time
	ended          time.Time
}

// startPushStdin starts `relayium push -i K -p P - localhost:<dest>` in its own
// process group with stdin as the given file. pathPrefix (may be "") goes
// before the fixture's ssh shim on PATH.
func (f *sshFixture) startPushStdin(t *testing.T, bin, dest string, stdin *os.File, pathPrefix string) *pushProc {
	t.Helper()
	path := f.shimDir + ":/usr/bin:/bin"
	if pathPrefix != "" {
		path = pathPrefix + ":" + path
	}
	cmd := exec.Command(bin, "push", "-i", f.clientKey, "-p", strconv.Itoa(f.port), "-", "localhost:"+dest)
	cmd.Env = append(os.Environ(), "PATH="+path)
	cmd.Stdin = stdin
	p := &pushProc{cmd: cmd, stdout: &lockedBuffer{}, stderr: &lockedBuffer{}, done: make(chan struct{})}
	cmd.Stdout, cmd.Stderr = p.stdout, p.stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = e2eWaitDelay
	p.began = time.Now()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		p.err = cmd.Wait()
		p.ended = time.Now()
		close(p.done)
	}()
	t.Cleanup(func() {
		select {
		case <-p.done:
		default:
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-p.done
			t.Errorf("push was still running at cleanup; killed its process group")
		}
	})
	return p
}

// wait returns the exit code (-1 for death by signal) and the time from start.
func (p *pushProc) wait(t *testing.T, bound time.Duration) (int, time.Duration) {
	t.Helper()
	select {
	case <-p.done:
	case <-time.After(bound):
		t.Fatalf("push still running after %v\nstderr:\n%s", bound, p.stderr.String())
	}
	var ee *exec.ExitError
	if errors.As(p.err, &ee) {
		return ee.ExitCode(), p.ended.Sub(p.began)
	}
	if p.err != nil {
		t.Fatal(p.err)
	}
	return 0, p.ended.Sub(p.began)
}

// pushStdinRun runs push - to completion.
func (f *sshFixture) pushStdinRun(t *testing.T, bin, dest string, stdin *os.File) (stdout, stderr string, code int) {
	t.Helper()
	p := f.startPushStdin(t, bin, dest, stdin, "")
	code, _ = p.wait(t, e2ePushTimeout)
	return p.stdout.String(), p.stderr.String(), code
}

// remoteShim puts a `relayium` shell script on the remote PATH.
func (f *sshFixture) remoteShim(t *testing.T, script string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "remote-shim")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "relayium"), "#!/bin/sh\n"+script, 0o700)
	writeFile(t, f.remotePath, dir+":/usr/bin:/bin\n", 0o600)
	return dir
}

// remoteUmask027 makes the remote the real built receiver under umask 027.
func (f *sshFixture) remoteUmask027(t *testing.T, bin string) {
	f.remoteShim(t, "umask 027\nexec "+sshx.ShellQuote(bin)+" \"$@\"\n")
}

type psEntry struct {
	pid, ppid int
	cmd       string
}

func psList(t *testing.T) []psEntry {
	t.Helper()
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,command=").Output()
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	var list []psEntry
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil {
			continue
		}
		list = append(list, psEntry{pid, ppid, strings.Join(f[2:], " ")})
	}
	return list
}

// pumpChildren are the processes whose parent is cli and whose argv names the
// pump subcommand.
func pumpChildren(t *testing.T, cli int) []int {
	t.Helper()
	var pids []int
	for _, e := range psList(t) {
		if e.ppid == cli && strings.Contains(e.cmd, " __pump-stdin") {
			pids = append(pids, e.pid)
		}
	}
	return pids
}

// waitPump waits for the CLI's single pump helper and returns its PID.
func waitPump(t *testing.T, p *pushProc) int {
	t.Helper()
	deadline := time.Now().Add(e2ePushTimeout)
	for {
		if pids := pumpChildren(t, p.cmd.Process.Pid); len(pids) == 1 {
			return pids[0]
		} else if len(pids) > 1 {
			t.Fatalf("more than one pump helper: %v", pids)
		}
		select {
		case <-p.done:
			t.Fatalf("push exited before its pump helper was seen\nstderr:\n%s", p.stderr.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("no pump helper under pid %d\nstderr:\n%s", p.cmd.Process.Pid, p.stderr.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitFor polls cond until it holds, failing after bound.
func waitFor(t *testing.T, bound time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(bound)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s", bound, what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// sshPIDShim records the ssh client's PID (the shim's $$ before exec).
func (f *sshFixture) sshPIDShim(t *testing.T) (dir, pidFile string) {
	t.Helper()
	dir = filepath.Join(t.TempDir(), "pid-shim")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	pidFile = filepath.Join(dir, "ssh.pid")
	writeFile(t, filepath.Join(dir, "ssh"), "#!/bin/sh\n"+
		"echo $$ >> "+sshx.ShellQuote(pidFile)+"\n"+
		"exec "+sshx.ShellQuote(filepath.Join(f.shimDir, "ssh"))+" \"$@\"\n", 0o700)
	return dir, pidFile
}

// sshPIDs are every ssh client PID the shim recorded.
func sshPIDs(t *testing.T, pidFile string) []int {
	t.Helper()
	var pids []int
	for _, l := range readLines(t, pidFile) {
		n, err := strconv.Atoi(l)
		if err != nil {
			t.Fatalf("pid file line %q", l)
		}
		pids = append(pids, n)
	}
	return pids
}

// assertReaped fails if any of pids is still in the process table.
func assertReaped(t *testing.T, what string, pids ...int) {
	t.Helper()
	for _, pid := range pids {
		if pidAlive(t, pid) {
			t.Fatalf("%s pid %d still in the process table after push returned", what, pid)
		}
	}
}

// assertNoPumpFor fails if any process still runs this binary's pump.
func assertNoPumpFor(t *testing.T, bin string) {
	t.Helper()
	assertNoProcessNaming(t, bin+" __pump-stdin")
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// heldPipe is stdin as a pipe the test writes and closes.
func heldPipe(t *testing.T) (r, w *os.File) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close(); w.Close() })
	return r, w
}

// unreadVariants runs refusal once with stdin as a regular file (offset must
// still be 0 afterwards) and once as a pipe holding 4096 bytes and closed
// (all 4096 must still be readable afterwards).
func unreadVariants(t *testing.T, run func(t *testing.T, stdin *os.File)) {
	t.Run("file", func(t *testing.T) {
		in := stdinFile(t, e2eRandom(t, 1<<20))
		run(t, in)
		if off := fileOffset(t, in); off != 0 {
			t.Fatalf("stdin offset %d after the refusal, want 0: something read stdin", off)
		}
	})
	t.Run("pipe", func(t *testing.T) {
		r, w := heldPipe(t)
		want := e2eRandom(t, 4096)
		if _, err := w.Write(want); err != nil {
			t.Fatal(err)
		}
		w.Close()
		run(t, r)
		got, err := io.ReadAll(r)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("after the refusal the pipe still held %d of %d bytes (err %v): something read stdin", len(got), len(want), err)
		}
	})
}

// ── E-U: success paths ───────────────────────────────────────────────────────

// lastFrame decodes the last frame of type want in a captured stream.
func lastFrame(t *testing.T, path string, want xfer.MsgType, v any) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	found := false
	for {
		mt, payload, err := xfer.ReadFrame(f)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if mt == want {
			if err := json.Unmarshal(payload, v); err != nil {
				t.Fatal(err)
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("%s holds no frame of type %d", path, want)
	}
}

// ── refusals: nothing read ──────────────────────────────────────────────────

// ── races on the receiver ───────────────────────────────────────────────────

// waitDirNamesE2E is waitDirNames (the remote may still be cleaning up).
func waitDirNamesE2E(t *testing.T, dir string, names ...string) {
	t.Helper()
	waitDirNames(t, dir, names...)
}

// ── failures while stdin is blocked ──────────────────────────────────────────

// holdingRemote makes the remote a stand-in (NOT the real receiver) that
// ignores signals, optionally sends pre-built frames, then holds until
// released, never reading. Returns a release func (also run at cleanup).
func (f *sshFixture) holdingRemote(t *testing.T, frames []byte, read bool) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "hold-bin")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	framesFile := filepath.Join(dir, "frames")
	writeFile(t, framesFile, string(frames), 0o600)
	pidFile := filepath.Join(dir, "remote.pid")
	release := filepath.Join(dir, "release")
	drain := ""
	if read {
		drain = "cat > /dev/null &\n"
	}
	writeFile(t, filepath.Join(dir, "relayium"), "#!/bin/sh\n"+
		"trap '' HUP PIPE TERM INT\n"+
		"echo $$ > "+sshx.ShellQuote(pidFile)+"\n"+
		"cat "+sshx.ShellQuote(framesFile)+"\n"+
		drain+
		"n=0\n"+
		"while [ ! -e "+sshx.ShellQuote(release)+" ] && [ $n -lt 600 ]; do sleep 0.2; n=$((n+1)); done\n", 0o700)
	writeFile(t, f.remotePath, dir+":/usr/bin:/bin\n", 0o600)
	t.Cleanup(func() {
		writeFile(t, release, "", 0o600)
		if _, err := os.Stat(pidFile); err != nil {
			return
		}
		pid := readPID(t, pidFile)
		waitFor(t, e2eCleanupTimeout, "the released stand-in to exit", func() bool { return !pidAlive(t, pid) })
	})
}

func acceptFrame(t *testing.T) []byte {
	var b bytes.Buffer
	if err := xfer.WriteJSON(&b, xfer.MsgStreamAccept, xfer.StreamAccept{ChunkMax: xfer.StreamChunkMax}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
