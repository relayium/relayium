package main

import (
	"fmt"
	"io"
	"net"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
	"github.com/relayium/relayium/internal/xfer"
)

const daemonDialTimeout = 10 * time.Second

// pushDaemon pushes srcs straight to a listening peer over a pinned TLS 1.3
// connection. The listener is trusted via known_hosts (TOFU on first contact,
// pinned thereafter); a fingerprint change is fatal and never auto-overwritten.
func pushDaemon(target string, srcs []string, configDir string, noResume bool, stdout, stderr io.Writer) int {
	hostport, err := parseDaemonURL(target)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	id, err := secure.LoadOrCreateIdentity(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	pinned, found, err := trust.LookupHost(cfgDir, hostport)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	conn, err := net.DialTimeout("tcp", hostport, daemonDialTimeout)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	// Complete the handshake accepting whatever cert the peer presents, learn
	// its fingerprint, then decide trust BEFORE any file bytes flow. This lets
	// us report "expected X / got Y" on a mismatch, which pinning inside the
	// handshake could not, while still sending nothing to an untrusted peer.
	tconn, presented, err := secure.ClientAny(conn, id)
	if err != nil {
		conn.Close()
		fmt.Fprintf(stderr, "TLS handshake with %s failed: %v\n", hostport, err)
		return 1
	}
	if found {
		if presented != pinned {
			tconn.Close()
			fmt.Fprintf(stderr, "fingerprint mismatch for %s\n  expected %s\n  got      %s\n"+
				"If this is an intentional key rotation, remove the known_hosts line for %s and retry.\n",
				hostport, pinned, presented, hostport)
			return 1
		}
	} else {
		if err := trust.AddHost(cfgDir, hostport, presented); err != nil {
			tconn.Close()
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintf(stderr, "learned %s %s (added to known_hosts)\n", hostport, presented)
	}
	defer tconn.Close()

	rep, err := xfer.Send(tconn, m, paths, xfer.SendOpts{Progress: progressFn(stderr)})
	if err != nil {
		fmt.Fprintln(stderr, err)
		// A listener that rejects an unauthorized pusher aborts the TLS handshake
		// and reveals nothing extra, so the failure surfaces here as an opaque
		// connection error. Point the user at the likely cause without asserting
		// it (a genuine mid-transfer network drop lands here too).
		fmt.Fprintf(stderr, "hint: if the peer refused the connection, it may not have authorized this host.\n  add this fingerprint to its authorized_fingerprints: %s\n", id.Fingerprint)
		return 1
	}
	return reportExit(rep, stderr)
}
