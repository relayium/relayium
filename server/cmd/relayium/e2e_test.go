package main

// Real-transport end-to-end tests for `relayium push host:path` over SSH.
//
// Every other test of the SSH path either checks the argv sshx builds or runs
// the tar half through a local `sh -c`. These run the built CLI against a real
// OpenSSH client and a real, private sshd, so the pieces only a live session
// exercises — the 255-versus-1 exit split in RemoteHasRelayium, stdin EOF
// reaching the remote tar, the native `__recv` path, host-key refusal — are
// actually executed.
//
// The fixture is isolated by construction and never touches the machine's own
// SSH setup:
//
//   - sshd is started by this test, as this user, on a 127.0.0.1 high port,
//     with a config, host key and authorized_keys it generated in a temp dir.
//     Remote Login, launchd/systemd services and /etc/ssh are not involved.
//   - The CLI runs `ssh` from PATH (sshx has no -F/-o), so PATH is pointed at a
//     shim that execs the REAL ssh with `-F <private config>`. -F replaces
//     ~/.ssh/config and /etc/ssh/ssh_config; the private config pins
//     UserKnownHostsFile, disables the agent, and keeps StrictHostKeyChecking
//     on. OpenSSH reads ~/.ssh from the account's home directory, not $HOME, so
//     overriding HOME would not have isolated anything.
//   - sshd's ForceCommand runs a wrapper that logs the exact remote command and
//     sets a test-controlled PATH, which is what makes "is relayium installed
//     on the remote" deterministic. The remote command is therefore run by
//     /bin/sh rather than the login shell; the product's remote commands are
//     written for /bin/sh (see sshx.ShellQuote), so that is the shell they
//     target anyway.
//
// Opt-in: without RELAYIUM_E2E_SSH=1 every test here skips. With it set, every
// setup problem — no sshd, a config sshd rejects, a daemon that never answers —
// is a FAILURE, never a skip: a CI step that asked for this proof must not go
// green having run nothing. RELAYIUM_E2E_SSHD overrides the sshd binary.

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

const (
	e2eHostAlias = "relayium-e2e"
	// Bounds for every child this file starts. A build is the only slow step;
	// everything else is local and should take well under a second.
	e2eBuildTimeout   = 3 * time.Minute
	e2eToolTimeout    = 20 * time.Second
	e2ePushTimeout    = 60 * time.Second
	e2eReadyTimeout   = 10 * time.Second
	e2eWaitDelay      = 5 * time.Second
	e2eCleanupTimeout = 10 * time.Second
)

func requireSSHE2E(t *testing.T) {
	t.Helper()
	if os.Getenv("RELAYIUM_E2E_SSH") != "1" {
		t.Skip("set RELAYIUM_E2E_SSH=1 to run the real-sshd push tests (private loopback sshd; no Remote Login or ~/.ssh needed)")
	}
}

// runBounded runs cmd with a hard deadline. WaitDelay also bounds the case
// where a grandchild (the CLI's own ssh) still holds the output pipes after
// the direct child is killed.
func runBounded(t *testing.T, timeout time.Duration, name string, args []string, dir string, env []string) (stdout, stderr string, code int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	cmd.WaitDelay = e2eWaitDelay
	var o, e bytes.Buffer
	cmd.Stdout, cmd.Stderr = &o, &e
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("%s %q timed out after %v\nstdout:\n%s\nstderr:\n%s", name, args, timeout, o.String(), e.String())
	}
	if err != nil {
		ee, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatalf("%s %q could not run: %v", name, args, err)
		}
		return o.String(), e.String(), ee.ExitCode()
	}
	return o.String(), e.String(), 0
}

// buildCLI builds this package — the test's working directory IS
// server/cmd/relayium, so the package is ".", not "./cmd/relayium".
func buildCLI(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "bin", "relayium")
	out, errOut, code := runBounded(t, e2eBuildTimeout, "go", []string{"build", "-o", bin, "."}, "", nil)
	if code != 0 {
		t.Fatalf("build CLI: exit %d\n%s%s", code, out, errOut)
	}
	return bin
}

// lockedBuffer collects sshd's stderr, which its own goroutine writes while
// the test reads.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type sshFixture struct {
	root       string
	port       int
	clientKey  string
	knownHosts string
	hostPub    string // "<type> <base64>" of the real host key
	remoteLog  string // one line per command sshd was asked to run
	remotePath string // file holding the PATH the remote command gets
	clientLog  string // one line per argv the CLI handed to ssh
	shimDir    string // contains the `ssh` shim; goes first on the CLI's PATH
	sshdLog    *lockedBuffer
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

func lookTool(t *testing.T, name string, fallbacks ...string) string {
	t.Helper()
	if p, err := exec.LookPath(name); err == nil {
		abs, err := filepath.Abs(p)
		if err != nil {
			t.Fatal(err)
		}
		return abs
	}
	for _, f := range fallbacks {
		if st, err := os.Stat(f); err == nil && !st.IsDir() {
			return f
		}
	}
	t.Fatalf("RELAYIUM_E2E_SSH=1 but %s was not found on PATH or at %v", name, fallbacks)
	return ""
}

func keygen(t *testing.T, keygenBin, path string) string {
	t.Helper()
	if _, errOut, code := runBounded(t, e2eToolTimeout, keygenBin, []string{"-q", "-t", "ed25519", "-N", "", "-C", "relayium-e2e", "-f", path}, "", nil); code != 0 {
		t.Fatalf("ssh-keygen %s: exit %d\n%s", path, code, errOut)
	}
	pub, err := os.ReadFile(path + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(pub))
	if len(f) < 2 {
		t.Fatalf("unexpected public key %q", pub)
	}
	return f[0] + " " + f[1]
}

// newSSHFixture starts a private sshd and writes the client side around it.
// Every failure here is fatal: the caller has already opted in.
func newSSHFixture(t *testing.T) *sshFixture {
	t.Helper()
	sshdBin := os.Getenv("RELAYIUM_E2E_SSHD")
	if sshdBin == "" {
		sshdBin = lookTool(t, "sshd", "/usr/sbin/sshd")
	} else if st, err := os.Stat(sshdBin); err != nil || st.IsDir() || !filepath.IsAbs(sshdBin) {
		t.Fatalf("RELAYIUM_E2E_SSHD=%q is not an absolute path to an sshd binary (stat: %v)", sshdBin, err)
	}
	sshBin := lookTool(t, "ssh")
	keygenBin := lookTool(t, "ssh-keygen")
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	f := &sshFixture{
		root:       root,
		clientKey:  filepath.Join(root, "client_ed25519"),
		knownHosts: filepath.Join(root, "known_hosts"),
		remoteLog:  filepath.Join(root, "remote.log"),
		remotePath: filepath.Join(root, "remote-path"),
		clientLog:  filepath.Join(root, "client.log"),
		shimDir:    filepath.Join(root, "shim"),
		sshdLog:    &lockedBuffer{},
	}
	hostKey := filepath.Join(root, "host_ed25519")
	f.hostPub = keygen(t, keygenBin, hostKey)
	clientPub := keygen(t, keygenBin, f.clientKey)
	authKeys := filepath.Join(root, "authorized_keys")
	writeFile(t, authKeys, clientPub+"\n", 0o600)
	writeFile(t, f.knownHosts, e2eHostAlias+" "+f.hostPub+"\n", 0o600)
	writeFile(t, f.remoteLog, "", 0o600)
	writeFile(t, f.clientLog, "", 0o600)
	writeFile(t, f.remotePath, "/usr/bin:/bin\n", 0o600)

	wrapper := filepath.Join(root, "remote-wrapper.sh")
	writeFile(t, wrapper, "printf '%s\\n' \"$SSH_ORIGINAL_COMMAND\" >> "+sshx.ShellQuote(f.remoteLog)+"\n"+
		"PATH=\"$(cat "+sshx.ShellQuote(f.remotePath)+")\"; export PATH\n"+
		"exec /bin/sh -c \"$SSH_ORIGINAL_COMMAND\"\n", 0o700)

	sshConfig := filepath.Join(root, "ssh_config")
	writeFile(t, sshConfig, strings.Join([]string{
		"Host localhost",
		"  HostName 127.0.0.1",
		"  HostKeyAlias " + e2eHostAlias,
		"  UserKnownHostsFile " + f.knownHosts,
		"  GlobalKnownHostsFile /dev/null",
		"  StrictHostKeyChecking yes",
		"  UpdateHostKeys no",
		"  CheckHostIP no",
		"  IdentitiesOnly yes",
		"  IdentityAgent none",
		"  BatchMode yes",
		"  ConnectTimeout 5",
		"  ControlMaster no",
		"  ControlPath none",
		"  LogLevel ERROR",
		"",
	}, "\n"), 0o600)
	if err := os.Mkdir(f.shimDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.shimDir, "ssh"), "#!/bin/sh\n"+
		"printf '%s\\n' \"$*\" >> "+sshx.ShellQuote(f.clientLog)+"\n"+
		"exec "+sshx.ShellQuote(sshBin)+" -F "+sshx.ShellQuote(sshConfig)+" \"$@\"\n", 0o700)

	var lastErr string
	for attempt := 1; attempt <= 3; attempt++ {
		port := freeLoopbackPort(t)
		cfg := filepath.Join(root, "sshd_config")
		writeFile(t, cfg, strings.Join([]string{
			"ListenAddress 127.0.0.1",
			"Port " + strconv.Itoa(port),
			"HostKey " + hostKey,
			"PidFile none",
			"AuthorizedKeysFile " + authKeys,
			// t.TempDir's ancestors are not all owner-only (/tmp is 1777), which
			// StrictModes treats as unsafe for authorized_keys.
			"StrictModes no",
			// PAM needs root; so does reading the shadow file it would consult.
			"UsePAM no",
			"PasswordAuthentication no",
			"KbdInteractiveAuthentication no",
			"PubkeyAuthentication yes",
			"AuthenticationMethods publickey",
			"AllowUsers " + u.Username,
			"PermitUserEnvironment no",
			"PermitUserRC no",
			"AllowAgentForwarding no",
			"AllowTcpForwarding no",
			"X11Forwarding no",
			"PermitTTY no",
			"UseDNS no",
			"LoginGraceTime 15",
			"ForceCommand /bin/sh " + sshx.ShellQuote(wrapper),
			"LogLevel VERBOSE",
			"",
		}, "\n"), 0o600)
		if out, errOut, code := runBounded(t, e2eToolTimeout, sshdBin, []string{"-t", "-f", cfg}, "", nil); code != 0 {
			t.Fatalf("%s -t rejected the fixture config: exit %d\n%s%s", sshdBin, code, out, errOut)
		}
		ok, msg := f.startSSHD(t, sshdBin, cfg, port)
		if ok {
			f.port = port
			return f
		}
		lastErr = msg
		if !strings.Contains(msg, "Address already in use") {
			break
		}
	}
	t.Fatalf("sshd did not become ready:\n%s", lastErr)
	return nil
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

// startSSHD runs `sshd -D -e` and waits for its banner. On success it
// registers cleanup that kills and reaps the daemon, then checks that no
// process whose command line names the fixture root is still running. That
// is not a full descendant census: a per-connection child that rewrites its
// argv (sshd-session, a remote command) would not be seen.
func (f *sshFixture) startSSHD(t *testing.T, sshdBin, cfg string, port int) (bool, string) {
	t.Helper()
	logBuf := &lockedBuffer{}
	// sshd re-execs itself and refuses to run from a relative path.
	cmd := exec.Command(sshdBin, "-D", "-e", "-f", cfg)
	cmd.Stdout = logBuf
	cmd.Stderr = logBuf
	cmd.WaitDelay = e2eWaitDelay
	if err := cmd.Start(); err != nil {
		return false, fmt.Sprintf("start %s: %v", sshdBin, err)
	}
	exited := make(chan struct{})
	go func() {
		cmd.Wait()
		close(exited)
	}()
	stop := func() {
		cmd.Process.Kill()
		select {
		case <-exited:
		case <-time.After(e2eCleanupTimeout):
			t.Errorf("sshd pid %d was not reaped within %v", cmd.Process.Pid, e2eCleanupTimeout)
		}
	}

	deadline := time.Now().Add(e2eReadyTimeout)
	for {
		select {
		case <-exited:
			return false, fmt.Sprintf("sshd exited before it was ready (%s):\n%s", cmd.ProcessState, logBuf.String())
		default:
		}
		// The log line proves the banner is OUR daemon's, not some other
		// process that took the port between freeLoopbackPort and sshd's bind.
		listening := strings.Contains(logBuf.String(), "Server listening on 127.0.0.1 port "+strconv.Itoa(port)+".")
		if banner, err := readSSHBanner(port); listening && err == nil && strings.HasPrefix(banner, "SSH-2.0-") {
			break
		}
		if time.Now().After(deadline) {
			stop()
			return false, fmt.Sprintf("no SSH banner on 127.0.0.1:%d within %v:\n%s", port, e2eReadyTimeout, logBuf.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	f.sshdLog = logBuf
	t.Cleanup(func() {
		stop()
		f.assertNoFixtureProcesses(t)
		if t.Failed() {
			t.Logf("sshd log:\n%s", logBuf.String())
		}
	})
	return true, ""
}

func readSSHBanner(port int) (string, error) {
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(time.Second))
	return bufio.NewReader(c).ReadString('\n')
}

// assertNoFixtureProcesses fails the test if any process whose command line
// names this fixture's temp root is still alive after sshd was reaped.
func (f *sshFixture) assertNoFixtureProcesses(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(e2eCleanupTimeout)
	for {
		out, err := exec.Command("ps", "-A", "-o", "pid=,command=").Output()
		if err != nil {
			t.Errorf("ps: %v", err)
			return
		}
		var left []string
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, f.root) {
				left = append(left, strings.TrimSpace(line))
			}
		}
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Errorf("fixture processes still running after cleanup:\n%s", strings.Join(left, "\n"))
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// push runs the built CLI with the ssh shim first on PATH.
func (f *sshFixture) push(t *testing.T, bin string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	env := append(os.Environ(), "PATH="+f.shimDir+":/usr/bin:/bin")
	full := append([]string{"push", "-i", f.clientKey, "-p", strconv.Itoa(f.port)}, args...)
	return runBounded(t, e2ePushTimeout, bin, full, "", env)
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.TrimSuffix(string(b), "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func equalLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// assertOnlyFile checks that dir holds exactly one regular file, name, with
// exactly want as its bytes.
func assertOnlyFile(t *testing.T, dir, name string, want []byte) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != name || !entries[0].Type().IsRegular() {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("destination %s holds %q, want exactly [%s]", dir, names, name)
	}
	got, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("received bytes = %q, want %q", got, want)
	}
}

// e2ePayload is not plain ASCII on purpose: a NUL, a CR and high bytes would
// expose any text-mode mangling on the way through tar or the native stream.
var e2ePayload = []byte("over-ssh\x00\r\n\xff\xfe relayium e2e\n")

func writePayload(t *testing.T) string {
	t.Helper()
	src := filepath.Join(t.TempDir(), "hello.bin")
	writeFile(t, src, string(e2ePayload), 0o644)
	return src
}

func (f *sshFixture) assertAccepted(t *testing.T, wantAccepted bool) {
	t.Helper()
	got := strings.Contains(f.sshdLog.String(), "Accepted publickey")
	if got != wantAccepted {
		t.Fatalf("sshd log 'Accepted publickey' = %v, want %v:\n%s", got, wantAccepted, f.sshdLog.String())
	}
}

func (f *sshFixture) assertClientArgv(t *testing.T, wantCalls int) {
	t.Helper()
	calls := readLines(t, f.clientLog)
	if len(calls) != wantCalls {
		t.Fatalf("CLI invoked ssh %d time(s), want %d: %q", len(calls), wantCalls, calls)
	}
	flags := "-i " + f.clientKey + " -p " + strconv.Itoa(f.port) + " -- localhost "
	for _, c := range calls {
		if !strings.HasPrefix(c, flags) {
			t.Fatalf("ssh argv %q does not start with %q", c, flags)
		}
	}
}

// Remote has no relayium on PATH: push must fall back to piping tar into the
// remote's `tar -x -k`.
func TestE2EZeroDepPushOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	src := writePayload(t)
	dst := t.TempDir()

	stdout, stderr, code := f.push(t, bin, src, "localhost:"+dst)
	if code != 0 {
		t.Fatalf("push exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "sent 1 file(s) (zero-dependency mode)") {
		t.Fatalf("expected the zero-dependency result line, stdout:\n%s", stdout)
	}
	assertOnlyFile(t, dst, "hello.bin", e2ePayload)
	want := []string{"command -v relayium", sshx.RemoteUntarCmd(dst)}
	if got := readLines(t, f.remoteLog); !equalLines(got, want) {
		t.Fatalf("remote commands = %q, want %q", got, want)
	}
	f.assertClientArgv(t, 2)
	f.assertAccepted(t, true)
}

// Remote has relayium on PATH: push must use the native `__recv` stream. The
// only difference from the zero-dep test is the remote PATH, which is what
// makes each test's mode assertion a control for the other's.
//
// Both push into an existing, empty directory; a missing one is the next test.
func TestE2ENativePushOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	src := writePayload(t)
	dst := t.TempDir()

	stdout, stderr, code := f.push(t, bin, src, "localhost:"+dst)
	if code != 0 {
		t.Fatalf("push exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if strings.Contains(stdout+stderr, "zero-dependency") {
		t.Fatalf("native push fell back to zero-dependency mode\nstdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
	assertOnlyFile(t, dst, "hello.bin", e2ePayload)
	want := []string{"command -v relayium", "relayium __recv -- " + sshx.ShellQuote(dst)}
	if got := readLines(t, f.remoteLog); !equalLines(got, want) {
		t.Fatalf("remote commands = %q, want %q", got, want)
	}
	f.assertClientArgv(t, 2)
	f.assertAccepted(t, true)
}

// Native push into a destination that does not exist yet, two levels deep:
// `__recv` creates it, as zero-dep's `mkdir -p` does. Before W-N26 the
// transfer calls on both sides returned no error, yet the report marked every
// file failed and the CLI exited nonzero, so the exit code, the exact bytes
// and the remote command are all asserted — not only that something arrived.
func TestE2ENativePushCreatesMissingDestinationOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	writeFile(t, f.remotePath, filepath.Dir(bin)+":/usr/bin:/bin\n", 0o600)
	src := writePayload(t)
	parent := t.TempDir()
	dst := filepath.Join(parent, "new", "nested")

	stdout, stderr, code := f.push(t, bin, src, "localhost:"+dst)
	if code != 0 {
		t.Fatalf("push exit %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if strings.Contains(stdout+stderr, "zero-dependency") {
		t.Fatalf("native push fell back to zero-dependency mode\nstdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
	if strings.Contains(stdout+stderr, "integrity") {
		t.Fatalf("push reported an integrity failure\nstdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
	if fi, err := os.Lstat(dst); err != nil || !fi.IsDir() {
		t.Fatalf("destination %s is not a real directory: %v", dst, err)
	}
	assertOnlyFile(t, dst, "hello.bin", e2ePayload)
	if entries, err := os.ReadDir(parent); err != nil || len(entries) != 1 || entries[0].Name() != "new" || !entries[0].IsDir() {
		t.Fatalf("%s holds %v (err %v), want only the created directory new/", parent, entries, err)
	}
	want := []string{"command -v relayium", "relayium __recv -- " + sshx.ShellQuote(dst)}
	if got := readLines(t, f.remoteLog); !equalLines(got, want) {
		t.Fatalf("remote commands = %q, want %q", got, want)
	}
	f.assertClientArgv(t, 2)
	f.assertAccepted(t, true)
}

// The remote presents a host key other than the one pinned in known_hosts:
// ssh must refuse before authenticating, push must report a connection
// failure (ssh's 255, not a "relayium not found" 1), and nothing may run on
// or land at the remote. The same fixture then accepts a probe once the real
// key is pinned, proving the refusal came from the host key alone.
func TestE2EPushOverSSHRefusesUnknownHostKey(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	keygenBin := lookTool(t, "ssh-keygen")
	impostor := keygen(t, keygenBin, filepath.Join(t.TempDir(), "impostor_ed25519"))
	if impostor == f.hostPub {
		t.Fatal("generated the same key twice")
	}
	writeFile(t, f.knownHosts, e2eHostAlias+" "+impostor+"\n", 0o600)
	src := writePayload(t)
	dst := filepath.Join(t.TempDir(), "dest")

	stdout, stderr, code := f.push(t, bin, src, "localhost:"+dst)
	if code != 1 {
		t.Fatalf("push exit %d, want 1\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if !strings.Contains(stderr, "Host key verification failed") {
		t.Fatalf("stderr does not show ssh's host-key refusal:\n%s", stderr)
	}
	if !strings.Contains(stderr, "ssh: could not connect to localhost") {
		t.Fatalf("stderr does not show the CLI's connection-failure report:\n%s", stderr)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("destination %s exists after a refused connection (stat err=%v)", dst, err)
	}
	if got := readLines(t, f.remoteLog); len(got) != 0 {
		t.Fatalf("remote ran %q despite the host-key refusal", got)
	}
	f.assertClientArgv(t, 1)
	f.assertAccepted(t, false)

	// Control: same daemon, same client key, correct pin.
	writeFile(t, f.knownHosts, e2eHostAlias+" "+f.hostPub+"\n", 0o600)
	if out, errOut, code := runBounded(t, e2eToolTimeout, filepath.Join(f.shimDir, "ssh"), []string{"-i", f.clientKey, "-p", strconv.Itoa(f.port), "--", "localhost", "true"}, "", nil); code != 0 {
		t.Fatalf("control probe with the real host key: exit %d\n%s%s", code, out, errOut)
	}
	if got, want := readLines(t, f.remoteLog), []string{"true"}; !equalLines(got, want) {
		t.Fatalf("remote commands after control = %q, want %q", got, want)
	}
	f.assertAccepted(t, true)
}

// ── `pull host:file -` over real ssh (R-C14 phase 1) ───────────────────────

// remoteRelayium puts bin on the remote PATH under the name `relayium`, in a
// directory of its own, so an old release can play the remote without its
// neighbours (and without ever touching where that binary came from).
func (f *sshFixture) remoteRelayium(t *testing.T, bin string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "remote-bin")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "relayium"), string(b), 0o700)
	writeFile(t, f.remotePath, dir+":/usr/bin:/bin\n", 0o600)
}

// pullCmd is the argv for `pull` through the fixture, and the environment
// that puts the ssh shim first.
func (f *sshFixture) pullCmd(bin string, args ...string) ([]string, []string) {
	env := append(os.Environ(), "PATH="+f.shimDir+":/usr/bin:/bin")
	return append([]string{bin, "pull", "-i", f.clientKey, "-p", strconv.Itoa(f.port)}, args...), env
}

// pull runs `pull ... -` in an empty working directory, which must still be
// empty afterwards: stdout mode has no local filesystem effect.
func (f *sshFixture) pullStdout(t *testing.T, bin string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	argv, env := f.pullCmd(bin, args...)
	cwd := t.TempDir()
	stdout, stderr, code = runBounded(t, e2ePushTimeout, argv[0], argv[1:], cwd, env)
	if entries, err := os.ReadDir(cwd); err != nil || len(entries) != 0 {
		t.Fatalf("pull to stdout wrote into its working directory: %v (err %v)", entries, err)
	}
	return stdout, stderr, code
}

// assertNoProcessNaming fails if any process whose command line contains
// marker (a path unique to this test) is still alive after a short bound. It
// is how "no ssh client and no remote helper outlived the pull" is checked:
// both carry the source path in their argv.
func assertNoProcessNaming(t *testing.T, marker string) {
	t.Helper()
	deadline := time.Now().Add(e2eCleanupTimeout)
	for {
		out, err := exec.Command("ps", "-A", "-o", "pid=,command=").Output()
		if err != nil {
			t.Fatalf("ps: %v", err)
		}
		var left []string
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, marker) && !strings.Contains(line, "ps -A") {
				left = append(left, strings.TrimSpace(line))
			}
		}
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("processes naming %s still running %v after the pull ended:\n%s", marker, e2eCleanupTimeout, strings.Join(left, "\n"))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func e2eRandom(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + i/251)
	}
	copy(b, e2ePayload)
	return b
}

func TestE2EPullToStdoutOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteRelayium(t, bin)
	srcDir := t.TempDir()
	body := e2eRandom(t, 5<<20+7)
	src := filepath.Join(srcDir, "data.bin")
	writeFile(t, src, string(body), 0o600)
	empty := filepath.Join(srcDir, "empty.bin")
	writeFile(t, empty, "", 0o600)

	stdout, stderr, code := f.pullStdout(t, bin, "localhost:"+src, "-")
	if code != 0 {
		t.Fatalf("pull exit %d\nstderr:\n%s", code, stderr)
	}
	if stdout != string(body) {
		t.Fatalf("stdout is %d bytes and differs from the %d-byte source", len(stdout), len(body))
	}
	if strings.Contains(stderr, "over-ssh") {
		t.Fatalf("payload leaked onto stderr:\n%s", stderr)
	}

	stdout, stderr, code = f.pullStdout(t, bin, "localhost:"+empty, "-")
	if code != 0 || stdout != "" {
		t.Fatalf("empty file: exit %d, %d stdout bytes\nstderr:\n%s", code, len(stdout), stderr)
	}
	want := []string{"relayium __send " + sshx.ShellQuote(src), "relayium __send " + sshx.ShellQuote(empty)}
	if got := readLines(t, f.remoteLog); !equalLines(got, want) {
		t.Fatalf("remote commands = %q, want %q", got, want)
	}
	f.assertClientArgv(t, 2)
	assertNoProcessNaming(t, srcDir)
}

// A directory — even one holding a single file — a symlink and a multi-file
// directory are refused with nothing on stdout, in bounded time, and nothing
// is left running.
func TestE2EPullToStdoutRefusesNonFilesOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteRelayium(t, bin)
	root := t.TempDir()
	one := filepath.Join(root, "one")
	many := filepath.Join(root, "many")
	for _, d := range []string{one, many} {
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(one, "big.bin"), string(e2eRandom(t, 16<<20)), 0o600)
	writeFile(t, filepath.Join(many, "a"), "a", 0o600)
	writeFile(t, filepath.Join(many, "b"), "b", 0o600)
	link := filepath.Join(root, "link.bin")
	if err := os.Symlink(filepath.Join(one, "big.bin"), link); err != nil {
		t.Fatal(err)
	}
	for _, src := range []string{one, many, link} {
		stdout, stderr, code := f.pullStdout(t, bin, "localhost:"+src, "-")
		if code != 1 || stdout != "" {
			t.Fatalf("%s: exit %d with %d stdout bytes\nstderr:\n%s", src, code, len(stdout), stderr)
		}
		if !strings.Contains(stderr, "exactly one regular file") {
			t.Fatalf("%s: stderr does not explain the refusal:\n%s", src, stderr)
		}
	}
	assertNoProcessNaming(t, root)
}

// A closed stdout pipe (`pull ... - | head -c 1`): the process must NOT die of
// SIGPIPE (a signal death skips the abort, so it proves nothing about the ssh
// child). It exits 1 after stopping the transfer, and neither the local ssh nor
// the remote `__send` outlives it.
func TestE2EPullToStdoutBrokenPipeOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteRelayium(t, bin)
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "big.bin")
	writeFile(t, src, string(e2eRandom(t, 64<<20)), 0o600)

	argv, env := f.pullCmd(bin, "localhost:"+src, "-")
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = sshx.ShellQuote(a)
	}
	// The pull's own exit status goes to stderr; head closes the pipe after
	// one byte.
	pipeline := "{ " + strings.Join(quoted, " ") + "; echo \"pull-rc=$?\" >&2; } | head -c 1 >/dev/null"
	_, stderr, _ := runBounded(t, e2ePushTimeout, "/bin/sh", []string{"-c", pipeline}, t.TempDir(), env)
	if !strings.Contains(stderr, "pull-rc=1\n") {
		t.Fatalf("pull did not exit 1 after its stdout closed (141 = killed by SIGPIPE before any cleanup):\n%s", stderr)
	}
	if !strings.Contains(stderr, "broken pipe") {
		t.Fatalf("stderr does not name the closed output:\n%s", stderr)
	}
	assertNoProcessNaming(t, srcDir)
}

// The host key check is ssh's and happens before any remote command: a
// mismatched key refuses with nothing on stdout and nothing run remotely.
func TestE2EPullToStdoutRefusesUnknownHostKey(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteRelayium(t, bin)
	impostor := keygen(t, lookTool(t, "ssh-keygen"), filepath.Join(t.TempDir(), "impostor_ed25519"))
	writeFile(t, f.knownHosts, e2eHostAlias+" "+impostor+"\n", 0o600)
	src := writePayload(t)

	stdout, stderr, code := f.pullStdout(t, bin, "localhost:"+src, "-")
	if code != 1 || stdout != "" {
		t.Fatalf("exit %d with %d stdout bytes\nstderr:\n%s", code, len(stdout), stderr)
	}
	if !strings.Contains(stderr, "Host key verification failed") {
		t.Fatalf("stderr does not show ssh's host-key refusal:\n%s", stderr)
	}
	if got := readLines(t, f.remoteLog); len(got) != 0 {
		t.Fatalf("remote ran %q despite the host-key refusal", got)
	}
	f.assertAccepted(t, false)
}

// Output from the remote side before the helper starts (a chatty rc file, a
// banner printed by a wrapper) is not payload: it fails framing and nothing
// reaches stdout.
func TestE2EPullToStdoutRejectsRemoteNoiseOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	dir := filepath.Join(t.TempDir(), "noisy-bin")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "relayium"), "#!/bin/sh\necho 'Welcome to the build host'\nexec "+sshx.ShellQuote(bin)+" \"$@\"\n", 0o700)
	writeFile(t, f.remotePath, dir+":/usr/bin:/bin\n", 0o600)
	src := writePayload(t)

	stdout, stderr, code := f.pullStdout(t, bin, "localhost:"+src, "-")
	if code != 1 || stdout != "" {
		t.Fatalf("exit %d with stdout %q\nstderr:\n%s", code, stdout, stderr)
	}
	assertNoProcessNaming(t, filepath.Dir(src))
}

// A real terminal as stdout is refused before ssh is started. `script` gives
// the CLI a pty, so this exercises the actual isatty call, not a stand-in.
func TestE2EPullToStdoutRefusesARealTerminal(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	f.remoteRelayium(t, bin)
	src := writePayload(t)
	argv, env := f.pullCmd(bin, "localhost:"+src, "-")
	scriptBin := lookTool(t, "script")
	var args []string
	switch runtime.GOOS {
	case "darwin", "freebsd":
		args = append([]string{"-q", "/dev/null"}, argv...)
	default: // util-linux
		quoted := make([]string, len(argv))
		for i, a := range argv {
			quoted[i] = sshx.ShellQuote(a)
		}
		args = []string{"-q", "-e", "-c", strings.Join(quoted, " "), "/dev/null"}
	}
	out, errOut, _ := runBounded(t, e2ePushTimeout, scriptBin, args, t.TempDir(), env)
	all := out + errOut
	if !strings.Contains(all, "refusing to write file bytes to a terminal") {
		t.Fatalf("no terminal refusal under a pty:\n%q", all)
	}
	if strings.Contains(all, "over-ssh") {
		t.Fatalf("payload reached the terminal:\n%q", all)
	}
	if calls := readLines(t, f.clientLog); len(calls) != 0 {
		t.Fatalf("ssh was started despite the terminal: %q", calls)
	}
}

// ── old remotes (opt-in: RELAYIUM_E2E_OLD_RELAYIUM=bin1:bin2...) ────────────
//
// Each named binary is a released relayium (or a private build of a release
// tag) placed on the remote PATH. They are supplied from outside the
// repository, so these tests skip without the variable even when
// RELAYIUM_E2E_SSH=1; once named, a missing binary is a failure.

func oldRelayiums(t *testing.T) []string {
	t.Helper()
	v := os.Getenv("RELAYIUM_E2E_OLD_RELAYIUM")
	if v == "" {
		t.Skip("set RELAYIUM_E2E_OLD_RELAYIUM to a colon-separated list of old relayium binaries")
	}
	bins := strings.Split(v, ":")
	for _, b := range bins {
		if st, err := os.Stat(b); err != nil || st.IsDir() || !filepath.IsAbs(b) {
			t.Fatalf("RELAYIUM_E2E_OLD_RELAYIUM entry %q is not an absolute path to a binary (%v)", b, err)
		}
	}
	return bins
}

func oldVersion(t *testing.T, bin string) string {
	t.Helper()
	out, _, _ := runBounded(t, e2eToolTimeout, bin, []string{"version"}, "", nil)
	return strings.TrimSpace(out)
}

// Pull to stdout needs no wire change: an old `__send` of one file is read as
// is. A directory against a sender that ignores the refusal (every release
// before v0.24.0 streams the whole body anyway) is ended by the abort, in
// bounded time, with nothing on stdout and nothing left running.
func TestE2EPullToStdoutOldPeerOverSSH(t *testing.T) {
	requireSSHE2E(t)
	olds := oldRelayiums(t)
	bin := buildCLI(t)
	for _, old := range olds {
		t.Run(oldVersion(t, old), func(t *testing.T) {
			f := newSSHFixture(t)
			f.remoteRelayium(t, old)
			root := t.TempDir()
			body := e2eRandom(t, 3<<20+1)
			src := filepath.Join(root, "data.bin")
			writeFile(t, src, string(body), 0o600)
			dir := filepath.Join(root, "dir")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(dir, "big.bin"), string(e2eRandom(t, 64<<20)), 0o600)

			stdout, stderr, code := f.pullStdout(t, bin, "localhost:"+src, "-")
			if code != 0 || stdout != string(body) {
				t.Fatalf("file: exit %d, %d stdout bytes (want %d)\nstderr:\n%s", code, len(stdout), len(body), stderr)
			}
			began := time.Now()
			stdout, stderr, code = f.pullStdout(t, bin, "localhost:"+dir, "-")
			if code != 1 || stdout != "" {
				t.Fatalf("dir: exit %d with %d stdout bytes\nstderr:\n%s", code, len(stdout), stderr)
			}
			if el := time.Since(began); el > 20*time.Second {
				t.Fatalf("dir refusal took %v", el)
			}
			assertNoProcessNaming(t, root)
		})
	}
}

// F1: an ordinary directory pull refused by THIS side (the file already exists
// locally) against an old sender, which ignores the refusal and streams the
// whole body. Before the abort, pull closed ssh's stdin and waited for a child
// blocked writing a body nobody read, and hung. The local file must be left
// exactly as it was, and nothing may stay running.
func TestE2EPullCollisionOldPeerOverSSH(t *testing.T) {
	requireSSHE2E(t)
	olds := oldRelayiums(t)
	bin := buildCLI(t)
	for _, old := range olds {
		t.Run(oldVersion(t, old), func(t *testing.T) {
			f := newSSHFixture(t)
			f.remoteRelayium(t, old)
			root := t.TempDir()
			src := filepath.Join(root, "big.bin")
			writeFile(t, src, string(e2eRandom(t, 64<<20)), 0o600)
			dst := t.TempDir()
			writeFile(t, filepath.Join(dst, "big.bin"), "ORIGINAL", 0o600)

			argv, env := f.pullCmd(bin, "localhost:"+src, dst)
			began := time.Now()
			stdout, stderr, code := runBounded(t, e2ePushTimeout, argv[0], argv[1:], "", env)
			if code != 1 {
				t.Fatalf("exit %d, want 1\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
			}
			if el := time.Since(began); el > 20*time.Second {
				t.Fatalf("refused pull took %v", el)
			}
			if !strings.Contains(stderr, "already exists") {
				t.Fatalf("stderr does not explain the refusal:\n%s", stderr)
			}
			assertOnlyFile(t, dst, "big.bin", []byte("ORIGINAL"))
			assertNoProcessNaming(t, root)
		})
	}
}

// e2eSilentPullBound is how long a pull against a silent remote may take:
// sshx's abortGrace + termGrace (2s + 2s; ssh normally exits on the SIGTERM at
// 2s) plus connection setup, doubled for a loaded runner. A pull that does not
// escalate is cut off at e2eSilentPullDeadline, and both stay far below
// e2eSilentHold, so the remote's own exit can never be what ends the pull.
const (
	e2eSilentPullBound    = 8 * time.Second
	e2eSilentPullDeadline = 30 * time.Second
	e2eSilentHold         = 120 * time.Second // backstop only; the test releases it
)

// pidAlive reports whether pid is still in the process table (a zombie
// counts: an unreaped child is not "gone").
func pidAlive(t *testing.T, pid int) bool {
	t.Helper()
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "pid=").Output()
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return false
		}
		t.Fatalf("ps -p %d: %v", pid, err)
	}
	return strings.TrimSpace(string(out)) != ""
}

func readPID(t *testing.T, path string) int {
	t.Helper()
	lines := readLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("%s holds %q, want exactly one pid", path, lines)
	}
	pid, err := strconv.Atoi(lines[0])
	if err != nil || pid <= 0 {
		t.Fatalf("%s holds %q, not a pid", path, lines[0])
	}
	return pid
}

// A remote that refuses to go away: it sends a stream pull must refuse, then
// ignores stdin EOF, SIGPIPE, SIGHUP, SIGINT and SIGTERM and sends nothing
// more. It is HELD alive by this test until an explicit release after the
// assertions (a 120s backstop covers a test killed before its cleanup ran), so
// only Abort's signal escalation can end the local ssh: closing ssh's pipes
// does not, ssh waits for a remote that will not exit. The test proves, at the
// moment pull returns and with the remote still demonstrably alive, that the
// exact ssh child pull started is gone, and that this took about abortGrace +
// termGrace, not the remote's lifetime.
//
// Killing the local ssh cannot make an arbitrary remote program exit (sshd
// sends no signal to a pty-less command), which is why the stand-in is released
// by the test rather than expected to die. The real `__send` is never silent
// like this — it either writes, which fails once the channel is gone, or reads,
// which sees EOF; its cleanup is proved by the broken-pipe and refusal tests.
func TestE2EPullToStdoutSilentRemoteOverSSH(t *testing.T) {
	requireSSHE2E(t)
	bin := buildCLI(t)
	f := newSSHFixture(t)
	dir := filepath.Join(t.TempDir(), "silent-bin")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var frames bytes.Buffer
	xfer.WriteJSON(&frames, xfer.MsgHello, xfer.Hello{Version: 1, Mode: "push"})
	xfer.WriteJSON(&frames, xfer.MsgManifest, xfer.Manifest{Files: []xfer.FileEntry{{Path: "d/x", Size: 1}}})
	framesFile := filepath.Join(dir, "frames")
	writeFile(t, framesFile, frames.String(), 0o600)
	remotePIDFile := filepath.Join(dir, "remote.pid")
	release := filepath.Join(dir, "release")
	// Signals are ignored before anything is sent, and the ignore is inherited
	// by cat and sleep. The loop's children carry no test path in their argv.
	writeFile(t, filepath.Join(dir, "relayium"), "#!/bin/sh\n"+
		"trap '' HUP PIPE TERM INT\n"+
		"echo $$ > "+sshx.ShellQuote(remotePIDFile)+"\n"+
		"cat "+sshx.ShellQuote(framesFile)+"\n"+
		"n=0\n"+
		"while [ ! -e "+sshx.ShellQuote(release)+" ] && [ $n -lt "+strconv.Itoa(int(e2eSilentHold/(200*time.Millisecond)))+" ]; do sleep 0.2; n=$((n+1)); done\n", 0o700)
	writeFile(t, f.remotePath, dir+":/usr/bin:/bin\n", 0o600)

	// A shim in front of the fixture's: $$ before exec IS the ssh client's pid.
	sshPIDFile := filepath.Join(dir, "ssh.pid")
	pidShim := filepath.Join(t.TempDir(), "pid-shim")
	if err := os.Mkdir(pidShim, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(pidShim, "ssh"), "#!/bin/sh\n"+
		"echo $$ >> "+sshx.ShellQuote(sshPIDFile)+"\n"+
		"exec "+sshx.ShellQuote(filepath.Join(f.shimDir, "ssh"))+" \"$@\"\n", 0o700)

	// Registered after the fixture, so it runs BEFORE sshd is stopped and the
	// fixture census runs. Only the exact owned stand-in is waited for; it is
	// killed by pid only if it ignores its release (a failure in itself).
	t.Cleanup(func() {
		writeFile(t, release, "", 0o600)
		if _, err := os.Stat(remotePIDFile); err != nil {
			return // the stand-in never started
		}
		pid := readPID(t, remotePIDFile)
		deadline := time.Now().Add(e2eCleanupTimeout)
		for pidAlive(t, pid) {
			if time.Now().After(deadline) {
				t.Errorf("released remote stand-in pid %d still running after %v; killing it", pid, e2eCleanupTimeout)
				if p, err := os.FindProcess(pid); err == nil {
					p.Kill()
				}
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	})

	marker := filepath.Join(t.TempDir(), "never-sent")
	argv, env := f.pullCmd(bin, "localhost:"+marker, "-")
	env = append(env, "PATH="+pidShim+":"+f.shimDir+":/usr/bin:/bin")
	cwd := t.TempDir()
	began := time.Now()
	// A pull that never escalates is killed at the deadline and fails there.
	stdout, stderr, code := runBounded(t, e2eSilentPullDeadline, argv[0], argv[1:], cwd, env)
	el := time.Since(began)

	// Everything below is observed BEFORE the remote is released.
	sshPID := readPID(t, sshPIDFile)
	sshAlive := pidAlive(t, sshPID)
	remotePID := readPID(t, remotePIDFile)
	remoteAlive := pidAlive(t, remotePID)
	t.Logf("pull returned after %v; ssh pid %d alive=%v; remote stand-in pid %d alive=%v",
		el.Round(time.Millisecond), sshPID, sshAlive, remotePID, remoteAlive)

	if code != 1 || stdout != "" || !strings.Contains(stderr, "exactly one regular file") {
		t.Fatalf("exit %d with %d stdout bytes\nstderr:\n%s", code, len(stdout), stderr)
	}
	if entries, err := os.ReadDir(cwd); err != nil || len(entries) != 0 {
		t.Fatalf("pull to stdout wrote into its working directory: %v (err %v)", entries, err)
	}
	if !remoteAlive {
		t.Fatalf("the held remote stand-in (pid %d) was gone when pull returned: the remote's exit, not Abort, may have ended ssh", remotePID)
	}
	if sshAlive {
		t.Fatalf("pull returned but its ssh child (pid %d) is still in the process table", sshPID)
	}
	if el > e2eSilentPullBound {
		t.Fatalf("pull took %v against a held silent remote (bound %v): Abort did not escalate in time", el, e2eSilentPullBound)
	}
	if got := readLines(t, f.clientLog); len(got) != 1 {
		t.Fatalf("ssh invocations = %q, want exactly one", got)
	}
}
