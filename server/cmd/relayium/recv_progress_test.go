package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/xfer"
)

// treeSenderOnAPipe runs a real sender of sendTree's fixture against the pipe
// end it returns, so the receiving command under test faces the actual protocol.
func treeSenderOnAPipe(t *testing.T) (conn net.Conn, errc <-chan error, big []byte) {
	t.Helper()
	root, big := sendTree(t)
	m, srcs, err := xfer.BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	peer, local := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	peer.SetDeadline(deadline)
	local.SetDeadline(deadline)
	c := make(chan error, 1)
	go func() {
		_, serr := xfer.Send(peer, m, srcs, xfer.SendOpts{})
		peer.Close()
		c <- serr
	}()
	return local, c, big
}

// Not a TTY: one line per completed file — none per chunk, none for the empty
// file — in the format the send side prints, and nothing on stdout.
const recvTreeStderr = "  tree/a.txt (5 bytes)\n  tree/big.bin (500000 bytes)\n"

// `receive` and `pull` printed nothing at all, however large the file, because
// RecvOpts had no hook to report through.
func TestReceiveCommandReportsProgress(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	conn, errc, big := treeSenderOnAPipe(t)
	stubCrossnetReceive(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"receive", "483920", dst}, &out, &errb); rc != 0 {
		t.Fatalf("`receive` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "tree", "big.bin")); !bytes.Equal(got, big) {
		t.Fatalf("`receive` delivered %d bytes of big.bin, want %d", len(got), len(big))
	}
	if info, err := os.Stat(filepath.Join(dst, "tree", "empty")); err != nil || info.Size() != 0 {
		t.Fatalf("the unreported empty file did not land: %v", err)
	}
	if errb.String() != recvTreeStderr {
		t.Errorf("stderr = %q\nwant     %q", errb.String(), recvTreeStderr)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want it empty", out.String())
	}
}

func TestPullCommandReportsProgress(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	conn, errc, big := treeSenderOnAPipe(t)
	stubSSHDial(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"pull", "example.com:/srv/tree", dst}, &out, &errb); rc != 0 {
		t.Fatalf("`pull` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "tree", "big.bin")); !bytes.Equal(got, big) {
		t.Fatalf("`pull` delivered %d bytes of big.bin, want %d", len(got), len(big))
	}
	if errb.String() != recvTreeStderr {
		t.Errorf("stderr = %q\nwant     %q", errb.String(), recvTreeStderr)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want it empty", out.String())
	}
}

func TestReceiveCommandFailureLeavesOnlyTheError(t *testing.T) {
	for _, cmd := range []string{"receive", "pull"} {
		t.Run(cmd, func(t *testing.T) {
			isolatedEnv(t)
			peer, local := net.Pipe()
			peer.Close() // the peer is gone before the first frame
			args := []string{"receive", "483920", t.TempDir()}
			stubCrossnetReceive(t, local)
			if cmd == "pull" {
				args = []string{"pull", "example.com:/srv/tree", t.TempDir()}
				stubSSHDial(t, local)
			}

			var out, errb bytes.Buffer
			if rc := Run(args, &out, &errb); rc != 1 {
				t.Fatalf("`%s` rc=%d, want 1 (stderr %q)", cmd, rc, errb.String())
			}
			got := errb.String()
			if strings.Count(got, "\n") != 1 || !strings.HasSuffix(got, "\n") || strings.ContainsAny(got, "\r\033") {
				t.Errorf("stderr = %q, want the one error line and no control characters", got)
			}
			if out.Len() != 0 {
				t.Errorf("stdout = %q, want it empty", out.String())
			}
		})
	}
}

// scriptedOneFileSender plays a push sender of one file, path, whose body is
// body and whose claimed hash is sum, against the pipe end it returns. It ends
// by reading the receiver's Result, so a per-file failure reaches the command.
func scriptedOneFileSender(t *testing.T, path string, body []byte, sum string) (conn net.Conn, errc <-chan error) {
	t.Helper()
	peer, local := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	peer.SetDeadline(deadline)
	local.SetDeadline(deadline)
	c := make(chan error, 1)
	go func() {
		defer peer.Close()
		c <- func() error {
			if err := xfer.WriteJSON(peer, xfer.MsgHello, xfer.Hello{Version: xfer.WireVersion, Mode: "push"}); err != nil {
				return err
			}
			m := xfer.Manifest{Files: []xfer.FileEntry{{Path: path, Size: int64(len(body)), Mode: 0o644}}}
			if err := xfer.WriteJSON(peer, xfer.MsgManifest, m); err != nil {
				return err
			}
			var rs xfer.ResumeState
			if _, err := xfer.ReadJSON(peer, &rs); err != nil {
				return err
			}
			if err := xfer.WriteJSON(peer, xfer.MsgFileStart, xfer.FileStart{}); err != nil {
				return err
			}
			if _, err := peer.Write(body); err != nil {
				return err
			}
			if err := xfer.WriteJSON(peer, xfer.MsgFileHash, xfer.FileHash{SHA256: sum}); err != nil {
				return err
			}
			var res xfer.Result
			_, err := xfer.ReadJSON(peer, &res)
			return err
		}()
	}()
	return local, c
}

// A completion line is printed when the last byte arrives, which is before the
// file is verified. A file that then fails must still end the command the way it
// always did: named in the failure line, exit 1, nothing installed.
func TestReceiveCommandStillFailsAFileThatArrivedInFullButDoesNotVerify(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	conn, errc := scriptedOneFileSender(t, "bad.bin", []byte("secret"), strings.Repeat("0", 64))
	stubCrossnetReceive(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"receive", "483920", dst}, &out, &errb); rc != 1 {
		t.Fatalf("`receive` rc=%d, want 1 (stderr %q)", rc, errb.String())
	}
	if perr := <-errc; perr != nil {
		t.Fatalf("scripted sender: %v", perr)
	}
	const want = "  bad.bin (6 bytes)\n1 file(s) could not be verified or saved: [bad.bin]\n"
	if errb.String() != want {
		t.Errorf("stderr = %q\nwant     %q", errb.String(), want)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want it empty", out.String())
	}
	if left, _ := filepath.Glob(filepath.Join(dst, "*")); len(left) != 0 {
		t.Errorf("a file that failed verification left something behind: %v", left)
	}
	if left, _ := filepath.Glob(filepath.Join(dst, ".relayium-recv-*")); len(left) != 0 {
		t.Errorf("staging left behind: %v", left)
	}
}

// The same per-file failure also covers a file whose hash is right but which
// could not be saved here. The wire carries no cause, so the line must not claim
// one: this file's content matched, and "failed integrity check" said it had not.
// The refusal comes from a symlinked parent directory under the destination; a
// symlinked leaf would stop the whole push at the no-clobber preflight instead.
func TestReceiveCommandDoesNotCallAFileItCouldNotSaveAnIntegrityFailure(t *testing.T) {
	isolatedEnv(t)
	dst, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dst, "box")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	body := []byte("secret")
	sum := sha256.Sum256(body)
	conn, errc := scriptedOneFileSender(t, "box/good.bin", body, hex.EncodeToString(sum[:]))
	stubCrossnetReceive(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"receive", "483920", dst}, &out, &errb); rc != 1 {
		t.Fatalf("`receive` rc=%d, want 1 (stderr %q)", rc, errb.String())
	}
	if perr := <-errc; perr != nil {
		t.Fatalf("scripted sender: %v", perr)
	}
	const want = "1 file(s) could not be verified or saved: [box/good.bin]\n"
	if errb.String() != want {
		t.Errorf("stderr = %q\nwant     %q", errb.String(), want)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want it empty", out.String())
	}
	if left, _ := os.ReadDir(outside); len(left) != 0 {
		t.Errorf("wrote through the symlinked directory: %d entries outside", len(left))
	}
}

// ── receivers that must stay silent ─────────────────────────────────────────

// `__recv` runs on the FAR end of someone's push/sync: its stderr is relayed
// into the pusher's terminal, where push already prints this very line per
// file. Progress there would double every line (and never be a TTY).
func TestRecvHelperReportsNoProgress(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	conn, errc, _ := treeSenderOnAPipe(t)
	old := helperStdio
	helperStdio = func() io.ReadWriter { return conn }
	t.Cleanup(func() { helperStdio = old })

	var out, errb bytes.Buffer
	rc := Run([]string{"__recv", "--", dst}, &out, &errb)
	conn.Close()
	if rc != 0 {
		t.Fatalf("`__recv` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	if errb.Len() != 0 || out.Len() != 0 {
		t.Errorf("`__recv` wrote stdout %q stderr %q, want both empty", out.String(), errb.String())
	}
}

// `serve` is a long-running listener that handles peers concurrently and is
// usually a service: its stderr is a log, shared by every transfer in flight.
// It keeps its one summary line on stdout and gains nothing else.
func TestServeReportsNoProgress(t *testing.T) {
	pusherDir, serverDir, recvDir := t.TempDir(), t.TempDir(), t.TempDir()
	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	id, err := secure.LoadOrCreateIdentity(serverDir)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var sout, serr bytes.Buffer // read only after serveLoop has returned
	h := &serveHandler{
		id: id, allow: map[string]bool{pusher.Fingerprint: true}, dir: recvDir, cfgDir: serverDir,
		stdout: &sout, stderr: &serr,
	}
	done := make(chan int, 1)
	go func() { done <- serveLoop(ln, h, true /*once*/) }()

	root, _ := sendTree(t)
	var o, e bytes.Buffer
	if rc := Run([]string{"push", "--config-dir", pusherDir, root, daemonTarget(ln.Addr().(*net.TCPAddr).Port)}, &o, &e); rc != 0 {
		t.Fatalf("push rc=%d: %s", rc, e.String())
	}
	if code := waitCode(t, done); code != 0 {
		t.Fatalf("serve exit = %d: %s", code, serr.String())
	}
	if serr.Len() != 0 {
		t.Errorf("serve stderr = %q, want it empty", serr.String())
	}
	if want := fmt.Sprintf("received 3 file(s), 500005 bytes from %s\n", pusher.Fingerprint); sout.String() != want {
		t.Errorf("serve stdout = %q\nwant         %q", sout.String(), want)
	}
}

// ── the reporter, receiving ─────────────────────────────────────────────────

// The same reporter as the send side, so the same cases: only the glyph differs.
func TestRecvProgressNonTTY(t *testing.T) {
	var buf bytes.Buffer
	report := newRecvProgress(&buf).report
	for _, c := range []progressCall{
		{"a.txt", 5, 5},
		{"dir/big.bin", 32768, 500000},
		{"dir/big.bin", 65536, 500000},
		{"dir/big.bin", 500000, 500000},
		{"resumed.bin", 432768, 500000}, // opens at its offset
		{"resumed.bin", 500000, 500000},
		{"cut.bin", 32768, 100000}, // interrupted mid-file: no line
	} {
		report(c.path, c.sent, c.total)
	}
	const want = "  a.txt (5 bytes)\n  dir/big.bin (500000 bytes)\n  resumed.bin (500000 bytes)\n"
	if buf.String() != want {
		t.Errorf("output = %q\nwant     %q", buf.String(), want)
	}
}

func TestRecvProgressTTY(t *testing.T) {
	cases := []struct {
		name  string
		step  time.Duration // clock advance per bar update
		calls []progressCall
		want  string
	}{
		{"throttled, then cleared by completion", 10 * time.Millisecond, []progressCall{
			{"big", 100, 1000}, {"big", 200, 1000}, {"big", 300, 1000}, {"big", 1000, 1000},
		}, clearLine + "⇣  10%  100 B/1000 B" + clearLine + "  big (1000 bytes)\n"},
		{"repaints once the throttle window passes", time.Second, []progressCall{
			{"big", 100, 1000}, {"big", 600, 1000}, {"big", 1000, 1000},
		}, clearLine + "⇣  10%  100 B/1000 B" +
			clearLine + "⇣  60%  600 B/1000 B  500 B/s" +
			clearLine + "  big (1000 bytes)\n"},
		{"a file received in one read never paints a bar", time.Second, []progressCall{
			{"a", 5, 5}, {"b", 7, 7},
		}, "  a (5 bytes)\n  b (7 bytes)\n"},
		{"each file gets its own bar", time.Second, []progressCall{
			{"one", 100, 200}, {"one", 200, 200},
			{"two", 50, 100}, {"two", 100, 100},
		}, clearLine + "⇣  50%  100 B/200 B" + clearLine + "  one (200 bytes)\n" +
			clearLine + "⇣  50%  50 B/100 B" + clearLine + "  two (100 bytes)\n"},
		// The prefix already on this disk was not received now: 60 B/s, not 960.
		{"resumed file does not count its offset in the rate", time.Second, []progressCall{
			{"big", 900, 1000}, {"big", 960, 1000},
		}, clearLine + "⇣  90%  900 B/1000 B" + clearLine + "⇣  96%  960 B/1000 B  60 B/s"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			s := &transferProgress{w: &buf, tty: true, recv: true, now: clockFrom(tc.step)}
			for _, c := range tc.calls {
				s.report(c.path, c.sent, c.total)
			}
			if buf.String() != tc.want {
				t.Errorf("output = %q\nwant     %q", buf.String(), tc.want)
			}
		})
	}
}

// A receive that fails mid-file leaves a painted bar with the cursor at its end.
// peerReceive finishes the reporter before returning, so the error the command
// prints next is a line of its own.
func TestRecvProgressFinishTerminatesAFailedReceive(t *testing.T) {
	recvErr := errors.New("unexpected EOF")

	var buf bytes.Buffer
	s := &transferProgress{w: &buf, tty: true, recv: true, now: clockFrom(time.Second)}
	s.report("big", 100, 1000)
	s.finish()
	s.finish() // idempotent
	fmt.Fprintln(&buf, recvErr)
	if want := clearLine + "⇣  10%  100 B/1000 B" + clearLine + "unexpected EOF\n"; buf.String() != want {
		t.Errorf("TTY output = %q\nwant         %q", buf.String(), want)
	}

	// Not a TTY: no bar was ever painted, so a failed receive adds nothing.
	buf.Reset()
	s = &transferProgress{w: &buf, tty: false, recv: true, now: clockFrom(time.Second)}
	s.report("big", 100, 1000)
	s.finish()
	if buf.Len() != 0 {
		t.Errorf("non-TTY failed receive wrote %q, want nothing", buf.String())
	}
}

// On a receive the path is the peer's. It must reach the terminal as text: an
// escape sequence that repaints the SAS line two rows up, or a newline that
// forges a line, arrives visible and inert. Ordinary names are untouched.
func TestProgressLineCannotCarryTerminalControlFromThePeer(t *testing.T) {
	cases := []struct{ name, path, want string }{
		{"ordinary", "photos/IMG 0413 (1).jpg", "photos/IMG 0413 (1).jpg"},
		{"non-ASCII is not control", "文档/résumé 📄.pdf", "文档/résumé 📄.pdf"},
		{"cursor up and repaint", "x\x1b[2A\rverification code (SAS): 000000", `x\x1b[2A\rverification code (SAS): 000000`},
		{"forged line", "a\n  b (1 bytes)", `a\n  b (1 bytes)`},
		{"C1 CSI and DEL", "a\u009b2Jb\x7f", `a\u009b2Jb\x7f`},
		{"unicode line separators", "a\u2028b\u2029c", `a\u2028b\u2029c`},
		{"raw non-UTF-8 byte", "a\x9b2J", `a\x9b2J`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := termSafe(tc.path); got != tc.want {
				t.Fatalf("termSafe = %q, want %q", got, tc.want)
			}
			for _, tty := range []bool{false, true} {
				var buf bytes.Buffer
				s := &transferProgress{w: &buf, tty: tty, recv: true, now: clockFrom(time.Second)}
				s.report(tc.path, 7, 7)
				if want := "  " + tc.want + " (7 bytes)\n"; buf.String() != want {
					t.Errorf("tty=%v: line = %q, want %q", tty, buf.String(), want)
				}
			}
		})
	}
}
