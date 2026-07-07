package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/relayium/relayium/internal/connect"
	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/xfer"
)

const defaultServer = "wss://relayium.com"

type crossFlags struct {
	server    string
	advertise string
	relayOnly bool
	verify    bool
}

// crossnetConn joins the code room, runs the handshake, establishes a direct or
// relayed stream, wraps it in pinned TLS, prints the SAS, and returns the conn.
func crossnetConn(ctx context.Context, code, name string, f crossFlags, stderr io.Writer) (*tls.Conn, bool, error) {
	id, err := secure.NewIdentity()
	if err != nil {
		return nil, false, err
	}
	sess, err := rzvous.Join(ctx, f.server, code, name)
	if err != nil {
		return nil, false, err
	}
	defer sess.Close()

	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, false, err
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	hs, err := rzvous.DoHandshake(ctx, sess, id, connect.LocalCandidates(port, f.advertise))
	if err != nil {
		return nil, false, err
	}

	fmt.Fprintf(stderr, "SAS: %s  (compare on both ends)\n", hs.SAS)
	if f.verify {
		if !confirmSAS(stderr) {
			return nil, false, fmt.Errorf("SAS not confirmed; aborting")
		}
	}

	raw, viaRelay, err := connect.Establish(ctx, connect.EstablishParams{
		Listener:       ln,
		PeerCandidates: hs.PeerCandidates,
		DialTimeout:    3 * time.Second,
		DirectWindow:   4 * time.Second,
		ServerURL:      f.server,
		Code:           code,
		RelayOnly:      f.relayOnly,
	})
	if err != nil {
		return nil, false, err
	}

	var tconn *tls.Conn
	if hs.IsServer {
		tconn, err = secure.Server(raw, id, hs.PeerFingerprint)
	} else {
		tconn, err = secure.Client(raw, id, hs.PeerFingerprint)
	}
	if err != nil {
		raw.Close()
		return nil, false, err
	}
	if viaRelay {
		fmt.Fprintln(stderr, "path: relay (metered)")
	} else {
		fmt.Fprintln(stderr, "path: direct (free)")
	}
	return tconn, viaRelay, nil
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	conn, _, err := crossnetConn(ctx, code, "sender", f, stderr)
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
	conn, _, err := crossnetConn(ctx, code, "receiver", f, stderr)
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
