package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/relayium/relayium/internal/sshx"
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
  relayium inbox <subcommand>               RECEIVE SIDE ONLY: accept files your account
                                             sends to this device. There is no CLI sender for
                                             it — you send TO an inbox from the Web or the app.
                                             To move files between two servers, use serve +
                                             push/sync above instead.
                                             (enable --dir, run, status, pause, resume, disable,
                                              service; see relayium inbox --help)
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

Pull runs over your own SSH connection: the bytes travel through it and never
touch Relayium's servers, and no Relayium account is involved. Host-key checking
(known_hosts) is what authenticates the server, exactly as for any other ssh.

It requires relayium to be INSTALLED ON THE REMOTE, because the remote acts as
the sender. There is no tar fallback for pull; install relayium there, or fetch
with scp/rsync. Each file is verified by SHA-256 and staged before it is
installed locally, and a pull onto a path that already exists is refused before
any bytes move.

Like push, this is not a transaction and does not resume: files are installed
one at a time as they pass, so an interrupted pull leaves the files that already
landed in place, and re-running the same pull is then refused because those
files exist. Fetch the remainder explicitly, or mirror with "relayium sync".

positional arguments:
  [user@]host:src   the remote file or directory to fetch
  <dest>            local directory to write into

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
		rep, err := xfer.Send(sess, m, srcs, xfer.SendOpts{Progress: progressFn(stderr)})
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
	// Pull requires relayium on the remote (it acts as the sender).
	sess, err := sshx.Dial(src, "relayium __send "+sshx.ShellQuote(src.Path), opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	rep, err := xfer.Receive(sess, destDir, xfer.RecvOpts{NoResume: f.noResume})
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
	rw := duplex{Reader: os.Stdin, Writer: os.Stdout}
	rep, err := xfer.Receive(rw, fs.Arg(0), xfer.RecvOpts{NoResume: noResume, AllowDelete: true})
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
	rw := duplex{Reader: os.Stdin, Writer: os.Stdout}
	if _, err := xfer.Send(rw, m, srcs, xfer.SendOpts{}); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func reportExit(rep xfer.Report, stderr io.Writer) int {
	if len(rep.Failed) > 0 {
		fmt.Fprintf(stderr, "%d file(s) failed integrity check: %v\n", len(rep.Failed), rep.Failed)
		return 1
	}
	return 0
}

func progressFn(stderr io.Writer) func(string, int64, int64) {
	// Minimal, non-TTY-safe progress; refined rendering is out of Phase 1 scope.
	return func(path string, sent, total int64) {
		if sent == total {
			fmt.Fprintf(stderr, "  %s (%d bytes)\n", path, total)
		}
	}
}
