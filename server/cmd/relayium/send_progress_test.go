package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

// sendTree writes the fixture every command-level case below sends: a small
// file, one spanning three 192 KiB chunks, and an empty one. WalkDir is
// lexical, so the manifest order is a.txt, big.bin, empty.
func sendTree(t *testing.T) (root string, big []byte) {
	t.Helper()
	root = filepath.Join(t.TempDir(), "tree")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	big = bytes.Repeat([]byte("relayium"), 62500) // 500000 bytes
	for name, body := range map[string][]byte{"a.txt": []byte("hello"), "big.bin": big, "empty": nil} {
		if err := os.WriteFile(filepath.Join(root, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root, big
}

// receiverOnAPipe runs a real receiver against the pipe end it returns, so the
// sending command under test faces the actual protocol.
func receiverOnAPipe(t *testing.T, dst string) (net.Conn, <-chan error) {
	t.Helper()
	peer, local := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	peer.SetDeadline(deadline)
	local.SetDeadline(deadline)
	errc := make(chan error, 1)
	go func() {
		_, rerr := xfer.Receive(peer, dst, xfer.RecvOpts{})
		peer.Close()
		errc <- rerr
	}()
	return local, errc
}

func stubCrossnetSend(t *testing.T, conn net.Conn) {
	t.Helper()
	old := crossnetSendDial
	crossnetSendDial = func(_ context.Context, _ string, _ crossFlags, _ io.Writer) (io.ReadWriteCloser, error) {
		return conn, nil
	}
	t.Cleanup(func() { crossnetSendDial = old })
}

// The adapter is only correct for the way xfer.Send actually reports. Pin that
// here, next to the code that depends on it: one call per written chunk,
// cumulative within the file, the last one at sent == total, and no call at
// all for an empty file.
func TestSendReportsProgressPerChunkAndNeverForAnEmptyFile(t *testing.T) {
	root, _ := sendTree(t)
	m, srcs, err := xfer.BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	conn, errc := receiverOnAPipe(t, t.TempDir())
	defer conn.Close()

	type call struct {
		path        string
		sent, total int64
	}
	var got []call
	if _, err := xfer.Send(conn, m, srcs, xfer.SendOpts{Progress: func(p string, sent, total int64) {
		got = append(got, call{p, sent, total})
	}}); err != nil {
		t.Fatal(err)
	}
	if rerr := <-errc; rerr != nil {
		t.Fatalf("receiver: %v", rerr)
	}
	want := []call{
		{"tree/a.txt", 5, 5},
		{"tree/big.bin", 196608, 500000},
		{"tree/big.bin", 393216, 500000},
		{"tree/big.bin", 500000, 500000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Progress calls = %v\nwant %v", got, want)
	}
}

// `send` passed an empty SendOpts, so a cross-network transfer printed nothing
// at all while every other send path reported each file.
func TestSendCommandReportsProgress(t *testing.T) {
	isolatedEnv(t)
	root, big := sendTree(t)
	dst := t.TempDir()
	conn, errc := receiverOnAPipe(t, dst)
	stubCrossnetSend(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"send", root, "483920"}, &out, &errb); rc != 0 {
		t.Fatalf("`send` rc=%d: %s", rc, errb.String())
	}
	if rerr := <-errc; rerr != nil {
		t.Fatalf("receiver: %v", rerr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "tree", "big.bin")); !bytes.Equal(got, big) {
		t.Fatalf("`send` delivered %d bytes of big.bin, want %d", len(got), len(big))
	}
	// Not a TTY: one line per completed file — none per chunk, none for the
	// empty file — and nothing on stdout.
	const want = "  tree/a.txt (5 bytes)\n  tree/big.bin (500000 bytes)\n"
	if errb.String() != want {
		t.Errorf("stderr = %q\nwant     %q", errb.String(), want)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want it empty", out.String())
	}
}

func TestSendCommandFailureLeavesOnlyTheError(t *testing.T) {
	isolatedEnv(t)
	root, _ := sendTree(t)
	peer, local := net.Pipe()
	peer.Close() // the peer is gone before the first frame
	stubCrossnetSend(t, local)

	var out, errb bytes.Buffer
	if rc := Run([]string{"send", root, "483920"}, &out, &errb); rc != 1 {
		t.Fatalf("`send` rc=%d, want 1 (stderr %q)", rc, errb.String())
	}
	got := errb.String()
	if strings.Count(got, "\n") != 1 || !strings.HasSuffix(got, "\n") || strings.ContainsAny(got, "\r\033") {
		t.Errorf("stderr = %q, want the one error line and no control characters", got)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want it empty", out.String())
	}
}

type progressCall struct {
	path        string
	sent, total int64
}

// Into a writer that is not a terminal — a pipe, a CI log — the output is the
// per-file completion line and nothing else.
func TestSendProgressNonTTY(t *testing.T) {
	cases := []struct {
		name  string
		calls []progressCall
		want  string
	}{
		{"several files, one of them chunked", []progressCall{
			{"a.txt", 5, 5},
			{"dir/big.bin", 196608, 500000},
			{"dir/big.bin", 393216, 500000},
			{"dir/big.bin", 500000, 500000},
			{"z.txt", 1, 1},
		}, "  a.txt (5 bytes)\n  dir/big.bin (500000 bytes)\n  z.txt (1 bytes)\n"},
		{"resumed file opens at its offset", []progressCall{
			{"big.bin", 400000, 500000},
			{"big.bin", 500000, 500000},
		}, "  big.bin (500000 bytes)\n"},
		{"interrupted mid-file", []progressCall{
			{"big.bin", 196608, 500000},
		}, ""},
		// Only a file that changed under the send produces these; Send fails it.
		{"empty in the manifest, bytes on disk", []progressCall{
			{"grew", 10, 0},
			{"grew", 20, 0},
		}, ""},
		{"grew past its manifest size", []progressCall{
			{"grew", 196608, 100},
		}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			report := newSendProgress(&buf).report
			for _, c := range tc.calls {
				report(c.path, c.sent, c.total)
			}
			if buf.String() != tc.want {
				t.Errorf("output = %q\nwant     %q", buf.String(), tc.want)
			}
		})
	}
}

const clearLine = "\r\033[K"

func TestSendProgressTTY(t *testing.T) {
	cases := []struct {
		name  string
		step  time.Duration // clock advance per bar update
		calls []progressCall
		want  string
	}{
		// 10ms/update: everything after the first paint is inside the 100ms
		// throttle. Completion clears the bar and leaves the file's line.
		{"throttled, then cleared by completion", 10 * time.Millisecond, []progressCall{
			{"big", 100, 1000}, {"big", 200, 1000}, {"big", 300, 1000}, {"big", 1000, 1000},
		}, clearLine + "⇡  10%  100 B/1000 B" + clearLine + "  big (1000 bytes)\n"},
		// 1s/update clears the throttle, so every update repaints — with a rate
		// counted from where the bar started.
		{"repaints once the throttle window passes", time.Second, []progressCall{
			{"big", 100, 1000}, {"big", 600, 1000}, {"big", 1000, 1000},
		}, clearLine + "⇡  10%  100 B/1000 B" +
			clearLine + "⇡  60%  600 B/1000 B  500 B/s" +
			clearLine + "  big (1000 bytes)\n"},
		{"a file sent in one chunk never paints a bar", time.Second, []progressCall{
			{"a", 5, 5}, {"b", 7, 7},
		}, "  a (5 bytes)\n  b (7 bytes)\n"},
		{"each file gets its own bar", time.Second, []progressCall{
			{"one", 100, 200}, {"one", 200, 200},
			{"two", 50, 100}, {"two", 100, 100},
		}, clearLine + "⇡  50%  100 B/200 B" + clearLine + "  one (200 bytes)\n" +
			clearLine + "⇡  50%  50 B/100 B" + clearLine + "  two (100 bytes)\n"},
		// A resumed file opens at its offset; those bytes were not sent now, so
		// the rate is 60 B/s, not 960 B/s.
		{"resumed file does not count its offset in the rate", time.Second, []progressCall{
			{"big", 900, 1000}, {"big", 960, 1000},
		}, clearLine + "⇡  90%  900 B/1000 B" + clearLine + "⇡  96%  960 B/1000 B  60 B/s"},
		{"manifest size 0 shows bytes and no percentage", time.Second, []progressCall{
			{"grew", 10, 0}, {"grew", 20, 0},
		}, clearLine + "⇡ 10 B" + clearLine + "⇡ 20 B  10 B/s"},
		{"past the manifest size is capped at 100%", time.Second, []progressCall{
			{"grew", 300, 100},
		}, clearLine + "⇡ 100%  300 B/100 B"},
		// Send never switches file mid-file; if a reporter is ever reused that
		// way, the old bar is cleared rather than painted over.
		{"a new path clears the previous bar first", time.Second, []progressCall{
			{"one", 100, 200}, {"two", 50, 100},
		}, clearLine + "⇡  50%  100 B/200 B" + clearLine + clearLine + "⇡  50%  50 B/100 B"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			s := &transferProgress{w: &buf, tty: true, now: clockFrom(tc.step)}
			for _, c := range tc.calls {
				s.report(c.path, c.sent, c.total)
			}
			if buf.String() != tc.want {
				t.Errorf("output = %q\nwant     %q", buf.String(), tc.want)
			}
		})
	}
}

// A send that fails mid-file leaves a painted bar with the cursor at its end.
// finish must clear it so the error the caller prints next is a line of its
// own, and must cost nothing when no bar is up.
func TestSendProgressFinishTerminatesAFailedSend(t *testing.T) {
	sendErr := errors.New("write tcp: broken pipe")

	var buf bytes.Buffer
	s := &transferProgress{w: &buf, tty: true, now: clockFrom(time.Second)}
	s.report("big", 100, 1000)
	s.finish()
	s.finish() // idempotent
	fmt.Fprintln(&buf, sendErr)
	if want := clearLine + "⇡  10%  100 B/1000 B" + clearLine + "write tcp: broken pipe\n"; buf.String() != want {
		t.Errorf("TTY output = %q\nwant         %q", buf.String(), want)
	}

	// Nothing in flight — before the first file, or after a completed one —
	// means nothing to clear.
	for _, tty := range []bool{true, false} {
		buf.Reset()
		s := &transferProgress{w: &buf, tty: tty, now: clockFrom(time.Second)}
		s.finish()
		s.report("big", 100, 1000)
		s.report("big", 1000, 1000)
		before := buf.String()
		s.finish()
		if buf.String() != before {
			t.Errorf("tty=%v: finish with nothing in flight wrote %q", tty, strings.TrimPrefix(buf.String(), before))
		}
	}

	// Not a TTY: no bar was ever painted, so a failed send adds nothing either.
	buf.Reset()
	s = &transferProgress{w: &buf, tty: false, now: clockFrom(time.Second)}
	s.report("big", 100, 1000)
	s.finish()
	if buf.Len() != 0 {
		t.Errorf("non-TTY failed send wrote %q, want nothing", buf.String())
	}
}
