//go:build !windows

package main

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
	"runtime"
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

// E-U1/E-U2: a 5 MiB+7 file, an empty stdin and a closed fd 0 (which Go's
// runtime reopens as /dev/null before main, so it is an empty input).
func TestE2EPushStdinOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteUmask027(t, bin)
	dir := t.TempDir()
	body := e2eRandom(t, 5<<20+7)
	dest := filepath.Join(dir, "data.bin")

	stdout, stderr, code := f.pushStdinRun(t, bin, dest, stdinFile(t, body))
	if code != 0 || stdout != "" {
		t.Fatalf("exit %d, %d stdout bytes\nstderr:\n%s", code, len(stdout), stderr)
	}
	if !strings.Contains(stderr, "data.bin ("+strconv.Itoa(len(body))+" bytes, sha256 "+sha(body)+")") {
		t.Fatalf("no summary on stderr:\n%s", stderr)
	}
	got, err := os.ReadFile(dest)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("installed %d bytes (err %v), want %d", len(got), err, len(body))
	}
	if fi, _ := os.Stat(dest); fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v, want 0640 under the remote's umask 027", fi.Mode().Perm())
	}
	assertDirNames(t, dir, "data.bin")
	want := []string{"command -v relayium", "relayium __recv --stream-file -- " + sshx.ShellQuote(dest)}
	if got := readLines(t, f.remoteLog); !equalLines(got, want) {
		t.Fatalf("remote commands %q, want %q", got, want)
	}
	f.assertClientArgv(t, 2)
	assertNoPumpFor(t, bin)

	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devnull.Close()
	empty := filepath.Join(dir, "empty")
	if _, stderr, code := f.pushStdinRun(t, bin, empty, devnull); code != 0 {
		t.Fatalf("empty: exit %d\n%s", code, stderr)
	}
	if fi, err := os.Stat(empty); err != nil || fi.Size() != 0 {
		t.Fatalf("empty: %v %v", fi, err)
	}

	// fd 0 closed by the shell before exec.
	closed := filepath.Join(dir, "closed")
	argv := []string{bin, "push", "-i", f.clientKey, "-p", strconv.Itoa(f.port), "-", "localhost:" + closed}
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = sshx.ShellQuote(a)
	}
	env := append(os.Environ(), "PATH="+f.shimDir+":/usr/bin:/bin")
	if _, stderr, code := runBounded(t, e2ePushTimeout, "/bin/sh", []string{"-c", "exec 0<&-; exec " + strings.Join(quoted, " ")}, "", env); code != 0 {
		t.Fatalf("closed fd 0: exit %d\n%s", code, stderr)
	}
	if fi, err := os.Stat(closed); err != nil || fi.Size() != 0 {
		t.Fatalf("closed fd 0: %v %v", fi, err)
	}
	assertDirNames(t, dir, "closed", "data.bin", "empty")
	assertNoPumpFor(t, bin)
}

// E-U1 (challenge): the remote's StreamResult echoes the End challenge the
// sender generated, captured byte-for-byte by tee on both directions.
func TestE2EPushStdinEchoesEndChallengeOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	logs := t.TempDir()
	in, out := filepath.Join(logs, "in"), filepath.Join(logs, "out")
	f.remoteShim(t, "tee "+sshx.ShellQuote(in)+" | "+sshx.ShellQuote(bin)+" \"$@\" | tee "+sshx.ShellQuote(out)+"\n")
	dir := t.TempDir()
	body := e2eRandom(t, 3<<20+5)
	if _, stderr, code := f.pushStdinRun(t, bin, filepath.Join(dir, "x"), stdinFile(t, body)); code != 0 {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	var end xfer.StreamEnd
	var res xfer.StreamResult
	lastFrame(t, in, xfer.MsgStreamEnd, &end)
	lastFrame(t, out, xfer.MsgStreamResult, &res)
	if len(end.Challenge) != xfer.StreamChallengeLen || res.Challenge != end.Challenge {
		t.Fatalf("End challenge %q, Result echo %q", end.Challenge, res.Challenge)
	}
	if end.Size != int64(len(body)) || end.SHA256 != sha(body) || res.Size != end.Size || res.SHA256 != end.SHA256 {
		t.Fatalf("end %+v result %+v", end, res)
	}
}

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

// E-U3: unknown length. 1 MiB, then a pause during which nothing is installed
// and exactly one private staging directory exists; then 2 MiB and EOF.
func TestE2EPushStdinUnknownLengthOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteUmask027(t, bin)
	dir := t.TempDir()
	dest := filepath.Join(dir, "stream.bin")
	body := e2eRandom(t, 3<<20)
	r, w := heldPipe(t)
	p := f.startPushStdin(t, bin, dest, r, "")
	pump := waitPump(t, p)
	if _, err := w.Write(body[:1<<20]); err != nil {
		t.Fatal(err)
	}
	waitFor(t, e2ePushTimeout, "one staging directory holding the first MiB", func() bool {
		s := stagingDirs(t, dir)
		if len(s) != 1 {
			return false
		}
		fi, err := os.Stat(filepath.Join(dir, s[0], "data"))
		return err == nil && fi.Size() == 1<<20
	})
	s := stagingDirs(t, dir)
	if fi, _ := os.Stat(filepath.Join(dir, s[0])); fi.Mode().Perm() != 0o700 {
		t.Fatalf("staging mode %v, want 0700", fi.Mode().Perm())
	}
	if _, err := os.Lstat(dest); !os.IsNotExist(err) {
		t.Fatalf("destination exists mid-stream (err %v)", err)
	}
	if _, err := w.Write(body[1<<20:]); err != nil {
		t.Fatal(err)
	}
	w.Close()
	code, _ := p.wait(t, e2ePushTimeout)
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, p.stderr.String())
	}
	got, _ := os.ReadFile(dest)
	if sha(got) != sha(body) {
		t.Fatalf("installed %d bytes with a different hash", len(got))
	}
	assertDirNames(t, dir, "stream.bin")
	assertReaped(t, "pump", pump)
}

// ── refusals: nothing read ──────────────────────────────────────────────────

// E-S1, E-C1, E-Z1, E-N1: every refusal before Accept leaves stdin unread,
// both as a file (offset 0) and as a pipe (every byte still there).
func TestE2EPushStdinRefusalsLeaveStdinUnreadOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	base := t.TempDir()
	writeFile(t, filepath.Join(base, "file"), "ORIGINAL", 0o600)
	if err := os.Mkdir(filepath.Join(base, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "file"), filepath.Join(base, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "gone"), filepath.Join(base, "dangling")); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		entries, _ := os.ReadDir(base)
		var s []string
		for _, e := range entries {
			s = append(s, e.Name())
		}
		b, _ := os.ReadFile(filepath.Join(base, "file"))
		return strings.Join(s, ",") + "|" + string(b)
	}
	before := snapshot()

	for _, tc := range []struct {
		name   string
		dest   string
		code   int
		want   string
		remote string // "real", "none" (no relayium), "noisy"
	}{
		{"shape-trailing-slash", base + "/dir/", 2, "names a directory", "real"},
		{"shape-dotdot", base + "/dir/..", 2, "names a directory", "real"},
		{"exists-file", base + "/file", 1, "already exists", "real"},
		{"exists-dir", base + "/dir", 1, "is a directory", "real"},
		{"exists-symlink", base + "/link", 1, "already exists", "real"},
		{"exists-dangling-symlink", base + "/dangling", 1, "already exists", "real"},
		{"parent-missing", base + "/missing/x", 1, "does not exist", "real"},
		{"parent-is-file", base + "/file/x", 1, "not a directory", "real"},
		{"zero-dependency-remote", base + "/new", 1, "no zero-dependency form", "none"},
		{"remote-noise", base + "/new", 1, "nothing was read from stdin", "noisy"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			unreadVariants(t, func(t *testing.T, stdin *os.File) {
				writeFile(t, f.remoteLog, "", 0o600)
				writeFile(t, f.clientLog, "", 0o600)
				switch tc.remote {
				case "real":
					writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
				case "none":
					writeFile(t, f.remotePath, "/usr/bin:/bin\n", 0o600)
				case "noisy":
					f.remoteShim(t, "echo 'Welcome to the build host'\nexec "+sshx.ShellQuote(bin)+" \"$@\"\n")
				}
				stdout, stderr, code := f.pushStdinRun(t, bin, tc.dest, stdin)
				if code != tc.code || stdout != "" || !strings.Contains(stderr, tc.want) {
					t.Fatalf("exit %d (want %d), stdout %q\nstderr:\n%s", code, tc.code, stdout, stderr)
				}
				if tc.code == 2 {
					if calls := readLines(t, f.clientLog); len(calls) != 0 {
						t.Fatalf("ssh ran for a command-line refusal: %q", calls)
					}
				}
				if tc.remote == "none" {
					if got := readLines(t, f.remoteLog); !equalLines(got, []string{"command -v relayium"}) {
						t.Fatalf("remote commands %q", got)
					}
				}
				if s := snapshot(); s != before {
					t.Fatalf("receiver directory changed: %q -> %q", before, s)
				}
				assertNoPumpFor(t, bin)
			})
		})
	}
}

// E-H1: an unknown host key refuses before anything runs remotely.
func TestE2EPushStdinRefusesUnknownHostKeyOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	impostor := keygen(t, lookTool(t, "ssh-keygen"), filepath.Join(t.TempDir(), "impostor_ed25519"))
	writeFile(t, f.knownHosts, e2eHostAlias+" "+impostor+"\n", 0o600)
	dir := t.TempDir()
	unreadVariants(t, func(t *testing.T, stdin *os.File) {
		stdout, stderr, code := f.pushStdinRun(t, bin, filepath.Join(dir, "x"), stdin)
		if code != 1 || stdout != "" || !strings.Contains(stderr, "Host key verification failed") || !strings.Contains(stderr, "nothing was read from stdin") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
	})
	if got := readLines(t, f.remoteLog); len(got) != 0 {
		t.Fatalf("remote ran %q despite the host-key refusal", got)
	}
	f.assertAccepted(t, false)
	assertDirNames(t, dir)
}

// E-TTY: a real terminal as stdin (`script` gives a pty) exits 2 before ssh.
func TestE2EPushStdinRefusesARealTerminal(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	dir := t.TempDir()
	argv := []string{bin, "push", "-i", f.clientKey, "-p", strconv.Itoa(f.port), "-", "localhost:" + filepath.Join(dir, "x")}
	scriptBin := lookTool(t, "script")
	var args []string
	switch runtime.GOOS {
	case "darwin", "freebsd":
		args = append([]string{"-q", "/dev/null"}, argv...)
	default:
		quoted := make([]string, len(argv))
		for i, a := range argv {
			quoted[i] = sshx.ShellQuote(a)
		}
		args = []string{"-q", "-e", "-c", strings.Join(quoted, " "), "/dev/null"}
	}
	env := append(os.Environ(), "PATH="+f.shimDir+":/usr/bin:/bin")
	out, errOut, _ := runBounded(t, e2ePushTimeout, scriptBin, args, t.TempDir(), env)
	if !strings.Contains(out+errOut, "refusing to read file bytes from a terminal") {
		t.Fatalf("no terminal refusal under a pty:\n%q", out+errOut)
	}
	if calls := readLines(t, f.clientLog); len(calls) != 0 {
		t.Fatalf("ssh was started despite the terminal: %q", calls)
	}
	assertDirNames(t, dir)
}

// ── races on the receiver ───────────────────────────────────────────────────

// E-C1 race: the destination appears during the transfer. The install
// refuses; the planted file is untouched; the staging is gone.
func TestE2EPushStdinDestinationPlantedMidStreamOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	dir := t.TempDir()
	dest := filepath.Join(dir, "x")
	r, w := heldPipe(t)
	p := f.startPushStdin(t, bin, dest, r, "")
	waitPump(t, p)
	w.Write(e2eRandom(t, 1<<20))
	waitFor(t, e2ePushTimeout, "staging", func() bool { return len(stagingDirs(t, dir)) == 1 })
	writeFile(t, dest, "PLANTED", 0o600)
	w.Close()
	code, _ := p.wait(t, e2ePushTimeout)
	if code != 1 || !strings.Contains(p.stderr.String(), "created on the receiver during the transfer") || !strings.Contains(p.stderr.String(), "nothing was installed") {
		t.Fatalf("exit %d\n%s", code, p.stderr.String())
	}
	if b, _ := os.ReadFile(dest); string(b) != "PLANTED" {
		t.Fatalf("planted file changed: %q", b)
	}
	waitDirNamesE2E(t, dir, "x")
}

// E-C2: the destination's directory is renamed away during the transfer and
// another put in its place. The install lands in the original (moved)
// directory, which the receiver holds open; nothing appears in the new one.
func TestE2EPushStdinParentSwappedMidStreamOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	base := t.TempDir()
	orig := filepath.Join(base, "d")
	if err := os.Mkdir(orig, 0o700); err != nil {
		t.Fatal(err)
	}
	r, w := heldPipe(t)
	p := f.startPushStdin(t, bin, filepath.Join(orig, "x"), r, "")
	waitPump(t, p)
	body := e2eRandom(t, 2<<20)
	w.Write(body[:1<<20])
	waitFor(t, e2ePushTimeout, "staging", func() bool { return len(stagingDirs(t, orig)) == 1 })
	moved := filepath.Join(base, "moved")
	if err := os.Rename(orig, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(orig, 0o700); err != nil {
		t.Fatal(err)
	}
	w.Write(body[1<<20:])
	w.Close()
	if code, _ := p.wait(t, e2ePushTimeout); code != 0 {
		t.Fatalf("exit %d\n%s", code, p.stderr.String())
	}
	got, _ := os.ReadFile(filepath.Join(moved, "x"))
	if !bytes.Equal(got, body) {
		t.Fatalf("moved dir holds %d bytes", len(got))
	}
	assertDirNames(t, moved, "x")
	assertDirNames(t, orig)
}

// waitDirNamesE2E is waitDirNames (the remote may still be cleaning up).
func waitDirNamesE2E(t *testing.T, dir string, names ...string) {
	t.Helper()
	waitDirNames(t, dir, names...)
}

// ── failures while stdin is blocked ──────────────────────────────────────────

// E-R1 (EFBIG): the remote runs under `ulimit -f 64`. After 256 KiB the
// receiver's write fails with EFBIG while this side's stdin stays open and
// silent. push must learn of it from the receiver, stop the pump, abort ssh
// and exit 1 within the healthy bound, with nothing installed and no staging
// left, and the test closes its write end only after push returned.
func TestE2EPushStdinRemoteWriteFailureOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteShim(t, "ulimit -f 64\nexec "+sshx.ShellQuote(bin)+" \"$@\"\n")
	dir := t.TempDir()
	dest := filepath.Join(dir, "big.bin")
	shim, pidFile := f.sshPIDShim(t)
	r, w := heldPipe(t)
	p := f.startPushStdin(t, bin, dest, r, shim)
	pump := waitPump(t, p)
	if _, err := w.Write(e2eRandom(t, 256<<10)); err != nil {
		t.Fatal(err)
	}
	code, el := p.wait(t, e2ePushTimeout)
	stderr := p.stderr.String()
	t.Logf("push returned after %v", el.Round(time.Millisecond))
	if code != 1 || !strings.Contains(stderr, "file too large") || !strings.Contains(stderr, "nothing was installed on the receiver") {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	if el > e2eStreamBound {
		t.Fatalf("took %v with stdin blocked (healthy bound %v)", el, e2eStreamBound)
	}
	assertReaped(t, "pump", pump)
	assertReaped(t, "ssh", sshPIDs(t, pidFile)[1:]...) // [0] is the probe
	w.Close()
	waitDirNamesE2E(t, dir)
	assertNoProcessNaming(t, dest)
}

// E-K1: the pump helper is killed (exact PID) during a pause. push must not
// take that for the end of input: exit 1, nothing installed, no staging.
func TestE2EPushStdinKilledPumpOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	dir := t.TempDir()
	dest := filepath.Join(dir, "x")
	shim, pidFile := f.sshPIDShim(t)
	r, w := heldPipe(t)
	p := f.startPushStdin(t, bin, dest, r, shim)
	pump := waitPump(t, p)
	w.Write(e2eRandom(t, 1<<20))
	waitFor(t, e2ePushTimeout, "staging", func() bool { return len(stagingDirs(t, dir)) == 1 })
	if err := syscall.Kill(pump, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	code, el := p.wait(t, e2ePushTimeout)
	if code != 1 || !strings.Contains(p.stderr.String(), "stdin reader ended unexpectedly") || !strings.Contains(p.stderr.String(), "nothing was installed") {
		t.Fatalf("exit %d\n%s", code, p.stderr.String())
	}
	if el > e2eStreamBound {
		t.Fatalf("took %v", el)
	}
	assertReaped(t, "pump", pump)
	assertReaped(t, "ssh", sshPIDs(t, pidFile)[1:]...)
	waitDirNamesE2E(t, dir)
	assertNoProcessNaming(t, dest)
}

// E-T1: SIGTERM to the real remote helper during a pause: its handler removes
// the staging; push exits 1 within the bound with nothing installed.
func TestE2EPushStdinRemoteHelperTerminatedOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	dir := t.TempDir()
	dest := filepath.Join(dir, "x")
	r, w := heldPipe(t)
	p := f.startPushStdin(t, bin, dest, r, "")
	pump := waitPump(t, p)
	w.Write(e2eRandom(t, 1<<20))
	waitFor(t, e2ePushTimeout, "staging", func() bool { return len(stagingDirs(t, dir)) == 1 })
	var helper int
	for _, e := range psList(t) {
		if strings.Contains(e.cmd, "__recv --stream-file -- "+dest) {
			if helper != 0 {
				t.Fatalf("two remote helpers for %s", dest)
			}
			helper = e.pid
		}
	}
	if helper == 0 {
		t.Fatal("remote helper not found")
	}
	if err := syscall.Kill(helper, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	code, el := p.wait(t, e2ePushTimeout)
	if code != 1 || !strings.Contains(p.stderr.String(), "nothing was installed") {
		t.Fatalf("exit %d\n%s", code, p.stderr.String())
	}
	if !strings.Contains(p.stderr.String(), "stopped by terminated") {
		t.Fatalf("the remote helper's own report did not reach stderr:\n%s", p.stderr.String())
	}
	if el > e2eStreamBound {
		t.Fatalf("took %v", el)
	}
	assertReaped(t, "pump", pump)
	waitDirNamesE2E(t, dir)
	assertNoProcessNaming(t, dest)
}

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

// E-B1: a stand-in remote accepts, then never reads (signals ignored), so
// push's writer blocks in ssh. SIGINT to push's PID: exit 130 within the
// bound, ssh and the pump reaped while the stand-in is still alive.
func TestE2EPushStdinBlockedTransportInterruptOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.holdingRemote(t, acceptFrame(t), false)
	dir := t.TempDir()
	shim, pidFile := f.sshPIDShim(t)
	r, w := heldPipe(t)
	p := f.startPushStdin(t, bin, filepath.Join(dir, "x"), r, shim)
	pump := waitPump(t, p)
	go func() {
		chunk := e2eRandom(t, 1<<20)
		for i := 0; i < 64; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}()
	time.Sleep(2 * time.Second)
	sent := time.Now()
	if err := syscall.Kill(p.cmd.Process.Pid, syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	code, _ := p.wait(t, e2ePushTimeout)
	el := p.ended.Sub(sent)
	if code != 130 || !strings.Contains(p.stderr.String(), "interrupted") {
		t.Fatalf("exit %d\n%s", code, p.stderr.String())
	}
	if el > e2eStreamBound {
		t.Fatalf("took %v after SIGINT", el)
	}
	assertReaped(t, "pump", pump)
	assertReaped(t, "ssh", sshPIDs(t, pidFile)[1:]...)
	assertDirNames(t, dir)
}

// Silent peer: the stand-in never answers at all (no Accept). Nothing reads
// stdin; SIGINT ends push with 130, no pump was ever started.
func TestE2EPushStdinSilentPeerInterruptOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.holdingRemote(t, nil, false)
	dir := t.TempDir()
	in := stdinFile(t, e2eRandom(t, 1<<20))
	shim, pidFile := f.sshPIDShim(t)
	p := f.startPushStdin(t, bin, filepath.Join(dir, "x"), in, shim)
	time.Sleep(2 * time.Second)
	if pids := pumpChildren(t, p.cmd.Process.Pid); len(pids) != 0 {
		t.Fatalf("a pump was started before any Accept: %v", pids)
	}
	sent := time.Now()
	syscall.Kill(p.cmd.Process.Pid, syscall.SIGINT)
	code, _ := p.wait(t, e2ePushTimeout)
	if code != 130 || !strings.Contains(p.stderr.String(), "nothing was read from stdin") {
		t.Fatalf("exit %d\n%s", code, p.stderr.String())
	}
	if el := p.ended.Sub(sent); el > e2eStreamBound {
		t.Fatalf("took %v", el)
	}
	if off := fileOffset(t, in); off != 0 {
		t.Fatalf("stdin offset %d", off)
	}
	assertReaped(t, "ssh", sshPIDs(t, pidFile)[1:]...)
	assertNoPumpFor(t, bin)
}

// E-I1: SIGINT to push's whole process group (what Ctrl-C does) during a
// pause with the real receiver: the pump ignores it, ssh dies of it, push
// exits 130 and leaves no destination, staging, pump or remote helper.
// Also SIGTERM to push alone: 143.
func TestE2EPushStdinSignalsOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	for _, tc := range []struct {
		name  string
		group bool
		sig   syscall.Signal
		code  int
	}{
		{"group-SIGINT", true, syscall.SIGINT, 130},
		{"SIGTERM", false, syscall.SIGTERM, 143},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newSSHFixture(t)
			writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
			dir := t.TempDir()
			dest := filepath.Join(dir, "x")
			r, w := heldPipe(t)
			p := f.startPushStdin(t, bin, dest, r, "")
			pump := waitPump(t, p)
			w.Write(e2eRandom(t, 1<<20))
			waitFor(t, e2ePushTimeout, "staging", func() bool { return len(stagingDirs(t, dir)) == 1 })
			target := p.cmd.Process.Pid
			if tc.group {
				target = -target
			}
			sent := time.Now()
			if err := syscall.Kill(target, tc.sig); err != nil {
				t.Fatal(err)
			}
			code, _ := p.wait(t, e2ePushTimeout)
			if code != tc.code || !strings.Contains(p.stderr.String(), "interrupted") || !strings.Contains(p.stderr.String(), "nothing was installed") {
				t.Fatalf("exit %d, want %d\n%s", code, tc.code, p.stderr.String())
			}
			if el := p.ended.Sub(sent); el > e2eStreamBound {
				t.Fatalf("took %v", el)
			}
			assertReaped(t, "pump", pump)
			waitDirNamesE2E(t, dir)
			assertNoProcessNaming(t, dest)
		})
	}
}

// E-P1: a stand-in (NOT the real receiver) answers Accept and then a
// StreamResult naming exactly the right size and hash BEFORE End was sent —
// (a) with no challenge, (b) with a random one. Never success.
func TestE2EPushStdinPrematureResultOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	body := e2eRandom(t, 1<<20)
	for _, tc := range []struct{ name, challenge string }{
		{"no-echo", ""},
		{"guessed-echo", strings.Repeat("5a", 16)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newSSHFixture(t)
			frames := acceptFrame(t)
			var b bytes.Buffer
			xfer.WriteJSON(&b, xfer.MsgStreamResult, xfer.StreamResult{Size: int64(len(body)), SHA256: sha(body), Challenge: tc.challenge})
			f.holdingRemote(t, append(frames, b.Bytes()...), true)
			dir := t.TempDir()
			r, w := heldPipe(t)
			// The premature answer arrives right behind Accept, so push may
			// reject it before its pump has read anything; stdin stays open
			// either way, so End is never sent.
			go w.Write(body)
			p := f.startPushStdin(t, bin, filepath.Join(dir, "x"), r, "")
			code, _ := p.wait(t, e2ePushTimeout)
			if code != 1 || !strings.Contains(p.stderr.String(), "NOT confirmed; do not trust x on the receiver") {
				t.Fatalf("exit %d\n%s", code, p.stderr.String())
			}
			assertNoPumpFor(t, bin)
			assertDirNames(t, dir)
		})
	}
}

// Lost receipt after install: the real receiver installs, but its
// StreamResult never reaches push (`head -c 25` passes only StreamAccept).
// push cannot confirm and must say the file may or may not be there — and it
// is there.
func TestE2EPushStdinLostReceiptOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	if n := len(acceptFrame(t)); n != 25 {
		t.Fatalf("StreamAccept frame is %d bytes; update the head -c below", n)
	}
	f.remoteShim(t, sshx.ShellQuote(bin)+" \"$@\" | head -c 25\n")
	dir := t.TempDir()
	dest := filepath.Join(dir, "x")
	body := e2eRandom(t, 2<<20+1)
	stdout, stderr, code := f.pushStdinRun(t, bin, dest, stdinFile(t, body))
	if code != 1 || stdout != "" || !strings.Contains(stderr, "may or may not have installed x. Check it there before retrying") {
		t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
	}
	if !strings.Contains(stderr, "was installed, but the confirmation could not be sent") {
		t.Fatalf("the receiver's own note did not reach stderr:\n%s", stderr)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, body) {
		t.Fatalf("remote holds %d bytes", len(got))
	}
	assertDirNames(t, dir, "x")
	assertNoPumpFor(t, bin)
}

// O-1: every released relayium (built privately from its tag) refuses
// `__recv --stream-file` with exit 2 before reading; push names that, reads
// nothing and creates nothing. Opt-in: RELAYIUM_E2E_OLD_RELAYIUM.
func TestE2EPushStdinOldPeerOverSSH(t *testing.T) {
	requireSSHE2E(t)
	olds := oldRelayiums(t)
	bin := buildCLI(t)
	for _, old := range olds {
		t.Run(oldVersion(t, old), func(t *testing.T) {
			f := newSSHFixture(t)
			f.remoteRelayium(t, old)
			dir := t.TempDir()
			unreadVariants(t, func(t *testing.T, stdin *os.File) {
				stdout, stderr, code := f.pushStdinRun(t, bin, filepath.Join(dir, "x"), stdin)
				if code != 1 || stdout != "" || !strings.Contains(stderr, "predates \"push -\"") {
					t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
				}
			})
			assertDirNames(t, dir)
			assertNoPumpFor(t, bin)
		})
	}
}
