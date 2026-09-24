package main

// `push - relayium://host[:port]/path` against a real loopback TLS listener:
// the in-process serveLoop (the code `relayium serve` runs) or `relayium serve`
// as a real process, with the CLI as a real process, the real stdin pump and
// the real stream receiver. Runs on every platform; the cancel-by-signal and
// process-table checks are in daemon_stream_e2e_unix_test.go.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
	"github.com/relayium/relayium/internal/xfer"
)

// countingListener counts accepted TCP connections: "nothing dialed" is
// asserted as zero accepts.
type countingListener struct {
	net.Listener
	n *atomic.Int32
}

func (l countingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.n.Add(1)
	}
	return c, err
}

// streamLn is an in-process `relayium serve` on 127.0.0.1.
type streamLn struct {
	port      int
	recv      string // --dir
	pusherDir string // the pusher's --config-dir
	pusherFP  string
	serverFP  string
	accepts   atomic.Int32
	done      chan int // serveLoop's exit code
	stdout    *lockedBuffer
	stderr    *lockedBuffer
}

func startStreamListener(t *testing.T, authorize, once bool) *streamLn {
	t.Helper()
	l := &streamLn{recv: t.TempDir(), pusherDir: t.TempDir(), done: make(chan int, 1), stdout: &lockedBuffer{}, stderr: &lockedBuffer{}}
	serverDir := t.TempDir()
	pusher, err := secure.LoadOrCreateIdentity(l.pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	id, err := secure.LoadOrCreateIdentity(serverDir)
	if err != nil {
		t.Fatal(err)
	}
	l.pusherFP, l.serverFP = pusher.Fingerprint, id.Fingerprint
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l.port = ln.Addr().(*net.TCPAddr).Port
	allow := map[string]bool{}
	if authorize {
		allow[pusher.Fingerprint] = true
	}
	h := &serveHandler{id: id, allow: allow, dir: l.recv, cfgDir: serverDir, stdout: l.stdout, stderr: l.stderr}
	go func() { l.done <- serveLoop(countingListener{ln, &l.accepts}, h, once) }()
	t.Cleanup(func() { ln.Close() })
	return l
}

func (l *streamLn) hostport() string { return "127.0.0.1:" + strconv.Itoa(l.port) }
func (l *streamLn) target(rel string) string {
	return daemonScheme + l.hostport() + "/" + rel
}

// onceCode waits (bounded) for a --once listener's exit code.
func (l *streamLn) onceCode(t *testing.T) int {
	t.Helper()
	select {
	case c := <-l.done:
		return c
	case <-time.After(e2eCleanupTimeout):
		t.Fatalf("the --once listener did not return\nstderr:\n%s", l.stderr.String())
	}
	return -1
}

// pushArgv is the real CLI's `push - relayium://…` command line.
func (l *streamLn) pushArgv(bin, rel string) []string {
	return []string{bin, "push", "--config-dir", l.pusherDir, "-", l.target(rel)}
}

// daemonEnv is the test's environment without RELAYIUM_* test roles.
func daemonEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "RELAYIUM_") {
			env = append(env, kv)
		}
	}
	return env
}

// osPipe is a pipe whose ends are closed at cleanup.
func osPipe(t *testing.T) (r, w *os.File) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close(); w.Close() })
	return r, w
}

// stdinUnreadVariants runs run once with stdin a regular file (its shared
// offset must still be 0) and once a closed pipe holding 4096 bytes (all
// must still be readable): nothing read stdin.
func stdinUnreadVariants(t *testing.T, run func(t *testing.T, stdin *os.File)) {
	t.Run("file", func(t *testing.T) {
		in := stdinFile(t, e2eRandom(t, 1<<20))
		run(t, in)
		if off := fileOffset(t, in); off != 0 {
			t.Fatalf("stdin offset %d, want 0: something read stdin", off)
		}
	})
	t.Run("pipe", func(t *testing.T) {
		r, w := osPipe(t)
		want := e2eRandom(t, 4096)
		if _, err := w.Write(want); err != nil {
			t.Fatal(err)
		}
		w.Close()
		run(t, r)
		got, err := io.ReadAll(r)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("the pipe still held %d of %d bytes (err %v): something read stdin", len(got), len(want), err)
		}
	})
}

// stagingIn lists the stream staging directories in dir.
func stagingIn(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var s []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".relayium-recv-") {
			s = append(s, e.Name())
		}
	}
	return s
}

// waitUntil polls cond (bounded).
func waitUntil(t *testing.T, bound time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(bound)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s", bound, what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// cliProc is the CLI running in the background.
type cliProc struct {
	cmd    *exec.Cmd
	stdout bytes.Buffer
	stderr lockedBuffer
	done   chan struct{}
	err    error
}

func startCLIProc(t *testing.T, argv []string, stdin *os.File) *cliProc {
	t.Helper()
	p := &cliProc{cmd: exec.Command(argv[0], argv[1:]...), done: make(chan struct{})}
	p.cmd.Env = daemonEnv()
	p.cmd.Stdin = stdin
	p.cmd.Stdout, p.cmd.Stderr = &p.stdout, &p.stderr
	p.cmd.WaitDelay = e2eWaitDelay
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { p.err = p.cmd.Wait(); close(p.done) }()
	t.Cleanup(func() {
		select {
		case <-p.done:
		default:
			_ = p.cmd.Process.Kill()
			<-p.done
		}
	})
	return p
}

// wait returns the exit code and how long it took from now, bounded.
func (p *cliProc) wait(t *testing.T, bound time.Duration) (int, time.Duration) {
	t.Helper()
	began := time.Now()
	select {
	case <-p.done:
	case <-time.After(bound):
		_ = p.cmd.Process.Kill()
		<-p.done
		t.Fatalf("CLI still running after %v\nstderr:\n%s", bound, p.stderr.String())
	}
	var ee *exec.ExitError
	if errors.As(p.err, &ee) {
		return ee.ExitCode(), time.Since(began)
	}
	if p.err != nil {
		t.Fatal(p.err)
	}
	return 0, time.Since(began)
}

func mkdirAll(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}

// W-5 / D-1: the real CLI streams a file, an empty input and a pipe of
// unknown length into a real in-process listener over loopback TLS.
func TestE2EPushStdinDaemonLoopback(t *testing.T) {
	bin := buildCLIExe(t)

	t.Run("file", func(t *testing.T) {
		l := startStreamListener(t, true, true)
		mkdirAll(t, filepath.Join(l.recv, "sub"))
		body := e2eRandom(t, 5<<20+7)
		stdout, stderr, code := runWithStdin(t, e2ePushTimeout, l.pushArgv(bin, "sub/out.bin"), daemonEnv(), stdinFile(t, body))
		if code != 0 || stdout != "" {
			t.Fatalf("exit %d, stdout %d bytes\nstderr:\n%s", code, len(stdout), stderr)
		}
		if !strings.Contains(stderr, "learned "+l.hostport()) || !strings.Contains(stderr, "sub/out.bin ("+strconv.Itoa(len(body))+" bytes, sha256 "+sha256hex(body)+")") {
			t.Fatalf("stderr:\n%s", stderr)
		}
		if c := l.onceCode(t); c != 0 {
			t.Fatalf("--once listener exit %d\n%s", c, l.stderr.String())
		}
		got, err := os.ReadFile(filepath.Join(l.recv, "sub", "out.bin"))
		if err != nil || !bytes.Equal(got, body) {
			t.Fatalf("installed %d bytes (err %v), want %d", len(got), err, len(body))
		}
		assertDirNames(t, l.recv, "sub")
		assertDirNames(t, filepath.Join(l.recv, "sub"), "out.bin")
		if want := "received sub/out.bin from stdin, " + strconv.Itoa(len(body)) + " bytes from " + l.pusherFP; !strings.Contains(l.stdout.String(), want) {
			t.Fatalf("listener stdout %q, want %q", l.stdout.String(), want)
		}
	})

	t.Run("empty", func(t *testing.T) {
		l := startStreamListener(t, true, true)
		_, stderr, code := runWithStdin(t, e2ePushTimeout, l.pushArgv(bin, "empty.bin"), daemonEnv(), stdinFile(t, nil))
		if code != 0 {
			t.Fatalf("exit %d\n%s", code, stderr)
		}
		if c := l.onceCode(t); c != 0 {
			t.Fatalf("--once listener exit %d", c)
		}
		fi, err := os.Stat(filepath.Join(l.recv, "empty.bin"))
		if err != nil || fi.Size() != 0 || !fi.Mode().IsRegular() {
			t.Fatalf("empty.bin: %v %v", fi, err)
		}
		assertDirNames(t, l.recv, "empty.bin")
	})

	t.Run("pipe", func(t *testing.T) {
		l := startStreamListener(t, true, true)
		r, w := osPipe(t)
		p := startCLIProc(t, l.pushArgv(bin, "piped.bin"), r)
		r.Close()
		first, second := e2eRandom(t, 1<<20), e2eRandom(t, 2<<20)
		if _, err := w.Write(first); err != nil { // returns once the pump took it
			t.Fatal(err)
		}
		// Accepted and streaming, the destination is still absent: only the
		// private staging exists.
		waitUntil(t, e2eCleanupTimeout, "the staging directory", func() bool { return len(stagingIn(t, l.recv)) == 1 })
		if _, err := os.Lstat(filepath.Join(l.recv, "piped.bin")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("destination exists mid-stream: %v", err)
		}
		if _, err := w.Write(second); err != nil {
			t.Fatal(err)
		}
		w.Close()
		if code, _ := p.wait(t, e2ePushTimeout); code != 0 {
			t.Fatalf("exit %d\n%s", code, p.stderr.String())
		}
		if c := l.onceCode(t); c != 0 {
			t.Fatalf("--once listener exit %d", c)
		}
		got, err := os.ReadFile(filepath.Join(l.recv, "piped.bin"))
		if err != nil || !bytes.Equal(got, append(first, second...)) {
			t.Fatalf("installed %d bytes (err %v)", len(got), err)
		}
		assertDirNames(t, l.recv, "piped.bin")
	})
}

func sha256hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// D-C2..D-C4: every refusal the listener makes about the path happens before
// its StreamAccept, so stdin is unread, and nothing is created anywhere — not
// under --dir, not outside it. An in-root symbolic link to a directory is
// followed, as a v1 push follows it.
func TestE2EPushStdinDaemonRefusals(t *testing.T) {
	bin := buildCLIExe(t)
	l := startStreamListener(t, true, false)
	outside := t.TempDir()
	writeFile(t, filepath.Join(l.recv, "exists"), "keep", 0o644)
	writeFile(t, filepath.Join(l.recv, "afile"), "keep", 0o644)
	mkdirAll(t, filepath.Join(l.recv, "adir"))
	mkdirAll(t, filepath.Join(l.recv, "real"))

	type tc struct{ rel, want string }
	cases := []tc{
		{"exists", "exists already exists on the receiver"},
		{"adir", "adir is a directory on the receiver"},
		{"missing/x", "the directory missing does not exist under the listener's directory"},
		{"afile/x", "afile is not a directory under the listener's directory"},
	}
	symlinks := true
	for _, s := range []struct{ old, name string }{
		{"exists", "link"},
		{filepath.Join(l.recv, "nowhere"), "dangling"},
		{outside, "esc"},
		{filepath.Join("..", filepath.Base(outside)), "relesc"},
		{"real", "in"},
	} {
		if err := os.Symlink(s.old, filepath.Join(l.recv, s.name)); err != nil {
			t.Logf("symbolic links unavailable here (%v): their cases are not run", err)
			symlinks = false
			break
		}
	}
	if symlinks {
		cases = append(cases,
			tc{"link", "link already exists on the receiver"},
			tc{"dangling", "dangling already exists on the receiver"},
			tc{"esc/x", "the directory esc leads outside the listener's directory"},
			tc{"relesc/x", "the directory relesc leads outside the listener's directory"},
		)
	}
	before := dirTree(t, l.recv)
	for _, c := range cases {
		t.Run(strings.ReplaceAll(c.rel, "/", "_"), func(t *testing.T) {
			stdinUnreadVariants(t, func(t *testing.T, stdin *os.File) {
				stdout, stderr, code := runWithStdin(t, e2ePushTimeout, l.pushArgv(bin, c.rel), daemonEnv(), stdin)
				if code != 1 || stdout != "" || !strings.Contains(stderr, c.want) || !strings.Contains(stderr, "nothing was read from stdin and nothing was installed") {
					t.Fatalf("exit %d\nstderr:\n%s\nwant %q", code, stderr, c.want)
				}
			})
		})
	}
	if after := dirTree(t, l.recv); after != before {
		t.Fatalf("--dir changed:\nbefore %s\nafter  %s", before, after)
	}
	assertDirNames(t, outside)

	if symlinks {
		t.Run("in-root symlink dir", func(t *testing.T) {
			body := e2eRandom(t, 70000)
			_, stderr, code := runWithStdin(t, e2ePushTimeout, l.pushArgv(bin, "in/ok.bin"), daemonEnv(), stdinFile(t, body))
			if code != 0 {
				t.Fatalf("exit %d\n%s", code, stderr)
			}
			got, err := os.ReadFile(filepath.Join(l.recv, "real", "ok.bin"))
			if err != nil || !bytes.Equal(got, body) {
				t.Fatalf("real/ok.bin: %d bytes, %v", len(got), err)
			}
		})
	}
}

// dirTree is a listing of every name under dir, for before/after equality.
func dirTree(t *testing.T, dir string) string {
	t.Helper()
	var names []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		names = append(names, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(names, " ")
}

// badStreamPaths are refused by ValidateStreamPath, on both sides.
var badStreamPaths = []string{
	"a/../b", "../x", "./a", "a/.", "a//b", "a/", "/abs",
	"a\\b", "c:x", "a/b:c", ".relayium-recv-0011223344556677/x", "a\x01b", "a\x7fb",
	strings.Repeat("d/", 64) + "x", strings.Repeat("n", 256),
	"a/" + strings.Repeat("p", 4095),
}

// D-C1 (client side) and D-V1: a path the listener would refuse is refused
// before any dial (exit 2, no connection accepted), and a relayium:// target
// with a path keeps today's refusal for anything but "push -".
func TestPushStdinDaemonPathRefusedBeforeDial(t *testing.T) {
	l := startStreamListener(t, true, false)
	for _, p := range append([]string{""}, badStreamPaths...) {
		installStdinSeams(t, false, true, nil, nil, nil)
		stdout, stderr, code := runCLI("push", "--config-dir", l.pusherDir, "-", l.target(p))
		if code != 2 || stdout != "" {
			t.Errorf("%q: exit %d stdout %q\n%s", p, code, stdout, stderr)
		}
	}
	for _, target := range []string{daemonScheme + l.hostport(), daemonScheme + "/x"} {
		installStdinSeams(t, false, true, nil, nil, nil)
		if _, stderr, code := runCLI("push", "--config-dir", l.pusherDir, "-", target); code != 2 {
			t.Errorf("%q: exit %d\n%s", target, code, stderr)
		}
	}
	src := filepath.Join(t.TempDir(), "f")
	writeFile(t, src, "x", 0o644)
	_, stderr, code := runCLI("push", "--config-dir", l.pusherDir, src, l.target("x"))
	if code != 1 || !strings.Contains(stderr, "daemon target must be host[:port] with no path") {
		t.Errorf("file push to a path: exit %d\n%s", code, stderr)
	}
	if n := l.accepts.Load(); n != 0 {
		t.Fatalf("%d connections reached the listener, want 0", n)
	}
	assertDirNames(t, l.recv)
}

// D-C1 (listener side): a sender that skips the client check still gets
// invalid_destination for every bad path, over real TLS, before StreamAccept.
func TestPushStdinDaemonListenerRefusesBadPaths(t *testing.T) {
	l := startStreamListener(t, true, false)
	for _, p := range append([]string{""}, badStreamPaths...) {
		tconn, err := dialDaemon(daemonScheme+l.hostport(), l.pusherDir, io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		_, err = xfer.SendStream(context.Background(), tlsStreamTransport{tconn}, p, func() (xfer.StreamSource, error) {
			t.Errorf("%q: stdin was started", p)
			return nil, errors.New("no source")
		}, xfer.StreamSendOpts{})
		tconn.Close()
		var re *xfer.RemoteError
		if !errors.As(err, &re) || re.Code != xfer.ErrCodeInvalidDestination {
			t.Errorf("%q: %v, want invalid_destination", p, err)
		}
	}
	assertDirNames(t, l.recv)
}

// D-A1: a listener that has not authorized this host closes without a word:
// exit 1 with the hint, stdin unread, nothing created.
func TestE2EPushStdinDaemonUnauthorized(t *testing.T) {
	bin := buildCLIExe(t)
	l := startStreamListener(t, false, false)
	stdinUnreadVariants(t, func(t *testing.T, stdin *os.File) {
		stdout, stderr, code := runWithStdin(t, e2ePushTimeout, l.pushArgv(bin, "x"), daemonEnv(), stdin)
		if code != 1 || stdout != "" || !strings.Contains(stderr, "did not accept the stream") ||
			!strings.Contains(stderr, "relayium authorize") || !strings.Contains(stderr, "nothing was read from stdin") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
	})
	if !strings.Contains(l.stderr.String(), "rejected unauthorized peer "+l.pusherFP) {
		t.Fatalf("listener stderr:\n%s", l.stderr.String())
	}
	assertDirNames(t, l.recv)
}

// D-P1: a pinned fingerprint that no longer matches is refused before any
// frame; stdin unread, the pin is not replaced, nothing created.
func TestE2EPushStdinDaemonPinMismatch(t *testing.T) {
	bin := buildCLIExe(t)
	l := startStreamListener(t, true, false)
	wrong := strings.Repeat("0", 64)
	if err := trust.AddHost(l.pusherDir, l.hostport(), wrong); err != nil {
		t.Fatal(err)
	}
	stdinUnreadVariants(t, func(t *testing.T, stdin *os.File) {
		stdout, stderr, code := runWithStdin(t, e2ePushTimeout, l.pushArgv(bin, "x"), daemonEnv(), stdin)
		if code != 1 || stdout != "" || !strings.Contains(stderr, "fingerprint mismatch") || !strings.Contains(stderr, "Nothing was read from stdin") {
			t.Fatalf("exit %d\nstderr:\n%s", code, stderr)
		}
	})
	if pin, ok, err := trust.LookupHost(l.pusherDir, l.hostport()); err != nil || !ok || pin != wrong {
		t.Fatalf("pin now %q %v %v, want the old one kept", pin, ok, err)
	}
	assertDirNames(t, l.recv)
}

// fixtureListener is a pinned-TLS listener that authorizes pusherFP and then
// hands the connection to handle — a stand-in for a listener this package no
// longer contains (an older release) or for a misbehaving one.
func fixtureListener(t *testing.T, pusherFP string, handle func(c *tls.Conn)) int {
	t.Helper()
	id, err := secure.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	t.Cleanup(func() { ln.Close(); wg.Wait() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(e2ePushTimeout))
				tconn, fp, err := secure.ServerAny(conn, id)
				if err != nil || fp != pusherFP {
					return
				}
				defer tconn.Close()
				handle(tconn)
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// D-O1, protocol-level old-peer fixtures (not old binaries; those are
// TestE2EPushStdinDaemonOldReleases, opt-in):
//
//   - "v1-serve": the listener body every release before this one ran —
//     xfer.Receive over the idle wrapper, which is unchanged — refuses the
//     stream manifest's size -1 and closes without a word.
//   - "resume-answer": a receiver that answers the Hello with a v1 resume
//     state (what releases up to v0.12 did).
//
// Either way: exit 1 with the right wording, stdin unread, nothing created.
func TestE2EPushStdinDaemonOldPeerFixtures(t *testing.T) {
	bin := buildCLIExe(t)
	pusherDir := t.TempDir()
	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, fx := range []struct {
		name   string
		handle func(dir string) func(c *tls.Conn)
		want   []string
	}{
		{"v1-serve", func(dir string) func(c *tls.Conn) {
			return func(c *tls.Conn) {
				_, _ = xfer.Receive(&idleConn{Conn: c, idle: transferIdleTimeout}, dir, xfer.RecvOpts{AllowSync: true})
			}
		}, []string{"did not accept the stream", "relayium update", "nothing was read from stdin"}},
		{"resume-answer", func(string) func(c *tls.Conn) {
			return func(c *tls.Conn) {
				var h xfer.Hello
				var m xfer.Manifest
				if _, err := xfer.ReadJSON(c, &h); err != nil {
					return
				}
				if _, err := xfer.ReadJSON(c, &m); err != nil {
					return
				}
				// A slow answer: an eagerly started stdin reader would have
				// read by now, so "stdin unread" below is observable.
				time.Sleep(300 * time.Millisecond)
				_ = xfer.WriteJSON(c, xfer.MsgResume, xfer.ResumeState{})
				_, _, _ = xfer.ReadFrame(c) // a v0.12 receiver waits for FileStart
			}
		}, []string{"predates \"push -\"", "relayium update", "Nothing was read from stdin"}},
	} {
		t.Run(fx.name, func(t *testing.T) {
			dir := t.TempDir()
			port := fixtureListener(t, pusher.Fingerprint, fx.handle(dir))
			stdinUnreadVariants(t, func(t *testing.T, stdin *os.File) {
				argv := []string{bin, "push", "--config-dir", pusherDir, "-", daemonScheme + "127.0.0.1:" + strconv.Itoa(port) + "/x"}
				stdout, stderr, code := runWithStdin(t, e2ePushTimeout, argv, daemonEnv(), stdin)
				if code != 1 || stdout != "" {
					t.Fatalf("exit %d\n%s", code, stderr)
				}
				for _, w := range fx.want {
					if !strings.Contains(stderr, w) {
						t.Fatalf("stderr lacks %q:\n%s", w, stderr)
					}
				}
			})
			assertDirNames(t, dir)
		})
	}
}

// D-O1 against real old releases, built privately from their tags
// (RELAYIUM_E2E_OLD_RELAYIUM, as for the SSH old-peer tests): each one's
// `serve`, with this pusher authorized, refuses the stream before stdin is
// read and creates nothing.
func TestE2EPushStdinDaemonOldReleases(t *testing.T) {
	olds := oldRelayiums(t)
	bin := buildCLIExe(t)
	for _, old := range olds {
		t.Run(oldVersion(t, old), func(t *testing.T) {
			pusherDir, cfg, dir := t.TempDir(), t.TempDir(), t.TempDir()
			pusher, err := secure.LoadOrCreateIdentity(pusherDir)
			if err != nil {
				t.Fatal(err)
			}
			if out, errOut, code := runBounded(t, e2eToolTimeout, old, []string{"authorize", "--config-dir", cfg, pusher.Fingerprint}, "", nil); code != 0 {
				t.Fatalf("authorize: %d %s %s", code, out, errOut)
			}
			port := startServeProc(t, old, "--dir", dir, "--config-dir", cfg)
			stdinUnreadVariants(t, func(t *testing.T, stdin *os.File) {
				argv := []string{bin, "push", "--config-dir", pusherDir, "-", daemonScheme + "127.0.0.1:" + strconv.Itoa(port) + "/x"}
				stdout, stderr, code := runWithStdin(t, e2ePushTimeout, argv, daemonEnv(), stdin)
				t.Logf("stderr:\n%s", stderr)
				if code != 1 || stdout != "" || !strings.Contains(stderr, "relayium update") ||
					!strings.Contains(strings.ToLower(stderr), "nothing was read from stdin") {
					t.Fatalf("exit %d\n%s", code, stderr)
				}
			})
			assertDirNames(t, dir)
		})
	}
}

// startServeProc runs `<bin> serve --bind 127.0.0.1 --port P args…` until the
// test ends and returns P once it is listening. stdin is not a terminal, so
// an unknown peer is rejected rather than prompted for.
func startServeProc(t *testing.T, bin string, args ...string) int {
	t.Helper()
	p, _ := startServeProcOnce(t, bin, args...)
	return p
}

// startServeProcOnce is startServeProc that also returns a function waiting
// (bounded) for the process's exit code and its stdout, for --once.
func startServeProcOnce(t *testing.T, bin string, args ...string) (int, func() (int, string)) {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	argv := []string{"serve", "--port", strconv.Itoa(port)}
	// Releases before --bind listen on every interface; only the port is ours.
	if o, e, _ := runBounded(t, e2eToolTimeout, bin, []string{"serve", "-h"}, "", nil); strings.Contains(o+e, "bind") {
		argv = append(argv, "--bind", "127.0.0.1")
	}
	argv = append(argv, args...)
	cmd := exec.Command(bin, argv...)
	cmd.Env = daemonEnv()
	var out bytes.Buffer
	errBuf := &lockedBuffer{}
	cmd.Stdout, cmd.Stderr = &out, errBuf
	cmd.WaitDelay = e2eWaitDelay
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var werr error
	go func() { werr = cmd.Wait(); close(done) }()
	t.Cleanup(func() {
		select {
		case <-done:
		default:
			_ = cmd.Process.Kill()
			<-done
		}
	})
	waitUntil(t, e2eToolTimeout, "serve to listen", func() bool {
		select {
		case <-done:
			t.Fatalf("serve exited early: %v\n%s", werr, errBuf.String())
		default:
		}
		return strings.Contains(errBuf.String(), "listening on")
	})
	return port, func() (int, string) {
		select {
		case <-done:
		case <-time.After(e2eCleanupTimeout):
			t.Fatalf("serve --once still running\n%s", errBuf.String())
		}
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			return ee.ExitCode(), out.String()
		}
		return 0, out.String()
	}
}

// --once as a real process: exit 0 after one installed stream, exit 1 after a
// refused one (destination exists) and after an unauthorized peer.
func TestE2EServeOnceStream(t *testing.T) {
	bin := buildCLIExe(t)
	pusherDir, cfg, dir := t.TempDir(), t.TempDir(), t.TempDir()
	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, errOut, code := runBounded(t, e2eToolTimeout, bin, []string{"authorize", "--config-dir", cfg, pusher.Fingerprint}, "", nil); code != 0 {
		t.Fatalf("authorize: %s", errOut)
	}
	push := func(port int, cfgDir string, body []byte) (string, int) {
		argv := []string{bin, "push", "--config-dir", cfgDir, "-", daemonScheme + "127.0.0.1:" + strconv.Itoa(port) + "/once.bin"}
		_, stderr, code := runWithStdin(t, e2ePushTimeout, argv, daemonEnv(), stdinFile(t, body))
		return stderr, code
	}
	body := e2eRandom(t, 300000)

	port, wait := startServeProcOnce(t, bin, "--dir", dir, "--config-dir", cfg, "--once")
	if stderr, code := push(port, pusherDir, body); code != 0 {
		t.Fatalf("push exit %d\n%s", code, stderr)
	}
	if code, out := wait(); code != 0 || !strings.Contains(out, "received once.bin from stdin, 300000 bytes") {
		t.Fatalf("serve --once exit %d, stdout %q", code, out)
	}

	port, wait = startServeProcOnce(t, bin, "--dir", dir, "--config-dir", cfg, "--once")
	if stderr, code := push(port, pusherDir, e2eRandom(t, 10)); code != 1 || !strings.Contains(stderr, "already exists") {
		t.Fatalf("push onto an existing file: exit %d\n%s", code, stderr)
	}
	if code, _ := wait(); code != 1 {
		t.Fatalf("serve --once after a refused stream: exit %d, want 1", code)
	}

	port, wait = startServeProcOnce(t, bin, "--dir", dir, "--config-dir", cfg, "--once")
	if stderr, code := push(port, t.TempDir(), body); code != 1 {
		t.Fatalf("unauthorized push: exit %d\n%s", code, stderr)
	}
	if code, _ := wait(); code != 1 {
		t.Fatalf("serve --once after an unauthorized peer: exit %d, want 1", code)
	}
	got, err := os.ReadFile(filepath.Join(dir, "once.bin"))
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("once.bin changed: %d bytes, %v", len(got), err)
	}
	assertDirNames(t, dir, "once.bin")
}

// Stream cut, both directions:
//
//   - the sender dies mid-stream (killed): the listener sees the connection
//     end, removes its staging, installs nothing, and --once reports 1;
//   - the listener drops the connection mid-stream: the CLI exits 1 saying
//     nothing was installed, in bounded time.
func TestE2EPushStdinDaemonStreamCut(t *testing.T) {
	bin := buildCLIExe(t)

	t.Run("sender killed", func(t *testing.T) {
		l := startStreamListener(t, true, true)
		r, w := osPipe(t)
		p := startCLIProc(t, l.pushArgv(bin, "cut.bin"), r)
		r.Close()
		if _, err := w.Write(e2eRandom(t, 256<<10)); err != nil {
			t.Fatal(err)
		}
		waitUntil(t, e2eCleanupTimeout, "the staging directory", func() bool { return len(stagingIn(t, l.recv)) == 1 })
		_ = p.cmd.Process.Kill()
		p.wait(t, e2eCleanupTimeout)
		if c := l.onceCode(t); c != 1 {
			t.Fatalf("--once listener exit %d, want 1", c)
		}
		assertDirNames(t, l.recv) // staging removed, nothing installed
		if !strings.Contains(l.stderr.String(), "stream receive of cut.bin") || !strings.Contains(l.stderr.String(), "nothing was installed") {
			t.Fatalf("listener stderr:\n%s", l.stderr.String())
		}
		w.Close() // lets a pump helper that outlived its parent see EPIPE
	})

	t.Run("listener drops", func(t *testing.T) {
		pusherDir := t.TempDir()
		pusher, err := secure.LoadOrCreateIdentity(pusherDir)
		if err != nil {
			t.Fatal(err)
		}
		got := make(chan int64, 1)
		port := fixtureListener(t, pusher.Fingerprint, func(c *tls.Conn) {
			var h xfer.Hello
			var m xfer.Manifest
			if _, err := xfer.ReadJSON(c, &h); err != nil {
				return
			}
			if _, err := xfer.ReadJSON(c, &m); err != nil {
				return
			}
			_ = xfer.WriteJSON(c, xfer.MsgStreamAccept, xfer.StreamAccept{ChunkMax: xfer.StreamChunkMax})
			n, _ := io.CopyN(io.Discard, c, 200<<10)
			got <- n
			_ = c.NetConn().Close() // drop, no close_notify
		})
		r, w := osPipe(t)
		argv := []string{bin, "push", "--config-dir", pusherDir, "-", daemonScheme + "127.0.0.1:" + strconv.Itoa(port) + "/x"}
		p := startCLIProc(t, argv, r)
		r.Close()
		go func() { _, _ = w.Write(e2eRandom(t, 1<<20)) }() // then silent, never EOF: End is never sent
		code, took := p.wait(t, e2ePushTimeout)
		if n := <-got; n != 200<<10 {
			t.Fatalf("listener read %d bytes", n)
		}
		stderr := p.stderr.String()
		if code != 1 || !strings.Contains(stderr, "nothing was installed on the receiver") {
			t.Fatalf("exit %d after %v\n%s", code, took, stderr)
		}
		if took > 15*time.Second {
			t.Fatalf("took %v", took)
		}
	})
}

// Cancel, in-process on every platform: a signal while the stream runs and
// stdin is silent ends the push with 128+N, aborts the connection, and the
// listener removes its staging and reports the failed --once connection.
func TestPushStdinDaemonCancelInProcess(t *testing.T) {
	l := startStreamListener(t, true, true)
	src := newBlockedSource()
	installStdinSeams(t, false, true, nil, nil, func() (xfer.StreamSource, error) { return src, nil })
	pushStdinNotify = func(c chan<- os.Signal) func() {
		go func() {
			<-src.reading
			// Accepted and streaming: the listener's staging exists (polled
			// without failing from this goroutine; the assertions below
			// decide).
			for i := 0; i < 500; i++ {
				if m, _ := filepath.Glob(filepath.Join(l.recv, ".relayium-recv-*")); len(m) == 1 {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			c <- os.Interrupt
		}()
		return func() {}
	}
	began := time.Now()
	stdout, stderr, code := runCLI("push", "--config-dir", l.pusherDir, "-", l.target("x"))
	if code != 130 || stdout != "" || !strings.Contains(stderr, "interrupted") || !strings.Contains(stderr, "nothing was installed") {
		t.Fatalf("exit %d\n%s", code, stderr)
	}
	if el := time.Since(began); el > 12*time.Second {
		t.Fatalf("took %v", el)
	}
	select {
	case <-src.stopped:
	default:
		t.Fatal("source not stopped")
	}
	if c := l.onceCode(t); c != 1 {
		t.Fatalf("--once listener exit %d, want 1", c)
	}
	assertDirNames(t, l.recv)
}

// timedSource is silent for delay, then yields body, then EOF.
type timedSource struct {
	delay   time.Duration
	body    []byte
	started sync.Once
	gate    chan struct{}
	stopped chan struct{}
	stop    sync.Once
	r       *bytes.Reader
}

func newTimedSource(delay time.Duration, body []byte) *timedSource {
	return &timedSource{delay: delay, body: body, gate: make(chan struct{}), stopped: make(chan struct{}), r: bytes.NewReader(body)}
}

func (s *timedSource) Read(p []byte) (int, error) {
	s.started.Do(func() {
		go func() {
			if s.delay > 0 {
				time.Sleep(s.delay)
			}
			close(s.gate)
		}()
	})
	select {
	case <-s.gate:
	case <-s.stopped:
		return 0, errors.New("stopped")
	}
	return s.r.Read(p)
}

func (s *timedSource) Stop() error { s.stop.Do(func() { close(s.stopped) }); return nil }

// D-K1: with the listener's idle bound at 1 s and keepalives every 200 ms, a
// stdin that is silent for 3 s still succeeds.
func TestPushStdinDaemonKeepaliveHoldsIdleListener(t *testing.T) {
	defer func(d time.Duration) { transferIdleTimeout = d }(transferIdleTimeout)
	transferIdleTimeout = time.Second
	defer func(d time.Duration) { pushStdinDaemonKeepalive = d }(pushStdinDaemonKeepalive)
	pushStdinDaemonKeepalive = 200 * time.Millisecond

	l := startStreamListener(t, true, true)
	body := e2eRandom(t, 4096)
	installStdinSeams(t, false, true, nil, nil, func() (xfer.StreamSource, error) { return newTimedSource(3*time.Second, body), nil })
	_, stderr, code := runCLI("push", "--config-dir", l.pusherDir, "-", l.target("slow.bin"))
	if code != 0 {
		t.Fatalf("exit %d\n%s\nlistener:\n%s", code, stderr, l.stderr.String())
	}
	if c := l.onceCode(t); c != 0 {
		t.Fatalf("--once listener exit %d", c)
	}
	got, err := os.ReadFile(filepath.Join(l.recv, "slow.bin"))
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("slow.bin: %d bytes, %v", len(got), err)
	}
}

// Exactly-once install: two pushes of different bytes to the same new path,
// both accepted before either ends. Exactly one installs; the other is told
// the file appeared during its transfer; the file holds the winner's bytes
// and nothing else is left.
func TestPushStdinDaemonExactlyOnceInstall(t *testing.T) {
	l := startStreamListener(t, true, false)
	if err := trust.AddHost(l.pusherDir, l.hostport(), l.serverFP); err != nil { // no concurrent first-contact writes
		t.Fatal(err)
	}
	bodies := [][]byte{e2eRandom(t, 3<<20+1), e2eRandom(t, 2<<20+3)}
	gate := make(chan struct{})
	srcs := make(chan xfer.StreamSource, 2)
	var started sync.WaitGroup
	started.Add(2)
	for _, b := range bodies {
		srcs <- &gatedSource{gate: gate, r: bytes.NewReader(b), started: &started}
	}
	installStdinSeams(t, false, true, nil, nil, func() (xfer.StreamSource, error) { return <-srcs, nil })

	type res struct {
		code   int
		stderr string
	}
	results := make(chan res, 2)
	for range 2 {
		go func() {
			var o, e bytes.Buffer
			c := Run([]string{"push", "--config-dir", l.pusherDir, "-", l.target("same.bin")}, &o, &e)
			results <- res{c, e.String()}
		}()
	}
	started.Wait() // both accepted, both pumps reading
	close(gate)
	var ok, lost int
	for range 2 {
		r := <-results
		switch {
		case r.code == 0:
			ok++
		case r.code == 1 && strings.Contains(r.stderr, "was created on the receiver during the transfer"):
			lost++
		default:
			t.Errorf("exit %d\n%s", r.code, r.stderr)
		}
	}
	if ok != 1 || lost != 1 {
		t.Fatalf("%d installed, %d refused; want exactly one of each", ok, lost)
	}
	got, err := os.ReadFile(filepath.Join(l.recv, "same.bin"))
	if err != nil || !(bytes.Equal(got, bodies[0]) || bytes.Equal(got, bodies[1])) {
		t.Fatalf("same.bin holds %d bytes matching neither push (%v)", len(got), err)
	}
	waitDirNames(t, l.recv, "same.bin")
}

// gatedSource blocks its first Read until gate closes.
type gatedSource struct {
	gate    chan struct{}
	r       *bytes.Reader
	once    sync.Once
	started *sync.WaitGroup
}

func (g *gatedSource) Read(p []byte) (int, error) {
	g.once.Do(g.started.Done)
	<-g.gate
	return g.r.Read(p)
}

func (g *gatedSource) Stop() error { return nil }

// The pump is never started for any refusal before StreamAccept — an
// unauthorized listener, a changed pin, an existing destination, a listener
// that answers as an old receiver — observed at the start seam itself
// (deterministic, whatever the refusal's timing).
func TestPushStdinDaemonRefusalsNeverStartThePump(t *testing.T) {
	check := func(t *testing.T, pusherDir, target, want string) {
		t.Helper()
		rec := installStdinSeams(t, false, true, nil, nil, nil) // start == nil: a start fails the test
		stdout, stderr, code := runCLI("push", "--config-dir", pusherDir, "-", target)
		if code != 1 || stdout != "" || !strings.Contains(stderr, want) {
			t.Fatalf("exit %d\n%s\nwant %q", code, stderr, want)
		}
		if n := rec.starts.Load(); n != 0 {
			t.Fatalf("stdin pump started %d times", n)
		}
	}
	t.Run("unauthorized", func(t *testing.T) {
		l := startStreamListener(t, false, false)
		check(t, l.pusherDir, l.target("x"), "did not accept the stream")
		assertDirNames(t, l.recv)
	})
	t.Run("pin mismatch", func(t *testing.T) {
		l := startStreamListener(t, true, false)
		if err := trust.AddHost(l.pusherDir, l.hostport(), strings.Repeat("0", 64)); err != nil {
			t.Fatal(err)
		}
		check(t, l.pusherDir, l.target("x"), "fingerprint mismatch")
		if n := l.accepts.Load(); n != 1 {
			t.Fatalf("accepts %d", n)
		}
	})
	t.Run("destination exists", func(t *testing.T) {
		l := startStreamListener(t, true, false)
		writeFile(t, filepath.Join(l.recv, "x"), "keep", 0o644)
		check(t, l.pusherDir, l.target("x"), "x already exists on the receiver")
	})
	t.Run("old receiver", func(t *testing.T) {
		pusherDir := t.TempDir()
		pusher, err := secure.LoadOrCreateIdentity(pusherDir)
		if err != nil {
			t.Fatal(err)
		}
		port := fixtureListener(t, pusher.Fingerprint, func(c *tls.Conn) {
			var h xfer.Hello
			var m xfer.Manifest
			if _, err := xfer.ReadJSON(c, &h); err != nil {
				return
			}
			if _, err := xfer.ReadJSON(c, &m); err != nil {
				return
			}
			_ = xfer.WriteJSON(c, xfer.MsgResume, xfer.ResumeState{})
		})
		check(t, pusherDir, daemonScheme+"127.0.0.1:"+strconv.Itoa(port)+"/x", "predates \"push -\"")
	})
}
