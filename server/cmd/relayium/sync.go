package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

const syncUsage = `relayium sync — one-way incremental folder mirror

usage:
  relayium sync <src...> relayium://host[:port] [--checksum] [--watch]
                [--delete [--strict-delete] | --exclude PATTERN ...]
  relayium sync --check [<src...>] relayium://host[:port]
  relayium sync --preview <src...> relayium://host[:port] [--exclude PATTERN ...]
                                                  direct, no SSH/account

A relayium:// destination is the direct server-to-server path: the receiver runs
"relayium serve --dir D" and this mirrors into that directory over a pinned TLS
1.3 connection. No relay, no SSH, no Relayium account — the listener accepts this
host only once its fingerprint ("relayium id") is authorized there.

Large selections are automatically split into bounded batches. A multi-batch
sync needs a receiver with large directory sync support and cannot use --delete.
Keep the receiver running without --once. If an ordinary sync is interrupted,
it retries up to eight times within the current batch, rechecking completed
files and reusing matching checkpoints. --delete disables reconnect within an attempt.

Only files that changed are sent, and an existing verified prefix can be reused.
"Unchanged" is decided by content: each source file's SHA-256 goes in the manifest
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
  --preview        list local candidate paths and sizes using metadata only.
                   No file content is opened or hashed, and no connection is
                   made. Which files actually need sending is decided in sync.
  --check          check the authorized connection before hashing or sending
                   files. Include sources to check capability for their file
                   count. Use with a persistent receiver: serve --once exits
                   after handling this check. No destination files change.
  --exclude PATTERN
                   skip only paths matched by a pattern you provide. Repeat
                   the flag for multiple patterns. Use forward slashes, and
                   quote shell globs. A pattern with a slash is relative to
                   each source directory; a basename glob matches at any
                   depth. A glob does not cross slashes. A matched directory
                   skips its entire subtree.
                   Exclusions cannot be combined with --delete.
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
                   one sync. It runs in the foreground. Use a process
                   supervisor to keep it running after logout and run the
                   receiver without --once.

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
                   is aborted. The receiver keeps only verified files at their
                   final paths. A second Ctrl-C ends it at
                   once.
  --config-dir D   identity/trust directory for relayium:// destinations
                   (default ~/.config/relayium)

The destination requires a Relayium listener. SSH destinations are disabled.
`

// runSync implements `relayium sync <src...> <dest> [--delete] [--watch]`: a
// one-way incremental mirror over the direct protocol.
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
	if len(rest) < 2 && !(f.check && len(rest) == 1) {
		fmt.Fprintln(stderr, "sync needs <src...> <dest>")
		return 2
	}
	dest := rest[len(rest)-1]
	srcs := rest[:len(rest)-1]
	// Refuse before watch can retry forever or touch the source filesystem.
	if !strings.HasPrefix(dest, daemonScheme) || f.identity != "" || f.port != 0 {
		return sshRetired(stderr)
	}
	if f.preview {
		if f.check || f.watch || f.del || f.strictDelete || f.checksum {
			fmt.Fprintln(stderr, "sync: --preview accepts file selection and exclusions only")
			return 2
		}
		return previewSync(dest, srcs, f.excludes, stdout, stderr)
	}
	if f.strictDelete && !f.del {
		fmt.Fprintln(stderr, "sync: --strict-delete only applies together with --delete")
		return 2
	}

	if f.del && len(f.excludes) != 0 {
		fmt.Fprintln(stderr, "sync: --exclude cannot be combined with --delete: the receiving side must keep excluded paths")
		return 2
	}
	if f.check && f.watch {
		fmt.Fprintln(stderr, "sync: --check cannot be combined with --watch")
		return 2
	}

	ctx, cancel := transferSignalContext()
	defer cancel()
	if !f.watch {
		// One sync: a signal stops it at once (no drain).
		return syncOnce(ctx, 0, dest, srcs, f, stderr)
	}
	// Watch mode: WatchAndSync owns the whole loop, including the first sync, so
	// an initial failure retries on its own timer instead of waiting for a
	// change that may never come. A signal starts no further attempt; the one
	// running gets syncWatchDrain to finish and is then aborted.
	err := xfer.WatchAndSync(ctx, srcs, func() error {
		if code := syncOnce(ctx, syncWatchDrain, dest, srcs, f, stderr); code != 0 {
			// syncOnce already printed why; the code is what the retry needs.
			return fmt.Errorf("exit status %d", code)
		}
		return nil
	}, xfer.WatchOpts{
		Excludes: f.excludes,
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
	check        bool
	preview      bool
	excludes     xfer.Excludes
}

// syncFlagSet declares `sync`'s flags, binding them into f. The help pre-scan
// reads its value-flag names off this same declaration (see wantsHelpFS), so a
// new flag cannot silently change what `--flag -h` means.
func syncFlagSet(f *syncFlags) *flag.FlagSet {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	fs.StringVar(&f.identity, "i", "", "ssh identity file")
	fs.IntVar(&f.port, "p", 0, "ssh port")
	fs.BoolVar(&f.del, "delete", false, "delete files on the receiver that are gone from the source")
	fs.BoolVar(&f.check, "check", false, "check the receiver connection and capabilities without transferring")
	fs.BoolVar(&f.preview, "preview", false, "list local candidate paths and sizes without opening files or connecting")
	fs.Func("exclude", "exclude a relative path or basename glob (repeatable)", f.excludes.Add)
	fs.BoolVar(&f.watch, "watch", false, "keep running and re-sync on change, retrying failures")
	fs.BoolVar(&f.checksum, "checksum", false, "require the receiver to compare content, refusing an older receiver before sending anything")
	fs.BoolVar(&f.strictDelete, "strict-delete", false, "with --delete: exit non-zero unless the receiver confirms the delete ran in full")
	fs.StringVar(&f.configDir, "config-dir", "", "identity/trust directory (daemon)")
	return fs
}

func previewSync(dest string, srcs []string, excludes xfer.Excludes, stdout, stderr io.Writer) int {
	if _, err := parseDaemonURL(dest); err != nil {
		fmt.Fprintln(stderr, termSafe(err.Error()))
		return 2
	}
	manifest, _, excluded, err := xfer.BuildFilteredManifest(srcs, excludes)
	if err != nil {
		fmt.Fprintln(stderr, termSafe(err.Error()))
		return 1
	}
	var size uint64
	for _, file := range manifest.Files {
		if uint64(file.Size) > math.MaxUint64-size {
			fmt.Fprintln(stderr, "sync preview: total byte count is too large")
			return 1
		}
		size += uint64(file.Size)
	}
	for _, file := range manifest.Files {
		if _, err := fmt.Fprintf(stdout, "%d\t%s\n", file.Size, strconv.Quote(file.Path)); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	_, err = fmt.Fprintf(stdout,
		"Preview: %d candidate files, %d bytes; excluded by your rules: %d files, %d directory trees. Destination not checked.\n",
		len(manifest.Files), size, excluded.Files, excluded.Directories)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// syncWatchDrain is how long `sync --watch` lets a transfer in flight finish
// after a stop signal before aborting it. A var so tests can shorten it.
var syncWatchDrain = 30 * time.Second

// syncOnce runs a single incremental sync of srcs → dest. ctx stops it: a
// transfer in flight gets drain to finish and is then aborted.
func syncOnce(ctx context.Context, drain time.Duration, dest string, srcs []string, f syncFlags, stderr io.Writer) int {
	if ctx.Err() != nil {
		return 130
	}
	if len(srcs) != 0 {
		fmt.Fprintln(stderr, "Scanning source paths...")
	}
	m, paths, excluded, err := xfer.BuildFilteredManifest(srcs, f.excludes)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if ctx.Err() != nil {
		return 130
	}
	if len(f.excludes) != 0 {
		fmt.Fprintf(stderr, "Excluded by your rules: %d files, %d directory trees\n", excluded.Files, excluded.Directories)
	}
	if !f.check {
		xfer.WarnIfEmpty(m, stderr)
	}
	if f.del && len(paths) == 0 {
		fmt.Fprintln(stderr, "refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).")
		return 1
	}
	ends, err := xfer.SyncBatches(m)
	if err != nil {
		fmt.Fprintln(stderr, termSafe(err.Error()))
		return 1
	}
	multiple := len(ends) > 1
	if multiple {
		if f.del {
			fmt.Fprintln(stderr, "sync: --delete requires the complete selection to fit in one batch; nothing was sent")
			return 1
		}
		if err := xfer.ValidateBatchedSync(m); err != nil {
			fmt.Fprintln(stderr, termSafe(err.Error()))
			return 1
		}
	}
	// Content checking is the default; --checksum makes it a requirement
	// rather than a best effort when talking to an older receiver.
	opts := xfer.SendOpts{Sync: true, Delete: f.del, ContentCheck: true,
		RequireContentCheck: f.checksum || multiple, RequireDeleteReport: f.strictDelete,
		ReceiverCheckProgress: receiverCheckProgress(stderr)}
	if f.check {
		return checkSync(ctx, dest, f.configDir, len(m.Files), opts, stderr)
	}
	var total xfer.Report
	start := 0
	for i, end := range ends {
		if multiple {
			fmt.Fprintf(stderr, "Sync batch %d/%d (%d files)\n", i+1, len(ends), end-start)
		}
		rep, err := sendSyncBatch(ctx, drain, i > 0, dest, f.configDir,
			xfer.Manifest{Files: m.Files[start:end]}, paths[start:end], opts, stderr)
		if multiple {
			// A failed or interrupted wire transaction has no final receipt.
			// Only count batches the receiver actually confirmed.
			if err == nil {
				total.Files += rep.Files
				total.Bytes += rep.Bytes
				total.Skipped += rep.Skipped
				total.Failed = append(total.Failed, rep.Failed...)
				total.ContentChecked = true
			}
			rep = total
		}
		if errors.Is(err, errTransferInterrupted) {
			fmt.Fprintf(stderr, "interrupted after sending %d file(s); rerun sync to verify completed files and resume supported checkpoints\n", rep.Files)
			return 130
		}
		if err != nil {
			fmt.Fprintln(stderr, termSafe(err.Error()))
			if multiple {
				fmt.Fprintf(stderr, "Confirmed before interruption: %d saved, %d existing matched, %d failed\n",
					max(0, total.Files-len(total.Failed)), total.Skipped, len(total.Failed))
			}
			return 1
		}
		if !multiple {
			return reportSync(rep, f, stderr)
		}
		start = end
	}
	return reportSync(total, f, stderr)
}

func sendSyncBatch(ctx context.Context, drain time.Duration, continuing bool, dest, configDir string, m xfer.Manifest,
	paths []string, opts xfer.SendOpts, stderr io.Writer) (xfer.Report, error) {
	// Hash before the data connection so a legacy receiver never waits for
	// source I/O under its handshake idle deadline.
	cm, err := xfer.WithContentDigestsProgress(ctx, m, paths, syncProgress(stderr, "Checking SHA-256"))
	if ctx.Err() != nil {
		return xfer.Report{}, errTransferInterrupted
	}
	if err != nil {
		return xfer.Report{}, err
	}
	return retrySyncBatch(ctx, drain, continuing, dest, configDir, cm, paths, opts, stderr)
}

func checkSync(ctx context.Context, dest, configDir string, fileCount int, opts xfer.SendOpts, stderr io.Writer) int {
	fmt.Fprintln(stderr, "Checking receiver connection...")
	tconn, err := dialDaemonContext(ctx, dest, configDir, stderr)
	if ctx.Err() != nil {
		return 130
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer tconn.Close()
	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	stop := context.AfterFunc(checkCtx, func() { abortRaw(tconn) })
	defer stop()
	rep, err := xfer.CheckSync(tconn, fileCount, opts)
	if ctx.Err() != nil {
		return 130
	}
	if errors.Is(checkCtx.Err(), context.DeadlineExceeded) {
		fmt.Fprintln(stderr, "sync check: receiver did not reply in time")
		return 1
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stderr, "Receiver connection and authorization OK (%d source files checked; no file data sent)\n", fileCount)
	if rep.ContentCheckUnconfirmed {
		fmt.Fprintln(stderr, "The receiver uses size and modification time to skip files. Use --checksum to require content checking.")
	}
	return 0
}

// reportSync prints a sync's outcome to stderr and returns its exit code.
//
// The default exit contract is unchanged: 0 unless a file failed. A receiver
// that could not confirm content checking (an older relayium) is a warning, as
// is a refused delete. --strict-delete turns every delete outcome other than
// "ran in full" into a non-zero exit.
func reportSync(rep xfer.Report, f syncFlags, stderr io.Writer) int {
	fmt.Fprintf(stderr, "synced: %d sent, %d unchanged\n", rep.Files, rep.Skipped)
	comparison := "size and modification time"
	if rep.ContentChecked {
		comparison = "SHA-256"
	}
	fmt.Fprintf(stderr, "Receiver result: %d saved, %d existing matched (%s), %d failed\n",
		max(0, rep.Files-len(rep.Failed)), rep.Skipped, comparison, len(rep.Failed))
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
		fmt.Fprintln(stderr, "warning: the receiver refused the mirror delete; nothing was deleted")
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
