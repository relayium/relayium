package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"
)

// This file is the ONLY thing the unprivileged node service gained in order to
// make a manual fast fleet rollout actually fast, and it is deliberately as
// small as a mechanism can be.
//
// THE PROBLEM. Removing the rollout's observation windows takes the fleet ladder
// from ~14 hours down to roughly the install time per node — but each node only
// discovers that it is its turn when its ROOT UPDATER polls central, and that
// poll is on a ~10-minute systemd timer. On a 16-machine fleet that is over two
// hours of pure waiting-for-a-timer, which is most of what is left.
//
// WHAT IS NOT ACCEPTABLE AS A FIX. The node service must never gain the
// authority to replace /usr/local/bin/relayium-node, to run arbitrary root
// commands, or to control a broad systemd unit. Its sandbox
// (ProtectSystem=strict, empty capability set, no login shell) is the reason a
// compromised relay node cannot become a compromised host, and "the release got
// out faster" is not worth trading any of it for. Equally unacceptable: letting
// the low-privilege process tell root WHAT to install. A version or a path
// handed upward is an instruction, and an instruction is the thing an attacker
// wants.
//
// WHAT THIS DOES INSTEAD. central's heartbeat response may carry
// updateCheckNow (see nodeHeartbeatResp on the server). The node's only response
// is to create an EMPTY file in its own runtime directory. A root-owned
// systemd path unit (relayium-node-update-request.path, installed by
// install-node.sh) watches exactly that one path and starts exactly one unit —
// the dedicated root updater that already existed. That updater then asks
// central itself what version to run, and verifies the release signature against
// a key compiled into it, exactly as it does on a timer-driven run. So:
//
//   - the request carries NO version, NO path, NO URL — nothing to obey. The
//     file's contents are never read;
//   - the root updater remains the sole installer and performs the authoritative
//     central check and signature verification;
//   - the worst a compromised node can do through this channel is cause its own
//     updater to ask central a question it would have asked anyway, at a rate
//     bounded by updateRequestMinInterval;
//   - a host without the path unit (anything installed before this shipped) is
//     unaffected: the file is written into a directory that does not exist, the
//     request is silently skipped, and the timer keeps driving updates.

// updateRequestFile is the marker relayium-node-update-request.path watches.
// The NAME is the entire protocol between the two privilege levels; its contents
// are never read by anything.
const updateRequestFile = "update-requested"

// defaultRuntimeDir is systemd's RuntimeDirectory=relayium-node for the node
// service: owned by the node user, mode 0700, and destroyed when the service
// stops (so a stale request can never survive a reboot).
const defaultRuntimeDir = "/run/relayium-node"

// updateRequestMinInterval bounds how often this process will ask. Central hints
// on every heartbeat for as long as it is this node's turn — every 30 seconds —
// and each granted request starts a root process, so the ask is rate-limited
// rather than mirrored. A minute is far below the ~10-minute timer it is
// replacing and far above anything that could be called spinning.
const updateRequestMinInterval = 60 * time.Second

// updateRequester holds the rate limiter's state. Not safe for concurrent use
// and does not need to be: it is touched only from the heartbeat loop.
type updateRequester struct {
	dir  string
	last time.Time
}

// newUpdateRequester returns a requester for dir, or nil when there is nothing
// to write into. nil is a supported value everywhere (see handleUpdateHint) and
// means "this host has no acceleration path" — the ordinary state of every node
// installed before this shipped.
func newUpdateRequester(dir string) *updateRequester {
	if dir == "" {
		return nil
	}
	return &updateRequester{dir: dir}
}

// request asks the root updater to poll central, by creating the marker file.
// It reports whether it actually wrote one.
//
// Three reasons it declines, and none of them is an error:
//
//   - no runtime directory configured, or the directory does not exist. It must
//     NOT create it: this process is unprivileged, and a directory it conjures
//     under a path systemd owns is at best ignored and at worst a wrongly-owned
//     entry that breaks the node's own start. A host without the path unit has
//     no directory, and its timer is the fallback.
//   - a request is already pending. systemd's PathExists triggers on the
//     TRANSITION into existence, so rewriting an unconsumed marker achieves
//     nothing; the updater will consume this one when it runs.
//   - too soon since the last granted request.
//
// Errors are returned rather than logged here so the caller decides how loud to
// be; a failure must never break the heartbeat that produced it.
func (u *updateRequester) request(now time.Time) (bool, error) {
	if u == nil || u.dir == "" {
		return false, nil
	}
	if _, err := os.Stat(u.dir); err != nil {
		// Not provisioned (or unreadable). Silent, and deliberately not an
		// error: this is the state of every node that has not re-run the
		// installer since this shipped.
		return false, nil
	}
	path := updateRequestPath(u.dir)
	if _, err := os.Stat(path); err == nil {
		return false, nil // already pending
	}
	if !u.last.IsZero() && now.Sub(u.last) < updateRequestMinInterval {
		return false, nil
	}
	// O_EXCL so two writes can never both believe they created the request, and
	// 0600 because nothing but this process and root has any business here. The
	// file is written EMPTY: see the note at the top of this file — anything in
	// it would be an instruction from a low-privilege process to root.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return false, nil // raced with itself; a request is pending either way
		}
		return false, fmt.Errorf("request update check: %w", err)
	}
	if err := f.Close(); err != nil {
		return false, fmt.Errorf("request update check: %w", err)
	}
	u.last = now
	return true, nil
}

// handleUpdateHint is the whole of the node process's reaction to central's
// hint: ask, or do nothing. It exists as a named function so the "and nothing
// else" half is testable — in particular that a hint never reaches anything that
// could install a binary, which this process has no code to do in the first
// place.
func handleUpdateHint(hr heartbeatResp, ur *updateRequester, now time.Time) {
	if !hr.UpdateCheckNow {
		return
	}
	wrote, err := ur.request(now)
	if err != nil {
		// Loud but harmless: the systemd timer still drives updates.
		log.Printf("relayium-node: could not ask the updater to check now (the update timer still applies): %v", err)
		return
	}
	if wrote {
		log.Printf("relayium-node: central asked for an update check; signalled the root updater (it re-checks central and verifies the release signature itself)")
	}
}

// updateRequestPath is where the marker lives inside a runtime directory.
func updateRequestPath(dir string) string { return filepath.Join(dir, updateRequestFile) }

// consumeUpdateRequest deletes a pending marker. The ROOT updater calls it as it
// starts, and that call is what makes the path unit's trigger idempotent:
// systemd re-arms a PathExists trigger the moment the unit it started
// deactivates, so a marker left in place would restart the updater immediately,
// forever. Consuming it at the START (rather than on success) is deliberate —
// every exit path of the updater, including a refusal, must retire the request
// that woke it.
//
// A missing marker is the NORMAL case: most runs are timer-driven. A failed
// removal is logged rather than swallowed, because that is the state that loops.
func consumeUpdateRequest(dir string, w io.Writer) {
	if dir == "" {
		return
	}
	if err := os.Remove(updateRequestPath(dir)); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(w, "could not clear the pending update-check request at %s: %v\n", updateRequestPath(dir), err)
	}
}
