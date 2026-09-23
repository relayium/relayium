package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/connect"
	"github.com/relayium/relayium/internal/linksession"
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

// modeCommand names a mode the way the user meets it: as a command. An unknown
// mode is reported as unknown rather than guessed at.
func modeCommand(mode string) string {
	switch mode {
	case rzvous.ModeText:
		return "`relayium text`"
	case rzvous.ModeFile, "":
		return "`relayium send`/`relayium receive`"
	default:
		return "something this version does not know (" + strconv.Quote(mode) + ")"
	}
}

// errPeerNotCLI is what the user reads when the other end of the code room is a
// Relayium app or the web page and the pairing fell to the older CLI
// handshake. Since link pairing (A10) that happens only on a server that
// predates pairing hints: with hints, discovery links the two directly. The
// way out differs by command: a file has `relayium up`, whose link an app or
// browser does open; a message session has no stored form.
func errPeerNotCLI(mode string) error {
	msg := "the other side is a Relayium app or the web page, but this server predates app pairing, " +
		"so here the CLI can pair only with another relayium CLI\n" +
		"  ask the server's operator to update it, or use " + modeCommand(mode) +
		" in a terminal on both machines (this attempt has ended; start it again)"
	if mode != rzvous.ModeText {
		// Role-neutral on purpose: this runs for `send` and for `receive`, and the
		// code may have been minted by either end.
		msg += "\n  moving a file between the CLI and an app or a browser?  `relayium up <file>` makes a link they open;" +
			" `relayium down <link>` fetches one they made"
	}
	return errors.New(msg)
}

// crossnetLegacy is the CLI pairing every released relayium speaks, on a room
// that is already joined: the commit/reveal handshake (continuing from the
// peer's commit when discovery already holds it), the mode check, the SAS
// line, --verify, a direct connection race and pinned TLS. `send`, `receive`
// and `text` reach it when discovery hands the room to the legacy wire, and
// the hidden __link reaches the same function, so the two cannot drift.
//
// This wire is direct-only: it races a direct connection and fails if it
// cannot get one, because it has no ICE and no TURN in it. That is a property
// of THIS WIRE, not a promise about Relayium — the link sessions (and the
// apps and the web page) relay a cross-network transfer, over ciphertext the
// relay cannot read. What holds everywhere, and is the thing not to trade
// away, is that nothing Relayium runs ever holds plaintext or a user's keys.
//
// mode is what this side wants the connection for (rzvous.ModeFile /
// ModeText). A mismatch is refused before anything is dialed. The caller owns
// sess and closes it.
func crossnetLegacy(ctx context.Context, sess *rzvous.Session, first json.RawMessage, f crossFlags, stderr io.Writer, mode string) (*tls.Conn, error) {
	id, err := secure.NewIdentity()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, err
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	var hs *rzvous.Handshake
	if first != nil {
		hs, err = rzvous.DoHandshakeFromPeerCommit(ctx, sess, id, connect.LocalCandidates(port, f.advertise), mode, first)
	} else {
		hs, err = rzvous.DoHandshake(ctx, sess, id, connect.LocalCandidates(port, f.advertise), mode)
	}
	if err != nil {
		if errors.Is(err, rzvous.ErrPeerNotCLI) {
			return nil, errPeerNotCLI(mode)
		}
		return nil, err
	}

	// Refused here, before RaceDirect: a mismatch costs no TCP connection and no
	// TLS handshake. An older peer reports "" and reads as a file peer, so this
	// cannot refuse anything that works today. Anything outside the known set is
	// refused too -- see rzvous.ModeCompatible.
	if !rzvous.ModeCompatible(mode, hs.PeerMode) {
		return nil, fmt.Errorf("the other side is running %s, not %s — both ends need the same command, on a recent enough relayium",
			modeCommand(hs.PeerMode), modeCommand(mode))
	}

	// Named "verification code", not just "SAS", and explicitly separated from the
	// pairing code: both are six digits now, and a line reading "SAS: 483920" next
	// to a pairing code the user just typed invites reading one as the other. What
	// it is for is stated in the same breath, because comparing it is optional
	// (--verify makes it blocking) and an unexplained code nobody compares is
	// worse than no line at all.
	fmt.Fprintf(stderr, "%s%s — not the pairing code; compare it on both ends to rule out a substituted endpoint\n", sasLinePrefix, hs.SAS)
	if f.verify {
		if !confirmSAS(stderr) {
			return nil, fmt.Errorf("SAS not confirmed; aborting")
		}
	}

	// Race a direct connection within the window. Reachable / server-to-server
	// peers connect directly; if none can be raced the transfer fails, because
	// this wire has no relay to fall back to.
	dctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	// hs.PeerCandidates come from the untrusted peer — filter out loopback /
	// link-local / unspecified so a malicious peer can't steer our dialer at our
	// own localhost or the cloud metadata endpoint (limited SSRF).
	raw, err := connect.RaceDirect(dctx, ln, connect.FilterPeerCandidates(hs.PeerCandidates), 3*time.Second, hs.IsServer)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("no direct connection to the peer (both ends behind strict NAT?): %w\n"+
			"  this pairing used the older CLI handshake, which is direct-only (the other side runs an older relayium, or the server predates pairing hints)", err)
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
// named "483920". When it is neither, guessing either way produces a wrong and
// confusing error ("no such file: 483920" for a mistyped code, "not a valid
// code" for a mistyped filename), so name both readings instead.
func splitSendArgs(args []string) (srcs []string, code string, err error) {
	if len(args) == 0 {
		return nil, "", fmt.Errorf("send needs <src...> [code]")
	}
	last := args[len(args)-1]
	// Only a genuine "does not exist" makes the last argument a candidate code.
	// A bare `statErr == nil` check would read EVERY stat failure as absence, so
	// a real file under a directory we lack +x on (or any I/O error) would be
	// silently reinterpreted as a pairing code — the user gets a rendezvous
	// failure instead of the permission error that actually stopped them. When
	// we cannot tell, keep treating it as a source and let BuildManifest report
	// the real reason.
	if _, statErr := os.Stat(last); !errors.Is(statErr, fs.ErrNotExist) {
		return args, "", nil // a real file (or an unreadable one) wins over a code-shaped name
	}
	if len(args) == 1 {
		return args, "", nil // a lone argument is a source; BuildManifest reports it missing
	}
	if signal.ValidCodeFormat(last) {
		return args[:len(args)-1], last, nil
	}
	return nil, "", fmt.Errorf(
		"last argument %q is neither an existing file nor a pairing code\n"+
			"  codes are %s\n"+
			"  to mint one automatically, leave it out:  relayium send %s",
		last, signal.CodeFormatNote(),
		strings.Join(args[:len(args)-1], " "))
}

// crossnetSendDial is the transport `send` runs over: the legacy connection,
// or a *linkHandle when discovery chose link/1 (crossnetDial). It is a var so a
// test can drive runSendCross itself — its argument handling, its SendOpts and
// what it prints — against a peer on a pipe.
var crossnetSendDial = func(ctx context.Context, code string, f crossFlags, stderr io.Writer) (io.ReadWriteCloser, error) {
	return crossnetDial(ctx, code, "sender", f, stderr, linksession.CmdSend, rzvous.ModeFile)
}

func runSendCross(args []string, stdout, stderr io.Writer) int {
	if wantsHelpFS(crossFlagSet(&crossFlags{}), args) {
		fmt.Fprint(stdout, sendUsage)
		return 0
	}
	f, rest, err := parseCrossFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	srcs, code, err := splitSendArgs(rest)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	xfer.WarnIfEmpty(m, stderr)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	// Mint only after the sources check out: a code starts its expiry clock
	// (signal.CodeTTLSeconds) the moment it is minted, and burning one on a
	// typo'd path wastes it.
	if code == "" {
		if code, err = mintCode(ctx, f.server, stderr, mintForSend); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	conn, err := crossnetSendDial(ctx, code, f, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if h, ok := conn.(*linkHandle); ok {
		// One batch, then leave once it is delivered (or refused). Inbound
		// files and messages are refused: `send` consents to neither.
		h.d.feedScript([]ldCmd{{op: "send", srcs: srcs}}, true)
		return h.drive()
	}
	defer conn.Close()
	prog := newSendProgress(stderr)
	rep, err := xfer.Send(conn, m, paths, xfer.SendOpts{Progress: prog.report})
	prog.finish()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

// crossnetReceiveDial is the transport `receive` runs over. It is a var so a
// test can drive runReceiveCross itself — its argument handling, its RecvOpts
// and its exit code — against a peer on a pipe.
var crossnetReceiveDial = func(ctx context.Context, code string, f crossFlags, stderr io.Writer) (io.ReadWriteCloser, error) {
	return crossnetDial(ctx, code, "receiver", f, stderr, linksession.CmdReceive, rzvous.ModeFile)
}

func runReceiveCross(args []string, stdout, stderr io.Writer) int {
	if wantsHelpFS(crossFlagSet(&crossFlags{}), args) {
		fmt.Fprint(stdout, receiveUsage)
		return 0
	}
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
	conn, err := crossnetReceiveDial(ctx, code, f, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if h, ok := conn.(*linkHandle); ok {
		// The command line consented to exactly one batch into dest (later
		// ones are refused by the session); leave once it has concluded —
		// after the peer acknowledged our last frame, so our COMPLETE is not
		// overtaken by the leave.
		h.d.dest = dest
		h.d.feedScript([]ldCmd{{op: "wait-batch", n: 1}}, true)
		return h.drive()
	}
	defer conn.Close()
	rep, err := peerReceive(conn, dest, false, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

func confirmSAS(w io.Writer) bool {
	// Minimal: in --verify mode read a line from stdin; "y"/"yes" confirms.
	fmt.Fprint(w, "Do the verification codes match on both ends? [y/N] ")
	var ans string
	fmt.Fscanln(osStdin(), &ans)
	return ans == "y" || ans == "yes" || ans == "Y"
}
