package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/relayium/relayium/internal/termtext"
	"github.com/relayium/relayium/internal/xfer"
)

// `relayium push - relayium://host[:port]/path/to/file`: standard input into
// one new file under a `relayium serve` listener's --dir.
//
// The trust is exactly that of a daemon file push: the listener is pinned by
// known_hosts (TOFU on first contact, a change is refused) and accepts this
// host only once its fingerprint is authorized there. The stream protocol is
// the one `push -` uses over SSH; the listener dispatches on the Hello.
//
// Order:
//
//   - The path is checked as strictly as the listener checks it, before any
//     dial (exit 2).
//   - Dial and the pinned TLS handshake. A failure there, a fingerprint
//     change included, exits 1 with stdin unread. Signals keep their default
//     effect until the connection exists, so an interrupt during a stalled
//     dial ends the process at once; nothing reads stdin before then anyway.
//   - xfer.SendStream: the stdin pump starts only after the listener's
//     StreamAccept. A listener that never accepts — one that has not
//     authorized this host, or a release that predates `push -` — ends the
//     transfer with stdin unread.
//   - Cancelling (INT/TERM/HUP) aborts the connection: the listener sees the
//     stream end early and removes its staging; nothing is installed unless
//     the end of the stream had already been sent (then the outcome is said
//     to be unknown, as for SSH).

// Test seams: the keepalive interval of the stream (0: the library default,
// 30 seconds), and the bound of the graceful TLS close after a confirmation.
var (
	pushStdinDaemonKeepalive  time.Duration
	pushStdinDaemonCloseGrace = 10 * time.Second
)

// tlsStreamTransport is a TLS connection as a stream transport. Abort closes
// the TCP connection underneath, which releases a Read or Write blocked in
// the TLS layer at once, without the close_notify write a TLS Close attempts.
type tlsStreamTransport struct{ *tls.Conn }

func (t tlsStreamTransport) Abort() error { return t.NetConn().Close() }

func pushStdinDaemon(destArg, configDir string, stderr io.Writer) int {
	target, rel, err := parseDaemonStreamTarget(destArg)
	if err != nil {
		fmt.Fprintf(stderr, "push: %v\n", err)
		return 2
	}

	tconn, err := dialDaemon(target, configDir, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "push: %v\nNothing was read from stdin.\n", err)
		return 1
	}
	t := tlsStreamTransport{tconn}

	sc := catchStdinSignals()
	defer sc.stop()

	prog := newStreamProgress(stderr)
	rep, err := xfer.SendStream(sc.ctx, t, rel, stdinPumpStart, xfer.StreamSendOpts{Progress: prog.report, Keepalive: pushStdinDaemonKeepalive})
	prog.finish()
	for _, n := range rep.Notes {
		fmt.Fprintf(stderr, "push: note: %s\n", n)
	}
	if err != nil {
		// SendStream already aborted the connection.
		_ = tconn.Close()
		if s := sc.caught(); s != nil {
			fmt.Fprintf(stderr, "push: interrupted (%v); %v\n", s, err)
			return signalExitCode(s)
		}
		var se *xfer.StreamSendError
		var re *xfer.RemoteError
		if errors.As(err, &se) && se.Stage == xfer.StreamBeforeAccept && !errors.As(err, &re) {
			switch {
			case errors.Is(err, xfer.ErrStreamOldReceiver):
				fmt.Fprintln(stderr, "push: the listener's relayium predates \"push -\" (it answered as a file-push receiver); run \"relayium update\" there. Nothing was read from stdin and nothing was installed on the receiver.")
				return 1
			case errors.Is(err, xfer.ErrStreamNotAccepted):
				fmt.Fprintf(stderr, "push: %v\n", err)
				fmt.Fprintln(stderr, "hint: a listener closes the connection without a word when it has not authorized this host (run \"relayium id\" here, then \"relayium authorize <fingerprint>\" on the listener), and a listener older than \"push -\" does the same (run \"relayium update\" there).")
				return 1
			}
		}
		fmt.Fprintf(stderr, "push: %v\n", err)
		return 1
	}

	// Confirmed by the listener's echo of this transfer's End challenge. A
	// late close error cannot undo that; it is a note.
	if cerr := closeTLSBounded(tconn, pushStdinDaemonCloseGrace); cerr != nil {
		fmt.Fprintf(stderr, "push: note: %s was confirmed by the listener, but closing the connection reported: %v\n", termtext.Safe(rel), cerr)
	}
	fmt.Fprintf(stderr, "  %s (%d bytes, sha256 %s)\n", termtext.Safe(rel), rep.Bytes, rep.SHA256)
	return 0
}

// closeTLSBounded closes c gracefully (its close_notify write is bounded by
// crypto/tls itself), or closes the TCP connection after d.
func closeTLSBounded(c *tls.Conn, d time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- c.Close() }()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case err := <-done:
		return err
	case <-t.C:
		_ = c.NetConn().Close()
		return fmt.Errorf("the connection did not close within %v after the transfer; it was dropped", d)
	}
}
