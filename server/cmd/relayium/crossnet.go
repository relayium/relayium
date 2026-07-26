package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/connect"
	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/xfer"
)

const defaultServer = "wss://relayium.com"

type crossFlags struct {
	server    string
	advertise string
	verify    bool
}

// crossnetConn joins the code room, runs the handshake, races a direct
// connection, wraps it in pinned TLS, prints the SAS, and returns the conn.
// The CLI is direct-only: file bytes never pass through Relayium's servers, so
// if no direct connection can be raced the transfer fails (there is no relay).
func crossnetConn(ctx context.Context, code, name string, f crossFlags, stderr io.Writer) (*tls.Conn, error) {
	id, err := secure.NewIdentity()
	if err != nil {
		return nil, err
	}
	sess, err := rzvous.Join(ctx, f.server, code, name)
	if err != nil {
		return nil, err
	}
	defer sess.Close()

	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, err
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	hs, err := rzvous.DoHandshake(ctx, sess, id, connect.LocalCandidates(port, f.advertise))
	if err != nil {
		return nil, err
	}

	fmt.Fprintf(stderr, "SAS: %s  (compare on both ends)\n", hs.SAS)
	if f.verify {
		if !confirmSAS(stderr) {
			return nil, fmt.Errorf("SAS not confirmed; aborting")
		}
	}

	// Race a direct connection within the window. Reachable / server-to-server
	// peers connect directly; if none can be raced, the transfer fails — the CLI
	// never proxies file bytes through Relayium.
	dctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	// hs.PeerCandidates come from the untrusted peer — filter out loopback /
	// link-local / unspecified so a malicious peer can't steer our dialer at our
	// own localhost or the cloud metadata endpoint (limited SSRF).
	raw, err := connect.RaceDirect(dctx, ln, connect.FilterPeerCandidates(hs.PeerCandidates), 3*time.Second, hs.IsServer)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("no direct connection to the peer (both ends behind strict NAT?): %w", err)
	}

	var tconn *tls.Conn
	if hs.IsServer {
		tconn, err = secure.Server(raw, id, hs.PeerFingerprint)
	} else {
		tconn, err = secure.Client(raw, id, hs.PeerFingerprint)
	}
	if err != nil {
		raw.Close()
		return nil, err
	}
	fmt.Fprintln(stderr, "path: direct")
	return tconn, nil
}

// splitSendArgs separates the source paths from an optional trailing pairing
// code. An empty code means "mint one".
//
// The last argument is a code iff it does NOT exist on disk and IS shaped like
// a code. Both halves matter: shape alone would eat the second file of
// `send a.zip b.zip`, and the disk check alone would misread a file genuinely
// named "K7M4XR". When it is neither, guessing either way produces a wrong and
// confusing error ("no such file: 726122" for a mistyped code, "not a valid
// code" for a mistyped filename), so name both readings instead.
func splitSendArgs(args []string) (srcs []string, code string, err error) {
	if len(args) == 0 {
		return nil, "", fmt.Errorf("send needs <src...> [code]")
	}
	last := args[len(args)-1]
	if _, statErr := os.Stat(last); statErr == nil {
		return args, "", nil // a real file wins over a code-shaped name
	}
	if len(args) == 1 {
		return args, "", nil // a lone argument is a source; BuildManifest reports it missing
	}
	if signal.ValidCodeFormat(last) {
		return args[:len(args)-1], last, nil
	}
	return nil, "", fmt.Errorf(
		"last argument %q is neither an existing file nor a pairing code\n"+
			"  codes are %d characters from %s, and last 5 minutes\n"+
			"  to mint one automatically, leave it out:  relayium send %s",
		last, signal.CodeLen, signal.CodeAlphabet, strings.Join(args[:len(args)-1], " "))
}

func runSendCross(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseCrossFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) < 2 {
		fmt.Fprintln(stderr, "send needs <src...> <code>")
		return 2
	}
	code := rest[len(rest)-1]
	srcs := rest[:len(rest)-1]
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	xfer.WarnIfEmpty(m, stderr)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	conn, err := crossnetConn(ctx, code, "sender", f, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer conn.Close()
	rep, err := xfer.Send(conn, m, paths, xfer.SendOpts{})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

func runReceiveCross(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseCrossFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) < 1 {
		fmt.Fprintln(stderr, "receive needs <code> [destdir]")
		return 2
	}
	code := rest[0]
	dest := "."
	if len(rest) > 1 {
		dest = rest[1]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	conn, err := crossnetConn(ctx, code, "receiver", f, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer conn.Close()
	rep, err := xfer.Receive(conn, dest, xfer.RecvOpts{})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

func confirmSAS(w io.Writer) bool {
	// Minimal: in --verify mode read a line from stdin; "y"/"yes" confirms.
	fmt.Fprint(w, "Do the SAS codes match on both ends? [y/N] ")
	var ans string
	fmt.Fscanln(osStdin(), &ans)
	return ans == "y" || ans == "yes" || ans == "Y"
}
