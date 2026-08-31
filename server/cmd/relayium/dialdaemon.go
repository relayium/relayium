package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
	"github.com/relayium/relayium/internal/xfer"
)

const daemonDialTimeout = 10 * time.Second

// dialDaemon resolves a relayium:// target, loads this host's identity, dials,
// completes the pinned-TLS handshake (TOFU on first contact, pinned after), and
// returns the ready connection. It prints "learned …" on first contact and
// returns a fatal error on a fingerprint mismatch.
func dialDaemon(target, configDir string, stderr io.Writer) (*tls.Conn, error) {
	hostport, err := parseDaemonURL(target)
	if err != nil {
		return nil, err
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		return nil, err
	}
	id, err := secure.LoadOrCreateIdentity(cfgDir)
	if err != nil {
		return nil, err
	}
	pinned, found, err := trust.LookupHost(cfgDir, hostport)
	if err != nil {
		return nil, err
	}
	conn, err := net.DialTimeout("tcp", hostport, daemonDialTimeout)
	if err != nil {
		return nil, err
	}
	tconn, presented, err := secure.ClientAny(conn, id)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("TLS handshake with %s failed: %w", hostport, err)
	}
	if found {
		if presented != pinned {
			tconn.Close()
			return nil, fmt.Errorf("fingerprint mismatch for %s\n  expected %s\n  got      %s\n"+
				"If this is an intentional key rotation, remove the known_hosts line for %s and retry.",
				hostport, pinned, presented, hostport)
		}
	} else {
		if err := trust.AddHost(cfgDir, hostport, presented); err != nil {
			tconn.Close()
			return nil, err
		}
		fmt.Fprintf(stderr, "learned %s %s (added to known_hosts)\n", hostport, presented)
	}
	return tconn, nil
}

// pushDaemon pushes srcs straight to a listening peer over a pinned TLS 1.3
// connection. The listener is trusted via known_hosts (TOFU on first contact,
// pinned thereafter); a fingerprint change is fatal and never auto-overwritten.
func pushDaemon(target string, srcs []string, configDir string, noResume bool, stdout, stderr io.Writer) int {
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	xfer.WarnIfEmpty(m, stderr)
	tconn, err := dialDaemon(target, configDir, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer tconn.Close()
	rep, err := xfer.Send(tconn, m, paths, xfer.SendOpts{Progress: progressFn(stderr)})
	if err != nil {
		fmt.Fprintln(stderr, err)
		// The authorization hint is a guess for the silent case — an unauthorized
		// peer is closed on without a word. When the receiver actually told us why
		// it refused, repeating the guess would only mislead.
		var remote *xfer.RemoteError
		if !errors.As(err, &remote) {
			fmt.Fprintf(stderr, "hint: if the peer refused the connection, it may not have authorized this host.\n  run `relayium id` on this machine and add it on the peer.\n")
		}
		return 1
	}
	return reportExit(rep, stderr)
}
