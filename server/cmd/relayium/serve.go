package main

import (
	"flag"
	"fmt"
	"io"
	"net"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
	"github.com/relayium/relayium/internal/xfer"
)

type serveFlags struct {
	dir       string
	port      int
	once      bool
	noResume  bool
	configDir string
}

func runServe(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var f serveFlags
	fs.StringVar(&f.dir, "dir", ".", "directory to receive files into")
	fs.IntVar(&f.port, "port", defaultDaemonPort, "TCP port to listen on")
	fs.BoolVar(&f.once, "once", false, "handle a single transfer then exit")
	fs.BoolVar(&f.noResume, "no-resume", false, "disable resuming partial files")
	fs.StringVar(&f.configDir, "config-dir", "", "identity/trust directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	cfgDir, err := resolveConfigDir(f.configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	id, err := secure.LoadOrCreateIdentity(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	allow, err := trust.LoadAuthorized(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if len(allow) == 0 {
		fmt.Fprintf(stderr, "warning: no authorized fingerprints; all pushes will be rejected.\n"+
			"  add a peer's fingerprint to %s (peer prints it with `relayium id`)\n", trust.AuthorizedPath(cfgDir))
	}

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", f.port))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer ln.Close()
	fmt.Fprintf(stderr, "relayium serve: listening on %s, receiving into %s (fingerprint %s)\n",
		ln.Addr(), f.dir, id.Fingerprint)

	return serveLoop(ln, id, allow, f.dir, f.once, f.noResume, stdout, stderr)
}

// serveLoop accepts and handles connections serially. With once it returns after
// the first handled connection (0 on success, 1 otherwise); otherwise it runs
// until Accept fails.
func serveLoop(ln net.Listener, id *secure.Identity, allow map[string]bool, dir string, once, noResume bool, stdout, stderr io.Writer) int {
	for {
		conn, err := ln.Accept()
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		ok := serveConn(conn, id, allow, dir, noResume, stdout, stderr)
		if once {
			if ok {
				return 0
			}
			return 1
		}
	}
}

// serveConn runs one pinned-TLS server handshake with allow-set authorization,
// then receives the pushed batch. It never lets one bad peer take down serve.
func serveConn(conn net.Conn, id *secure.Identity, allow map[string]bool, dir string, noResume bool, stdout, stderr io.Writer) bool {
	defer conn.Close()
	remote := conn.RemoteAddr()

	tconn, fp, err := secure.ServerSet(conn, id, allow)
	if err != nil {
		// An out-of-set fingerprint fails the handshake; distinguish it from a
		// transport/TLS error so the operator sees who was rejected.
		if fp != "" && !allow[fp] {
			fmt.Fprintf(stderr, "rejected unauthorized peer %s from %s\n", fp, remote)
		} else {
			fmt.Fprintf(stderr, "handshake failed from %s: %v\n", remote, err)
		}
		return false
	}
	defer tconn.Close()

	rep, err := xfer.Receive(tconn, dir, xfer.RecvOpts{NoResume: noResume})
	if err != nil {
		fmt.Fprintf(stderr, "receive from %s (%s): %v\n", fp, remote, err)
		return false
	}
	if len(rep.Failed) > 0 {
		fmt.Fprintf(stderr, "%d file(s) failed integrity check from %s: %v\n", len(rep.Failed), fp, rep.Failed)
		return false
	}
	fmt.Fprintf(stdout, "received %d file(s), %d bytes from %s\n", rep.Files, rep.Bytes, fp)
	return true
}
