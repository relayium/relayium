package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/termtext"
	"github.com/relayium/relayium/internal/xfer"
)

// `relayium __recv --stream-file -- <path>`: the remote half of `push -`,
// started by the pusher's own ssh session and running as that user.
//
// It receives exactly one file of unknown length and installs it at exactly
// <path>, only if nothing exists there, inside a directory that already
// exists (xfer.ReceiveStream: private staging beside it, verified size and
// SHA-256, a no-clobber hard link). It never creates the directory: the
// user named one file, so a missing directory is a mistake to report, not a
// tree to invent.
//
// Its stdio is the ssh channel. Neither can be given a kernel deadline, so
// every bound is a process exit instead (xfer.ExitWatchdogPeer): an idle
// sender, a sender that stopped reading, or a signal abandons the staging
// under the guard and exits. Nothing it prints goes to stdout, which carries
// only frames; diagnostics and the receiver's notes go to stderr, each within
// a time budget so a full stderr cannot hold the process either.

// Seams for tests. Production values: the process's own stdio, the library's
// default idle bound, os.Exit.
var (
	streamRecvStdio = func() (io.Reader, io.Writer) { return os.Stdin, os.Stdout }
	streamRecvIdle  time.Duration // 0: xfer's default (2 minutes)
	streamRecvExit  = os.Exit
	// streamRecvDiagBudget bounds each stderr diagnostic.
	streamRecvDiagBudget = 200 * time.Millisecond
)

// streamRecvTarget splits path into the directory to open and the file name
// to create, or says why path cannot name one new file.
func streamRecvTarget(path string) (dir, leaf, why string) {
	if why := stdoutSourceRefusal(path); why != "" {
		return "", "", fmt.Sprintf("%q %s; push - needs the full name of one new file", termtext.Safe(path), why)
	}
	return filepath.Dir(path), filepath.Base(path), ""
}

func runRecvStream(path string, stderr io.Writer) int {
	g := xfer.NewStageGuard()
	in, out := streamRecvStdio()
	peer := xfer.NewExitWatchdogPeer(in, out, g)
	peer.Diag = stderr
	peer.Exit = streamRecvExit
	peer.DiagBudget = streamRecvDiagBudget

	// HUP/INT/TERM: abandon the staging (an installed file is kept) and exit.
	// SIGPIPE is registered only so that a write to a closed stdout returns
	// EPIPE here instead of killing the process before its cleanup.
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGPIPE, syscall.SIGHUP, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigs)
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case s := <-sigs:
				if s == syscall.SIGPIPE {
					continue
				}
				boundedDiag(stderr, fmt.Sprintf("relayium: stopped by %v; %s", s, g.Abandon()), streamRecvDiagBudget)
				streamRecvExit(1)
				return
			case <-done:
				return
			}
		}
	}()

	dir, leaf, why := streamRecvTarget(path)
	if why != "" {
		return refuseStream(peer, stderr, xfer.ErrCodeInvalidDestination, why)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return refuseStream(peer, stderr, xfer.ErrCodeInvalidDestination, streamDirProblem(dir, err))
	}
	defer root.Close()

	rep, err := xfer.ReceiveStream(peer, xfer.StreamTarget{Parent: root, Leaf: leaf}, xfer.StreamRecvOpts{Idle: streamRecvIdle, Guard: g})
	for _, n := range rep.Notes {
		boundedDiag(stderr, "relayium: note: "+n, streamRecvDiagBudget)
	}
	if err != nil {
		boundedDiag(stderr, "relayium: "+err.Error(), streamRecvDiagBudget)
		return 1
	}
	return 0
}

// streamDirProblem describes why the directory that should hold the file
// cannot be opened.
func streamDirProblem(dir string, err error) string {
	d := termtext.Safe(dir)
	// Checked by kind, not by errno: a file where the directory should be is
	// ENOTDIR on Unix but ERROR_DIRECTORY on Windows.
	if fi, serr := os.Stat(dir); serr == nil && !fi.IsDir() {
		return d + " is not a directory on the receiver"
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "the directory " + d + " does not exist on the receiver; push - does not create directories"
	}
	var pe *fs.PathError
	if errors.As(err, &pe) {
		err = pe.Err
	}
	return "cannot open the directory " + d + " on the receiver: " + termtext.Safe(err.Error())
}

// refuseStream sends a refusal before the stream was accepted — nothing has
// been created — within the peer's write bound, and reports it locally.
func refuseStream(peer *xfer.ExitWatchdogPeer, stderr io.Writer, code, msg string) int {
	_ = peer.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = xfer.WriteJSON(peer, xfer.MsgError, xfer.WireError{Code: code, Msg: msg})
	_ = peer.SetWriteDeadline(time.Time{})
	boundedDiag(stderr, "relayium: "+msg, streamRecvDiagBudget)
	return 1
}

// boundedDiag writes one line to w from another goroutine and waits at most
// budget for it: a stderr nobody drains must not keep a helper from exiting.
func boundedDiag(w io.Writer, msg string, budget time.Duration) {
	done := make(chan struct{})
	go func() {
		fmt.Fprintln(w, msg)
		close(done)
	}()
	t := time.NewTimer(budget)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
	}
}
