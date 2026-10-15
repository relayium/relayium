package main

import (
	"bytes"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/xfer"
)

func setDuration(t *testing.T, p *time.Duration, d time.Duration) {
	t.Helper()
	old := *p
	*p = d
	t.Cleanup(func() { *p = old })
}

// tlsListener accepts one connection, completes the server side of the pinned
// TLS handshake, and hands the connection to fn.
func tlsListener(t *testing.T, fn func(c net.Conn)) string {
	t.Helper()
	id, err := secure.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		tc, _, err := secure.ServerAny(c, id)
		if err != nil {
			c.Close()
			return
		}
		fn(tc)
	}()
	return "relayium://" + ln.Addr().String()
}

func syncManifestFor(t *testing.T, size int) (xfer.Manifest, []string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "d")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, size)
	_, _ = rand.Read(b)
	if err := os.WriteFile(filepath.Join(src, "f.bin"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	m, paths, err := xfer.BuildManifest([]string{src})
	if err != nil {
		t.Fatal(err)
	}
	return m, paths
}

// TCP accepted, TLS never answered: the handshake phase has its own bound.
func TestDialDaemonHandshakeIsBounded(t *testing.T) {
	setDuration(t, &daemonHandshakeTimeout, 300*time.Millisecond)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			defer c.Close()
			time.Sleep(10 * time.Second) // accepts and says nothing
		}
	}()
	start := time.Now()
	_, err = dialDaemon("relayium://"+ln.Addr().String(), t.TempDir(), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "handshake") || !strings.Contains(err.Error(), "no answer within") {
		t.Fatalf("err = %v, want a handshake timeout", err)
	}
	if el := time.Since(start); el > 3*time.Second {
		t.Fatalf("handshake bound took %s", el)
	}
}

// TLS completes, then the receiver never answers: the transfer phase's read
// idle bound ends it.
func TestDaemonStalledReceiverReadIsBounded(t *testing.T) {
	setDuration(t, &daemonReadIdle, 300*time.Millisecond)
	release := make(chan struct{})
	defer close(release)
	target := tlsListener(t, func(c net.Conn) {
		defer c.Close()
		<-release // reads nothing, writes nothing
	})
	tconn, err := dialDaemon(target, t.TempDir(), &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	defer tconn.Close()
	m, paths := syncManifestFor(t, 1024)
	start := time.Now()
	_, err = xfer.Send(tconn, m, paths, xfer.SendOpts{Sync: true})
	if err == nil {
		t.Fatal("Send against a silent receiver succeeded")
	}
	var ne net.Error
	if !strings.Contains(err.Error(), "timeout") && !(asNetErr(err, &ne) && ne.Timeout()) {
		t.Fatalf("err = %v, want an idle timeout", err)
	}
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("stalled read took %s", el)
	}
}

// The receiver stops reading mid-body: the write idle bound ends it.
func TestDaemonStalledReceiverWriteIsBounded(t *testing.T) {
	setDuration(t, &daemonWriteIdle, 300*time.Millisecond)
	release := make(chan struct{})
	defer close(release)
	target := tlsListener(t, func(c net.Conn) {
		defer c.Close()
		// Answer the hello/manifest like a receiver, then stop reading.
		var h xfer.Hello
		if _, err := xfer.ReadJSON(c, &h); err != nil {
			return
		}
		var m xfer.Manifest
		if _, err := xfer.ReadJSON(c, &m); err != nil {
			return
		}
		_ = xfer.WriteJSON(c, xfer.MsgResume, xfer.ResumeState{})
		<-release
	})
	tconn, err := dialDaemon(target, t.TempDir(), &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	defer tconn.Close()
	m, paths := syncManifestFor(t, 64<<20) // far more than any socket buffer
	start := time.Now()
	_, err = xfer.Send(tconn, m, paths, xfer.SendOpts{})
	if err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("err = %v, want a write idle timeout", err)
	}
	if el := time.Since(start); el > 10*time.Second {
		t.Fatalf("stalled write took %s", el)
	}
}

// throttledConn delivers at most chunk bytes per read and waits gap first: a
// slow but steadily progressing link.
type throttledConn struct {
	net.Conn
	chunk int
	gap   time.Duration
	read  *atomic.Int64
}

func (c *throttledConn) Read(p []byte) (int, error) {
	time.Sleep(c.gap)
	if len(p) > c.chunk {
		p = p[:c.chunk]
	}
	n, err := c.Conn.Read(p)
	c.read.Add(int64(n))
	return n, err
}

// tlsTransferPipe exercises the actual TLS and phasedConn layers with explicit
// backpressure. A TCP receive window can stop an individual socket write even
// while the application drains buffered bytes; that is not a deterministic
// fixture for the per-operation deadline refresh this test proves. The TCP
// dial/handshake and stalled-peer tests above still exercise real sockets.
func tlsTransferPipe(t *testing.T, fn func(net.Conn)) net.Conn {
	t.Helper()
	clientID, err := secure.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	serverID, err := secure.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rawClient, rawServer := net.Pipe()
	exited := make(chan struct{})
	t.Cleanup(func() {
		rawClient.Close()
		rawServer.Close()
		select {
		case <-exited:
		case <-time.After(time.Second):
			t.Error("TLS pipe receiver did not exit")
		}
	})
	_ = rawClient.SetDeadline(time.Now().Add(daemonHandshakeTimeout))
	_ = rawServer.SetDeadline(time.Now().Add(daemonHandshakeTimeout))
	go func() {
		defer close(exited)
		defer rawServer.Close()
		c, _, err := secure.ServerAny(rawServer, serverID)
		if err != nil {
			return
		}
		_ = rawServer.SetDeadline(time.Time{})
		fn(c)
	}()
	phased := &phasedConn{Conn: rawClient, readIdle: daemonReadIdle, writeIdle: daemonWriteIdle}
	c, _, err := secure.ClientAny(phased, clientID)
	if err != nil {
		t.Fatal(err)
	}
	phased.startTransfer()
	return c
}

// A slow transfer that keeps moving bytes outlives the write idle bound many
// times over: the bound is per operation, not a cap on the whole transfer.
func TestDaemonSlowSteadyTransferOutlivesIdleBound(t *testing.T) {
	// 750 ms, not tighter: on a loaded machine (a full parallel suite) one
	// 16 KiB write can legitimately wait a few hundred milliseconds for the
	// throttled reader. The proof is the ratio below, not the absolute bound.
	const idle = 750 * time.Millisecond
	setDuration(t, &daemonWriteIdle, idle)
	setDuration(t, &daemonReadIdle, 5*time.Second) // covers draining buffered bytes before the result
	dst := t.TempDir()
	var got atomic.Int64
	done := make(chan error, 1)
	tconn := tlsTransferPipe(t, func(c net.Conn) {
		defer c.Close()
		// The receiver reads 8 KiB every 3 ms (~2.7 MB/s).
		tc := &throttledConn{Conn: c, chunk: 8 << 10, gap: 3 * time.Millisecond, read: &got}
		_, err := xfer.Receive(duplexConn{r: tc, w: c}, dst, xfer.RecvOpts{AllowSync: true})
		done <- err
	})
	const size = 10 << 20 // ~3.8 s at ~2.7 MB/s
	m, paths := syncManifestFor(t, size)
	start := time.Now()
	rep, err := xfer.Send(tconn, m, paths, xfer.SendOpts{Sync: true})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("slow but steady transfer failed after %s: %v", elapsed, err)
	}
	if rerr := <-done; rerr != nil {
		t.Fatalf("receive: %v", rerr)
	}
	if rep.Files != 1 || got.Load() < size {
		t.Fatalf("files=%d bytes read=%d", rep.Files, got.Load())
	}
	// The proof needs the transfer to have lasted well past the idle bound.
	if elapsed < 3*idle {
		t.Fatalf("transfer took only %s; the link was not slow enough to prove anything (want > %s)", elapsed, 3*idle)
	}
	installed, err := os.ReadFile(filepath.Join(dst, "d", "f.bin"))
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(installed) != size || !bytes.Equal(installed, source) {
		t.Fatalf("installed payload differs: %d bytes, want %d", len(installed), size)
	}
	t.Logf("%d bytes in %s with a %s write idle bound", size, elapsed, idle)
}

type duplexConn struct {
	r interface{ Read([]byte) (int, error) }
	w interface{ Write([]byte) (int, error) }
}

func (d duplexConn) Read(p []byte) (int, error)  { return d.r.Read(p) }
func (d duplexConn) Write(p []byte) (int, error) { return d.w.Write(p) }

func asNetErr(err error, ne *net.Error) bool {
	for e := err; e != nil; {
		if n, ok := e.(net.Error); ok {
			*ne = n
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}
