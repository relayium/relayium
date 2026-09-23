package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

// These run `relayium __recv --stream-file -- <path>` as a real process (this
// test binary in its "cli" role, i.e. Run with the real stdio, signals and
// os.Exit) and speak the stream protocol to it over its stdin/stdout, the way
// ssh would carry it.

type recvProc struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    io.ReadCloser
	stderr *lockedBuffer
	done   chan struct{}
	err    error
}

func startRecvProc(t *testing.T, path string, env ...string) *recvProc {
	t.Helper()
	cmd := exec.Command(os.Args[0], "__recv", "--stream-file", "--", path)
	cmd.Env = append(append(os.Environ(), "RELAYIUM_TEST_ROLE=cli"), env...)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	p := &recvProc{cmd: cmd, in: in, out: out, stderr: &lockedBuffer{}, done: make(chan struct{})}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { p.err = cmd.Wait(); close(p.done) }()
	t.Cleanup(func() {
		select {
		case <-p.done:
		default:
			cmd.Process.Kill()
			<-p.done
		}
	})
	return p
}

func (p *recvProc) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *recvProc) Write(b []byte) (int, error) { return p.in.Write(b) }
func (p *recvProc) Abort() error {
	p.in.Close()
	p.out.Close()
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		p.cmd.Process.Kill()
		<-p.done
	}
	return nil
}

// exitCode waits (bounded) for the helper and returns its exit code.
func (p *recvProc) exitCode(t *testing.T, bound time.Duration) int {
	t.Helper()
	select {
	case <-p.done:
	case <-time.After(bound):
		t.Fatalf("helper still running after %v; stderr:\n%s", bound, p.stderr.String())
	}
	var ee *exec.ExitError
	if errors.As(p.err, &ee) {
		return ee.ExitCode()
	}
	if p.err != nil {
		t.Fatal(p.err)
	}
	return 0
}

type bytesSource struct{ r io.Reader }

func (b *bytesSource) Read(p []byte) (int, error) { return b.r.Read(p) }
func (b *bytesSource) Stop() error                { return nil }

func TestRecvStreamFileHelperInstalls(t *testing.T) {
	dir := t.TempDir()
	body := e2eRandom(t, 2*xfer.StreamChunkMax+3)
	p := startRecvProc(t, filepath.Join(dir, "f.bin"))
	rep, err := xfer.SendStream(context.Background(), p, "f.bin", func() (xfer.StreamSource, error) {
		return &bytesSource{bytes.NewReader(body)}, nil
	}, xfer.StreamSendOpts{})
	if err != nil {
		t.Fatalf("send: %v\nhelper stderr:\n%s", err, p.stderr.String())
	}
	p.in.Close()
	if code := p.exitCode(t, 5*time.Second); code != 0 {
		t.Fatalf("helper exit %d\n%s", code, p.stderr.String())
	}
	if rep.Bytes != int64(len(body)) {
		t.Fatalf("confirmed %d bytes", rep.Bytes)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.bin"))
	if !bytes.Equal(got, body) {
		t.Fatalf("installed %d bytes, want %d", len(got), len(body))
	}
	assertDirNames(t, dir, "f.bin")
}

// Every refusal happens before StreamAccept: the sender never starts its
// input, the helper exits 1, and the directory is exactly as it was.
func TestRecvStreamFileHelperRefusesBeforeAccept(t *testing.T) {
	base := t.TempDir()
	writeFile(t, filepath.Join(base, "file"), "ORIGINAL", 0o600)
	if err := os.Mkdir(filepath.Join(base, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	links := runtime.GOOS != "windows"
	if links {
		if err := os.Symlink(filepath.Join(base, "file"), filepath.Join(base, "link")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(base, "missing"), filepath.Join(base, "dangling")); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := os.ReadDir(base)
	cases := []struct{ path, code, want string }{
		{filepath.Join(base, "file"), xfer.ErrCodeDestinationExists, "already exists"},
		{filepath.Join(base, "dir"), xfer.ErrCodeDestinationExists, "is a directory"},
		{filepath.Join(base, "nope", "x"), xfer.ErrCodeInvalidDestination, "does not exist"},
		{filepath.Join(base, "file", "x"), xfer.ErrCodeInvalidDestination, "not a directory"},
		{filepath.Join(base, "dir") + "/", xfer.ErrCodeInvalidDestination, "names a directory"},
		{filepath.Join(base, ".relayium-recv-0000000000000000"), xfer.ErrCodeInvalidDestination, "not a plain file name"},
	}
	if links {
		cases = append(cases,
			struct{ path, code, want string }{filepath.Join(base, "link"), xfer.ErrCodeDestinationExists, "already exists"},
			struct{ path, code, want string }{filepath.Join(base, "dangling"), xfer.ErrCodeDestinationExists, "already exists"})
	}
	for _, tc := range cases {
		p := startRecvProc(t, tc.path)
		_, err := xfer.SendStream(context.Background(), p, leafForSend(tc.path), func() (xfer.StreamSource, error) {
			t.Errorf("%s: the input was started", tc.path)
			return nil, errors.New("must not start")
		}, xfer.StreamSendOpts{})
		var re *xfer.RemoteError
		if !errors.As(err, &re) || re.Code != tc.code || !strings.Contains(re.Msg, tc.want) {
			t.Errorf("%s: err %v, want %s containing %q\nhelper stderr:\n%s", tc.path, err, tc.code, tc.want, p.stderr.String())
		}
		if code := p.exitCode(t, 5*time.Second); code != 1 {
			t.Errorf("%s: helper exit %d, want 1", tc.path, code)
		}
	}
	after, _ := os.ReadDir(base)
	if len(before) != len(after) {
		t.Fatalf("directory changed: %v -> %v", before, after)
	}
	if b, _ := os.ReadFile(filepath.Join(base, "file")); string(b) != "ORIGINAL" {
		t.Fatalf("original changed: %q", b)
	}
}

// leafForSend is what the real sender puts in the manifest: the last
// element of the POSIX path (and nothing after a trailing slash).
func leafForSend(p string) string {
	p = filepath.ToSlash(p)
	return p[strings.LastIndexByte(p, '/')+1:]
}

// streamHandshake sends Hello and the manifest for leaf and reads Accept.
func streamHandshake(t *testing.T, p *recvProc, leaf string) {
	t.Helper()
	if err := xfer.WriteJSON(p, xfer.MsgHello, xfer.Hello{Version: xfer.WireVersion, Mode: "push", Stream: true}); err != nil {
		t.Fatal(err)
	}
	if err := xfer.WriteJSON(p, xfer.MsgManifest, xfer.Manifest{Files: []xfer.FileEntry{{Path: leaf, Size: -1}}}); err != nil {
		t.Fatal(err)
	}
	var acc xfer.StreamAccept
	if mt, err := xfer.ReadJSON(p, &acc); err != nil || mt != xfer.MsgStreamAccept {
		t.Fatalf("accept: type %d err %v\n%s", mt, err, p.stderr.String())
	}
}

func stagingDirs(t *testing.T, dir string) []string {
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

// A sender that goes silent after Accept: the helper's idle watchdog removes
// the staging and exits 1 even though its stdin stays open.
func TestRecvStreamFileHelperIdleWatchdog(t *testing.T) {
	dir := t.TempDir()
	p := startRecvProc(t, filepath.Join(dir, "x"), "RELAYIUM_TEST_RECV_IDLE=400ms")
	streamHandshake(t, p, "x")
	if err := xfer.WriteFrame(p, xfer.MsgStreamData, []byte("partial")); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	if code := p.exitCode(t, 5*time.Second); code != 1 {
		t.Fatalf("exit %d, want 1\n%s", code, p.stderr.String())
	}
	if el := time.Since(began); el < 300*time.Millisecond {
		t.Fatalf("exited after %v, before the idle bound", el)
	}
	if !strings.Contains(p.stderr.String(), "idle limit") || !strings.Contains(p.stderr.String(), "staging directory was removed") {
		t.Fatalf("stderr:\n%s", p.stderr.String())
	}
	assertDirNames(t, dir)
}

// SIGTERM to the helper mid-stream: guarded cleanup, exit 1.
func TestRecvStreamFileHelperSignalRemovesStaging(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGTERM cannot be sent to one process on Windows; the stand-in e2e covers the Windows receiver's cleanup on sender loss")
	}
	dir := t.TempDir()
	p := startRecvProc(t, filepath.Join(dir, "x"))
	streamHandshake(t, p, "x")
	if err := xfer.WriteFrame(p, xfer.MsgStreamData, bytes.Repeat([]byte{7}, 4096)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(stagingDirs(t, dir)) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("no staging directory appeared")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if code := p.exitCode(t, 5*time.Second); code != 1 {
		t.Fatalf("exit %d, want 1\n%s", code, p.stderr.String())
	}
	if !strings.Contains(p.stderr.String(), "stopped by terminated") {
		t.Fatalf("stderr:\n%s", p.stderr.String())
	}
	assertDirNames(t, dir)
}

// The confirmation cannot be delivered (the sender's reading end is gone):
// the install stands, the helper says so on stderr — never on stdout, which
// only ever carries frames — and exits 0.
func TestRecvStreamFileHelperLostReceiptIsReportedOnStderr(t *testing.T) {
	dir := t.TempDir()
	p := startRecvProc(t, filepath.Join(dir, "x"))
	streamHandshake(t, p, "x")
	body := []byte("installed without a receipt\n")
	if err := xfer.WriteFrame(p, xfer.MsgStreamData, body); err != nil {
		t.Fatal(err)
	}
	p.out.Close() // nobody will read the StreamResult
	sum := sha256.Sum256(body)
	if err := xfer.WriteJSON(p, xfer.MsgStreamEnd, xfer.StreamEnd{Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:]), Challenge: strings.Repeat("ab", 16)}); err != nil {
		t.Fatal(err)
	}
	p.in.Close()
	if code := p.exitCode(t, 5*time.Second); code != 0 {
		t.Fatalf("exit %d, want 0\n%s", code, p.stderr.String())
	}
	if !strings.Contains(p.stderr.String(), "was installed, but the confirmation could not be sent") {
		t.Fatalf("stderr:\n%s", p.stderr.String())
	}
	got, _ := os.ReadFile(filepath.Join(dir, "x"))
	if !bytes.Equal(got, body) {
		t.Fatalf("installed %q", got)
	}
	assertDirNames(t, dir, "x")
}
