package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

const syncUsage = `relayium sync — one-way incremental folder mirror

usage:
  relayium sync <src...> relayium://host[:port] [--delete] [--watch]   direct, no SSH/account
  relayium sync <src...> [user@]host:dest [--delete] [--watch]         over SSH

A relayium:// destination is the direct server-to-server path: the receiver runs
"relayium serve --dir D" and this mirrors into that directory over a pinned TLS
1.3 connection. No relay, no SSH, no Relayium account — the listener accepts this
host only once its fingerprint ("relayium id") is authorized there.

Only files that changed are sent; unchanged ones (same size and mtime) are
skipped, and a partial file resumes.

positional arguments:
  <src...>   directories or files to mirror
  <dest>     relayium://host[:port], or [user@]host:dest for the SSH path

flags:
  --delete         also delete files on the receiver that are gone from the
                   source. WHO HAS TO AGREE differs by destination:

                   relayium://host — the listener is a separate long-running
                   process someone else started, so it must have been started as
                   "relayium serve --allow-delete". Without that, the delete is
                   ignored and reported back to you; nothing is removed.

                   [user@]host:dest — there is no separate listener to consent:
                   this starts the receiver over your own SSH session, as you.
                   No --allow-delete is involved, and passing --delete here does
                   delete.

                   Either way deletion is confined to the top-level directories
                   this run actually sends — a sibling folder under the
                   receiver's --dir is never touched — and an empty source
                   refuses outright rather than mirroring nothing onto
                   everything.
  --watch          keep running and re-sync when the sources change. Changes are
                   debounced and runs never overlap, so a burst of edits becomes
                   one sync.

                   A failed sync retries on its own with exponential backoff
                   (1s, doubling, capped at 30s) — including the very first
                   sync, so a receiver that was down when you started is
                   picked up without you touching a file again. It keeps
                   retrying for as long as it runs; that is recovery from a
                   transient failure, not a promise that the sync will ever
                   succeed. Every attempt reports its own error, so a
                   permanent problem stays visible instead of looking like
                   progress.

                   Sources are checked before it starts watching: a missing,
                   unreadable or unwatchable source fails immediately instead of
                   leaving a process that is watching nothing. A file source is
                   watched together with the directory holding it, because
                   editors replace a file by renaming a new one over it.

                   The watch set repairs itself while it runs. A new
                   subdirectory that could not be followed, or a source that is
                   deleted and recreated, is rebuilt before the next sync counts
                   as healthy — until then it keeps reporting the problem and
                   retrying, so it never sits there "synced" while blind to part
                   of the source.

                   Ctrl-C stops it: no further attempt is started, and it exits
                   once the attempt already running returns. A sync in flight is
                   not cut off mid-transfer, so stopping can take as long as the
                   current transfer does.
  -i <file>        ssh identity file (SSH destinations)
  -p <port>        ssh port (SSH destinations)
  --config-dir D   identity/trust directory for relayium:// destinations
                   (default ~/.config/relayium)

Both destinations require relayium on the receiver: sync speaks the native
protocol and has no tar fallback.
`

// runSync implements `relayium sync <src...> <dest> [--delete] [--watch]`: a
// one-way incremental mirror over the same transports as push. It always uses
// the native protocol (no tar fallback).
func runSync(args []string, stdout, stderr io.Writer) int {
	var f syncFlags
	fs := syncFlagSet(&f)
	fs.SetOutput(stderr)
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, syncUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) < 2 {
		fmt.Fprintln(stderr, "sync needs <src...> <dest>")
		return 2
	}
	dest := rest[len(rest)-1]
	srcs := rest[:len(rest)-1]

	once := func() int {
		return syncOnce(dest, srcs, f, stdout, stderr)
	}
	if !f.watch {
		return once()
	}
	// Watch mode: WatchAndSync owns the whole loop, including the first sync, so
	// an initial failure retries on its own timer instead of waiting for a
	// change that may never come.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	err := xfer.WatchAndSync(ctx, srcs, func() error {
		if code := once(); code != 0 {
			// syncOnce already printed why; the code is what the retry needs.
			return fmt.Errorf("exit status %d", code)
		}
		return nil
	}, xfer.WatchOpts{
		OnNotice: func(err error) { fmt.Fprintln(stderr, "watch:", err) },
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

type syncFlags struct {
	identity  string
	port      int
	del       bool
	watch     bool
	configDir string
}

// syncFlagSet declares `sync`'s flags, binding them into f. The help pre-scan
// reads its value-flag names off this same declaration (see wantsHelpFS), so a
// new flag cannot silently change what `--flag -h` means.
func syncFlagSet(f *syncFlags) *flag.FlagSet {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	fs.StringVar(&f.identity, "i", "", "ssh identity file")
	fs.IntVar(&f.port, "p", 0, "ssh port")
	fs.BoolVar(&f.del, "delete", false, "delete files on the receiver that are gone from the source")
	fs.BoolVar(&f.watch, "watch", false, "keep running and re-sync on change, retrying failures")
	fs.StringVar(&f.configDir, "config-dir", "", "identity/trust directory (daemon)")
	return fs
}

// syncOnce runs a single incremental sync of srcs → dest.
func syncOnce(dest string, srcs []string, f syncFlags, stdout, stderr io.Writer) int {
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	xfer.WarnIfEmpty(m, stderr)
	if f.del && len(paths) == 0 {
		fmt.Fprintln(stderr, "refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).")
		return 1
	}
	opts := xfer.SendOpts{Sync: true, Delete: f.del, Progress: progressFn(stderr)}

	if strings.HasPrefix(dest, daemonScheme) {
		tconn, err := dialDaemon(dest, f.configDir, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		defer tconn.Close()
		rep, err := xfer.Send(tconn, m, paths, opts)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintf(stderr, "synced: %d sent, %d unchanged\n", rep.Files, rep.Skipped)
		if rep.DeleteDenied {
			fmt.Fprintln(stderr, "warning: the receiver ignored --delete (its listener isn't started with --allow-delete); nothing was deleted")
		}
		return reportExit(rep, stderr)
	}

	// SSH transport: sync requires relayium on the remote (native protocol).
	ep, err := xfer.ParseEndpoint(dest)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !ep.IsRemote() {
		fmt.Fprintln(stderr, "sync destination must be remote (host:path or relayium://host)")
		return 2
	}
	sopts := sshx.Opts{IdentityFile: f.identity, Port: f.port}
	has, err := sshx.RemoteHasRelayium(ep, sopts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !has {
		fmt.Fprintln(stderr, "sync requires relayium installed on the remote (native protocol); install it there or use push")
		return 1
	}
	sess, err := sshx.Dial(ep, "relayium __recv -- "+sshx.ShellQuote(ep.Path), sopts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	rep, serr := xfer.Send(sess, m, paths, opts)
	cerr := sess.Close()
	if serr != nil {
		fmt.Fprintln(stderr, serr)
		return 1
	}
	if cerr != nil {
		fmt.Fprintln(stderr, cerr)
		return 1
	}
	fmt.Fprintf(stderr, "synced: %d sent, %d unchanged\n", rep.Files, rep.Skipped)
	if rep.DeleteDenied {
		fmt.Fprintln(stderr, "warning: the receiver ignored --delete (its listener isn't started with --allow-delete); nothing was deleted")
	}
	return reportExit(rep, stderr)
}
