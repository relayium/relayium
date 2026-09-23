package main

// A10: `relayium pair`, and `send`/`receive`/`text` routed through discovery.
//
// The end-to-end tests run the REAL CLI as separate processes (this test
// binary in the RELAYIUM_TEST_ROLE=cli role, see TestMain) against the real
// signalling hub with pairing hints (startLinkDevHub), so stdin, stdout,
// stderr, exit codes and ctrl-C are the ones a script or a person meets. The
// older CLI is the binary built from 723481c78 (ldOldCLI).

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/linksession"
	"github.com/relayium/relayium/internal/linkwire"
	"github.com/relayium/relayium/internal/xfer"
)

func init() {
	// Seams for the process-level tests: a pipe standing in for a terminal.
	if os.Getenv("RELAYIUM_TEST_FORCE_TTY") == "1" {
		pairStdinIsTTY = func() bool { return true }
		textStdinIsTTY = func() bool { return true }
	}
	if os.Getenv("RELAYIUM_TEST_FORCE_OUT_TTY") == "1" {
		stdoutIsTTY = func(io.Writer) bool { return true }
	}
}

// ---------------------------------------------------------------- process harness

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// pairProc is one real CLI process.
type pairProc struct {
	name  string
	cmd   *exec.Cmd
	in    io.WriteCloser
	out   lockedBuf
	err   lockedBuf
	done  chan struct{}
	code  int
	start time.Time
	end   time.Time
}

func startCLI(t *testing.T, name string, env []string, stdin io.Reader, args ...string) *pairProc {
	t.Helper()
	p := &pairProc{name: name, done: make(chan struct{})}
	p.cmd = exec.Command(os.Args[0], args...)
	p.cmd.Env = append(os.Environ(), "RELAYIUM_TEST_ROLE=cli", "HOME="+t.TempDir(), "XDG_CONFIG_HOME="+t.TempDir())
	p.cmd.Env = append(p.cmd.Env, env...)
	p.cmd.Stdout, p.cmd.Stderr = &p.out, &p.err
	if stdin != nil {
		p.cmd.Stdin = stdin
	} else {
		w, err := p.cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		p.in = w
	}
	p.start = time.Now()
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = p.cmd.Wait()
		p.code = p.cmd.ProcessState.ExitCode()
		p.end = time.Now()
		close(p.done)
	}()
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

// startOld runs the older CLI (723481c78) as a process.
func startOld(t *testing.T, bin, name string, stdin io.Reader, args ...string) *pairProc {
	t.Helper()
	p := &pairProc{name: name, done: make(chan struct{})}
	p.cmd = exec.Command(bin, args...)
	p.cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), "XDG_CONFIG_HOME="+t.TempDir())
	p.cmd.Stdout, p.cmd.Stderr, p.cmd.Stdin = &p.out, &p.err, stdin
	p.start = time.Now()
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = p.cmd.Wait()
		p.code = p.cmd.ProcessState.ExitCode()
		p.end = time.Now()
		close(p.done)
	}()
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

func (p *pairProc) line(t *testing.T, s string) {
	t.Helper()
	if _, err := io.WriteString(p.in, s+"\n"); err != nil {
		t.Fatalf("%s: write %q: %v", p.name, s, err)
	}
}

func (p *pairProc) String() string {
	return fmt.Sprintf("[%s] exit %d\n--- stderr\n%s--- stdout\n%s", p.name, p.code, p.err.String(), p.out.String())
}

// waitFor polls until cond holds, or fails the test with both ends' output.
func pairWaitFor(t *testing.T, d time.Duration, what string, cond func() bool, procs ...*pairProc) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			var b strings.Builder
			for _, p := range procs {
				b.WriteString(p.String())
				b.WriteString("\n")
			}
			t.Fatalf("timed out waiting for %s\n%s", what, b.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (p *pairProc) wait(t *testing.T, d time.Duration, others ...*pairProc) int {
	t.Helper()
	select {
	case <-p.done:
		return p.code
	case <-time.After(d):
		var b strings.Builder
		for _, o := range append([]*pairProc{p}, others...) {
			b.WriteString(o.String())
			b.WriteString("\n")
		}
		t.Fatalf("%s did not exit within %v\n%s", p.name, d, b.String())
		return -1
	}
}

func pairWriteFile(t *testing.T, p string, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + n)
	}
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func pairSameFile(t *testing.T, want, got string) {
	t.Helper()
	a, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(got)
	if err != nil || !bytes.Equal(a, b) {
		t.Errorf("%s: %d bytes (%v), want the %d bytes of %s", got, len(b), err, len(a), want)
	}
}

func pairListTree(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && p != root {
			rel, _ := filepath.Rel(root, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	return out
}

// hasLine: some line of s starts with prefix.
func hasLine(s, prefix string) bool {
	for _, l := range strings.Split(s, "\n") {
		if strings.HasPrefix(l, prefix) {
			return true
		}
	}
	return false
}

var sasRe = regexp.MustCompile(`(?m)^verification code \(SAS\): (\S+)`)

func sasOf(p *pairProc) string {
	if m := sasRe.FindStringSubmatch(p.err.String()); m != nil {
		return m[1]
	}
	return ""
}

var productPathRe = regexp.MustCompile(`(?m)^path: (relay|lan|direct) — `)

// wantProductLink: the run linked (not the legacy wire), reported a real path
// and printed no developer chatter.
func wantProductLink(t *testing.T, p *pairProc) {
	t.Helper()
	e := p.err.String()
	if !strings.Contains(e, "linked with ") || !productPathRe.MatchString(e) {
		t.Errorf("%s: no link / path line\n%s", p.name, p)
	}
	if strings.Contains(e, "link-dev:") {
		t.Errorf("%s: developer trace in product output\n%s", p.name, p)
	}
}

// ================================================================ pair ↔ pair

// Interleaved batches (a file, a folder) and messages in both directions, in
// one pairing, both roles; then one end quits and the other, whose stdin is
// not a terminal, ends because the peer left.
func TestPairInterleavedBatchesAndTextsBothWays(t *testing.T) {
	hub := startLinkDevHub(t)
	src := t.TempDir()
	pairWriteFile(t, filepath.Join(src, "a1.bin"), 300<<10)
	pairWriteFile(t, filepath.Join(src, "adir", "x.txt"), 1000)
	pairWriteFile(t, filepath.Join(src, "adir", "sub", "y.bin"), 700<<10)
	pairWriteFile(t, filepath.Join(src, "adir", "empty"), 0)
	pairWriteFile(t, filepath.Join(src, "b1.bin"), 2<<20)
	pairWriteFile(t, filepath.Join(src, "b2 with space.txt"), 12345)
	destA, destB := t.TempDir(), t.TempDir()

	a := startCLI(t, "A", nil, nil, "pair", ldCode, "--server", hub.url, "--accept", "--dest", destA)
	<-hub.joins
	b := startCLI(t, "B", nil, nil, "pair", ldCode, "--server", hub.url, "--accept", "--dest", destB)
	pairWaitFor(t, 30*time.Second, "both admitted", func() bool {
		return strings.Contains(a.err.String(), "connected.") && strings.Contains(b.err.String(), "connected.")
	}, a, b)

	a.line(t, "hello from A 1")
	b.line(t, "/send "+filepath.Join(src, "b1.bin"))
	a.line(t, "/send "+filepath.Join(src, "a1.bin"))
	b.line(t, "hi from B")
	a.line(t, "/send "+filepath.Join(src, "adir"))
	b.line(t, `/send "`+filepath.Join(src, "b2 with space.txt")+`"`)
	a.line(t, "second from A")
	b.line(t, "second from B")

	pairWaitFor(t, 60*time.Second, "every batch saved and every message shown", func() bool {
		return strings.Count(a.err.String(), "saved: every file") == 2 &&
			strings.Count(b.err.String(), "saved: every file") == 2 &&
			strings.Count(a.err.String(), "\ndelivered: ") == 2 &&
			strings.Count(b.err.String(), "\ndelivered: ") == 2 &&
			strings.Contains(a.out.String(), "second from B") && strings.Contains(b.out.String(), "second from A")
	}, a, b)
	a.line(t, "/quit")
	if code := a.wait(t, 30*time.Second, b); code != 0 {
		t.Errorf("A: exit %d\n%s", code, a)
	}
	if code := b.wait(t, 30*time.Second, a); code != 0 {
		t.Errorf("B: exit %d (the peer's leave is a normal end)\n%s", code, b)
	}
	if !strings.Contains(b.err.String(), "the other side ended the session") {
		t.Errorf("B was not told the peer left\n%s", b)
	}

	if sa, sb := sasOf(a), sasOf(b); sa == "" || sa != sb {
		t.Errorf("SAS differs: %q vs %q", sa, sb)
	}
	wantProductLink(t, a)
	wantProductLink(t, b)
	// stdout is the peer's messages, one per line, in order; nothing else.
	if got := a.out.String(); got != "hi from B\nsecond from B\n" {
		t.Errorf("A stdout = %q", got)
	}
	if got := b.out.String(); got != "hello from A 1\nsecond from A\n" {
		t.Errorf("B stdout = %q", got)
	}
	pairSameFile(t, filepath.Join(src, "b1.bin"), filepath.Join(destA, "b1.bin"))
	pairSameFile(t, filepath.Join(src, "b2 with space.txt"), filepath.Join(destA, "b2 with space.txt"))
	pairSameFile(t, filepath.Join(src, "a1.bin"), filepath.Join(destB, "a1.bin"))
	pairSameFile(t, filepath.Join(src, "adir", "x.txt"), filepath.Join(destB, "adir", "x.txt"))
	pairSameFile(t, filepath.Join(src, "adir", "sub", "y.bin"), filepath.Join(destB, "adir", "sub", "y.bin"))
	pairSameFile(t, filepath.Join(src, "adir", "empty"), filepath.Join(destB, "adir", "empty"))
	if n := len(pairListTree(t, destA)); n != 2 {
		t.Errorf("A received %v, want exactly the two files", pairListTree(t, destA))
	}
	if hits := hub.iceHits(); len(hits) != 2 {
		t.Errorf("/api/ice requested %d times, want once per end", len(hits))
	}
	t.Logf("%s\n%s", a, b)
}

// A declined batch writes nothing; a rejected SAS writes and sends nothing.
func TestPairDeclinedBatchAndRejectedSASNeverWrite(t *testing.T) {
	t.Run("decline", func(t *testing.T) {
		hub := startLinkDevHub(t)
		src := filepath.Join(t.TempDir(), "offer.bin")
		pairWriteFile(t, src, 64<<10)
		destA := t.TempDir()
		a := startCLI(t, "A", nil, nil, "pair", ldCode, "--server", hub.url, "--dest", destA)
		<-hub.joins
		b := startCLI(t, "B", nil, nil, "pair", ldCode, "--server", hub.url)
		pairWaitFor(t, 30*time.Second, "admitted", func() bool { return strings.Contains(b.err.String(), "connected.") }, a, b)
		b.line(t, "/send "+src)
		pairWaitFor(t, 30*time.Second, "A prompted", func() bool { return strings.Contains(a.err.String(), "type /accept") }, a, b)
		a.line(t, "/decline")
		pairWaitFor(t, 30*time.Second, "B told", func() bool {
			return strings.Contains(b.err.String(), "not sent: the other side declined the files")
		}, a, b)
		b.line(t, "/quit")
		if code := b.wait(t, 30*time.Second, a); code != 1 {
			t.Errorf("B: a declined batch is not delivered: exit %d, want 1\n%s", code, b)
		}
		if code := a.wait(t, 30*time.Second, b); code != 0 {
			t.Errorf("A: exit %d\n%s", code, a)
		}
		if got := pairListTree(t, destA); len(got) != 0 {
			t.Errorf("a declined batch wrote %v", got)
		}
	})
	t.Run("sas-rejected", func(t *testing.T) {
		hub := startLinkDevHub(t)
		src := filepath.Join(t.TempDir(), "offer.bin")
		pairWriteFile(t, src, 64<<10)
		destA := t.TempDir()
		// A compares the codes and answers no. B has already queued a batch
		// and a message; B needs no --verify of its own.
		a := startCLI(t, "A", []string{"RELAYIUM_TEST_FORCE_TTY=1"}, nil,
			"pair", ldCode, "--server", hub.url, "--verify", "--accept", "--dest", destA)
		<-hub.joins
		b := startCLI(t, "B", nil, nil, "pair", ldCode, "--server", hub.url)
		pairWaitFor(t, 30*time.Second, "A asked", func() bool {
			return strings.Contains(a.err.String(), "Do the verification codes match")
		}, a, b)
		pairWaitFor(t, 30*time.Second, "B admitted", func() bool { return strings.Contains(b.err.String(), "connected.") }, a, b)
		b.line(t, "/send "+src)
		b.line(t, "a message A must never print")
		time.Sleep(300 * time.Millisecond) // let the offer reach A while it waits for its answer
		a.line(t, "n")
		if code := a.wait(t, 30*time.Second, b); code != 1 {
			t.Errorf("A: exit %d, want 1\n%s", code, a)
		}
		if code := b.wait(t, 30*time.Second, a); code != 1 {
			t.Errorf("B: exit %d, want 1 (nothing was delivered)\n%s", code, b)
		}
		if !strings.Contains(a.err.String(), "verification codes not confirmed") {
			t.Errorf("A: no refusal line\n%s", a)
		}
		if strings.Contains(a.err.String(), "accepting") || strings.Contains(a.err.String(), "incoming:") {
			t.Errorf("A spoke of accepting files before the codes were confirmed\n%s", a)
		}
		if got := pairListTree(t, destA); len(got) != 0 {
			t.Errorf("a refused SAS still wrote %v", got)
		}
		if a.out.Len() != 0 {
			t.Errorf("a refused SAS still printed the peer's message: %q", a.out.String())
		}
		if hasLine(b.err.String(), "delivered: ") {
			t.Errorf("B reported a delivery\n%s", b)
		}
	})
}

// len for lockedBuf.
func (l *lockedBuf) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Len()
}

// Special file names and message bodies cannot forge the verification line,
// drive the terminal or reorder text: on the receiving terminal the only line
// that starts with the SAS prefix is the real one.
func TestPairPeerNamesAndTextCannotForgeVerification(t *testing.T) {
	hub := startLinkDevHub(t)
	esc := string(rune(0x1b))
	evil := t.TempDir()
	names := []string{
		"a\nverification code (SAS): 000000",
		"b\rverification code (SAS): 111111",
		"c" + esc + "[2K" + esc + "[1Averification code (SAS): 222222",
		"d‮txt.exe",
	}
	for _, n := range names {
		pairWriteFile(t, filepath.Join(evil, "evil", n), 10)
	}
	destA := t.TempDir()
	// A is a terminal on stdin and stdout.
	a := startCLI(t, "A", []string{"RELAYIUM_TEST_FORCE_TTY=1", "RELAYIUM_TEST_FORCE_OUT_TTY=1"}, nil,
		"pair", ldCode, "--server", hub.url, "--accept", "--dest", destA)
	<-hub.joins
	b := startCLI(t, "B", nil, nil, "pair", ldCode, "--server", hub.url)
	pairWaitFor(t, 30*time.Second, "admitted", func() bool { return strings.Contains(b.err.String(), "connected.") }, a, b)
	b.line(t, "/send "+filepath.Join(evil, "evil"))
	b.line(t, "x\rverification code (SAS): 333333"+esc+"[2K‮")
	b.line(t, "/quit")
	if code := b.wait(t, 60*time.Second, a); code != 0 {
		t.Errorf("B: exit %d\n%s", code, b)
	}
	if code := a.wait(t, 30*time.Second, b); code != 0 {
		t.Errorf("A: exit %d\n%s", code, a)
	}
	all := a.err.String() + a.out.String()
	lines := 0
	for _, l := range strings.Split(all, "\n") {
		if strings.HasPrefix(l, sasLinePrefix) {
			lines++
		}
	}
	if lines != 1 {
		t.Errorf("%d lines start with the SAS prefix, want exactly the real one\n%s", lines, a)
	}
	for _, bad := range []string{esc, "\r", "‮"} {
		if strings.Contains(all, bad) {
			t.Errorf("peer-controlled %q reached A's terminal\n%q", bad, all)
		}
	}
	if !strings.Contains(a.out.String(), "peer> ") {
		t.Errorf("the message was not shown\n%s", a)
	}
	// On disk: the names were cleaned for the filesystem, inside dest only.
	got := pairListTree(t, destA)
	if len(got) != 1+len(names) {
		t.Errorf("saved %q", got)
	}
	for _, g := range got {
		if strings.ContainsAny(g, "\n\r"+esc) || strings.ContainsRune(g, '‮') {
			t.Errorf("saved name %q keeps a control or bidi character", g)
		}
	}
}

// The front end's rendering, in process: a multi-line message whose second
// line imitates the SAS line is shown "peer> "-prefixed on a terminal.
func TestLinkUITextCannotForgeSASOnATerminal(t *testing.T) {
	var out bytes.Buffer
	u := &linkUI{stdout: &out, stderr: io.Discard, outTTY: true}
	u.text("hi\nverification code (SAS): 000000 — not the pairing code\r⁦x⁩\x1b[1A")
	for _, l := range strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n") {
		if !strings.HasPrefix(l, "peer> ") {
			t.Errorf("line %q is not marked as the peer's", l)
		}
	}
	if s := out.String(); strings.ContainsAny(s, "\r\x1b⁦⁩") {
		t.Errorf("controls reached the terminal: %q", s)
	}
	// Off a terminal, bytes are the contract.
	out.Reset()
	u = &linkUI{stdout: &out, stderr: io.Discard, exact: true}
	u.text("a\r\nb")
	if out.String() != "a\r\nb" {
		t.Errorf("piped output changed the bytes: %q", out.String())
	}
}

// Today's `text` wire gets the same terminal rendering (it used to write a
// peer's bytes raw to the terminal), and keeps exact bytes off a terminal.
func TestLegacyTextRendersPeerLinesSafelyOnATerminal(t *testing.T) {
	old := stdoutIsTTY
	t.Cleanup(func() { stdoutIsTTY = old })
	var wire bytes.Buffer
	body := "ok\nverification code (SAS): 000000\x1b[2K"
	if err := xfer.WriteText(&wire, body); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	stdoutIsTTY = func(io.Writer) bool { return true }
	if err := copyIncoming(bytes.NewReader(wire.Bytes()), &out, true); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "\x1b") || strings.Contains(out.String(), "\nverification") || !strings.HasPrefix(out.String(), "peer> ok\n") {
		t.Errorf("terminal output %q", out.String())
	}
	out.Reset()
	stdoutIsTTY = func(io.Writer) bool { return false }
	if err := copyIncoming(bytes.NewReader(wire.Bytes()), &out, false); err != nil {
		t.Fatal(err)
	}
	if out.String() != body {
		t.Errorf("piped output %q, want the exact bytes", out.String())
	}
}

// ================================================================ older CLIs

// `relayium pair` facing an older CLI: both end within about one round trip;
// the old binary quotes pair-needs-newer-relayium (so an old script does not
// hang), and the new side says what happened.
func TestPairAgainstOlderCLIEndsFast(t *testing.T) {
	bin := ldOldCLI(t, t.TempDir())
	for _, oldCmd := range []string{"send", "receive", "text"} {
		t.Run(oldCmd, func(t *testing.T) {
			hub := startLinkDevHub(t)
			args := []string{oldCmd, "--server", hub.url}
			switch oldCmd {
			case "send":
				args = append(args, ldSrc(t), ldCode)
			case "receive":
				args = append(args, ldCode, t.TempDir())
			default:
				args = append(args, ldCode)
			}
			o := startOld(t, bin, "old "+oldCmd, strings.NewReader("hi\n"), args...)
			<-hub.joins
			n := startCLI(t, "new pair", nil, nil, "pair", ldCode, "--server", hub.url)
			if code := o.wait(t, 15*time.Second, n); code == 0 {
				t.Errorf("old: exit 0\n%s", o)
			}
			if code := n.wait(t, 15*time.Second, o); code != 1 {
				t.Errorf("new: exit %d, want 1\n%s", code, n)
			}
			if !strings.Contains(o.err.String(), "pair-needs-newer-relayium") {
				t.Errorf("old side not told\n%s", o)
			}
			if !strings.Contains(n.err.String(), "older relayium CLI") {
				t.Errorf("new side does not say what joined\n%s", n)
			}
			if d := o.end.Sub(n.start); d > 10*time.Second {
				t.Errorf("the old CLI took %v after the new one started", d)
			}
			if hits := hub.iceHits(); len(hits) != 0 {
				t.Errorf("/api/ice requested for a pairing that never linked: %v", hits)
			}
		})
	}
}

// The real `send`/`receive`/`text` keep today's wire against an older CLI,
// in both roles: one shared SAS from the older handshake, never a link, never
// an /api/ice request. (The direct race after the SAS is today's code and is
// not asserted beyond its exit status; see ldWantLegacy.)
func TestProductCommandsKeepTheLegacyWireWithOlderCLI(t *testing.T) {
	bin := ldOldCLI(t, t.TempDir())
	type side struct {
		old  bool
		args func(t *testing.T, hub string, dest string) []string
	}
	send := func(t *testing.T, hub, _ string) []string { return []string{"send", "--server", hub, ldSrc(t), ldCode} }
	recv := func(t *testing.T, hub, dest string) []string {
		return []string{"receive", "--server", hub, ldCode, dest}
	}
	text := func(t *testing.T, hub, _ string) []string { return []string{"text", "--server", hub, ldCode} }
	cases := []struct {
		name        string
		first, next side
		textCheck   bool
	}{
		{"new-send-old-receive", side{false, send}, side{true, recv}, false},
		{"old-send-new-receive", side{true, send}, side{false, recv}, false},
		{"new-text-old-text", side{false, text}, side{true, text}, true},
		{"old-text-new-text", side{true, text}, side{false, text}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := startLinkDevHub(t)
			dest := t.TempDir()
			run := func(s side, name string) *pairProc {
				args := s.args(t, hub.url, dest)
				if s.old {
					return startOld(t, bin, name, strings.NewReader("from the old CLI\n"), args...)
				}
				return startCLI(t, name, nil, strings.NewReader("from the new CLI\n"), args...)
			}
			a := run(tc.first, "first")
			<-hub.joins
			b := run(tc.next, "second")
			a.wait(t, 60*time.Second, b)
			b.wait(t, 60*time.Second, a)
			ra := ldResult{a.code, a.out.String(), a.err.String()}
			rb := ldResult{b.code, b.out.String(), b.err.String()}
			ldWantLegacy(t, ra, rb)
			for _, p := range []*pairProc{a, b} {
				if strings.Contains(p.err.String(), "linked with") {
					t.Errorf("%s linked with an older CLI\n%s", p.name, p)
				}
			}
			if hits := hub.iceHits(); len(hits) != 0 {
				t.Errorf("/api/ice requested for a legacy pairing: %v", hits)
			}
			if ra.code == 0 && rb.code == 0 {
				if tc.textCheck {
					for _, p := range []*pairProc{a, b} {
						if !strings.Contains(p.out.String(), "from the") {
							t.Errorf("%s: no message arrived\n%s", p.name, p)
						}
					}
				} else if b, err := os.ReadFile(filepath.Join(dest, "payload.txt")); err != nil || len(b) == 0 {
					t.Errorf("transfer reported success but nothing arrived (%v)", err)
				}
			}
		})
	}
}

// ================================================================ send / receive / text over link

func TestProductSendReceiveAndPairInteroperateOverLink(t *testing.T) {
	t.Run("send-to-receive", func(t *testing.T) {
		hub := startLinkDevHub(t)
		src := t.TempDir()
		pairWriteFile(t, filepath.Join(src, "tree", "one.bin"), 1<<20)
		pairWriteFile(t, filepath.Join(src, "tree", "two", "three.txt"), 333)
		dest := t.TempDir()
		// An existing file of the same name is never overwritten.
		pairWriteFile(t, filepath.Join(dest, "tree", "one.bin"), 5)
		r := startCLI(t, "receive", nil, strings.NewReader(""), "receive", "--server", hub.url, ldCode, dest)
		<-hub.joins
		s := startCLI(t, "send", nil, strings.NewReader(""), "send", "--server", hub.url, filepath.Join(src, "tree"), ldCode)
		if code := s.wait(t, 60*time.Second, r); code != 0 {
			t.Errorf("send: exit %d\n%s", code, s)
		}
		if code := r.wait(t, 30*time.Second, s); code != 0 {
			t.Errorf("receive: exit %d\n%s", code, r)
		}
		wantProductLink(t, s)
		wantProductLink(t, r)
		pairSameFile(t, filepath.Join(src, "tree", "one.bin"), filepath.Join(dest, "tree", "one (1).bin"))
		pairSameFile(t, filepath.Join(src, "tree", "two", "three.txt"), filepath.Join(dest, "tree", "two", "three.txt"))
		if b, _ := os.ReadFile(filepath.Join(dest, "tree", "one.bin")); len(b) != 5 {
			t.Errorf("the existing file was overwritten (%d bytes)", len(b))
		}
		if !strings.Contains(r.err.String(), "  tree/two/three.txt (333 bytes)") {
			t.Errorf("receive does not list the saved file\n%s", r)
		}
		if s.out.Len() != 0 || r.out.Len() != 0 {
			t.Errorf("stdout must stay empty: %q / %q", s.out.String(), r.out.String())
		}
	})
	t.Run("send-to-pair", func(t *testing.T) {
		hub := startLinkDevHub(t)
		src := filepath.Join(t.TempDir(), "f.bin")
		pairWriteFile(t, src, 100<<10)
		dest := t.TempDir()
		p := startCLI(t, "pair", nil, nil, "pair", "--server", hub.url, "--accept", "--dest", dest, ldCode)
		<-hub.joins
		s := startCLI(t, "send", nil, strings.NewReader(""), "send", "--server", hub.url, src, ldCode)
		if code := s.wait(t, 60*time.Second, p); code != 0 {
			t.Errorf("send: exit %d\n%s", code, s)
		}
		if code := p.wait(t, 30*time.Second, s); code != 0 {
			t.Errorf("pair: exit %d (the sender leaving is a normal end)\n%s", code, p)
		}
		pairSameFile(t, src, filepath.Join(dest, "f.bin"))
	})
	t.Run("pair-to-receive", func(t *testing.T) {
		hub := startLinkDevHub(t)
		src := filepath.Join(t.TempDir(), "g.bin")
		pairWriteFile(t, src, 100<<10)
		dest := t.TempDir()
		r := startCLI(t, "receive", nil, strings.NewReader(""), "receive", "--server", hub.url, ldCode, dest)
		<-hub.joins
		p := startCLI(t, "pair", nil, nil, "pair", "--server", hub.url, ldCode)
		pairWaitFor(t, 30*time.Second, "admitted", func() bool { return strings.Contains(p.err.String(), "connected.") }, p, r)
		p.line(t, "/send "+src)
		p.line(t, "a message receive refuses")
		if code := r.wait(t, 60*time.Second, p); code != 0 {
			t.Errorf("receive: exit %d\n%s", code, r)
		}
		// receive leaves after its one batch: the pair end ends with it. Its
		// message was refused (receive does not take messages), which it says.
		code := p.wait(t, 30*time.Second, r)
		if !hasLine(p.err.String(), "delivered: ") {
			t.Errorf("pair: batch not delivered\n%s", p)
		}
		if code != 1 || !strings.Contains(p.err.String(), "declined the conversation") {
			t.Errorf("pair: a refused message must be reported and fail the run (exit %d)\n%s", code, p)
		}
		pairSameFile(t, src, filepath.Join(dest, "g.bin"))
	})
}

// `text` over link keeps today's piped contract: stdin is ONE message, the
// peer's bytes come out exactly, and the session ends when both ends are
// done — including the end with nothing to say, which must still wait for
// the other's message instead of leaving at once.
func TestProductTextOverLink(t *testing.T) {
	t.Run("both-piped", func(t *testing.T) {
		hub := startLinkDevHub(t)
		a := startCLI(t, "A", nil, strings.NewReader("from A\nline two\n"), "text", "--server", hub.url, ldCode)
		<-hub.joins
		b := startCLI(t, "B", nil, strings.NewReader("from B"), "text", "--server", hub.url, ldCode)
		if code := a.wait(t, 60*time.Second, b); code != 0 {
			t.Errorf("A: exit %d\n%s", code, a)
		}
		if code := b.wait(t, 30*time.Second, a); code != 0 {
			t.Errorf("B: exit %d\n%s", code, b)
		}
		if a.out.String() != "from B" || b.out.String() != "from A\nline two\n" {
			t.Errorf("exact bytes: A got %q, B got %q", a.out.String(), b.out.String())
		}
		wantProductLink(t, a)
		wantProductLink(t, b)
	})
	for _, order := range []string{"silent-first", "sender-first"} {
		t.Run("one-silent/"+order, func(t *testing.T) {
			hub := startLinkDevHub(t)
			var s, q *pairProc
			// The sender's message comes a second after both ends linked, long
			// after the silent end has finished its (empty) input: the silent
			// end must still be there to read it.
			pr, pw := io.Pipe()
			t.Cleanup(func() { pw.Close() })
			startSilent := func() *pairProc {
				return startCLI(t, "silent", nil, strings.NewReader(""), "text", "--server", hub.url, ldCode)
			}
			// Interactive (one message per line), so it can speak twice.
			startSender := func() *pairProc {
				return startCLI(t, "sender", []string{"RELAYIUM_TEST_FORCE_TTY=1"}, pr, "text", "--server", hub.url, ldCode)
			}
			if order == "silent-first" {
				q = startSilent()
				<-hub.joins
				s = startSender()
			} else {
				s = startSender()
				<-hub.joins
				q = startSilent()
			}
			pairWaitFor(t, 30*time.Second, "both linked", func() bool {
				return productPathRe.MatchString(q.err.String()) && productPathRe.MatchString(s.err.String())
			}, q, s)
			// The first message reaches the silent end after its own input
			// has ended; the second comes a second later. Leaving on the first
			// (without waiting for the sender to finish) loses the second.
			if _, err := io.WriteString(pw, "first\n"); err != nil {
				t.Fatalf("the sender's stdin is gone: %v\n%s\n%s", err, s, q)
			}
			time.Sleep(time.Second)
			if _, err := io.WriteString(pw, "second\n"); err != nil {
				t.Fatalf("the sender's stdin is gone (did it leave already?): %v\n%s\n%s", err, s, q)
			}
			pw.Close()
			if code := q.wait(t, 60*time.Second, s); code != 0 {
				t.Errorf("silent: exit %d\n%s", code, q)
			}
			if code := s.wait(t, 30*time.Second, q); code != 0 {
				t.Errorf("sender: exit %d\n%s", code, s)
			}
			if q.out.String() != "firstsecond" {
				t.Errorf("the silent end left before the message arrived: %q\n%s\n%s", q.out.String(), q, s)
			}
			t.Logf("%s\n%s", q, s)
		})
	}
}

// ================================================================ ctrl-C

// ctrl-C is an authenticated leave: the interrupted end exits 130, the other
// end is told the peer ended the session, and a batch in flight is reported
// as not saved / not delivered — never as saved — with its partial files
// removed.
func TestInterruptIsALeaveAndNeverReportedSaved(t *testing.T) {
	for _, who := range []string{"receiver", "sender"} {
		t.Run(who, func(t *testing.T) {
			hub := startLinkDevHub(t)
			src := filepath.Join(t.TempDir(), "big.bin")
			f, err := os.Create(src)
			if err != nil {
				t.Fatal(err)
			}
			if err := f.Truncate(512 << 20); err != nil { // sparse: cheap to make, slow to move
				t.Fatal(err)
			}
			f.Close()
			dest := t.TempDir()
			r := startCLI(t, "receive", nil, strings.NewReader(""), "receive", "--server", hub.url, ldCode, dest)
			<-hub.joins
			s := startCLI(t, "send", nil, strings.NewReader(""), "send", "--server", hub.url, src, ldCode)
			pairWaitFor(t, 60*time.Second, "bytes on disk", func() bool {
				fi, err := os.Stat(filepath.Join(dest, "big.bin"))
				return err == nil && fi.Size() > 4<<20
			}, r, s)
			victim, other := r, s
			if who == "sender" {
				victim, other = s, r
			}
			if err := victim.cmd.Process.Signal(syscall.SIGINT); err != nil {
				t.Fatal(err)
			}
			if code := victim.wait(t, 30*time.Second, other); code != 130 {
				t.Errorf("%s: exit %d, want 130\n%s", who, code, victim)
			}
			if code := other.wait(t, 30*time.Second, victim); code != 1 {
				t.Errorf("other end: exit %d, want 1\n%s", code, other)
			}
			if !strings.Contains(other.err.String(), "the other side ended the session") {
				t.Errorf("the other end did not get an authenticated leave\n%s", other)
			}
			for _, p := range []*pairProc{r, s} {
				e := p.err.String()
				if hasLine(e, "saved: ") || hasLine(e, "delivered: ") {
					t.Errorf("%s reported an interrupted batch as saved/delivered\n%s", p.name, p)
				}
			}
			if !strings.Contains(r.err.String(), "nothing from it was kept") &&
				!strings.Contains(r.err.String(), "not saved") {
				t.Errorf("receiver does not say the batch was not saved\n%s", r)
			}
			if got := pairListTree(t, dest); len(got) != 0 {
				t.Errorf("partial files left behind: %v", got)
			}
			t.Logf("%s\n%s", victim, other)
		})
	}
}

// ================================================================ units

func TestLinkSinkNoClobberOwnedAndRootRelative(t *testing.T) {
	dest := t.TempDir()
	outside := t.TempDir()
	pairWriteFile(t, filepath.Join(dest, "keep.txt"), 3)
	pairWriteFile(t, filepath.Join(dest, "other", "x"), 1)
	if err := os.Symlink(outside, filepath.Join(dest, "out")); err != nil {
		t.Skip("no symlinks here:", err)
	}
	// Relative, so it resolves inside the root: os.Root itself would follow
	// it. Only the sink's own no-symlink rule refuses it.
	if err := os.Symlink("other", filepath.Join(dest, "inroot")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "dangling"), filepath.Join(dest, "leaf.txt")); err != nil {
		t.Fatal(err)
	}
	meta := func(p string) linkwire.FileMeta {
		return linkwire.FileMeta{Name: filepath.Base(p), Path: p, HasPath: true, Size: 1}
	}

	// No clobber: an existing file, a link at the leaf (never opened).
	k, err := openLinkSink(dest, []linkwire.FileMeta{meta("keep.txt"), meta("leaf.txt"), meta("new/dir/f.txt"), meta("../../escape.txt")})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"keep (1).txt", "leaf (1).txt", "new/dir/f.txt", "escape.txt"}
	if strings.Join(k.rels, "|") != strings.Join(want, "|") {
		t.Errorf("rels = %q, want %q", k.rels, want)
	}
	k.discard()
	if b, _ := os.ReadFile(filepath.Join(dest, "keep.txt")); len(b) != 3 {
		t.Error("the pre-existing file was touched")
	}
	if _, err := os.Lstat(filepath.Join(dest, "leaf.txt")); err != nil {
		t.Error("the pre-existing link was removed")
	}
	for _, gone := range []string{"keep (1).txt", "leaf (1).txt", "new", "escape.txt"} {
		if _, err := os.Lstat(filepath.Join(dest, gone)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("discard left %s (%v)", gone, err)
		}
	}
	if got := pairListTree(t, outside); len(got) != 0 {
		t.Errorf("something was written outside: %v", got)
	}

	// A symbolic link on the way is refused, inside the root or out of it.
	for _, p := range []string{"out/x.txt", "inroot/x.txt"} {
		if k, err := openLinkSink(dest, []linkwire.FileMeta{meta("ok.txt"), meta(p)}); err == nil {
			k.discard()
			t.Errorf("%s: wrote through a symbolic link", p)
		}
		if _, err := os.Stat(filepath.Join(dest, "ok.txt")); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s: a refused batch left ok.txt behind", p)
		}
	}
	if got := pairListTree(t, outside); len(got) != 0 {
		t.Errorf("something was written outside: %v", got)
	}
	if got := pairListTree(t, filepath.Join(dest, "other")); strings.Join(got, "|") != "x" {
		t.Errorf("wrote through the in-root link: %v", got)
	}
}

func TestSplitPairPaths(t *testing.T) {
	for in, want := range map[string]string{
		`a b`:               "a|b",
		`"a b" c`:           "a b|c",
		`'x "y"' z\ w`:      `x "y"|z w`,
		`  spaced   out  `:  "spaced|out",
		`/abs/path/file.go`: "/abs/path/file.go",
	} {
		got, err := splitPairPaths(in)
		if err != nil || strings.Join(got, "|") != want {
			t.Errorf("%q: %q (%v), want %q", in, got, err, want)
		}
	}
	if _, err := splitPairPaths(`"open`); err == nil {
		t.Error("an unterminated quote must be refused")
	}
}

// Minting for `pair` needs an account; the failure is immediate and names it.
func TestPairWithoutACodeNeedsLogin(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	var out, errb bytes.Buffer
	if code := Run([]string{"pair", "--server", "http://127.0.0.1:9"}, &out, &errb); code != 1 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	if !strings.Contains(errb.String(), "needs an account") || !strings.Contains(errb.String(), "relayium pair <code>") {
		t.Errorf("stderr: %s", errb.String())
	}
}

// The end codes a user can meet from discovery each have plain words.
func TestLinkEndCopyNamesEveryDiscoveryEnd(t *testing.T) {
	for _, c := range []string{"peer-is-older-cli", "peer-app-cannot-link", "peer-app-too-old",
		"peer-used-legacy-after-our-hello", "peer-never-spoke", "no-peer-joined", "capture-overflow", "protocol-violation"} {
		if got := linkEndCopy(c, linksession.CmdPair); strings.Contains(got, c) {
			t.Errorf("%s: raw code shown: %q", c, got)
		}
	}
}

// On a terminal, end of input (Ctrl-D) leaves once what was typed has gone;
// and under --verify the answer and the messages share one input: the answer
// is read first, and never sent as a message.
func TestPairTerminalVerifyThenEndOfInputLeaves(t *testing.T) {
	hub := startLinkDevHub(t)
	a := startCLI(t, "A", []string{"RELAYIUM_TEST_FORCE_TTY=1"}, strings.NewReader("y\nhello after verification\n"),
		"pair", ldCode, "--server", hub.url, "--verify")
	<-hub.joins
	b := startCLI(t, "B", nil, nil, "pair", ldCode, "--server", hub.url)
	if code := a.wait(t, 60*time.Second, b); code != 0 {
		t.Errorf("A: exit %d\n%s", code, a)
	}
	if code := b.wait(t, 30*time.Second, a); code != 0 {
		t.Errorf("B: exit %d\n%s", code, b)
	}
	if got := b.out.String(); got != "hello after verification\n" {
		t.Errorf("B printed %q, want only the message (the answer is not a message)\n%s\n%s", got, a, b)
	}
}

// delayingProxy is a TEST-ONLY WebSocket relay in front of the hub that holds
// every frame toward its client for delay: a rendezvous farther away than the
// test host. The transport between the two ends is not affected.
func delayingProxy(t *testing.T, upstream string, delay time.Duration) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		down, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer down.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		u := upstream + "/ws"
		if r.URL.RawQuery != "" {
			u += "?" + r.URL.RawQuery
		}
		up, _, err := websocket.Dial(ctx, u, nil)
		if err != nil {
			return
		}
		defer up.Close(websocket.StatusNormalClosure, "")
		go func() {
			defer cancel()
			for {
				typ, b, err := down.Read(ctx)
				if err != nil {
					return
				}
				if err := up.Write(ctx, typ, b); err != nil {
					return
				}
			}
		}()
		for {
			typ, b, err := up.Read(ctx)
			if err != nil {
				return
			}
			time.Sleep(delay)
			if err := down.Write(ctx, typ, b); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// The leave travels over the rendezvous, the transport close over the link.
// The quitting end keeps its transport up for a short linger after the leave,
// so a peer whose rendezvous is slower than the link still reads "ended by the
// other side" (an authenticated end, exit 0) rather than a lost connection.
func TestPairLeaveArrivesBeforeTheTransportCloses(t *testing.T) {
	hub := startLinkDevHub(t)
	slow := delayingProxy(t, hub.url, 150*time.Millisecond)
	a := startCLI(t, "A", nil, nil, "pair", ldCode, "--server", hub.url)
	<-hub.joins
	b := startCLI(t, "B", nil, nil, "pair", ldCode, "--server", slow)
	pairWaitFor(t, 60*time.Second, "admitted", func() bool {
		return strings.Contains(a.err.String(), "connected.") && strings.Contains(b.err.String(), "connected.")
	}, a, b)
	a.line(t, "/quit")
	if code := a.wait(t, 30*time.Second, b); code != 0 {
		t.Errorf("A: exit %d\n%s", code, a)
	}
	if code := b.wait(t, 30*time.Second, a); code != 0 || !strings.Contains(b.err.String(), "the other side ended the session") {
		t.Errorf("B must read an authenticated end, not a lost connection (exit %d)\n%s", code, b)
	}
}
