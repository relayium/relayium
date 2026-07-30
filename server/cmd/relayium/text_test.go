package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

func TestTextRequiresACode(t *testing.T) {
	var out, errb bytes.Buffer
	if code := runText(nil, &out, &errb); code == 0 {
		t.Fatal("expected a non-zero exit without a code")
	}
	if !strings.Contains(errb.String(), "relayium text") {
		t.Fatalf("error should show the usage form, got %q", errb.String())
	}
}

func TestTextRejectsAMalformedCodeBeforeDialing(t *testing.T) {
	var out, errb bytes.Buffer
	// 0 and 1 are not in CodeAlphabet, so this cannot be a real code.
	if code := runText([]string{"726122"}, &out, &errb); code == 0 {
		t.Fatal("expected a non-zero exit on a malformed code")
	}
	if strings.Contains(errb.String(), "dial") {
		t.Fatalf("must fail on shape before dialing, got %q", errb.String())
	}
}

func TestParseTextFlags(t *testing.T) {
	f, rest, err := parseTextFlags([]string{"--server", "wss://example.invalid", "K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if f.server != "wss://example.invalid" {
		t.Fatalf("server = %q", f.server)
	}
	if len(rest) != 1 || rest[0] != "K7M4XR" {
		t.Fatalf("rest = %v", rest)
	}
}

// A message session has no manifest to inspect, so the SAS gate is on by
// default -- unlike `send`, where --verify opts in.
func TestTextConfirmsTheSasByDefaultOnATty(t *testing.T) {
	f, _, err := parseTextFlags([]string{"K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if !f.confirmSAS(true) {
		t.Fatal("a TTY session must confirm the SAS by default")
	}
	if f.confirmSAS(false) {
		t.Fatal("a piped session cannot prompt")
	}
}

// And a piped session without --yes must refuse rather than proceed unverified.
func TestTextRefusesAPipedSessionWithoutYes(t *testing.T) {
	f, _, err := parseTextFlags([]string{"K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if f.allowUnverified(false) {
		t.Fatal("piped without --yes must not proceed unverified")
	}
	fy, _, err := parseTextFlags([]string{"--yes", "K7M4XR"})
	if err != nil {
		t.Fatal(err)
	}
	if !fy.allowUnverified(false) {
		t.Fatal("--yes is the documented opt-out for scripts")
	}
}

func TestUsageListsText(t *testing.T) {
	if !strings.Contains(usage, "text") {
		t.Fatal("usage must list the text subcommand")
	}
}

// ── the injectable seams the deterministic tests need ────────────────────────
// runText's signature takes only stdout/stderr (the plan's interface), so stdin
// and the TTY answer come from package vars. Swapping them is what lets the piped
// path be driven without a terminal and without a network.

// withStdin points the command at a fixed stdin and says whether it is a TTY.
func withStdin(t *testing.T, in string, tty bool) {
	t.Helper()
	oldIn, oldTTY := textStdin, textStdinIsTTY
	textStdin = func() io.Reader { return strings.NewReader(in) }
	textStdinIsTTY = func() bool { return tty }
	t.Cleanup(func() { textStdin, textStdinIsTTY = oldIn, oldTTY })
}

// A piped run with no --yes must refuse before it reaches the network, and say
// which flag unblocks it.
func TestRunTextRefusesAPipedRunWithoutYesBeforeDialing(t *testing.T) {
	withStdin(t, "hello\n", false)
	var out, errb bytes.Buffer
	code := runText([]string{"K7M4XR"}, &out, &errb)
	if code == 0 {
		t.Fatal("expected a non-zero exit")
	}
	if !strings.Contains(errb.String(), "--yes") {
		t.Fatalf("the refusal must name the opt-out, got %q", errb.String())
	}
	if out.Len() != 0 {
		t.Fatalf("nothing should reach stdout, got %q", out.String())
	}
}

// The code's shape is checked before the SAS/TTY gate, so a typo is reported as a
// typo rather than masked by a complaint about --yes.
func TestRunTextReportsABadCodeAheadOfTheYesGate(t *testing.T) {
	withStdin(t, "hello\n", false)
	var out, errb bytes.Buffer
	if code := runText([]string{"726122"}, &out, &errb); code == 0 {
		t.Fatal("expected a non-zero exit")
	}
	if strings.Contains(errb.String(), "--yes") {
		t.Fatalf("a malformed code must not be reported as a --yes problem: %q", errb.String())
	}
}

func TestRunTextRejectsExtraOperands(t *testing.T) {
	var out, errb bytes.Buffer
	if code := runText([]string{"K7M4XR", "extra"}, &out, &errb); code == 0 {
		t.Fatal("expected a non-zero exit on a second operand")
	}
}

// ── pumpText: the stdin/stdout contract, over real framing ───────────────────
// fakeStream is a duplex whose two halves are independent: `in` is what the peer
// sends us (pre-framed, ending in a natural EOF), `out` collects what we send.
// Deterministic, no goroutine choreography, but every byte still goes through the
// real xfer framing, the real bufio.Scanner and the real limit checks.
type fakeStream struct {
	in  io.Reader
	out bytes.Buffer
}

func (f *fakeStream) Read(p []byte) (int, error)  { return f.in.Read(p) }
func (f *fakeStream) Write(p []byte) (int, error) { return f.out.Write(p) }

func peerFrames(t *testing.T, bodies ...string) io.Reader {
	t.Helper()
	var buf bytes.Buffer
	for _, b := range bodies {
		if err := xfer.WriteText(&buf, b); err != nil {
			t.Fatal(err)
		}
	}
	return &buf
}

// drainSent decodes everything pumpText put on the wire.
func drainSent(t *testing.T, s *fakeStream) []string {
	t.Helper()
	var got []string
	for {
		body, err := xfer.ReadText(&s.out)
		if errors.Is(err, io.EOF) {
			return got
		}
		if err != nil {
			t.Fatalf("decoding what we sent: %v", err)
		}
		got = append(got, body)
	}
}

const pipedBody = "  \tif x:\n\n\t\tprintf %s '你好 مرحبا 🌍 e\u0301'\n   \r\n  trailing   "

// The piped form is the one that promises exact bytes: one message, verbatim.
func TestPumpTextPipedSendsStdinAsOneExactMessage(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader(pipedBody), &out, &errb, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	sent := drainSent(t, s)
	if len(sent) != 1 {
		t.Fatalf("sent %d messages, want exactly 1: %q", len(sent), sent)
	}
	if sent[0] != pipedBody {
		t.Fatalf("got %q, want %q", sent[0], pipedBody)
	}
	if !bytes.Equal([]byte(sent[0]), []byte(pipedBody)) {
		t.Fatal("bytes differ despite comparing equal as strings")
	}
}

// And the piped form adds nothing to what it prints, either.
func TestPumpTextPipedPrintsRepliesVerbatim(t *testing.T) {
	s := &fakeStream{in: peerFrames(t, "one\n\ttwo", "   ")}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader("hi"), &out, &errb, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "one\n\ttwo   " {
		t.Fatalf("stdout = %q; the piped form must not add a byte", out.String())
	}
}

func TestPumpTextPipedAcceptsExactlyTheLimit(t *testing.T) {
	body := strings.Repeat("a", xfer.TextMaxBytes)
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader(body), &out, &errb, false, time.Time{}); err != nil {
		t.Fatalf("a body of exactly the limit must be accepted: %v", err)
	}
	if sent := drainSent(t, s); len(sent) != 1 || sent[0] != body {
		t.Fatal("the at-limit body did not round trip")
	}
}

// Strict refusal: over the limit sends NOTHING and names the alternative.
func TestPumpTextPipedRefusesOverTheLimitWithoutSending(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	err := pumpText(s, strings.NewReader(strings.Repeat("a", xfer.TextMaxBytes+1)), &out, &errb, false, time.Time{})
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if !strings.Contains(err.Error(), "relayium send") {
		t.Fatalf("the refusal must point at the file path, got %v", err)
	}
	if s.out.Len() != 0 {
		t.Fatalf("nothing should have reached the wire, got %d bytes", s.out.Len())
	}
	if strings.Contains(err.Error(), "aaaa") {
		t.Fatal("the refusal leaks content")
	}
}

// Bytes, not runes: 22000 Chinese characters are 66000 bytes.
func TestPumpTextPipedRefusesOnBytesNotRunes(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader(strings.Repeat("你", 22000)), &out, &errb, false, time.Time{}); err == nil {
		t.Fatal("expected a refusal measured in bytes")
	}
	if s.out.Len() != 0 {
		t.Fatal("nothing should have reached the wire")
	}
}

// An empty stdin is an empty message, which the wire treats as valid content.
func TestPumpTextPipedSendsAnEmptyBody(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader(""), &out, &errb, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if sent := drainSent(t, s); len(sent) != 1 || sent[0] != "" {
		t.Fatalf("want one empty message, got %q", sent)
	}
}

// ── interactive ─────────────────────────────────────────────────────────────
// One line per message, and the newline is a delimiter rather than content.
func TestPumpTextInteractiveSendsOneMessagePerLine(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader("first\n  indented  \n\n你好\n"), &out, &errb, true, time.Time{}); err != nil {
		t.Fatal(err)
	}
	want := []string{"first", "  indented  ", "", "你好"}
	got := drainSent(t, s)
	if len(got) != len(want) {
		t.Fatalf("sent %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d: got %q, want %q — interior spaces must survive", i, got[i], want[i])
		}
	}
}

// A line with no trailing newline is still a message.
func TestPumpTextInteractiveSendsAFinalUnterminatedLine(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader("no trailing newline"), &out, &errb, true, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if got := drainSent(t, s); len(got) != 1 || got[0] != "no trailing newline" {
		t.Fatalf("got %q", got)
	}
}

// Interactive output is line-oriented so a terminal stays readable.
func TestPumpTextInteractivePrintsEachMessageOnItsOwnLine(t *testing.T) {
	s := &fakeStream{in: peerFrames(t, "alpha", "beta")}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader(""), &out, &errb, true, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "alpha\nbeta\n" {
		t.Fatalf("stdout = %q", out.String())
	}
}

// An over-long line is refused, and the session keeps going: tearing a whole
// conversation down over one pasted blob would be worse than saying no to it.
func TestPumpTextInteractiveRefusesALongLineAndContinues(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	in := "ok before\n" + strings.Repeat("a", xfer.TextMaxBytes+1) + "\nok after\n"
	if err := pumpText(s, strings.NewReader(in), &out, &errb, true, time.Time{}); err != nil {
		t.Fatal(err)
	}
	got := drainSent(t, s)
	if len(got) != 2 || got[0] != "ok before" || got[1] != "ok after" {
		t.Fatalf("the long line must be skipped, not fatal: %q", got)
	}
	if !strings.Contains(errb.String(), "relayium send") {
		t.Fatalf("stderr must explain the refusal, got %q", errb.String())
	}
}

// The banner tells the user where multiline content goes -- otherwise the
// line-oriented reader reads as "the CLI cannot carry multiline".
func TestPumpTextInteractiveBannerNamesThePipeForm(t *testing.T) {
	s := &fakeStream{in: peerFrames(t)}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader(""), &out, &errb, true, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errb.String(), "relayium text") || !strings.Contains(errb.String(), "|") {
		t.Fatalf("banner should point at the pipe form, got %q", errb.String())
	}
}

// ── shutdown and errors ─────────────────────────────────────────────────────
// A peer that hangs up cleanly is not an error, in either mode.
func TestPumpTextTreatsAPeerEOFAsACleanEnd(t *testing.T) {
	for _, interactive := range []bool{false, true} {
		s := &fakeStream{in: peerFrames(t, "bye")}
		var out, errb bytes.Buffer
		if err := pumpText(s, strings.NewReader("x"), &out, &errb, interactive, time.Time{}); err != nil {
			t.Fatalf("interactive=%v: %v", interactive, err)
		}
	}
}

// A malformed inbound frame is an error, not a silently dropped message.
func TestPumpTextSurfacesAMalformedInboundFrame(t *testing.T) {
	var bad bytes.Buffer
	if err := xfer.WriteFrame(&bad, xfer.MsgText, []byte{0xff}); err != nil {
		t.Fatal(err)
	}
	for _, interactive := range []bool{false, true} {
		s := &fakeStream{in: bytes.NewReader(bad.Bytes())}
		var out, errb bytes.Buffer
		if err := pumpText(s, strings.NewReader("x"), &out, &errb, interactive, time.Time{}); err == nil {
			t.Fatalf("interactive=%v: expected invalid UTF-8 from the peer to fail", interactive)
		}
	}
}

// A wrong-type frame means the peer is not speaking this protocol. Fail, do not
// guess.
func TestPumpTextSurfacesAWrongTypeInboundFrame(t *testing.T) {
	var bad bytes.Buffer
	if err := xfer.WriteJSON(&bad, xfer.MsgManifest, xfer.Manifest{}); err != nil {
		t.Fatal(err)
	}
	s := &fakeStream{in: bytes.NewReader(bad.Bytes())}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader("x"), &out, &errb, false, time.Time{}); err == nil {
		t.Fatal("expected a non-text frame to fail")
	}
}

// ── CloseWrite / drain termination ──────────────────────────────────────────
// The fakeStream above has no CloseWrite and hands out a pre-baked EOF, so it
// cannot show that the real termination path works. These do.

// blockingPeer never says anything and never hangs up. It records CloseWrite and
// only lets a read return once a deadline has been set -- exactly the shape that
// hangs forever if endWrite forgets either half.
type blockingPeer struct {
	out         bytes.Buffer
	closedWrite bool
	deadlineSet chan struct{}
}

func newBlockingPeer() *blockingPeer {
	return &blockingPeer{deadlineSet: make(chan struct{})}
}
func (b *blockingPeer) Read(p []byte) (int, error) {
	<-b.deadlineSet
	return 0, os.ErrDeadlineExceeded
}
func (b *blockingPeer) Write(p []byte) (int, error) { return b.out.Write(p) }
func (b *blockingPeer) CloseWrite() error           { b.closedWrite = true; return nil }
func (b *blockingPeer) SetReadDeadline(t time.Time) error {
	select {
	case <-b.deadlineSet:
	default:
		close(b.deadlineSet)
	}
	return nil
}

func TestPumpTextPipedHalfClosesAndStopsOnASilentPeer(t *testing.T) {
	b := newBlockingPeer()
	var out, errb bytes.Buffer
	done := make(chan error, 1)
	go func() {
		done <- pumpText(b, strings.NewReader("hello"), &out, &errb, false, time.Now().Add(300*time.Millisecond))
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a peer that never hangs up is not an error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pumpText hung: a peer that never closes must not block us forever")
	}
	if !b.closedWrite {
		t.Fatal("CloseWrite was not called; the peer never learns we finished")
	}
}

func TestPumpTextInteractiveHalfClosesAndStopsOnASilentPeer(t *testing.T) {
	b := newBlockingPeer()
	var out, errb bytes.Buffer
	done := make(chan error, 1)
	go func() {
		done <- pumpText(b, strings.NewReader("a\nb\n"), &out, &errb, true, time.Now().Add(300*time.Millisecond))
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a peer that never hangs up is not an error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pumpText hung after stdin EOF")
	}
	if !b.closedWrite {
		t.Fatal("CloseWrite was not called")
	}
}

// Two piped peers, both waiting for the other to finish, over a real duplex
// connection. This is the deadlock the drain window exists to prevent: net.Pipe
// has no CloseWrite, so neither side ever sees an EOF and only the deadline ends
// it. Byte preservation is asserted in both directions at the same time.
func TestTwoPipedPeersBothTerminateAndExchangeExactBytes(t *testing.T) {
	a, b := net.Pipe()
	t.Cleanup(func() { a.Close(); b.Close() })

	const fromA = "  \tA: 你好 مرحبا 🌍\n\n\tprintf %s x  "
	const fromB = "B:\ttrailing spaces   \n\n"

	type result struct {
		out string
		err error
	}
	res := make(chan result, 2)
	run := func(conn net.Conn, body string) {
		var out, errb bytes.Buffer
		err := pumpText(conn, strings.NewReader(body), &out, &errb, false, time.Now().Add(300*time.Millisecond))
		res <- result{out.String(), err}
	}
	go run(a, fromA)
	go run(b, fromB)

	var outs []string
	for i := 0; i < 2; i++ {
		select {
		case r := <-res:
			if r.err != nil {
				t.Fatalf("peer %d: %v", i, r.err)
			}
			outs = append(outs, r.out)
		case <-time.After(10 * time.Second):
			t.Fatal("two piped peers deadlocked")
		}
	}
	// Each side printed exactly what the other sent, byte for byte, with nothing
	// added.
	want := map[string]bool{fromA: true, fromB: true}
	for _, got := range outs {
		if !want[got] {
			t.Fatalf("got %q, which is neither peer's exact body", got)
		}
		delete(want, got)
	}
	if len(want) != 0 {
		t.Fatalf("a body never arrived: %v", want)
	}
}

// The drain deadline must not swallow a genuine failure.
func TestPumpTextStillReportsARealErrorAfterHalfClose(t *testing.T) {
	var bad bytes.Buffer
	if err := xfer.WriteFrame(&bad, xfer.MsgText, []byte{0xff}); err != nil {
		t.Fatal(err)
	}
	s := &fakeStream{in: bytes.NewReader(bad.Bytes())}
	var out, errb bytes.Buffer
	if err := pumpText(s, strings.NewReader("x"), &out, &errb, false, time.Time{}); err == nil {
		t.Fatal("a malformed frame must survive the drain path as an error")
	}
}

// eofBeforeSecondLine is the shape that truncated a session: the inbound half
// reaches a clean EOF while stdin still has lines to send.
//
// Read blocks until the first Write lands and only then returns EOF, so by the
// time the send loop considers line two, the inbound half has definitely already
// finished. Inbound EOF means "the peer will send nothing more"; on a half-closed
// duplex it says nothing about whether the peer can still RECEIVE, so every
// remaining line must still go out.
type eofBeforeSecondLine struct {
	out      bytes.Buffer
	wrote    chan struct{} // closed by the first Write, releasing Read
	readDone chan struct{} // closed by Read immediately before it returns EOF
	once     sync.Once
}

func newEOFBeforeSecondLine() *eofBeforeSecondLine {
	return &eofBeforeSecondLine{wrote: make(chan struct{}), readDone: make(chan struct{})}
}

func (e *eofBeforeSecondLine) Read(p []byte) (int, error) {
	<-e.wrote
	close(e.readDone)
	return 0, io.EOF
}

func (e *eofBeforeSecondLine) Write(p []byte) (int, error) {
	n, err := e.out.Write(p)
	first := false
	e.once.Do(func() { first = true; close(e.wrote) })
	if !first {
		// Every write after the first waits for Read to have returned EOF, so the
		// inbound half is finished before the send loop reaches line two. A single
		// `wrote` channel only proved Read had been *released*, not that it had
		// published EOF.
		<-e.readDone
		// Yield so the receive goroutine can also publish its result, making the
		// buggy behaviour (abort on clean EOF) reliably observable rather than
		// merely likely.
		for i := 0; i < 3; i++ {
			runtime.Gosched()
		}
	}
	return n, err
}

func TestPumpTextInteractiveDoesNotTruncateOnInboundEOF(t *testing.T) {
	e := newEOFBeforeSecondLine()
	var want []string
	var in strings.Builder
	for i := 0; i < 20; i++ {
		line := fmt.Sprintf("line-%02d", i)
		want = append(want, line)
		in.WriteString(line + "\n")
	}

	var out, errb bytes.Buffer
	if err := pumpText(e, strings.NewReader(in.String()), &out, &errb, true, time.Time{}); err != nil {
		t.Fatalf("a clean inbound EOF is not an error: %v", err)
	}

	var got []string
	for {
		body, err := xfer.ReadText(&e.out)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("decoding what we sent: %v", err)
		}
		got = append(got, body)
	}
	if len(got) != len(want) {
		t.Fatalf("sent %d of %d lines — a clean inbound EOF truncated stdin: %q", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d: got %q, want %q", i, got[i], want[i])
		}
	}
}

// The other half of the same rule: a genuine inbound failure DOES stop the send
// loop, and is reported rather than swallowed.
func TestPumpTextInteractiveStopsOnAGenuineInboundError(t *testing.T) {
	var bad bytes.Buffer
	if err := xfer.WriteFrame(&bad, xfer.MsgText, []byte{0xff}); err != nil {
		t.Fatal(err)
	}
	e := &fakeStream{in: bytes.NewReader(bad.Bytes())}
	var in strings.Builder
	for i := 0; i < 200; i++ {
		in.WriteString(fmt.Sprintf("line-%03d\n", i))
	}
	var out, errb bytes.Buffer
	err := pumpText(e, strings.NewReader(in.String()), &out, &errb, true, time.Time{})
	if err == nil {
		t.Fatal("a malformed inbound frame must be reported, not swallowed")
	}
	if !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("err = %v, want the inbound decoding failure", err)
	}
}

// ── whole-session deadline installation ─────────────────────────────────────
type recordingDeadliner struct {
	got  time.Time
	n    int
	fail error
}

func (r *recordingDeadliner) SetDeadline(t time.Time) error {
	r.n++
	r.got = t
	return r.fail
}

func TestInstallDeadlineAppliesTheSessionCeiling(t *testing.T) {
	want := time.Now().Add(9 * time.Minute)
	r := &recordingDeadliner{}
	if err := installDeadline(r, want); err != nil {
		t.Fatal(err)
	}
	if r.n != 1 {
		t.Fatalf("SetDeadline called %d times, want 1", r.n)
	}
	if !r.got.Equal(want) {
		t.Fatalf("got %v, want the session ceiling %v", r.got, want)
	}
}

// A zero deadline means no ceiling was set, so nothing should be installed --
// otherwise a zero time would read as "deadline already passed" and kill the
// connection immediately.
func TestInstallDeadlineIgnoresAZeroDeadline(t *testing.T) {
	r := &recordingDeadliner{}
	if err := installDeadline(r, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if r.n != 0 {
		t.Fatalf("SetDeadline called %d times on a zero deadline, want 0", r.n)
	}
}

func TestInstallDeadlineWrapsAFailure(t *testing.T) {
	boom := errors.New("connection already closed")
	r := &recordingDeadliner{fail: boom}
	err := installDeadline(r, time.Now().Add(time.Minute))
	if err == nil {
		t.Fatal("a failure to install the ceiling must not be ignored")
	}
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want it to wrap the cause", err)
	}
	if !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("err = %v, want it to name what failed", err)
	}
}
