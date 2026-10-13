package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

// Phase bounds for the direct (relayium://) client. Each phase has its own
// limit, and none of them is a cap on how long a healthy transfer may take:
//
//   - dial: TCP connect (daemonDialTimeout);
//   - handshake: the pinned-TLS handshake, a fixed deadline that is cleared
//     once the listener is identified;
//   - transfer: a per-operation IDLE bound -- every read and every write gets a
//     fresh deadline, so a transfer that keeps moving bytes runs as long as it
//     needs, and one whose peer stops reading or writing fails instead of
//     hanging forever.
//
// The read bound is longer than the write bound because a receiver legitimately
// goes quiet while it works: it hashes its existing copies before answering a
// content-checked sync, and a terminal listener may be waiting for a person to
// approve this host.
var (
	daemonHandshakeTimeout = 30 * time.Second
	daemonReadIdle         = 10 * time.Minute
	daemonWriteIdle        = 2 * time.Minute
)

// phasedConn is the raw TCP connection under the client's TLS. Until transfer
// starts it touches no deadline (the caller holds one fixed handshake
// deadline); afterwards every Read and Write is bounded by its idle limit.
// Writes are split so that one deadline never has to cover more than
// maxIdleWrite bytes: a slow but steadily draining link is progress, and must
// not be mistaken for a stall because one large buffer took long in total.
type phasedConn struct {
	net.Conn
	readIdle, writeIdle time.Duration
	transfer            atomic.Bool
}

const maxIdleWrite = 16 << 10

func (c *phasedConn) startTransfer() {
	_ = c.Conn.SetDeadline(time.Time{})
	c.transfer.Store(true)
}

func (c *phasedConn) Read(p []byte) (int, error) {
	if c.transfer.Load() {
		_ = c.Conn.SetReadDeadline(time.Now().Add(c.readIdle))
	}
	return c.Conn.Read(p)
}

func (c *phasedConn) Write(p []byte) (int, error) {
	if !c.transfer.Load() {
		return c.Conn.Write(p)
	}
	written := 0
	for written < len(p) {
		end := written + maxIdleWrite
		if end > len(p) {
			end = len(p)
		}
		_ = c.Conn.SetWriteDeadline(time.Now().Add(c.writeIdle))
		n, err := c.Conn.Write(p[written:end])
		written += n
		if err != nil {
			return written, err
		}
	}
	return written, nil
}

// shutdownSignals are the signals that stop a transfer command: Ctrl-C and a
// service manager's stop.
var shutdownSignals = []os.Signal{os.Interrupt, syscall.SIGTERM}

// transferSignalContext is cancelled by the first shutdown signal. After that first
// signal the default disposition is restored, so a second Ctrl-C ends the
// process at once if a bounded drain is still not fast enough for the person.
func transferSignalContext() (context.Context, context.CancelFunc) {
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals...)
	go func() {
		<-ctx.Done()
		stop()
	}()
	return ctx, stop
}

// errTransferInterrupted is returned by sendWithShutdown when a signal stopped
// the transfer before it finished.
var errTransferInterrupted = errors.New("interrupted")

// sendWithShutdown runs xfer.Send on conn and honours ctx: once ctx is done the
// transfer gets drain to finish by itself, and is then aborted by closing the
// raw connection (never the TLS layer, whose close_notify write could block on
// a peer that stopped reading). The receiver discards whatever file was in
// flight -- it installs a file only after it verifies -- so an abort leaves no
// half file there; files it already verified stay.
//
// On an abort the returned error is errTransferInterrupted and the report is
// whatever Send completed. conn must expose its raw connection (NetConn); a
// connection that does not is closed whole.
func sendWithShutdown(ctx context.Context, conn io.ReadWriteCloser, m xfer.Manifest, srcs []string, opts xfer.SendOpts, drain time.Duration) (xfer.Report, error) {
	type result struct {
		rep xfer.Report
		err error
	}
	done := make(chan result, 1)
	go func() {
		rep, err := xfer.Send(conn, m, srcs, opts)
		done <- result{rep, err}
	}()
	select {
	case r := <-done:
		return r.rep, r.err
	case <-ctx.Done():
	}
	if drain > 0 {
		t := time.NewTimer(drain)
		defer t.Stop()
		select {
		case r := <-done:
			return r.rep, r.err
		case <-t.C:
		}
	}
	abortRaw(conn)
	// Send returns promptly once its connection is gone; bound the wait anyway.
	select {
	case r := <-done:
		return r.rep, errTransferInterrupted
	case <-time.After(5 * time.Second):
		return xfer.Report{}, errTransferInterrupted
	}
}

// abortRaw closes the connection under any TLS layer.
func abortRaw(c io.Closer) {
	if nc, ok := c.(interface{ NetConn() net.Conn }); ok {
		_ = nc.NetConn().Close()
		return
	}
	_ = c.Close()
}

// reportInterrupted says what an interrupted send did and did not do.
func reportInterrupted(rep xfer.Report, stderr io.Writer) int {
	fmt.Fprintf(stderr, "interrupted: the transfer was stopped after %d file(s) were sent. The receiver keeps only files it verified; the file in flight was discarded there.\n", rep.Files)
	return 130
}

// connTracker records the raw connections serve is handling, so a shutdown can
// abort the ones still running after the drain budget.
type connTracker struct {
	mu    sync.Mutex
	conns map[net.Conn]struct{}
	wg    sync.WaitGroup
}

func newConnTracker() *connTracker { return &connTracker{conns: map[net.Conn]struct{}{}} }

func (t *connTracker) add(c net.Conn) {
	t.mu.Lock()
	t.conns[c] = struct{}{}
	t.mu.Unlock()
	t.wg.Add(1)
}

func (t *connTracker) done(c net.Conn) {
	t.mu.Lock()
	delete(t.conns, c)
	t.mu.Unlock()
	t.wg.Done()
}

// abortAll closes every tracked raw connection and returns how many there were.
func (t *connTracker) abortAll() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	for c := range t.conns {
		_ = c.Close()
	}
	return len(t.conns)
}

// wait waits up to d for every tracked handler to return; it reports whether
// they all did.
func (t *connTracker) wait(d time.Duration) bool {
	ch := make(chan struct{})
	go func() {
		t.wg.Wait()
		close(ch)
	}()
	if d <= 0 {
		select {
		case <-ch:
			return true
		default:
			return false
		}
	}
	tm := time.NewTimer(d)
	defer tm.Stop()
	select {
	case <-ch:
		return true
	case <-tm.C:
		return false
	}
}
