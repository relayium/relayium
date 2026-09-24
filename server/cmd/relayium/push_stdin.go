package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/stdinpump"
	"github.com/relayium/relayium/internal/termtext"
	"github.com/relayium/relayium/internal/xfer"
	"golang.org/x/term"
)

// `relayium push - [user@]host:file` and `relayium push - relayium://host[:port]/path`:
// standard input, of any length, into one new file on a remote that runs
// relayium — over SSH, or straight to a `relayium serve` listener.
//
// The order below is the contract (see pushStdin and pushStdinDaemon):
//
//   - Every refusal this side can make by itself (a terminal as stdin, a
//     destination shape that is not one file, no relayium on the remote, ssh
//     failing to connect, a listener that cannot be reached or whose pinned
//     fingerprint changed) happens before anything reads stdin.
//   - Nothing in this process ever reads fd 0. After the remote receiver has
//     accepted the stream, xfer.SendStream starts an exact-owned helper
//     process (`relayium __pump-stdin`, stdinpump) that inherits fd 0 and is
//     its only reader; stopping it is a kill of that one PID.
//   - Diagnostics, notes and progress go to stderr. stdout is not written.

// stdinSession is what `push -` needs from its SSH transport. *sshx.Session
// is one; tests substitute a fake to observe that failures Abort and never
// Close.
type stdinSession interface {
	io.ReadWriter
	Abort() error
	Close() error
	Wait() error
}

// Seams for tests. Production values are the real terminal test, the real
// ssh probe and dial, the real helper process and real signals.
var (
	// pushStdinIsTerminal is the real terminal test on standard input (an
	// ioctl via x/term; on Windows GetConsoleMode). It reads no byte, and it
	// uses the raw descriptor rather than os.Stdin.Fd(), which on Unix would
	// switch a non-blocking fd 0 to blocking mode — a flag of a file
	// description this process shares with its shell and siblings.
	pushStdinIsTerminal = func() bool { return term.IsTerminal(int(syscall.Stdin)) }

	stdinRemoteHasRelayium = sshx.RemoteHasRelayium

	stdinSSHDial = func(e xfer.Endpoint, remoteCmd string, o sshx.Opts) (stdinSession, error) {
		s, err := sshx.Dial(e, remoteCmd, o)
		if err != nil {
			return nil, err
		}
		return s, nil
	}

	// stdinPumpStart is called by xfer.SendStream only after the receiver's
	// StreamAccept: `<this executable> __pump-stdin` with fd 0 inherited.
	stdinPumpStart = func() (xfer.StreamSource, error) {
		p, err := stdinpump.Start()
		if err != nil {
			return nil, err
		}
		return p, nil
	}

	// pushStdinNotify registers c for the signals that cancel a `push -`.
	pushStdinNotify = func(c chan<- os.Signal) (stop func()) {
		signal.Notify(c, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
		return func() { signal.Stop(c) }
	}

	// pushStdinCloseGrace bounds the graceful ssh close after a confirmed
	// transfer; a remote that keeps the channel open is then aborted.
	pushStdinCloseGrace = 10 * time.Second
)

// streamRecvCommand is the remote command `push -` runs. The "--" keeps a
// destination starting with "-" from being read as a flag.
func streamRecvCommand(path string) string {
	return "relayium __recv --stream-file -- " + sshx.ShellQuote(path)
}

// pushStdinDestRefusal names why p cannot be one file by its shape alone, or
// returns "". The shapes are the same as for `pull host:file -`.
func pushStdinDestRefusal(p string) string { return stdoutSourceRefusal(p) }

// streamLeaf is the last element of a POSIX remote path the shape check
// accepted.
func streamLeaf(p string) string { return p[strings.LastIndexByte(p, '/')+1:] }

// signalExitCode is the conventional 128+N exit status for a signal.
func signalExitCode(s os.Signal) int {
	if n, ok := s.(syscall.Signal); ok {
		return 128 + int(n)
	}
	return 130
}

// pushStdin is `push - destArg`. It returns the exit code: 2 for a refusal
// of the command line or of a terminal stdin, 1 for any transfer failure,
// 128+N after signal N, 0 when the receiver confirmed exactly the bytes sent.
func pushStdin(destArg string, f sshFlags, stderr io.Writer) int {
	if pushStdinIsTerminal() {
		fmt.Fprintln(stderr, "push: refusing to read file bytes from a terminal; pipe or redirect stdin (… | relayium push - relayium://host/file)")
		return 2
	}
	if strings.HasPrefix(destArg, daemonScheme) {
		return pushStdinDaemon(destArg, f.configDir, stderr)
	}
	dest, err := xfer.ParseEndpoint(destArg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !dest.IsRemote() {
		fmt.Fprintln(stderr, "push: \"push -\" needs a remote destination, [user@]host:file")
		return 2
	}
	if why := pushStdinDestRefusal(dest.Path); why != "" {
		fmt.Fprintf(stderr, "push: %q %s; \"push - host:file\" writes exactly one new file. Give the full file name.\n", termtext.Safe(dest.Path), why)
		return 2
	}
	name := streamLeaf(dest.Path)
	opts := sshx.Opts{IdentityFile: f.identity, Port: f.port}

	has, err := stdinRemoteHasRelayium(dest, opts)
	if err != nil {
		fmt.Fprintf(stderr, "push: %v; nothing was read from stdin\n", err)
		return 1
	}
	if !has {
		fmt.Fprintln(stderr, "push: \"push -\" needs relayium installed on the remote; there is no zero-dependency form for stdin. Nothing was read from stdin.")
		return 1
	}

	sc := catchStdinSignals()
	defer sc.stop()
	ctx, caughtSignal := sc.ctx, sc.caught

	sess, err := stdinSSHDial(dest, streamRecvCommand(dest.Path), opts)
	if err != nil {
		fmt.Fprintf(stderr, "push: %v; nothing was read from stdin\n", err)
		return 1
	}

	prog := newStreamProgress(stderr)
	rep, err := xfer.SendStream(ctx, sess, name, stdinPumpStart, xfer.StreamSendOpts{Progress: prog.report})
	prog.finish()
	for _, n := range rep.Notes {
		fmt.Fprintf(stderr, "push: note: %s\n", n)
	}
	if err != nil {
		// SendStream already aborted the session and reaped ssh.
		if s := caughtSignal(); s != nil {
			fmt.Fprintf(stderr, "push: interrupted (%v); %v\n", s, err)
			return signalExitCode(s)
		}
		if remotePredatesStream(err, sess) {
			fmt.Fprintln(stderr, "push: the remote relayium predates \"push -\" (it refused __recv --stream-file); run \"relayium update\" there. Nothing was read from stdin and nothing was installed on the receiver.")
			return 1
		}
		fmt.Fprintf(stderr, "push: %v\n", err)
		return 1
	}

	// Confirmed: the receiver echoed this transfer's End challenge with
	// exactly the bytes sent. A late transport error cannot undo that; it is
	// reported, not fatal.
	if cerr := closeBounded(sess, pushStdinCloseGrace); cerr != nil {
		fmt.Fprintf(stderr, "push: note: %s was confirmed by the receiver, but ssh then reported: %v\n", termtext.Safe(name), cerr)
	}
	fmt.Fprintf(stderr, "  %s (%d bytes, sha256 %s)\n", termtext.Safe(name), rep.Bytes, rep.SHA256)
	return 0
}

// stdinSignals turns INT/TERM/HUP into the cancellation of a `push -`.
type stdinSignals struct {
	ctx    context.Context
	cancel context.CancelCauseFunc
	stopFn func()
	done   chan struct{}
	mu     sync.Mutex
	sig    os.Signal
}

func catchStdinSignals() *stdinSignals {
	ctx, cancel := context.WithCancelCause(context.Background())
	sc := &stdinSignals{ctx: ctx, cancel: cancel, done: make(chan struct{})}
	sigs := make(chan os.Signal, 4)
	sc.stopFn = pushStdinNotify(sigs)
	go func() {
		select {
		case s := <-sigs:
			sc.mu.Lock()
			sc.sig = s
			sc.mu.Unlock()
			cancel(fmt.Errorf("interrupted by %v", s))
		case <-sc.done:
		}
	}()
	return sc
}

// caught is the signal that cancelled the transfer, or nil. A signal to the
// whole process group reaches ssh too, which may end the transfer before this
// process's own delivery was handled, so it waits a moment for that.
func (sc *stdinSignals) caught() os.Signal {
	select {
	case <-sc.ctx.Done():
	case <-time.After(50 * time.Millisecond):
	}
	sc.mu.Lock()
	defer sc.mu.Unlock()
	return sc.sig
}

func (sc *stdinSignals) stop() {
	close(sc.done)
	sc.stopFn()
	sc.cancel(nil)
}

// remotePredatesStream: the receiver never accepted the stream, gave no
// refusal of its own, and the remote command exited 2 — which is what every
// released `relayium __recv` does with an unknown flag, before reading
// anything. err's session has already been reaped, so Wait returns at once.
func remotePredatesStream(err error, sess stdinSession) bool {
	var se *xfer.StreamSendError
	if !errors.As(err, &se) || se.Stage != xfer.StreamBeforeAccept {
		return false
	}
	var re *xfer.RemoteError
	if errors.As(err, &re) {
		return false
	}
	var ee *exec.ExitError
	return errors.As(sess.Wait(), &ee) && ee.ExitCode() == 2
}

// closeBounded closes sess gracefully, or aborts it after d.
func closeBounded(sess stdinSession, d time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- sess.Close() }()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case err := <-done:
		return err
	case <-t.C:
		_ = sess.Abort()
		return fmt.Errorf("ssh did not exit within %v after the transfer; it was stopped", d)
	}
}

// streamProgress renders `push -` progress on stderr: on a terminal a live
// byte count and rate (the total is unknown), elsewhere nothing until the
// summary line. report is called only from SendStream's writer goroutine,
// and finish only after SendStream returned.
type streamProgress struct {
	bar *progressBar
}

func newStreamProgress(w io.Writer) *streamProgress {
	if !isTTY(w) {
		return &streamProgress{}
	}
	return &streamProgress{bar: &progressBar{w: w, tty: true, glyph: "⇡", verb: "Sending", now: time.Now}}
}

func (p *streamProgress) report(sent int64) {
	if p.bar != nil {
		p.bar.update(sent, 0)
	}
}

func (p *streamProgress) finish() {
	if p.bar != nil {
		p.bar.finish()
	}
}
