package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/termtext"
	"github.com/relayium/relayium/internal/xfer"
)

const usage = `relayium — file and text transfer

server to server, direct (no relay, no Relayium account):
  relayium serve [--dir D] [--bind ADDR] [--port N] [--once] [--allow-delete]
                                             listen for direct pushes from another machine
                                             (in a terminal, approve each new peer on its
                                              first push; otherwise pre-authorize it)
  relayium push <src...> relayium://host[:port]
                                             push straight to that listener over pinned TLS
  relayium sync <src...> relayium://host[:port] [--delete] [--watch]
                                             mirror a folder onto that listener, incrementally
  relayium id                                print this host's fingerprint
  relayium authorize <fingerprint>           pre-authorize a pusher (for non-interactive serve)

  These need no Relayium account and never touch our servers. Logging in
  grants NO filesystem access to anyone: a listener accepts a pusher only when
  its fingerprint is in that listener's own authorized_fingerprints file, which
  is a separate decision from any account. Use the same --config-dir for
  serve and authorize; see "relayium serve -h".

usage:
  relayium push <src...> [user@]host:dest    push files to a server you can ssh into
  relayium sync <src...> <dest> [--delete] [--watch]   incremental one-way folder mirror
  relayium pull [user@]host:src <dest>       pull files from such a server
                                             (<dest> "-": one file to stdout)
  relayium send <src...> [code]              send to a peer over a pairing code (cross-network)
                                             (omit the code to mint one; requires login)
  relayium receive <code> [destdir]          receive such a transfer
  relayium text [code] [--verify]            ephemeral encrypted messages with a peer
                                             (both ends run this; omit the code to mint one,
                                              which requires login; pipe stdin for exact multiline)
  relayium serve / id / authorize            direct server-to-server listener; see the
                                             section above and "relayium serve -h"
  relayium login [--server URL] [--config-dir D] [--device-name LABEL]
                                             log in to the cloud (device code flow)
                                             (the label names this machine in My Devices;
                                              defaults to this host's name)
  relayium logout [--local-only] [--config-dir D]
                                             revoke and clear cloud credentials
  relayium whoami                           show the logged-in cloud account
  relayium up <path...> [--burn] [--ttl D] [--max-downloads N]
                                             encrypt client-side and upload to the cloud
  relayium down <link-or-code> [destDir]    fetch and decrypt a cloud claim (no login needed)
  relayium inbox <subcommand>               Device Inbox: send files to one of your devices
                                             (devices, send, sent, cancel, retry) or receive
                                             them here (enable --dir, run, status, pause,
                                             resume, disable, service). Hosted and
                                             asynchronous; to move files directly between two
                                             servers, use serve + push/sync above instead.
                                             See relayium inbox --help.
  relayium update [--check] [--force]       upgrade to the latest release in place
  relayium version                          print the CLI version

flags (after the subcommand; "→" lists every command the flag applies to):
  -i <file>       ssh identity file
                  → push, pull, sync
  -p <port>       ssh port
                  → push, pull, sync
  --no-resume     turn off resuming partial files. Resume is a "sync" feature:
                  it is real on a serve listener receiving a sync, and this flag
                  is accepted but does nothing on push and pull, which refuse a
                  collision before a partial file could ever be continued.
                  → push, pull, serve
  --verify        stop to compare the SAS before sending/opening
                  → send, receive, text
  --yes           never prompt for SAS confirmation (this is already the
                  default; it is kept for scripts)
                  → text
  --config-dir D  credential/identity/state directory (default ~/.config/relayium)
                  → push, sync, serve, id, authorize, login, logout, inbox <any subcommand>

Every other flag belongs to one command; see that command's own help, e.g.
"relayium serve -h" or "relayium up -h".
`

// duplex adapts a separate reader and writer into one io.ReadWriter (used to
// hand os.Stdin/os.Stdout to the transfer engine on the remote side).
type duplex struct {
	io.Reader
	io.Writer
}

// helperStdio is the stream the hidden `__recv`/`__send` helpers speak over: the
// stdio of the SSH session that started them. A var so tests can drive those
// handlers over a pipe.
var helperStdio = func() io.ReadWriter { return duplex{Reader: os.Stdin, Writer: os.Stdout} }

// sshDial is `pull`'s transport. A var so tests can drive runPull against a
// remote sender on a pipe.
var sshDial = func(e xfer.Endpoint, remoteCmd string, o sshx.Opts) (io.ReadWriteCloser, error) {
	sess, err := sshx.Dial(e, remoteCmd, o)
	if err != nil {
		return nil, err
	}
	return sess, nil
}

// peerReceive is the receiving half of `receive` and `pull`: the two commands
// whose bytes come from a process this side did not start. Neither authorizes
// sync, so a peer's Hello.Sync is refused rather than obeyed. One function so
// the two cannot drift apart.
//
// Both run in the foreground with the user's terminal as stderr, so both report
// progress there, and the reporter is finished before returning so whatever the
// caller prints next — an error included — starts on a clean line. `serve` and
// the `__recv` helper do not: a daemon's log and the far end of someone else's
// ssh session are not a terminal anyone is watching this transfer on.
//
// destDir is this user's own argument, so a missing one is created
// (CreateDestDir), as zero-dependency push's `mkdir -p` does for its target.
func peerReceive(rw io.ReadWriter, destDir string, noResume bool, stderr io.Writer) (xfer.Report, error) {
	prog := newRecvProgress(stderr)
	rep, err := xfer.Receive(rw, destDir, xfer.RecvOpts{NoResume: noResume, CreateDestDir: true, Progress: prog.report})
	prog.finish()
	return rep, err
}

// Run dispatches a subcommand and returns a process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "push":
		return runPush(args[1:], stdout, stderr)
	case "sync":
		return runSync(args[1:], stdout, stderr)
	case "pull":
		return runPull(args[1:], stdout, stderr)
	case "send":
		return runSendCross(args[1:], stdout, stderr)
	case "receive":
		return runReceiveCross(args[1:], stdout, stderr)
	case "text":
		return runText(args[1:], stdout, stderr)
	case "serve":
		return runServe(args[1:], stdout, stderr)
	case "id":
		return runID(args[1:], stdout, stderr)
	case "authorize":
		return runAuthorize(args[1:], stdout, stderr)
	case "login":
		return runLogin(args[1:], stdout, stderr)
	case "logout":
		return runLogout(args[1:], stdout, stderr)
	case "whoami":
		return runWhoami(args[1:], stdout, stderr)
	case "up":
		return runUp(args[1:], stdout, stderr)
	case "down":
		return runDown(args[1:], stdout, stderr)
	case "inbox":
		return runInbox(args[1:], stdout, stderr)
	case "update":
		return runUpdate(args[1:], stdout, stderr)
	case "version", "--version", "-version":
		return runVersion(args[1:], stdout, stderr)
	case "__recv":
		return runRecv(args[1:], stdout, stderr)
	case "__send":
		return runSend(args[1:], stdout, stderr)
	case "-h", "-help", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	case "help":
		// `relayium help <command>` is the third spelling of the same contract:
		// it prints that command's usage and runs nothing.
		return runHelp(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

type sshFlags struct {
	identity  string
	port      int
	noResume  bool
	configDir string
}

const pushUsage = `relayium push — copy files to another machine

usage:
  relayium push <src...> relayium://host[:port]   direct to a listening peer (no SSH, no account)
  relayium push <src...> [user@]host:dest         over SSH to a server you can log into

A relayium:// destination is the direct server-to-server path: the receiver runs
"relayium serve --dir D", this pushes straight into that directory over a pinned
TLS 1.3 connection. No relay, no SSH, no Relayium account — the listener accepts
this host only once its fingerprint ("relayium id") is authorized there. The
listener's own fingerprint is pinned on first contact and a later change is
refused, not trusted.

Any other destination is the SSH path, and what it gives you depends on what is
installed on the far end. The two are not equivalent:

  relayium installed on the remote — the native Relayium receiver. The whole
  batch is checked for collisions BEFORE any bytes are sent, so a push onto an
  existing file is refused with nothing written, and each file is verified by
  SHA-256 and staged before it is installed, so a file that arrives corrupt is
  never installed under its real name.

  What this is NOT is a transaction, and re-running is NOT the recovery step.
  Files are installed one at a time as they pass, so a connection lost partway
  through leaves the files that already landed in place and the rest missing —
  and because those files now exist, re-running the SAME push is refused by the
  collision check above ("destination already exists"). Push does not resume a
  partial file either: the collision check runs first, so there is never a
  partial destination to continue from. To finish an interrupted push, either
  push only the files that are still missing, or use "relayium sync", which is
  the mode that skips what already matches and does resume.

  relayium NOT installed — the zero-dependency fallback: a tar stream piped into
  the remote's own "tar -x -k". It does NOT resume and does NOT verify anything
  per file. Existing receiver files are kept rather than overwritten, but tar
  extracts members in order, so a collision can happen after other new files
  from the same batch were already written, leaving the batch partly applied.
  Whether the collision is reported depends on the remote's tar: GNU tar names
  it and exits non-zero, bsdtar keeps the file and exits 0. A "sent" line is
  therefore not proof that every file landed. Install relayium on the remote
  when you need per-file verification and the up-front collision check.

positional arguments:
  <src...>   files or directories to push
  <dest>     relayium://host[:port], or [user@]host:dest for the SSH path

flags:
  -i <file>        ssh identity file (SSH destinations)
  -p <port>        ssh port (SSH destinations)
  --no-resume      accepted, and a no-op for push: resume is a "sync" feature.
                   Push refuses a collision before it could ever continue a
                   partial file, and the tar fallback has no resume at all.
  --config-dir D   identity/trust directory for relayium:// destinations
                   (default ~/.config/relayium)

No push overwrites a file that is already on the receiver; use "relayium sync"
for the explicit replace/mirror operation.
`

const pullUsage = `relayium pull — copy files from a server you can ssh into

usage:
  relayium pull [user@]host:src <dest>
  relayium pull [user@]host:file -          write that one file to stdout

Pull runs over your own SSH connection: the bytes travel through it and never
touch Relayium's servers, and no Relayium account is involved. Host-key checking
(known_hosts) is what authenticates the server, exactly as for any other ssh.

It requires relayium to be INSTALLED ON THE REMOTE, because the remote acts as
the sender. There is no tar fallback for pull; install relayium there, or fetch
with scp/rsync. Each file is verified by SHA-256 and staged before it is
installed locally, and a pull onto a path that already exists is refused before
anything is written locally.

Like push, this is not a transaction and does not resume: files are installed
one at a time as they pass, so an interrupted pull leaves the files that already
landed in place, and re-running the same pull is then refused because those
files exist. Fetch the remainder explicitly, or mirror with "relayium sync".

A lone "-" as <dest> writes exactly one remote regular file to stdout and
nothing else: no local file or directory is created, and progress and errors
go to stderr. A directory (even one holding a single file), a symlink, a
special file or several files are refused with none of their bytes written
to stdout. The one file's bytes are written as they arrive and cannot be taken
back: if the stream is cut short or its final SHA-256 check fails, pull exits
non-zero and says to discard the output, so check the exit status (in a
pipeline, "set -o pipefail"). Pull into a directory instead to have each file
verified before it is installed. stdout must not be a terminal. A local
directory named "-" is written "./-".

positional arguments:
  [user@]host:src   the remote file or directory to fetch
  <dest>            local directory to write into, or "-" for stdout
                    (exactly one regular file)

flags:
  -i <file>        ssh identity file
  -p <port>        ssh port
  --no-resume      accepted, and a no-op for pull, for the same reason as push:
                   resume is a "sync" feature.
  --config-dir D   accepted because pull shares push's flag set, and IGNORED:
                   pull has no relayium:// path and reads no identity or trust
                   directory.
`

// What this side can honestly say about a zero-dependency push. The remote ran
// its own `tar -x -k`; nothing here saw which members it kept, and neither the
// tar path nor the native `relayium __recv` path resumes — an ordinary receive
// refuses a batch whose destination already exists, and a partial file is an
// existing path. So installing relayium on the remote buys verification and an
// up-front collision report, not resume; `relayium sync` is the mode that
// resumes. See push_resume_contract_test.go, which asserts both halves.
const zeroDepPushNote = "note: zero-dependency mode streamed a tar into the remote's `tar -x -k`. Files" +
	"\nalready on the receiver were kept, not overwritten, and this side cannot tell" +
	"\nwhich were skipped, so nothing was verified per file. Install relayium on the" +
	"\nremote for per-file SHA-256 verification, staging and an up-front collision" +
	"\nreport. Use `relayium sync` where you need resume, which no push mode does."

// A failed extraction is the case where "just run it again" is actively wrong:
// whatever landed is now an existing path, so a re-run's `tar -x -k` keeps it
// and skips the incoming copy — silently, even when the kept file is truncated.
const zeroDepPushFailureNote = "the remote extraction failed. Files already on the receiver were kept, but part" +
	"\nof this batch may have been written before it stopped, and this side cannot tell" +
	"\nhow much. Do not simply re-run: anything that landed, including a truncated file," +
	"\nis now an existing path that the remote's `tar -x -k` will keep and skip over." +
	"\nInspect the destination on the receiver, remove or reconcile the partial batch," +
	"\nthen retry. Install relayium on the remote for per-file SHA-256 verification," +
	"\nstaging and an up-front collision report. Use `relayium sync` where resume is" +
	"\nwhat you actually want."

func runPush(args []string, stdout, stderr io.Writer) int {
	if wantsHelpFS(stdFlagSet(&sshFlags{}), args) {
		fmt.Fprint(stdout, pushUsage)
		return 0
	}
	f, rest, err := parseFlagsStd(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) < 2 {
		fmt.Fprintln(stderr, "push needs <src...> <dest>")
		return 2
	}
	destArg := rest[len(rest)-1]
	srcArgs := rest[:len(rest)-1]
	// A relayium:// target is a daemon-direct push (server-to-server, no SSH);
	// everything else keeps the SSH path below unchanged.
	if strings.HasPrefix(destArg, daemonScheme) {
		return pushDaemon(destArg, srcArgs, f.configDir, f.noResume, stdout, stderr)
	}
	dest, err := xfer.ParseEndpoint(destArg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !dest.IsRemote() {
		fmt.Fprintln(stderr, "push destination must be remote (host:path)")
		return 2
	}
	m, srcs, err := xfer.BuildManifest(srcArgs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	xfer.WarnIfEmpty(m, stderr)
	opts := sshx.Opts{IdentityFile: f.identity, Port: f.port}

	has, err := sshx.RemoteHasRelayium(dest, opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if has {
		// A "--" terminator stops the remote runRecv's flag parser, so a dest
		// path literally starting with "-" isn't misread as an unknown flag.
		remoteCmd := "relayium __recv -- " + sshx.ShellQuote(dest.Path)
		if f.noResume {
			remoteCmd = "relayium __recv --no-resume -- " + sshx.ShellQuote(dest.Path)
		}
		sess, err := sshx.Dial(dest, remoteCmd, opts)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		prog := newSendProgress(stderr)
		rep, err := xfer.Send(sess, m, srcs, xfer.SendOpts{Progress: prog.report})
		prog.finish()
		cerr := sess.Close()
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if cerr != nil {
			fmt.Fprintln(stderr, cerr)
			return 1
		}
		return reportExit(rep, stderr)
	}

	// Zero-dependency mode: pipe a tar stream into the remote's own
	// `tar -x -k`. Keep-existing is the receiver's only protection here, and
	// nothing on this side can see which members it skipped, so say what this
	// mode is instead of implying the guarantees the native path gives.
	sess, err := sshx.Dial(dest, sshx.RemoteUntarCmd(dest.Path), opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := sshx.WriteTarStream(sess, m, srcs); err != nil {
		sess.Close()
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := sess.Close(); err != nil {
		fmt.Fprintln(stderr, err)
		fmt.Fprintln(stderr, zeroDepPushFailureNote)
		return 1
	}
	fmt.Fprintf(stdout, "sent %d file(s) (zero-dependency mode)\n", len(m.Files))
	fmt.Fprintln(stderr, zeroDepPushNote)
	return 0
}

func runPull(args []string, stdout, stderr io.Writer) int {
	if wantsHelpFS(stdFlagSet(&sshFlags{}), args) {
		fmt.Fprint(stdout, pullUsage)
		return 0
	}
	f, rest, err := parseFlagsStd(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) != 2 {
		fmt.Fprintln(stderr, "pull needs <host:src> <dest>")
		return 2
	}
	src, err := xfer.ParseEndpoint(rest[0])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !src.IsRemote() {
		fmt.Fprintln(stderr, "pull source must be remote (host:path)")
		return 2
	}
	destDir := rest[1]
	opts := sshx.Opts{IdentityFile: f.identity, Port: f.port}
	if destDir == "-" {
		// A lone "-" is stdout. A local directory literally named "-" is
		// spelled "./-" and takes the ordinary path below.
		return pullToStdout(src, opts, stdout, stderr)
	}
	// Pull requires relayium on the remote (it acts as the sender).
	sess, err := sshDial(src, "relayium __send "+sshx.ShellQuote(src.Path), opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	rep, err := peerReceive(sess, destDir, f.noResume, stderr)
	if err != nil {
		// This side stopped reading. A sender before v0.24.0 ignores a refusal
		// (an existing destination, say) and keeps streaming the body, and
		// Close would wait on it forever; abort instead.
		abortTransport(sess)
		fmt.Fprintln(stderr, err)
		return 1
	}
	if cerr := sess.Close(); cerr != nil {
		fmt.Fprintln(stderr, cerr)
		return 1
	}
	return reportExit(rep, stderr)
}

// pullStdoutIsTerminal is the real terminal test (an ioctl via x/term, never
// the character-device heuristic that also matches /dev/null). A var so tests
// can stand in for a terminal without one.
var pullStdoutIsTerminal = func(w io.Writer) bool { return isTTY(w) }

// stdoutSourceRefusal names why src cannot be a single file by its shape
// alone, or returns "". Every spelling of a filesystem root ("/", "/.", "a/..",
// "//") has one of these shapes, which matters because the remote builds its
// manifest relative to the source's parent: a root holding a single top-level
// file is the one directory that would otherwise look like one flat file.
func stdoutSourceRefusal(p string) string {
	last := p[strings.LastIndexByte(p, '/')+1:]
	switch {
	case p == "" || p == ".":
		return "names the remote working directory"
	case strings.HasSuffix(p, "/"):
		return "ends with \"/\", so it names a directory"
	case last == "." || last == "..":
		return "ends with \"" + last + "\", so it names a directory"
	}
	return ""
}

// abortTransport ends a transport this side has given up on without waiting
// for the peer: an ssh session is aborted and its child reaped in bounded
// time (sshx.Session.Abort). Anything else is closed.
func abortTransport(c io.Closer) {
	if a, ok := c.(interface{ Abort() error }); ok {
		_ = a.Abort()
		return
	}
	_ = c.Close()
}

// pullToStdout is `pull host:file -`: exactly one remote regular file, its
// bytes and nothing else on stdout, no local filesystem effect. It speaks the
// unchanged v1 protocol to the same `relayium __send` as a directory pull.
//
// Bytes are written as they arrive. A stream that is cut short or fails its
// final hash check exits 1 with a stderr line saying to discard the output;
// what was written cannot be recalled.
func pullToStdout(src xfer.Endpoint, opts sshx.Opts, stdout, stderr io.Writer) int {
	if pullStdoutIsTerminal(stdout) {
		fmt.Fprintln(stderr, "pull: refusing to write file bytes to a terminal; redirect stdout (> file) or pipe it (| cat)")
		return 2
	}
	if why := stdoutSourceRefusal(src.Path); why != "" {
		fmt.Fprintf(stderr, "pull: %q %s; \"pull host:file -\" writes exactly one file to stdout. Name the file, or pull into a local directory instead.\n", termtext.Safe(src.Path), why)
		return 2
	}
	// A write to a closed stdout pipe (`pull ... - | head -c1`) would otherwise
	// kill this process with SIGPIPE on the spot, before the ssh child could
	// be stopped. While this is registered the write returns EPIPE instead,
	// and the ordinary error path below aborts the session.
	sigpipe := make(chan os.Signal, 1)
	signal.Notify(sigpipe, syscall.SIGPIPE)
	defer signal.Stop(sigpipe)

	sess, err := sshDial(src, "relayium __send "+sshx.ShellQuote(src.Path), opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	prog := newRecvProgress(stderr)
	_, err = xfer.ReceiveToWriter(sess, stdout, xfer.StdoutOpts{Progress: prog.report})
	prog.finish()
	if err != nil {
		// Never Close here: a sender before v0.24.0 ignores a refusal and keeps
		// streaming into a pipe nobody reads, and Close would wait on it forever.
		abortTransport(sess)
		var oe *xfer.OutputError
		switch {
		case errors.As(err, &oe):
			fmt.Fprintf(stderr, "pull: %v; the transfer was stopped and the output is incomplete\n", err)
		case err == io.EOF:
			// Bare EOF comes only from a frame read before the body (every
			// later failure is wrapped with a byte count), so nothing was
			// written to stdout.
			fmt.Fprintln(stderr, "pull: the remote closed the connection before any file data arrived; nothing was written to stdout (its own error, if any, is shown above)")
		default:
			fmt.Fprintf(stderr, "pull: %v\n", err)
		}
		return 1
	}
	if err := sess.Close(); err != nil {
		fmt.Fprintf(stderr, "pull: the output is complete and verified, but ssh then reported: %v\n", err)
		return 1
	}
	return 0
}

func runRecv(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("__recv", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var noResume bool
	fs.BoolVar(&noResume, "no-resume", false, "disable resuming partial files")
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, "__recv needs <destDir>")
		return 2
	}
	// AllowSync: `__recv` is the receiver half of the user's own push/sync,
	// started by their own SSH session and running as them. `sync` over SSH is
	// this path. CreateDestDir: the destination is that same user's `host:path`,
	// created when missing just as zero-dependency push's `mkdir -p` does.
	rep, err := xfer.Receive(helperStdio(), fs.Arg(0), xfer.RecvOpts{NoResume: noResume, AllowSync: true, AllowDelete: true, CreateDestDir: true})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

func runSend(args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "__send needs <srcPath>")
		return 2
	}
	m, srcs, err := xfer.BuildManifest([]string{args[0]})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	xfer.WarnIfEmpty(m, stderr)
	if _, err := xfer.Send(helperStdio(), m, srcs, xfer.SendOpts{}); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func reportExit(rep xfer.Report, stderr io.Writer) int {
	if len(rep.Failed) > 0 {
		// The names are the peer's manifest paths on a pull or a receive. Failed
		// holds both a hash mismatch and a file the receiver could not save or
		// install, and the result on the wire does not say which, so neither side
		// names a cause.
		fmt.Fprintf(stderr, "%d file(s) could not be verified or saved: %v\n", len(rep.Failed), termtext.SafeAll(rep.Failed))
		return 1
	}
	return 0
}
