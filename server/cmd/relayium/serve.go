package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
	"github.com/relayium/relayium/internal/xfer"
)

// handshakeTimeout bounds the unauthenticated TLS handshake per connection.
// A var so tests can shorten it.
var handshakeTimeout = 30 * time.Second

type serveFlags struct {
	dir         string
	port        int
	once        bool
	noResume    bool
	allowDelete bool
	configDir   string
}

func runServe(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var f serveFlags
	fs.StringVar(&f.dir, "dir", ".", "directory to receive files into")
	fs.IntVar(&f.port, "port", defaultDaemonPort, "TCP port to listen on")
	fs.BoolVar(&f.once, "once", false, "handle a single transfer then exit")
	fs.BoolVar(&f.noResume, "no-resume", false, "disable resuming partial files")
	fs.BoolVar(&f.allowDelete, "allow-delete", false, "honor a sender's --delete (mirror) request")
	fs.StringVar(&f.configDir, "config-dir", "", "identity/trust directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	cfgDir, err := resolveConfigDir(f.configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	id, err := secure.LoadOrCreateIdentity(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	allow, err := trust.LoadAuthorized(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	h := &serveHandler{
		id: id, allow: allow, dir: f.dir, noResume: f.noResume, allowDelete: f.allowDelete, cfgDir: cfgDir,
		stdout: stdout, stderr: stderr,
	}
	// In an interactive terminal, an unknown pusher is approved on first push and
	// remembered. Under systemd or a pipe (no TTY) there is no one to ask, so an
	// unknown pusher is rejected — pre-authorize with `relayium authorize`.
	if stdinIsTTY() {
		h.approve = func(remote, fp string) bool { return promptApprove(os.Stdin, stderr, remote, fp) }
	}

	if len(allow) == 0 {
		if h.approve != nil {
			fmt.Fprintf(stderr, "no authorized peers yet — you'll be asked to approve each new peer on its first push.\n")
		} else {
			fmt.Fprintf(stderr, "warning: no authorized peers and no terminal to approve on; all pushes will be rejected.\n"+
				"  pre-authorize with `relayium authorize <fingerprint>` (peer prints it with `relayium id`).\n")
		}
	}

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", f.port))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer ln.Close()
	fmt.Fprintf(stderr, "relayium serve: listening on %s, receiving into %s (fingerprint %s)\n",
		ln.Addr(), f.dir, id.Fingerprint)

	return serveLoop(ln, h, f.once)
}

// maxConcurrentServe bounds how many pushes serve handles at once, so a flood of
// slow/stalled peers can't spawn unbounded goroutines.
const maxConcurrentServe = 64

// serveHandler carries everything one serve invocation needs to authorize and
// receive pushes. allow is mutated in place as new peers are approved; mu guards
// it (and serializes interactive approval) across concurrent connections.
type serveHandler struct {
	id          *secure.Identity
	mu          sync.Mutex
	allow       map[string]bool
	dir         string
	noResume    bool
	allowDelete bool
	cfgDir      string
	// approve is consulted for an unknown fingerprint; nil (or false) rejects it.
	// It receives the peer's remote address and fingerprint.
	approve func(remote, fp string) bool
	stdout  io.Writer
	stderr  io.Writer
}

// serveLoop accepts and handles connections. With once it handles exactly one
// serially and returns (0 on success, 1 otherwise) — used by the first-approval
// flow. Otherwise it handles connections concurrently (bounded by
// maxConcurrentServe) so one slow or stalled peer can't starve the rest, running
// until Accept fails.
func serveLoop(ln net.Listener, h *serveHandler, once bool) int {
	if once {
		conn, err := ln.Accept()
		if err != nil {
			fmt.Fprintln(h.stderr, err)
			return 1
		}
		if h.serve(conn) {
			return 0
		}
		return 1
	}
	sem := make(chan struct{}, maxConcurrentServe)
	for {
		conn, err := ln.Accept()
		if err != nil {
			fmt.Fprintln(h.stderr, err)
			return 1
		}
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			h.serve(conn)
		}()
	}
}

// authorize reports whether fp may push, consulting and updating the shared
// allow-list under lock. The lock also serializes interactive approval so
// concurrent connections don't race the map or double-prompt.
func (h *serveHandler) authorize(fp, remote string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.allow[fp] {
		return true
	}
	if h.approve == nil || !h.approve(remote, fp) {
		fmt.Fprintf(h.stderr, "rejected unauthorized peer %s from %s\n", fp, remote)
		return false
	}
	// Approved: remember the fingerprint so future pushes pass silently
	// (this is what makes cron/script automation work after a one-time yes).
	if err := trust.AddAuthorized(h.cfgDir, fp); err != nil {
		fmt.Fprintf(h.stderr, "warning: could not persist fingerprint to %s: %v\n", trust.AuthorizedPath(h.cfgDir), err)
	}
	h.allow[fp] = true
	fmt.Fprintf(h.stderr, "authorized %s (added to %s)\n", fp, trust.AuthorizedPath(h.cfgDir))
	return true
}

// serve runs one pinned-TLS server handshake, authorizes the peer (allow-list
// membership, or interactive approval that remembers the fingerprint), then
// receives the pushed batch. No file data is read until the peer is authorized,
// and one bad peer never takes down serve.
func (h *serveHandler) serve(conn net.Conn) (ok bool) {
	remote := conn.RemoteAddr()
	defer conn.Close()
	// A panic while handling one connection must not take down the daemon: turn
	// it into a failed connection so serveLoop keeps accepting.
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(h.stderr, "panic serving %s: %v\n", remote, r)
			ok = false
		}
	}()

	// Bound the unauthenticated TLS handshake so a client that connects and then
	// stalls can't wedge the (serial) accept loop indefinitely. Cleared once the
	// peer is cryptographically identified: interactive approval and large file
	// receives legitimately take longer.
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	tconn, fp, err := secure.ServerAny(conn, h.id)
	if err != nil {
		fmt.Fprintf(h.stderr, "handshake failed from %s: %v\n", remote, err)
		return false
	}
	_ = conn.SetDeadline(time.Time{})
	defer tconn.Close()

	if !h.authorize(fp, remote.String()) {
		return false
	}

	rep, err := xfer.Receive(tconn, h.dir, xfer.RecvOpts{NoResume: h.noResume, AllowDelete: h.allowDelete})
	if err != nil {
		fmt.Fprintf(h.stderr, "receive from %s (%s): %v\n", fp, remote, err)
		return false
	}
	if rep.DeleteDenied {
		fmt.Fprintf(h.stderr, "warning: sender requested --delete but this listener isn't started with --allow-delete; nothing was deleted\n")
	}
	if len(rep.Failed) > 0 {
		fmt.Fprintf(h.stderr, "%d file(s) failed integrity check from %s: %v\n", len(rep.Failed), fp, rep.Failed)
		return false
	}
	fmt.Fprintf(h.stdout, "received %d file(s), %d bytes from %s\n", rep.Files, rep.Bytes, fp)
	return true
}

// promptApprove asks the operator on the terminal whether to accept and remember
// an unknown peer, showing its address and fingerprint. A bare Enter means no.
func promptApprove(stdin io.Reader, out io.Writer, remote, fp string) bool {
	fmt.Fprintf(out, "\nIncoming push from %s\n  fingerprint: %s\nAccept and remember this peer? [y/N] ", remote, fp)
	var ans string
	fmt.Fscanln(stdin, &ans)
	switch ans {
	case "y", "Y", "yes", "Yes", "YES":
		return true
	}
	return false
}

// stdinIsTTY reports whether standard input is an interactive terminal, so serve
// only prompts when there is a human to answer. It uses a real isatty check, so
// a pipe or systemd's /dev/null stdin correctly reads as non-interactive.
func stdinIsTTY() bool {
	return term.IsTerminal(int(os.Stdin.Fd()))
}

// runAuthorize adds a pusher's fingerprint to this host's allow-list, for the
// non-interactive (systemd) case where serve can't prompt.
func runAuthorize(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("authorize", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	fs.StringVar(&configDir, "config-dir", "", "identity/trust directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, "authorize needs <fingerprint> (the pusher prints it with `relayium id`)")
		return 2
	}
	fp := strings.ToLower(strings.TrimSpace(fs.Arg(0)))
	if !isFingerprint(fp) {
		fmt.Fprintf(stderr, "not a valid fingerprint: %q (want the 64 hex chars from `relayium id`)\n", fs.Arg(0))
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := trust.AddAuthorized(cfgDir, fp); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "authorized %s\n", fp)
	return 0
}

// isFingerprint reports whether s is a 64-char lowercase hex string (a SHA-256).
func isFingerprint(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
