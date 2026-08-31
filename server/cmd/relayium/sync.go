package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"time"

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

flags:
  --delete         also delete files on the receiver that are gone from the
                   source. The receiver must be started with --allow-delete or
                   it is ignored and reported. Deletion is confined to the
                   top-level directories this run actually sends — a sibling
                   folder under the receiver's --dir is never touched — and an
                   empty source refuses outright rather than mirroring nothing
                   onto everything.
  --watch          keep running and re-sync on change (debounced).
  -i <file>        ssh identity file (SSH destinations)
  -p <port>        ssh port (SSH destinations)
  --config-dir D   identity/trust directory for relayium:// destinations
                   (default ~/.config/relayium)

Both destinations require relayium on the receiver: sync speaks the native
protocol and has no tar fallback.
`

// syncValueFlags are the sync flags whose value is a separate token (--delete
// and --watch are bool, so they are correctly absent). Keep it in step with the
// FlagSet below; TestValueFlagArgumentIsNotAHelpRequest exercises every entry.
var syncValueFlags = []string{"i", "p", "config-dir"}

// runSync implements `relayium sync <src...> <dest> [--delete] [--watch]`: a
// one-way incremental mirror over the same transports as push. It always uses
// the native protocol (no tar fallback).
func runSync(args []string, stdout, stderr io.Writer) int {
	if wantsHelp(args, syncValueFlags...) {
		fmt.Fprint(stdout, syncUsage)
		return 0
	}
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var identity, configDir string
	var port int
	var del, watch bool
	fs.StringVar(&identity, "i", "", "ssh identity file")
	fs.IntVar(&port, "p", 0, "ssh port")
	fs.BoolVar(&del, "delete", false, "delete files on the receiver that are gone from the source")
	fs.BoolVar(&watch, "watch", false, "keep running and re-sync on change")
	fs.StringVar(&configDir, "config-dir", "", "identity/trust directory (daemon)")
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
		return syncOnce(dest, srcs, syncFlags{identity: identity, port: port, del: del, configDir: configDir}, stdout, stderr)
	}
	if !watch {
		return once()
	}
	// Watch mode: sync once, then re-sync (debounced) on any change under the sources.
	if code := once(); code != 0 {
		fmt.Fprintln(stderr, "initial sync failed; watching for changes anyway")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	err := xfer.WatchDirs(ctx, srcs, 800*time.Millisecond, func() {
		if code := once(); code != 0 {
			fmt.Fprintln(stderr, "sync failed; will retry on next change")
		}
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
	configDir string
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
