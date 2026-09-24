package stdinpump

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test binary is its own helper until the CLI dispatches HelperArg (phase
// 2b): `<test binary> __pump-stdin --death-fd N` runs the real RunHelper.
// Two test-only roles exist besides it:
//
//	stuck:  STDINPUMP_TEST_ROLE=stuck — a helper that writes the end marker and
//	        then never exits (Stop must bound the reap).
//	victim: `<test binary> __pump-victim` — a parent that starts a real pump on
//	        its own stdin, prints the helper's PID and waits to be killed.
const victimArg = "__pump-victim"

func TestMain(m *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case HelperArg:
			if os.Getenv("STDINPUMP_TEST_ROLE") == "stuck" {
				var end [4]byte
				_, _ = os.Stdout.Write(end[:])
				time.Sleep(time.Hour)
				os.Exit(0)
			}
			os.Exit(RunHelper(os.Args[2:]))
		case victimArg:
			p, err := StartWith(Options{Exe: os.Args[0], Args: []string{HelperArg}})
			if err != nil {
				fmt.Fprintln(os.Stderr, "victim:", err)
				os.Exit(1)
			}
			fmt.Printf("helper %d\n", p.Pid())
			time.Sleep(time.Hour) // killed by the test, without any cleanup
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}

func testHelper(stdin *os.File) Options {
	return Options{Exe: os.Args[0], Args: []string{HelperArg}, Stdin: stdin}
}

// silentPipe is a stdin nobody writes to and that stays open until the test
// ends: a helper reading it blocks until it is killed.
func silentPipe(t *testing.T) (r, w *os.File) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close(); w.Close() })
	return r, w
}

// processGoneOS is the platform's own "this PID no longer names a live
// process" check where Signal(0) cannot express it (Windows; see
// pump_windows_test.go).
var processGoneOS func(pid int) bool

func processGone(pid int) bool {
	if processGoneOS != nil {
		return processGoneOS(pid)
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return true
	}
	defer p.Release()
	return errors.Is(p.Signal(syscall.Signal(0)), os.ErrProcessDone)
}

// waitGone polls processGone for at most d.
func waitGone(pid int, d time.Duration) (time.Duration, bool) {
	start := time.Now()
	for {
		if processGone(pid) {
			return time.Since(start), true
		}
		if time.Since(start) > d {
			return time.Since(start), false
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func killPid(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Kill()
		p.Release()
	}
}

// readAsync runs one Read in a goroutine and reports its result.
type readResult struct {
	n   int
	err error
	at  time.Time
}

func readAsync(p *Pump, b []byte) <-chan readResult {
	c := make(chan readResult, 1)
	go func() {
		n, err := p.Read(b)
		c <- readResult{n, err, time.Now()}
	}()
	return c
}

// U-P1: a Read blocked on a silent, open stdin is released by Stop in bounded
// time, the helper is reaped, and the error is ErrStopped — never io.EOF.
func TestPumpStopReleasesBlockedRead(t *testing.T) { testStopReleasesBlockedRead(t) }

func testStopReleasesBlockedRead(t *testing.T) {
	r, _ := silentPipe(t)
	p, err := StartWith(testHelper(r))
	if err != nil {
		t.Fatal(err)
	}
	res := readAsync(p, make([]byte, 64))
	select {
	case rr := <-res:
		t.Fatalf("Read returned before Stop: n=%d err=%v", rr.n, rr.err)
	case <-time.After(300 * time.Millisecond):
	}
	stopAt := time.Now()
	if err := p.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	select {
	case rr := <-res:
		d := rr.at.Sub(stopAt)
		t.Logf("Read released %v after Stop began (n=%d err=%v)", d, rr.n, rr.err)
		if !errors.Is(rr.err, ErrStopped) {
			t.Fatalf("Read error = %v, want ErrStopped", rr.err)
		}
		if d > time.Second {
			t.Fatalf("Read released only %v after Stop, want < 1s", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Read still blocked 5s after Stop")
	}
	if !p.Exited() {
		t.Fatal("helper not reaped after Stop returned")
	}
	if d, ok := waitGone(p.Pid(), 2*time.Second); !ok {
		killPid(p.Pid())
		t.Fatalf("helper pid %d still present %v after Stop", p.Pid(), d)
	}
	if err := p.Stop(); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
}

// U-P2: bytes arrive in order and the end marker is io.EOF; the helper exits 0
// by itself and Stop only reaps it.
func TestPumpEndMarkerIsEOF(t *testing.T) { testEndMarkerIsEOF(t) }

func testEndMarkerIsEOF(t *testing.T) {
	for _, size := range []int{0, 1, HelperChunk - 1, HelperChunk, HelperChunk + 1, 3*HelperChunk + 7} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			want := make([]byte, size)
			_, _ = rand.Read(want)
			f := tempFileWith(t, want)
			p, err := StartWith(testHelper(f))
			if err != nil {
				t.Fatal(err)
			}
			// Odd-sized reads so frame boundaries fall inside a caller's buffer.
			got, err := readAllWith(p, 7919)
			if err != io.EOF {
				t.Fatalf("final error = %v, want io.EOF", err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("got %d bytes, want %d (content differs=%v)", len(got), len(want), len(got) == len(want))
			}
			if _, err := p.Read(make([]byte, 1)); err != io.EOF {
				t.Fatalf("Read after EOF = %v, want io.EOF again", err)
			}
			if err := p.Stop(); err != nil {
				t.Fatalf("Stop: %v", err)
			}
			if code := p.cmd.ProcessState.ExitCode(); code != exitEOF {
				t.Fatalf("helper exit code %d, want %d", code, exitEOF)
			}
		})
	}
	t.Run("devnull", func(t *testing.T) {
		null, err := os.Open(os.DevNull)
		if err != nil {
			t.Fatal(err)
		}
		defer null.Close()
		p, err := StartWith(testHelper(null))
		if err != nil {
			t.Fatal(err)
		}
		if got, err := readAllWith(p, 64); err != io.EOF || len(got) != 0 {
			t.Fatalf("got %d bytes, err %v; want 0, io.EOF", len(got), err)
		}
		if err := p.Stop(); err != nil {
			t.Fatal(err)
		}
	})
}

func readAllWith(p *Pump, bufSize int) ([]byte, error) {
	var out []byte
	buf := make([]byte, bufSize)
	for {
		n, err := p.Read(buf)
		out = append(out, buf[:n]...)
		if err != nil {
			return out, err
		}
	}
}

func tempFileWith(t *testing.T, b []byte) *os.File {
	t.Helper()
	name := t.TempDir() + string(os.PathSeparator) + "stdin"
	if err := os.WriteFile(name, b, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// U-P3: a helper killed from outside (by the exact PID the pump exposes) is
// ErrHelperVanished, never io.EOF — also after some bytes were relayed.
func TestPumpKilledHelperIsNotEOF(t *testing.T) { testKilledHelperIsNotEOF(t) }

func testKilledHelperIsNotEOF(t *testing.T) {
	r, w := silentPipe(t)
	p, err := StartWith(testHelper(r))
	if err != nil {
		t.Fatal(err)
	}
	defer p.Stop()
	if _, err := w.Write([]byte("partial")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	n, err := p.Read(buf)
	if err != nil || string(buf[:n]) != "partial" {
		t.Fatalf("first Read = %q, %v", buf[:n], err)
	}
	res := readAsync(p, buf)
	killPid(p.Pid())
	select {
	case rr := <-res:
		if !errors.Is(rr.err, ErrHelperVanished) {
			t.Fatalf("Read after kill = %v, want ErrHelperVanished", rr.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Read still blocked 5s after the helper was killed")
	}
	if _, err := p.Read(buf); !errors.Is(err, ErrHelperVanished) {
		t.Fatalf("second Read = %v, want the same terminal ErrHelperVanished", err)
	}
}

// U-P4: a read error on fd 0 (fd 0 is a directory) is a *StdinError, the
// helper exits 1 by itself, and no byte is reported.
func TestPumpStdinReadErrorIsStdinError(t *testing.T) { testStdinReadErrorIsStdinError(t) }

func testStdinReadErrorIsStdinError(t *testing.T) {
	d, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	p, err := StartWith(testHelper(d))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Stop() })
	got, err := readAllWith(p, 64)
	var se *StdinError
	if !errors.As(err, &se) || len(got) != 0 {
		t.Fatalf("got %d bytes, err %v (%T); want 0 and *StdinError", len(got), err, err)
	}
	if !strings.HasPrefix(se.Error(), "reading stdin failed: ") {
		t.Fatalf("StdinError text %q", se.Error())
	}
	// The helper writes the error frame before it exits, and Stop kills a
	// helper that has not sent the end marker at once. Its own exit code is
	// only observable if it is awaited before Stop.
	if !waitFor(p.waited, 5*time.Second) {
		t.Fatal("helper did not exit by itself within 5s of its error frame")
	}
	if code := p.cmd.ProcessState.ExitCode(); code != exitStdinError {
		t.Fatalf("helper exit code %d, want %d", code, exitStdinError)
	}
	if err := p.Stop(); err != nil {
		t.Fatal(err)
	}
}

// U-P5: an interrupt delivered to the helper (as a terminal's Ctrl-C reaches
// the whole process group) does not end it; it keeps relaying, and only Stop
// ends it.
func TestPumpHelperIgnoresInterrupt(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Go cannot deliver os.Interrupt to one chosen process on Windows
		// (Process.Signal supports only Kill), and a console control event
		// would reach this test process too. The helper's handler is the same
		// signal.Notify call on every platform.
		t.Skip("os.Interrupt cannot be sent to a single process on Windows")
	}
	r, w := silentPipe(t)
	p, err := StartWith(testHelper(r))
	if err != nil {
		t.Fatal(err)
	}
	defer p.Stop()
	proc, err := os.FindProcess(p.Pid())
	if err != nil {
		t.Fatal(err)
	}
	// Give the helper time to install its handler: send the relay a byte and
	// wait until it comes back, which happens only after RunHelper started.
	if _, err := w.Write([]byte("a")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8)
	if n, err := p.Read(buf); err != nil || string(buf[:n]) != "a" {
		t.Fatalf("Read = %q, %v", buf[:n], err)
	}
	for _, sig := range []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP} {
		if err := proc.Signal(sig); err != nil {
			t.Fatalf("signal %v: %v", sig, err)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if p.Exited() {
		t.Fatalf("helper exited after an interrupt: %v", p.cmd.ProcessState)
	}
	if _, err := w.Write([]byte("b")); err != nil {
		t.Fatal(err)
	}
	if n, err := p.Read(buf); err != nil || string(buf[:n]) != "b" {
		t.Fatalf("Read after the interrupt = %q, %v; the helper must keep relaying", buf[:n], err)
	}
	if err := p.Stop(); err != nil {
		t.Fatal(err)
	}
}

// U-P6: nothing touches the shared stdin description before Start; after a
// kill mid-stream the shared offset has advanced by exactly what the helper
// read — the parent's bytes plus at most one chunk in flight — and the rest is
// still readable through the same *os.File by whoever reads it next.
func TestPumpSharedOffsetBeforeAndAfterStart(t *testing.T) { testSharedOffset(t) }

func testSharedOffset(t *testing.T) {
	const total = 3_000_000
	data := make([]byte, total)
	_, _ = rand.Read(data)
	f := tempFileWith(t, data)
	if pos, err := f.Seek(0, io.SeekCurrent); err != nil || pos != 0 {
		t.Fatalf("offset before Start = %d, %v", pos, err)
	}
	p, err := StartWith(testHelper(f))
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, HelperChunk)
	n, err := io.ReadFull(p, buf)
	if err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	if err := p.Stop(); err != nil {
		t.Fatal(err)
	}
	pos, err := f.Seek(0, io.SeekCurrent)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("parent received %d; shared offset after the kill %d; in flight in the helper %d", n, pos, pos-int64(n))
	if pos < int64(n) || pos-int64(n) > HelperChunk {
		t.Fatalf("shared offset %d not within [received %d, received+%d]", pos, n, HelperChunk)
	}
	if !bytes.Equal(buf[:n], data[:n]) {
		t.Fatal("relayed bytes differ from the input prefix")
	}
	rest, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(rest)) != total-pos || !bytes.Equal(rest, data[pos:]) {
		t.Fatalf("follower read %d bytes, want exactly the %d after the shared offset", len(rest), total-pos)
	}
}

// U-P6 (pipe form): a stdin pipe that no pump was started for keeps every byte.
func TestPumpNotStartedLeavesPipeUnread(t *testing.T) {
	r, w := silentPipe(t)
	msg := bytes.Repeat([]byte("x"), 4096)
	if _, err := w.Write(msg); err != nil {
		t.Fatal(err)
	}
	w.Close()
	got, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(got, msg) {
		t.Fatalf("read back %d bytes, %v", len(got), err)
	}
}

// U-P7: a helper that wrote the end marker but never exits is killed after
// ExitGrace and reaped; Stop returns within the bound, never hangs.
func TestPumpStopBoundsStuckHelperAfterEnd(t *testing.T) {
	defer func(e, k time.Duration) { ExitGrace, KillGrace = e, k }(ExitGrace, KillGrace)
	ExitGrace, KillGrace = 300*time.Millisecond, 5*time.Second
	t.Setenv("STDINPUMP_TEST_ROLE", "stuck")
	r, _ := silentPipe(t)
	p, err := StartWith(testHelper(r))
	if err != nil {
		t.Fatal(err)
	}
	// This helper never exits by itself: whatever Stop does, never leave it.
	t.Cleanup(func() { killPid(p.Pid()) })
	if _, err := p.Read(make([]byte, 8)); err != io.EOF {
		t.Fatalf("Read = %v, want io.EOF from the end marker", err)
	}
	start := time.Now()
	if err := p.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	d := time.Since(start)
	t.Logf("Stop returned after %v (ExitGrace %v)", d, ExitGrace)
	if d < ExitGrace || d > 2*ExitGrace+time.Second {
		t.Fatalf("Stop took %v; want the ExitGrace timer (%v) to fire, then a prompt reap", d, ExitGrace)
	}
	if st := p.cmd.ProcessState; st == nil || st.Success() {
		t.Fatalf("stuck helper state %v; want killed", st)
	}
	if d, ok := waitGone(p.Pid(), 2*time.Second); !ok {
		killPid(p.Pid())
		t.Fatalf("stuck helper pid %d present %v after Stop", p.Pid(), d)
	}
}

// U-P8: a parent killed without any cleanup does not leave its helper reading
// the user's stdin: the parent-death pipe ends the helper even though stdin
// stays silent and open.
func TestPumpHelperExitsOnParentDeath(t *testing.T) { testHelperExitsOnParentDeath(t) }

func testHelperExitsOnParentDeath(t *testing.T) {
	r, _ := silentPipe(t) // the victim's stdin, and so the helper's
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer outR.Close()
	victim := exec.Command(os.Args[0], victimArg)
	victim.Stdin = r
	victim.Stdout = outW
	victim.Stderr = os.Stderr
	if err := victim.Start(); err != nil {
		t.Fatal(err)
	}
	outW.Close()
	defer func() { _ = victim.Process.Kill(); _ = victim.Wait() }()

	line := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(outR).ReadString('\n')
		line <- s
	}()
	var hpid int
	select {
	case s := <-line:
		if _, err := fmt.Sscanf(s, "helper %d", &hpid); err != nil {
			t.Fatalf("victim said %q", s)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("victim did not report its helper")
	}
	if processGone(hpid) {
		t.Fatalf("helper %d not running before the parent's death", hpid)
	}
	if err := victim.Process.Kill(); err != nil { // SIGKILL / TerminateProcess: no cleanup runs
		t.Fatal(err)
	}
	_ = victim.Wait()
	d, ok := waitGone(hpid, 3*time.Second)
	if !ok {
		killPid(hpid)
		t.Fatalf("helper %d still alive %v after its parent was killed (stdin silent and open)", hpid, d)
	}
	t.Logf("helper %d gone %v after its parent was killed", hpid, d)
}

// Framing of the relay itself, in process.
func TestHelperFraming(t *testing.T) {
	t.Run("data then end", func(t *testing.T) {
		var out bytes.Buffer
		in := io.MultiReader(bytes.NewReader([]byte("abc")), bytes.NewReader([]byte("de")))
		if code := pumpLoop(in, &out); code != exitEOF {
			t.Fatalf("exit %d", code)
		}
		want := append(append(frame([]byte("abc")), frame([]byte("de"))...), 0, 0, 0, 0)
		if !bytes.Equal(out.Bytes(), want) {
			t.Fatalf("frames %x, want %x", out.Bytes(), want)
		}
	})
	t.Run("read error", func(t *testing.T) {
		var out bytes.Buffer
		if code := pumpLoop(errReader{errors.New("boom")}, &out); code != exitStdinError {
			t.Fatalf("exit %d", code)
		}
		b := out.Bytes()
		if binary.BigEndian.Uint32(b[:4]) != frameErr || string(b[8:]) != "boom" || int(binary.BigEndian.Uint32(b[4:8])) != 4 {
			t.Fatalf("error frame %x", b)
		}
	})
	t.Run("output gone", func(t *testing.T) {
		if code := pumpLoop(bytes.NewReader([]byte("x")), errWriter{}); code != exitOutputGone {
			t.Fatalf("exit %d", code)
		}
	})
	t.Run("usage", func(t *testing.T) {
		for _, args := range [][]string{nil, {DeathFlag}, {"--x", "3"}, {DeathFlag, "-1"}, {DeathFlag, "3", "x"}} {
			var errOut bytes.Buffer
			if code := runHelper(args, bytes.NewReader(nil), io.Discard, &errOut); code != exitUsage {
				t.Fatalf("%q: exit %d", args, code)
			}
		}
	})
}

func frame(b []byte) []byte {
	h := make([]byte, 4, 4+len(b))
	binary.BigEndian.PutUint32(h, uint32(len(b)))
	return append(h, b...)
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

type errWriter struct{}

func (errWriter) Write([]byte) (int, error) { return 0, errors.New("closed") }

// Decoding of what arrives on the pipe, independent of a real helper.
func TestPumpReadDecoding(t *testing.T) {
	cases := []struct {
		name    string
		stream  []byte
		wantErr func(error) bool
		wantOut string
	}{
		{"bare EOF is vanished", nil, func(e error) bool { return errors.Is(e, ErrHelperVanished) }, ""},
		{"truncated header", []byte{0, 0}, func(e error) bool { return errors.Is(e, ErrHelperVanished) }, ""},
		{"truncated data", frame([]byte("abcd"))[:6], func(e error) bool { return errors.Is(e, ErrHelperVanished) }, "ab"},
		{"data without marker", frame([]byte("abcd")), func(e error) bool { return errors.Is(e, ErrHelperVanished) }, "abcd"},
		{"oversize frame", func() []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, HelperChunk+1); return b }(), func(e error) bool { return errors.Is(e, errMalformed) }, ""},
		{"oversize error message", func() []byte {
			b := make([]byte, 8)
			binary.BigEndian.PutUint32(b, frameErr)
			binary.BigEndian.PutUint32(b[4:], maxErrMsgBytes+1)
			return b
		}(), func(e error) bool { return errors.Is(e, errMalformed) }, ""},
		{"marker", append(frame([]byte("xy")), 0, 0, 0, 0), func(e error) bool { return e == io.EOF }, "xy"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			go func() { w.Write(c.stream); w.Close() }()
			p := &Pump{pr: r}
			got, err := readAllWith(p, 3)
			if !c.wantErr(err) || string(got) != c.wantOut {
				t.Fatalf("got %q, %v", got, err)
			}
		})
	}
}
