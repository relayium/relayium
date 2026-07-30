package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/xfer"
)

type textFlags struct {
	server    string
	advertise string
	yes       bool // skip the SAS prompt -- for scripts, which cannot answer one
}

func parseTextFlags(args []string) (textFlags, []string, error) {
	var f textFlags
	fs := flag.NewFlagSet("text", flag.ContinueOnError)
	fs.StringVar(&f.server, "server", defaultServer, "Relayium server base URL (self-host)")
	fs.StringVar(&f.advertise, "advertise", "", "host:port to advertise as a direct endpoint")
	fs.BoolVar(&f.yes, "yes", false, "skip the SAS confirmation prompt (for scripts)")
	// parseArgs is permuteFlags + Parse, the one entry point every subcommand
	// uses, so trailing flags work here too.
	if err := parseArgs(fs, args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}

// A message session has no manifest for the user to inspect before content
// arrives, so unlike `send` -- where --verify opts IN to a prompt -- this prompts
// by default and --yes opts out.
func (f textFlags) confirmSAS(tty bool) bool { return tty && !f.yes }

// And a session that cannot prompt must refuse rather than proceed unverified.
// Failing fast is the rule the pairing-code work already set for scripted
// environments: never block a job on a human who is not there.
func (f textFlags) allowUnverified(tty bool) bool { return tty || f.yes }

// stdin and the TTY answer come through vars because runText's signature carries
// only stdout/stderr. Swapping them is what lets the piped path be driven in a
// test with no terminal and no network.
var (
	textStdin      = func() io.Reader { return osStdin() }
	textStdinIsTTY = func() bool {
		fi, err := osStdin().Stat()
		return err == nil && fi.Mode()&os.ModeCharDevice != 0
	}
)

// Whole-session ceiling, same as send/receive: the peer may never arrive.
const textSessionTimeout = 10 * time.Minute

func runText(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseTextFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) < 1 {
		fmt.Fprintln(stderr, "usage: relayium text <code>   — both ends run `relayium text` with the same code")
		return 2
	}
	if len(rest) > 1 {
		fmt.Fprintf(stderr, "relayium text takes one code, got %d arguments: %q\n", len(rest), rest)
		return 2
	}
	code := rest[0]

	// Shape first, and ahead of the SAS/TTY gate: a mistyped code should be
	// reported as a mistyped code rather than masked by a complaint about --yes.
	// rzvous.Join checks this too (that is the authoritative copy); this check is
	// what guarantees a made-up code never reaches the network at all.
	if !signal.ValidCodeFormat(code) {
		fmt.Fprintf(stderr,
			"pairing code %q is not a valid code: codes are %d characters from %s, last %d minutes, and are issued by the server — one cannot be made up\n",
			code, signal.CodeLen, signal.CodeAlphabet, signal.CodeTTLSeconds/60)
		return 2
	}

	tty := textStdinIsTTY()
	if !f.allowUnverified(tty) {
		fmt.Fprintln(stderr, "refusing to start a message session without confirming the SAS: stdin is not a terminal, so there is nobody to prompt.")
		fmt.Fprintln(stderr, "Pass --yes if you have compared the code another way, or run it from a terminal.")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), textSessionTimeout)
	defer cancel()

	// crossFlags.verify means "prompt to confirm the SAS", and confirmSAS has
	// already inverted the default for text: interactive confirms, --yes or a
	// non-terminal does not prompt.
	cf := crossFlags{server: f.server, advertise: f.advertise, verify: f.confirmSAS(tty)}
	conn, err := crossnetConn(ctx, code, "text", cf, stderr, rzvous.ModeText)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer conn.Close()

	// The ceiling covers the whole session -- live reads and writes, not just the
	// drain -- so a reply that arrives minutes later still lands, and a peer that
	// stalls mid-session cannot hang us.
	deadline, _ := ctx.Deadline()
	if err := installDeadline(conn, deadline); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := pumpText(conn, textStdin(), stdout, stderr, tty, deadline); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// deadliner is net.Conn's SetDeadline, reached structurally so the installation
// step can be tested without a network.
type deadliner interface{ SetDeadline(time.Time) error }

// installDeadline applies the whole-session ceiling to the live connection.
//
// endWrite's read deadline only bounds the drain AFTER stdin ends. Without this,
// a stalled peer could hang an active interactive session's reads or writes
// indefinitely and the advertised ceiling would be a claim about establishment
// only. A zero deadline means no ceiling was set, so nothing is installed.
func installDeadline(conn deadliner, deadline time.Time) error {
	if deadline.IsZero() {
		return nil
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return fmt.Errorf("setting the message session deadline: %w", err)
	}
	return nil
}

// halfCloser is *tls.Conn's CloseWrite, reached structurally so pumpText can be
// tested over a plain pipe.
type halfCloser interface{ CloseWrite() error }

// readDeadliner / writeDeadliner are net.Conn's deadlines, likewise reached
// structurally.
type readDeadliner interface{ SetReadDeadline(time.Time) error }
type writeDeadliner interface{ SetWriteDeadline(time.Time) error }

// endWrite says "we are done talking" and, if the session has a deadline, applies
// it to the read side.
//
// Both halves matter: without CloseWrite the peer never learns we finished;
// without a bound, a peer that simply never hangs up would hang us. The bound is
// the WHOLE SESSION's deadline, not a fresh window -- the contract for the
// non-interactive form is to read replies until the peer closes, and a short
// additive window would silently discard a reply the peer typed a little later.
// A zero deadline means no bound at all: read until the peer closes, full stop.
func endWrite(stream io.ReadWriter, deadline time.Time) {
	if hc, ok := stream.(halfCloser); ok {
		_ = hc.CloseWrite()
	}
	if deadline.IsZero() {
		return
	}
	if rd, ok := stream.(readDeadliner); ok {
		_ = rd.SetReadDeadline(deadline)
	}
}

// drainEnded reports whether a drain finished acceptably: cleanly, or because the
// session's own deadline expired. Reaching the session ceiling is how a session
// ends when nobody hangs up; it is not an error worth a non-zero exit.
func drainEnded(err error) bool {
	return err == nil || errors.Is(err, os.ErrDeadlineExceeded)
}

func tooLongNote(n int) string {
	return fmt.Sprintf("message not sent: %d bytes is over the %d-byte limit — send it as a file with `relayium send` instead", n, xfer.TextMaxBytes)
}

// pumpText moves messages both ways until one side is done.
//
// Interactive and piped are two ways of READING stdin, not two wire formats: the
// frames are identical, only the boundary of "one message" differs. A terminal
// cannot tell "a newline inside this message" from "send" without inventing a
// terminator or a modifier key, and either would make the common case worse to
// serve the rare one -- so multiline content goes through the pipe form, byte for
// byte.
// deadline is the whole session's ceiling (zero for none); it bounds the wait for
// a peer that never hangs up without capping how long a real conversation may run.
func pumpText(stream io.ReadWriter, stdin io.Reader, stdout, stderr io.Writer, interactive bool, deadline time.Time) error {
	if !interactive {
		return pumpPiped(stream, stdin, stdout, deadline)
	}
	return pumpInteractive(stream, stdin, stdout, stderr, deadline)
}

// pumpPiped sends stdin as ONE message, byte for byte, then prints whatever the
// peer sends back until it closes or the whole-session deadline expires.
func pumpPiped(stream io.ReadWriter, stdin io.Reader, stdout io.Writer, deadline time.Time) error {
	// Read to the cap plus one: enough to know whether it is over, without
	// buffering an arbitrarily large input just to find out. Done before the
	// stream is touched, so an over-limit body sends nothing at all.
	body, err := io.ReadAll(io.LimitReader(stdin, xfer.TextMaxBytes+1))
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}
	if len(body) > xfer.TextMaxBytes {
		return errors.New(tooLongNote(len(body)))
	}

	// Start reading BEFORE writing. Both ends of `… | relayium text CODE` send
	// first and read second, so a send that blocks until the peer reads would have
	// each side waiting on the other -- a deadlock whose likelihood depends on
	// whether 64 KiB happens to fit the socket buffer. Reading concurrently means
	// neither side has to win that race.
	recv := startReceiving(stream, stdout, false)

	// And bound the one write too, by the same session ceiling: a peer that never
	// reads must not hang us either.
	if wd, ok := stream.(writeDeadliner); ok && !deadline.IsZero() {
		_ = wd.SetWriteDeadline(deadline)
	}
	if err := xfer.WriteText(stream, string(body)); err != nil {
		return err
	}
	endWrite(stream, deadline)
	if err := recv.wait(); !drainEnded(err) {
		return err
	}
	return nil
}

func pumpInteractive(stream io.ReadWriter, stdin io.Reader, stdout, stderr io.Writer, deadline time.Time) error {
	fmt.Fprintln(stderr, "connected — one line per message, Ctrl-D to end. For multiline or exact bytes, pipe it instead: `… | relayium text <code>`")

	recv := startReceiving(stream, stdout, true)

	sc := bufio.NewScanner(stdin)
	// Room for one byte over the cap, so "too long" is reported by the friendly
	// message below rather than as bufio.ErrTooLong.
	sc.Buffer(make([]byte, 0, 4096), xfer.TextMaxBytes+2)

	var sendErr error
sending:
	for sc.Scan() {
		line := sc.Text()
		if len(line) > xfer.TextMaxBytes {
			// Refuse the line, keep the session: tearing down a whole conversation
			// over one pasted blob would be worse than saying no to the blob.
			fmt.Fprintln(stderr, tooLongNote(len(line)))
			continue
		}
		if err := xfer.WriteText(stream, line); err != nil {
			sendErr = err
			break sending
		}
		// A genuine inbound failure means the session is unusable, so stop.
		//
		// A clean inbound EOF must NOT stop us. On a half-closed duplex it means
		// only "the peer will send nothing more" -- the peer may still be reading,
		// and abandoning the rest of stdin there silently drops lines the user
		// already typed. Treating EOF as "the peer is gone" truncated a session to
		// its first few lines, at random, depending on goroutine scheduling.
		if err, ended := recv.result(); ended && !drainEnded(err) {
			sendErr = err
			break sending
		}
	}
	if sendErr == nil {
		if err := sc.Err(); err != nil {
			if errors.Is(err, bufio.ErrTooLong) {
				fmt.Fprintln(stderr, tooLongNote(xfer.TextMaxBytes+2))
			} else {
				sendErr = fmt.Errorf("reading stdin: %w", err)
			}
		}
	}
	endWrite(stream, deadline)
	// Let the reader finish the peer's remaining messages, bounded only by the
	// session ceiling, then stop.
	// wait() is safe even when result() already observed completion: it waits on a
	// closed channel rather than consuming a value, so an inbound error seen in the
	// loop cannot deadlock here.
	if err := recv.wait(); !drainEnded(err) && sendErr == nil {
		sendErr = err
	}
	return sendErr
}

// receiver is the inbound half, running on its own goroutine.
//
// Completion is published by CLOSING a channel rather than sending on one, so the
// send loop can poll it on every iteration and the final wait can still read the
// result. A buffered channel carrying the error would let the loop consume the one
// value and leave the final wait blocking forever.
type receiver struct {
	done chan struct{}
	err  error // written once before done is closed; read only after observing it
}

func startReceiving(stream io.Reader, stdout io.Writer, addNewline bool) *receiver {
	r := &receiver{done: make(chan struct{})}
	go func() {
		r.err = copyIncoming(stream, stdout, addNewline)
		close(r.done)
	}()
	return r
}

// result reports whether the inbound half has finished, and with what. Non-blocking.
func (r *receiver) result() (error, bool) {
	select {
	case <-r.done:
		return r.err, true
	default:
		return nil, false
	}
}

// wait blocks until the inbound half finishes and returns its error.
func (r *receiver) wait() error {
	<-r.done
	return r.err
}

// copyIncoming prints each inbound message until the peer closes.
//
// addNewline is true only when interactive: a terminal needs one message per line
// to stay readable. The piped form adds NOTHING -- exact bytes is its contract.
func copyIncoming(stream io.Reader, stdout io.Writer, addNewline bool) error {
	for {
		body, err := xfer.ReadText(stream)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := io.WriteString(stdout, body); err != nil {
			return err
		}
		if addNewline {
			if _, err := io.WriteString(stdout, "\n"); err != nil {
				return err
			}
		}
	}
}
