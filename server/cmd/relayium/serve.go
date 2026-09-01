package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
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

// transferIdleTimeout bounds how long a receive may STALL (no bytes) before it's
// aborted. It's an idle timeout, not a total one, so an arbitrarily large but
// steadily-progressing transfer is fine, while a peer that connects, gets
// approved, then goes silent can't pin a goroutine + concurrency slot forever
// (maxConcurrentServe such stalls would otherwise starve new connections).
var transferIdleTimeout = 2 * time.Minute

// idleConn resets a read deadline before every Read, so a connection that stops
// producing bytes for idle fails its next read instead of blocking indefinitely.
type idleConn struct {
	net.Conn
	idle time.Duration
}

func (c *idleConn) Read(p []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(c.idle))
	return c.Conn.Read(p)
}

type serveFlags struct {
	dir         string
	bind        string
	port        int
	once        bool
	noResume    bool
	allowDelete bool
	configDir   string
}

const serveUsage = `relayium serve — listen for direct pushes from another machine

usage:
  relayium serve [--dir D] [--bind ADDR] [--port N] [--once]
                 [--allow-delete] [--no-resume] [--config-dir D]

Direct server-to-server transfer: the sender reaches this listener over a pinned
TLS 1.3 connection and writes into --dir. No relay, no SSH, no Relayium account.
Trust is this host's authorized_fingerprints file and nothing else — being logged
into a Relayium account grants no one filesystem access here, and logging in does
not authorize a pusher.

flags:
  --dir D          directory to receive files into (default "."). It must
                   already exist and be writable; serve never creates it.
  --bind ADDR      address to listen on. Empty (the default) listens on
                   all interfaces, including public ones, and relies on your
                   firewall — pass --bind 127.0.0.1, or a private address, to
                   limit the listener itself.
  --port N         TCP port (default 9031).
  --once           handle a single transfer, then exit.
  --allow-delete   honor a sender's "sync --delete" mirror request. Without it,
                   nothing on this host is ever deleted. With it, deletion is
                   still confined to the top-level directories the sender's
                   manifest actually contains — never the rest of --dir.
  --no-resume      disable resuming partial files.
  --config-dir D   identity/trust directory (default ~/.config/relayium).
                   Use the SAME value with "relayium authorize": a fingerprint
                   added there takes effect on the next connection, with
                   no restart of this listener.

In a terminal, serve asks you to approve each new pusher on its first push and
remembers it. With no terminal (systemd, a pipe), an unknown pusher is rejected:
pre-authorize it with "relayium authorize <fingerprint>" — the pusher prints its
own fingerprint with "relayium id".
`

// serveFlagSet declares `serve`'s flags, binding them into f. The help pre-scan
// reads its value-flag names off this same declaration (see wantsHelpFS), so
// `--dir -h` names a directory rather than asking a question.
func serveFlagSet(f *serveFlags) *flag.FlagSet {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.StringVar(&f.dir, "dir", ".", "directory to receive files into")
	fs.StringVar(&f.bind, "bind", "", "address to listen on (empty: all interfaces)")
	fs.IntVar(&f.port, "port", defaultDaemonPort, "TCP port to listen on")
	fs.BoolVar(&f.once, "once", false, "handle a single transfer then exit")
	fs.BoolVar(&f.noResume, "no-resume", false, "disable resuming partial files")
	fs.BoolVar(&f.allowDelete, "allow-delete", false, "honor a sender's --delete (mirror) request")
	fs.StringVar(&f.configDir, "config-dir", "", "identity/trust directory")
	return fs
}

func runServe(args []string, stdout, stderr io.Writer) int {
	var f serveFlags
	fs := serveFlagSet(&f)
	fs.SetOutput(stderr)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, serveUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}

	// Check --dir BEFORE binding the port. A listener that accepts a connection,
	// completes a handshake and only then discovers it cannot write is a worse
	// failure than not starting: the operator sees a running service, and the
	// sender sees a transfer die mid-flight.
	if err := checkReceiveDir(f.dir); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
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
			fmt.Fprintf(stderr, "warning: no authorized peers and no terminal to approve on; pushes will be rejected until one is authorized.\n"+
				"  run `relayium authorize --config-dir %s <fingerprint>` (peer prints it with `relayium id`);\n"+
				"  this listener picks it up on the next connection — no restart needed.\n", cfgDir)
		}
	}

	ln, err := net.Listen("tcp", serveListenAddr(f.bind, f.port))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer ln.Close()
	fmt.Fprintf(stderr, "relayium serve: listening on %s, receiving into %s (fingerprint %s)\n",
		ln.Addr(), f.dir, id.Fingerprint)
	if f.bind == "" {
		fmt.Fprintf(stderr, "note: listening on all interfaces. Restrict it with --bind or a firewall rule.\n")
	}

	return serveLoop(ln, h, f.once)
}

// serveListenAddr builds the listen address. An empty bind keeps the historical
// ":port" form (every interface); JoinHostPort is what makes a literal IPv6
// address come out as "[::1]:9031" rather than an unparseable "::1:9031".
func serveListenAddr(bind string, port int) string {
	return net.JoinHostPort(bind, strconv.Itoa(port))
}

// checkReceiveDir verifies --dir is an existing, writable, real directory.
//
// Deliberately NOT the Device Inbox's resolveReceiveDir: that one creates the
// directory (an enrolment-time opt-in) and returns inbox-specific state. serve
// takes a path an operator already prepared; silently creating a mistyped one
// would put received files somewhere nobody looks.
//
// Lstat, not Stat: a symlink that happens to point at a directory would satisfy
// Stat, and then every received file lands wherever the link points — a target
// anyone who can rewrite the link chooses, after the operator approved the path
// they typed. Refuse it here and name the fix, rather than resolve it silently.
//
// The probe must create, close AND remove cleanly. A close that fails is a
// deferred write error (the data reaches the filesystem on Close, not Write),
// and a probe that cannot be removed means serve would litter the directory on
// every start. Both are reasons this directory is not usable, so neither may be
// swallowed — a successful startup claim has to mean all three worked.
func checkReceiveDir(dir string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("receive directory %s: %w", dir, err)
	}
	fi, err := os.Lstat(abs)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("receive directory %s does not exist — create it first: mkdir -p %s", abs, abs)
	}
	if err != nil {
		return fmt.Errorf("receive directory %s: %w", abs, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("--dir %s is a symlink — pass the real directory instead, "+
			"so nothing can redirect received files by rewriting the link", abs)
	}
	if !fi.IsDir() {
		return fmt.Errorf("--dir %s is not a directory — pass a directory to receive into", abs)
	}
	// Probe by actually creating a file: mode bits alone miss ownership, ACLs, a
	// read-only mount, and every other reason the write would fail later.
	probe, err := os.CreateTemp(abs, ".relayium-serve-check-*")
	if err != nil {
		return fmt.Errorf("receive directory %s is not writable: %w", abs, err)
	}
	name := probe.Name()
	if cerr := probe.Close(); cerr != nil {
		_ = os.Remove(name) // best effort: the write already failed, don't also litter
		return fmt.Errorf("receive directory %s is not writable: %w", abs, cerr)
	}
	if err := os.Remove(name); err != nil {
		return fmt.Errorf("receive directory %s: could not clean up the write probe: %w", abs, err)
	}
	return nil
}

// maxConcurrentServe bounds how many pushes serve handles at once, so a flood of
// slow/stalled peers can't spawn unbounded goroutines.
const maxConcurrentServe = 64

// serveHandler carries everything one serve invocation needs to authorize and
// receive pushes. allow is mutated in place as new peers are approved.
//
// It takes TWO locks, and keeping them apart is the point (see authorize):
//
//   - mu guards the allow map and nothing else. It is held only for map reads
//     and merges, never across a disk read or a prompt, so checking an
//     already-authorized peer stays a memory lookup however slow the disk is
//     and however long a human takes to answer another connection.
//   - approveMu serializes the slow path — the reload, the prompt and the
//     persist — so concurrent unknown peers cannot produce overlapping prompts
//     or race each other's approval.
//
// Lock order is approveMu then mu, never the reverse.
type serveHandler struct {
	id          *secure.Identity
	mu          sync.Mutex
	allow       map[string]bool
	approveMu   sync.Mutex
	dir         string
	noResume    bool
	allowDelete bool
	cfgDir      string
	// approve is consulted for an unknown fingerprint; nil (or false) rejects it.
	// It receives the peer's remote address and fingerprint.
	approve func(remote, fp string) bool
	// loadAllow reads the allow-list; nil means trust.LoadAuthorized. A seam for
	// tests that need to control exactly when a reload starts and finishes.
	loadAllow func(dir string) (map[string]bool, error)
	stdout    io.Writer
	stderr    io.Writer
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

// authorize reports whether fp may push. It runs three deliberately separate
// stages, so the overwhelmingly common case costs one map lookup:
//
//  1. a cached check under mu alone — no disk I/O, no prompt, nothing to wait
//     for;
//  2. a reload of authorized_fingerprints performed with NO lock held, merged
//     back into the cache under mu;
//  3. for a peer still unknown after that reload, the serialized approval path.
//
// Stage 1 is what keeps an already-authorized peer from queueing behind another
// connection's slow disk or a human staring at a prompt: the only lock it needs
// is mu, and mu is never held across either.
//
// Stage 2 exists because the file has a second writer — `relayium authorize
// --config-dir <the same dir> <fp>` — and the documented systemd workflow is
// exactly that: authorize a new pusher on a listener that is already running.
// Without the reload the in-memory set is whatever existed at startup, and the
// operator's authorize appears to do nothing until the service is restarted.
//
// Fail closed exactly as far as the stages allow, and no further. A file that
// cannot be read or parsed means we do not know who is authorized, so no peer
// this process has not already cached is: stages 2 and 3 deny the connection
// that provoked the failure and never fall through to the prompt, so a broken
// file can only ever narrow access.
//
// It cannot narrow it below the cache, and that is deliberate rather than an
// oversight. Stage 1 does no I/O at all, so a peer already in the map — read at
// startup, merged by an earlier successful reload, or approved interactively
// since — keeps pushing while the file is unreadable. This is the same
// add-only boundary as reloadAndMerge's: breaking the file is not a revocation
// channel, and clearing the cache on a failed read would hand one to anyone who
// can corrupt or unlink it. Revoking a cached peer means fixing the file and
// restarting the listener.
func (h *serveHandler) authorize(fp, remote string) bool {
	// Stage 1: the fast path. Cached peers stop here.
	if h.cachedAllows(fp) {
		return true
	}
	// Stage 2: pick up anything `relayium authorize` added since we last looked.
	allowed, err := h.reloadAndMerge(fp)
	if err != nil {
		h.reportUnreadable(fp, remote, err)
		return false
	}
	if allowed {
		return true
	}
	// Stage 3: genuinely unknown — ask, under serialization.
	return h.approveUnknown(fp, remote)
}

// cachedAllows answers from memory only. Reading a nil map is legal, so a
// handler built without an allow map still answers "no" rather than panicking.
func (h *serveHandler) cachedAllows(fp string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.allow[fp]
}

// reloadAndMerge re-reads the allow-list and folds it into the cache, reporting
// whether fp is authorized afterwards.
//
// The read and parse happen with NO lock held — that is the whole point, since
// they are the slow part. mu is taken only to merge the result.
//
// The merge only ever ADDS. Dropping fingerprints that vanished from the file
// would be revocation, which is a separate decision (a live transfer would also
// race it); an operator revoking access still restarts the listener. Add-only is
// what also makes the unlocked read safe: this snapshot may already be stale by
// the time we merge it — another connection may have approved a peer, or the
// operator may have authorized one, in between — and a merge cannot erase
// either of those. For the same reason the answer comes from the merged map
// rather than the snapshot, so a decision is never made on the stale read.
func (h *serveHandler) reloadAndMerge(fp string) (bool, error) {
	reloaded, err := h.loadAuthorized()
	if err != nil {
		return false, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.allow == nil {
		h.allow = map[string]bool{}
	}
	for known := range reloaded {
		h.allow[known] = true
	}
	return h.allow[fp], nil
}

// loadAuthorized reads the allow-list through the test seam when one is set.
func (h *serveHandler) loadAuthorized() (map[string]bool, error) {
	if h.loadAllow != nil {
		return h.loadAllow(h.cfgDir)
	}
	return trust.LoadAuthorized(h.cfgDir)
}

// approveUnknown runs the slow path for a fingerprint stage 2 did not authorize:
// ask the operator, remember the answer. approveMu makes it exclusive, so
// concurrent unknown peers can never overlap prompts. mu is left free the whole
// time, so cached peers keep passing while a human is being asked.
func (h *serveHandler) approveUnknown(fp, remote string) bool {
	h.approveMu.Lock()
	defer h.approveMu.Unlock()

	// Reaching this line may have taken arbitrarily long — a human at another
	// connection's prompt. Stage 2's answer is therefore stale, and both of the
	// re-checks below exist to avoid acting on it.
	//
	// The cache may have gained fp from the very approval we queued behind. This
	// is what collapses a burst of first connections from the SAME peer into one
	// prompt instead of one prompt each.
	if h.cachedAllows(fp) {
		return true
	}
	// The file may have gained fp from `relayium authorize` run while we waited.
	// Re-reading here — still outside mu — means we never prompt for, or reject,
	// a peer the operator has meanwhile authorized.
	allowed, err := h.reloadAndMerge(fp)
	if err != nil {
		h.reportUnreadable(fp, remote, err)
		return false
	}
	if allowed {
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
	h.grant(fp)
	fmt.Fprintf(h.stderr, "authorized %s (added to %s)\n", fp, trust.AuthorizedPath(h.cfgDir))
	return true
}

// grant records an approved fingerprint in the cache.
func (h *serveHandler) grant(fp string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.allow == nil {
		h.allow = map[string]bool{}
	}
	h.allow[fp] = true
}

// reportUnreadable explains an allow-list that could not be read or parsed. The
// operator has to fix the file; its contents are never echoed.
//
// The wording states the actual boundary (see authorize): the failure denies
// peers this listener has not already cached, and does NOT revoke the ones it
// has. Telling an operator that "every peer is rejected" would send them
// looking for an outage that is not happening — and could read as a promise
// that corrupting this file locks everyone out, which is not true either.
func (h *serveHandler) reportUnreadable(fp, remote string, err error) {
	fmt.Fprintf(h.stderr, "rejected peer %s from %s: cannot read %s: %v\n"+
		"  fix or remove that file — until it can be read, no peer this listener has not\n"+
		"  already cached can be authorized. Peers cached at startup or approved since\n"+
		"  then keep pushing until you restart it.\n",
		fp, remote, trust.AuthorizedPath(h.cfgDir), err)
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

	// Wrap in an idle-deadline conn: post-approval, a stalled peer must not hold a
	// goroutine + concurrency slot forever (the handshake deadline was cleared
	// above because large receives legitimately take long).
	rep, err := xfer.Receive(&idleConn{Conn: tconn, idle: transferIdleTimeout}, h.dir, xfer.RecvOpts{NoResume: h.noResume, AllowDelete: h.allowDelete})
	if err != nil {
		fmt.Fprintf(h.stderr, "receive from %s (%s): %v\n", fp, remote, err)
		return false
	}
	if rep.DeleteRefusedReason != "" {
		fmt.Fprintf(h.stderr, "warning: refused the sender's --delete because %s; nothing was deleted\n", rep.DeleteRefusedReason)
	} else if rep.DeletePartial != "" {
		fmt.Fprintf(h.stderr, "warning: the mirror delete did not finish: %s\n", rep.DeletePartial)
	} else if rep.DeleteDenied {
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
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, authorizeUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
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
