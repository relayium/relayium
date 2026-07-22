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

const usage = `relayium — file transfer

usage:
  relayium push <src...> [user@]host:dest    push files to a server you can ssh into
  relayium push <src...> relayium://host[:port]  push straight to a listening peer (daemon direct)
  relayium sync [--delete] [--watch] <src...> <dest>   incremental one-way folder mirror
  relayium pull [user@]host:src <dest>       pull files from such a server
  relayium send <src...> <code>              send to a peer over a pairing code (cross-network)
  relayium receive <code> [destdir]          receive such a transfer
  relayium serve [--dir D] [--port N] [--once]   listen for daemon-direct pushes
                                             (in a terminal, approve each new peer on first push)
  relayium id                                print this host's fingerprint
  relayium authorize <fingerprint>          pre-authorize a pusher (for non-interactive serve)
  relayium login [--server URL]             log in to the cloud (device code flow)
  relayium logout                           clear local cloud credentials
  relayium whoami                           show the logged-in cloud account
  relayium up [--burn] [--ttl D] [--max-downloads N] <path...>
                                             encrypt client-side and upload to the cloud
  relayium down <link-or-code> [destDir]    fetch and decrypt a cloud claim (no login needed)
  relayium update [--check] [--force]       upgrade to the latest release in place
  relayium version                          print the CLI version

flags (after the subcommand):
  -i <file>       ssh identity file
  -p <port>       ssh port
  --no-resume     disable resuming partial files
  --config-dir D  identity/trust directory (daemon direct; default ~/.config/relayium)
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
	case "update":
		return runUpdate(args[1:], stdout, stderr)
	case "version", "--version", "-version":
		return runVersion(stdout)
	case "__recv":
		return runRecv(args[1:], stdout, stderr)
	case "__send":
		return runSend(args[1:], stdout, stderr)
	case "-h", "--help", "help":
		fmt.Fprint(stdout, usage)
		return 0
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

func runPush(args []string, stdout, stderr io.Writer) int {
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

	// Zero-dependency mode: pipe a tar stream into remote `tar -x`.
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
		return 1
	}
	fmt.Fprintf(stdout, "sent %d file(s) (zero-dependency mode)\n", len(m.Files))
	return 0
}

func runPull(args []string, stdout, stderr io.Writer) int {
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
	if err := fs.Parse(args); err != nil {
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
