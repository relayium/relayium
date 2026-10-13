package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

const syncUsage = `relayium sync — one-way incremental folder mirror

usage:
  relayium sync <src...> relayium://host[:port] [--delete [--strict-delete]] [--checksum] [--watch]
                                                  direct, no SSH/account

A relayium:// destination is the direct server-to-server path: the receiver runs
"relayium serve --dir D" and this mirrors into that directory over a pinned TLS
1.3 connection. No relay, no SSH, no Relayium account — the listener accepts this
host only once its fingerprint ("relayium id") is authorized there.

Only files that changed are sent, and a partial file resumes. "Unchanged" is
decided by content: this side puts each source file's SHA-256 in the manifest
(one extra read of every source file per run), and the receiver skips a file
only when its own copy has the same size and digest, and installs a received
file only when its bytes match that digest. An edit that keeps the size within
the same second, or a copy that preserves timestamps, is therefore still sent.
A receiver running an older relayium cannot compare content: it skips by size
and modification time as before, and this side warns that it did (see
--checksum to refuse instead).

positional arguments:
  <src...>   directories or files to mirror
  <dest>     relayium://host[:port]

flags:
  --delete         also delete files on the receiver that are gone from the
                   source. the listener must consent:

                   relayium://host — the listener is a separate long-running
                   process someone else started, so it must have been started as
                   "relayium serve --allow-delete". Without that, the delete is
                   ignored and reported back to you; nothing is removed.

                   Deletion is confined to the top-level directories
                   this run actually sends — a sibling folder under the
                   receiver's --dir is never touched — and an empty source
                   refuses outright rather than mirroring nothing onto
                   everything.
  --checksum       require content checking: ask the receiver first, with a
                   question that writes and deletes nothing, and refuse a
                   receiver that cannot compare content (an older relayium).
                   Without it the check is still the default; an older
                   receiver then falls back to size+mtime and a warning says so.
  --strict-delete  with --delete only: exit 1 unless the receiver confirms
                   the delete ran in full (not ignored, refused or stopped
                   part-way). A receiver running an older relayium cannot
                   report that; the same first question finds out, and it is
                   refused before the delete request is ever sent. Without
                   --strict-delete these outcomes stay warnings, as before.
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

                   Ctrl-C or SIGTERM stops it: no further attempt is started,
                   and a transfer in flight gets 30 seconds to finish before it
                   is aborted (the receiver discards the file it was writing
                   and keeps only verified files). A second Ctrl-C ends it at
                   once.
  --config-dir D   identity/trust directory for relayium:// destinations
                   (default ~/.config/relayium)

The destination requires a Relayium listener. SSH destinations are disabled.
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
	// Refuse before watch can retry forever or touch the source filesystem.
	if !strings.HasPrefix(dest, daemonScheme) || f.identity != "" || f.port != 0 {
		return sshRetired(stderr)
	}
	if f.strictDelete && !f.del {
		fmt.Fprintln(stderr, "sync: --strict-delete only applies together with --delete")
		return 2
	}

	ctx, cancel := transferSignalContext()
	defer cancel()
	if !f.watch {
		// One sync: a signal stops it at once (no drain).
		return syncOnce(ctx, 0, dest, srcs, f, stdout, stderr)
	}
	// Watch mode: WatchAndSync owns the whole loop, including the first sync, so
	// an initial failure retries on its own timer instead of waiting for a
	// change that may never come. A signal starts no further attempt; the one
	// running gets syncWatchDrain to finish and is then aborted.
	err := xfer.WatchAndSync(ctx, srcs, func() error {
		if code := syncOnce(ctx, syncWatchDrain, dest, srcs, f, stdout, stderr); code != 0 {
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
	identity     string
	port         int
	del          bool
	watch        bool
	checksum     bool
	strictDelete bool
	configDir    string
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
	fs.BoolVar(&f.checksum, "checksum", false, "require the receiver to compare content, refusing an older receiver before sending anything")
	fs.BoolVar(&f.strictDelete, "strict-delete", false, "with --delete: exit non-zero unless the receiver confirms the delete ran in full")
	fs.StringVar(&f.configDir, "config-dir", "", "identity/trust directory (daemon)")
	return fs
}

// syncWatchDrain is how long `sync --watch` lets a transfer in flight finish
// after a stop signal before aborting it. A var so tests can shorten it.
var syncWatchDrain = 30 * time.Second

// syncOnce runs a single incremental sync of srcs → dest. ctx stops it: a
// transfer in flight gets drain to finish and is then aborted.
func syncOnce(ctx context.Context, drain time.Duration, dest string, srcs []string, f syncFlags, stdout, stderr io.Writer) int {
	if ctx.Err() != nil {
		return 130
	}
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if ctx.Err() != nil {
		return 130
	}
	xfer.WarnIfEmpty(m, stderr)
	if f.del && len(paths) == 0 {
		fmt.Fprintln(stderr, "refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).")
		return 1
	}
	prog := newSendProgress(stderr)
	// Content checking is the default: what counts as "unchanged" is decided
	// by the bytes, not by size and whole-second mtime. --checksum makes it a
	// requirement rather than a best effort.
	opts := xfer.SendOpts{Sync: true, Delete: f.del, Progress: prog.report,
		ContentCheck: true, RequireContentCheck: f.checksum, RequireDeleteReport: f.strictDelete}

	if strings.HasPrefix(dest, daemonScheme) {
		// Digests are computed BEFORE dialing: hashing a large tree takes
		// time, and a listener bounds how long a connected peer may stay
		// silent.
		cm, err := xfer.WithContentDigestsContext(ctx, m, paths)
		if ctx.Err() != nil {
			// Stopped while hashing: nothing was dialed or sent.
			fmt.Fprintln(stderr, "interrupted before anything was sent")
			return 130
		}
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		tconn, err := dialDaemon(dest, f.configDir, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		defer tconn.Close()
		rep, err := sendWithShutdown(ctx, tconn, cm, paths, opts, drain)
		prog.finish()
		if errors.Is(err, errTransferInterrupted) {
			return reportInterrupted(rep, stderr)
		}
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return reportSync(rep, f, stderr)
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
	prog.finish()
	cerr := sess.Close()
	if serr != nil {
		fmt.Fprintln(stderr, serr)
		return 1
	}
	if cerr != nil {
		fmt.Fprintln(stderr, cerr)
		return 1
	}
	return reportSync(rep, f, stderr)
}

// reportSync prints a sync's outcome to stderr and returns its exit code.
//
// The default exit contract is unchanged: 0 unless a file failed. A receiver
// that could not confirm content checking (an older relayium) is a warning, as
// is a refused delete. --strict-delete turns every delete outcome other than
// "ran in full" into a non-zero exit.
func reportSync(rep xfer.Report, f syncFlags, stderr io.Writer) int {
	fmt.Fprintf(stderr, "synced: %d sent, %d unchanged\n", rep.Files, rep.Skipped)
	if rep.ContentCheckUnconfirmed {
		fmt.Fprintln(stderr, "warning: the receiver runs an older relayium that decides what is unchanged by size and modification time only;")
		fmt.Fprintln(stderr, "  a file whose content changed without changing either may have been skipped. Update relayium on the receiver,")
		fmt.Fprintln(stderr, "  or pass --checksum to refuse such a receiver instead of syncing.")
	}
	deleteFailed := false
	switch {
	case rep.DeleteDenied:
		deleteFailed = true
		fmt.Fprintln(stderr, "warning: the receiver ignored --delete (its listener isn't started with --allow-delete); nothing was deleted")
	case rep.DeleteRefused:
		deleteFailed = true
		fmt.Fprintln(stderr, "warning: the receiver refused the mirror delete (it could not derive a safe scope); nothing was deleted")
	case rep.DeletePartialRemote:
		deleteFailed = true
		fmt.Fprintln(stderr, "warning: the receiver's mirror delete stopped part-way; some stale files were removed and some remain (see the receiver's log)")
	case rep.DeleteOutcomeUnknown && f.strictDelete:
		// Send refuses this case before any file (RequireDeleteReport); kept
		// so the exit can never be 0 if that ever changed.
		deleteFailed = true
		fmt.Fprintln(stderr, "warning: the receiver runs an older relayium that cannot report whether its delete ran in full")
	}
	code := reportExit(rep, stderr)
	if code == 0 && f.strictDelete && deleteFailed {
		fmt.Fprintln(stderr, "sync: --strict-delete: the delete did not run in full")
		return 1
	}
	return code
}
