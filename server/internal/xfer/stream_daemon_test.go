package xfer

// ReceiveAny: the listener's dispatch between a v1 batch and a `push -`
// stream, the strict relative path, and the stream's bounds over a real
// loopback TCP connection (its deadlines are kernel deadlines, as on the
// listener's TLS connection).

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// tcpPair is a connected loopback TCP pair: the client end and the server end.
func tcpPair(t *testing.T) (client, server net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	acc := make(chan net.Conn, 1)
	go func() {
		c, _ := ln.Accept()
		acc <- c
	}()
	client, err = net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server = <-acc
	if server == nil {
		t.Fatal("accept failed")
	}
	t.Cleanup(func() { client.Close(); server.Close() })
	return client, server
}

type anyResult struct {
	rep AnyReport
	err error
}

// receiveAnyAsync runs ReceiveAny on the server end, as serve does: rw is the
// connection (serve wraps it in its idle wrapper; the wrapper is not part of
// this package), sp the same connection.
func receiveAnyAsync(server net.Conn, dir string, opts RecvOpts, so StreamRecvOpts) <-chan anyResult {
	c := make(chan anyResult, 1)
	go func() {
		defer server.Close()
		rep, err := ReceiveAny(server, server, dir, opts, so)
		c <- anyResult{rep, err}
	}()
	return c
}

func waitAny(t *testing.T, c <-chan anyResult, d time.Duration) anyResult {
	t.Helper()
	select {
	case r := <-c:
		return r
	case <-time.After(d):
		t.Fatalf("ReceiveAny did not return within %v", d)
	}
	return anyResult{}
}

func TestValidateStreamPath(t *testing.T) {
	for _, p := range []string{"x", "a/b/c.bin", "dir/.hidden", "ü/日本.txt", "a b/c d", "-x", strings.Repeat("d/", 63) + "x",
		strings.Repeat("n", 255), ".relayium-recv", "x.relayium-recv-1"} {
		if err := ValidateStreamPath(p); err != nil {
			t.Errorf("%q refused: %v", p, err)
		}
	}
	for _, p := range []string{"", "/", "/x", "x/", "a//b", ".", "..", "./x", "a/./b", "a/../b", "../x", "a/..",
		"a\\b", "c:x", "a/b:c", "a\x00b", "a\x01b", "a\x1fb", "a\x7fb", "a\nb", "\xff\xfe", ".relayium-recv-00/x", "a/.relayium-recv-11",
		strings.Repeat("d/", 64) + "x", strings.Repeat("n", 256), strings.Repeat("a/", 2048) + "x"} {
		if err := ValidateStreamPath(p); err == nil {
			t.Errorf("%q accepted", p)
		}
	}
}

// The v1 body behind ReceiveAny is Receive's: a v1 Send lands exactly as
// before, with the options serve passes.
func TestReceiveAnyDispatchesV1Unchanged(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "d", "b.txt"), []byte("bravo"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, paths, err := BuildManifest([]string{filepath.Join(src, "a.txt"), filepath.Join(src, "d")})
	if err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	client, server := tcpPair(t)
	rc := receiveAnyAsync(server, dst, RecvOpts{AllowSync: true}, StreamRecvOpts{})
	if _, err := Send(client, m, paths, SendOpts{}); err != nil {
		t.Fatal(err)
	}
	r := waitAny(t, rc, 10*time.Second)
	if r.err != nil || r.rep.Stream || r.rep.V1.Files != 2 {
		t.Fatalf("%+v %v", r.rep, r.err)
	}
	for p, want := range map[string]string{"a.txt": "alpha", "d/b.txt": "bravo"} {
		if b, err := os.ReadFile(filepath.Join(dst, filepath.FromSlash(p))); err != nil || string(b) != want {
			t.Fatalf("%s: %q %v", p, b, err)
		}
	}
}

// A stream into a relative path under the listener's directory, through a
// symbolic link that stays inside it; a stream never replaces anything, even
// where the v1 options allow sync.
func TestReceiveAnyStreamInstallsUnderRoot(t *testing.T) {
	dst := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dst, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := specialBytes(3*StreamChunkMax + 5)
	client, server := tcpPair(t)
	rc := receiveAnyAsync(server, dst, RecvOpts{AllowSync: true, AllowDelete: true}, StreamRecvOpts{})
	rep, err := SendStream(context.Background(), &connTransport{Conn: client}, "a/b/c.bin", startOf(newSource(body, 64<<10)), StreamSendOpts{})
	if err != nil || rep.Bytes != int64(len(body)) {
		t.Fatalf("%+v %v", rep, err)
	}
	r := waitAny(t, rc, 10*time.Second)
	if r.err != nil || !r.rep.Stream || r.rep.StreamPath != "a/b/c.bin" || !r.rep.Streamed.Installed {
		t.Fatalf("%+v %v", r.rep, r.err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "a", "b", "c.bin")); err != nil || !bytes.Equal(b, body) {
		t.Fatalf("installed %d bytes %v", len(b), err)
	}
	assertNoStaging(t, filepath.Join(dst, "a", "b"))

	// Existing file, sync allowed for v1: still refused, still unread.
	client, server = tcpPair(t)
	rc = receiveAnyAsync(server, dst, RecvOpts{AllowSync: true}, StreamRecvOpts{})
	var started atomic.Bool
	_, err = SendStream(context.Background(), &connTransport{Conn: client}, "a/b/c.bin", noStart(t, &started), StreamSendOpts{})
	var re *RemoteError
	if !errors.As(err, &re) || re.Code != ErrCodeDestinationExists {
		t.Fatalf("%v", err)
	}
	waitAny(t, rc, 10*time.Second)
	if b, _ := os.ReadFile(filepath.Join(dst, "a", "b", "c.bin")); !bytes.Equal(b, body) {
		t.Fatal("the existing file changed")
	}

	if err := os.Symlink(filepath.Join("a", "b"), filepath.Join(dst, "in")); err != nil {
		t.Logf("no symbolic links here (%v); in-root link case not run", err)
		return
	}
	client, server = tcpPair(t)
	rc = receiveAnyAsync(server, dst, RecvOpts{}, StreamRecvOpts{})
	if _, err := SendStream(context.Background(), &connTransport{Conn: client}, "in/via-link", startOf(newSource([]byte("linked"), 64<<10)), StreamSendOpts{}); err != nil {
		t.Fatal(err)
	}
	if r := waitAny(t, rc, 10*time.Second); r.err != nil {
		t.Fatal(r.err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "a", "b", "via-link")); err != nil || string(b) != "linked" {
		t.Fatalf("%q %v", b, err)
	}
}

// Every path the listener refuses is refused with invalid_destination before
// StreamAccept (the source is never started) and creates nothing, inside or
// outside the listener's directory. Raw frames, so the sender's own check
// cannot hide the listener's.
func TestReceiveAnyStreamRefusesPathsBeforeAccept(t *testing.T) {
	dst, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(dst, "afile"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{
		"":                       "is empty",
		"../x":                   `".." component`,
		"a/../x":                 `".." component`,
		"./x":                    `".." component`,
		"/abs":                   "is absolute",
		"a//b":                   "empty component",
		"a\\b":                   `"\" or ":"`,
		"c:x":                    `"\" or ":"`,
		".relayium-recv-00/x":    "staging",
		"missing/x":              "does not exist under the listener's directory",
		"afile/x":                "afile is not a directory",
		strings.Repeat("n", 256): "longer than 255",
	}
	if err := os.Symlink(outside, filepath.Join(dst, "esc")); err == nil {
		paths["esc/x"] = "leads outside the listener's directory"
		if err := os.Symlink(filepath.Join("..", filepath.Base(outside)), filepath.Join(dst, "relesc")); err != nil {
			t.Fatal(err)
		}
		paths["relesc/x"] = "leads outside the listener's directory"
	} else {
		t.Logf("no symbolic links here (%v); escape cases not run", err)
	}
	before := listDir(t, dst)
	for p, want := range paths {
		client, server := tcpPair(t)
		rc := receiveAnyAsync(server, dst, RecvOpts{AllowSync: true}, StreamRecvOpts{})
		var started atomic.Bool
		_, err := SendStream(context.Background(), &connTransport{Conn: client}, p, noStart(t, &started), StreamSendOpts{})
		var re *RemoteError
		if !errors.As(err, &re) || re.Code != ErrCodeInvalidDestination || !strings.Contains(re.Msg, want) {
			t.Errorf("%q: %v, want invalid_destination containing %q", p, err, want)
		}
		if strings.Contains(re.Msg, dst) || strings.Contains(re.Msg, outside) {
			t.Errorf("%q: the refusal names a listener path: %q", p, re.Msg)
		}
		if r := waitAny(t, rc, 10*time.Second); r.err == nil || !r.rep.Stream {
			t.Errorf("%q: listener %+v %v", p, r.rep, r.err)
		}
	}
	if after := listDir(t, dst); strings.Join(after, " ") != strings.Join(before, " ") {
		t.Fatalf("listener dir %v, was %v", after, before)
	}
	if l := listDir(t, outside); len(l) != 0 {
		t.Fatalf("outside dir got %v", l)
	}
}

// D-R1 / W-6: a local write failure on the listener while the sender does
// not read: ReceiveAny returns within the write bound plus the drain bound
// (a flooding sender ends the drain at DrainMax, a silent one at Drain), with
// its staging removed and nothing installed.
func TestReceiveAnyStreamWriteFailedBoundedTCP(t *testing.T) {
	for _, flood := range []bool{true, false} {
		name := "silent sender"
		if flood {
			name = "flooding sender"
		}
		t.Run(name, func(t *testing.T) {
			failAfter(t, 4, nil)
			dst := t.TempDir()
			client, server := tcpPair(t)
			so := StreamRecvOpts{WriteTimeout: 300 * time.Millisecond, Drain: 300 * time.Millisecond}
			rc := receiveAnyAsync(server, dst, RecvOpts{AllowSync: true}, so)
			if err := WriteJSON(client, MsgHello, Hello{Version: WireVersion, Mode: "push", Stream: true}); err != nil {
				t.Fatal(err)
			}
			if err := WriteJSON(client, MsgManifest, Manifest{Files: []FileEntry{{Path: "out.bin", Size: -1}}}); err != nil {
				t.Fatal(err)
			}
			if typ, _, err := ReadFrame(client); err != nil || typ != MsgStreamAccept {
				t.Fatalf("accept: %v %v", typ, err)
			}
			chunk := appendFrame(nil, MsgStreamData, bytes.Repeat([]byte{7}, 64<<10))
			if _, err := client.Write(chunk); err != nil {
				t.Fatal(err)
			}
			stop := make(chan struct{})
			defer close(stop)
			if flood { // keep sending, never read
				go func() {
					for {
						select {
						case <-stop:
							return
						default:
						}
						if _, err := client.Write(chunk); err != nil {
							return
						}
					}
				}()
			}
			start := time.Now()
			r := waitAny(t, rc, 10*time.Second)
			d := time.Since(start)
			t.Logf("returned after %v: %v", d, r.err)
			if r.err == nil || !strings.Contains(r.err.Error(), "failed") || d > so.WriteTimeout+so.Drain+2*time.Second {
				t.Fatalf("returned %v after %v", r.err, d)
			}
			if l := listDir(t, dst); len(l) != 0 {
				t.Fatalf("left %v", l)
			}
		})
	}
}

// A listener's idle bound applies to the stream: a sender that goes silent
// after Accept is dropped within Idle, its staging removed.
func TestReceiveAnyStreamIdleTCP(t *testing.T) {
	dst := t.TempDir()
	client, server := tcpPair(t)
	rc := receiveAnyAsync(server, dst, RecvOpts{}, StreamRecvOpts{Idle: 300 * time.Millisecond})
	if err := WriteJSON(client, MsgHello, Hello{Version: WireVersion, Mode: "push", Stream: true}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(client, MsgManifest, Manifest{Files: []FileEntry{{Path: "x", Size: -1}}}); err != nil {
		t.Fatal(err)
	}
	if typ, _, err := ReadFrame(client); err != nil || typ != MsgStreamAccept {
		t.Fatalf("accept: %v %v", typ, err)
	}
	r := waitAny(t, rc, 5*time.Second)
	if r.err == nil || !strings.Contains(r.err.Error(), "nothing was installed") {
		t.Fatalf("%v", r.err)
	}
	if l := listDir(t, dst); len(l) != 0 {
		t.Fatalf("left %v", l)
	}
}
