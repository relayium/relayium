package main

// `relayium __link` is a HIDDEN developer entry point (A08d). It is not in
// the usage text, not in `relayium help`, and not a supported command: it
// exists so the link-pairing discovery order (A08-DESIGN §3) can be driven end
// to end over a real signalling hub before any public command depends on it.
//
// What it does:
//
//   - joins the code room with the roster hint (rzvous.JoinRoom, which keeps
//     the peer's signals that beat our own roster);
//   - drives the pure linksession state machine with the room view, the
//     captured signals and every later signal, executing only the effects that
//     belong to DISCOVERY (the link/1 hello and the older-CLI notice);
//   - on a legacy outcome it completes today's commit/reveal handshake and the
//     same direct pinned-TLS connection `send`/`receive`/`text` use, then runs
//     that command's normal transfer;
//   - on a link outcome it stops and says the link would be established: the
//     WebRTC transport under the session is A09b. Link-establishment effects
//     (request, offer, ICE) are deliberately NOT executed.
//
// The pairing code is required. The code-less LAN room ignores roster hints
// (A08a), so a missing welcome echo there would read as "old hub" when it is
// not; refusing the LAN room keeps that misreading unreachable.

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/relayium/relayium/internal/connect"
	"github.com/relayium/relayium/internal/linkcrypto"
	"github.com/relayium/relayium/internal/linksession"
	"github.com/relayium/relayium/internal/linkwire"
	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/xfer"
)

const linkDevUsage = `relayium __link is a hidden developer command (link-pairing discovery); it is not supported.
usage:
  relayium __link pair    [--server URL] <code>
  relayium __link send    [--server URL] [--advertise HOST:PORT] [--verify] <src...> <code>
  relayium __link receive [--server URL] [--advertise HOST:PORT] [--verify] <code> [destdir]
  relayium __link text    [--server URL] [--advertise HOST:PORT] [--verify] <code>
`

// linkDevExitLinkPending is the exit status of a run whose discovery chose
// link/1: nothing was transferred, because the link transport is not wired
// yet. Distinct from 0 so no script can mistake it for a finished transfer.
const linkDevExitLinkPending = 3

// linkDevSessionTimeout is the whole-run ceiling, the same as send/receive.
const linkDevSessionTimeout = 10 * time.Minute

type linkDevClock struct{}

func (linkDevClock) Now() time.Time { return time.Now() }

// linkDevResult is what discovery decided.
type linkDevResult struct {
	room *rzvous.Room
	// link: discovery reached link establishment.
	link bool
	// legacy: discovery handed the room to the legacy handshake. first is the
	// peer's first legacy frame when it has already arrived (the peer spoke
	// first, possibly before our room view was complete); nil means we speak
	// first and read the peer's commit from the wire.
	legacy bool
	first  json.RawMessage
	// ended is the session's end code when discovery failed.
	ended string
}

func runLinkDev(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, linkDevUsage)
		return 2
	}
	var (
		cmd  linksession.Cmd
		name string
		mode string
	)
	switch args[0] {
	case "pair":
		cmd, name = linksession.CmdPair, "pair"
	case "send":
		cmd, name, mode = linksession.CmdSend, "sender", rzvous.ModeFile
	case "receive":
		cmd, name, mode = linksession.CmdReceive, "receiver", rzvous.ModeFile
	case "text":
		cmd, name, mode = linksession.CmdText, "text", rzvous.ModeText
	default:
		fmt.Fprint(stderr, linkDevUsage)
		return 2
	}
	f, rest, err := parseCrossFlags(args[1:])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}

	var (
		code  string
		dest  = "."
		srcs  []string
		m     xfer.Manifest
		paths []string
		tty   bool
	)
	switch cmd {
	case linksession.CmdPair:
		if len(rest) != 1 {
			fmt.Fprint(stderr, linkDevUsage)
			return 2
		}
		code = rest[0]
	case linksession.CmdSend:
		if srcs, code, err = splitSendArgs(rest); err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
	case linksession.CmdReceive:
		if len(rest) < 1 || len(rest) > 2 {
			fmt.Fprint(stderr, linkDevUsage)
			return 2
		}
		code = rest[0]
		if len(rest) == 2 {
			dest = rest[1]
		}
	case linksession.CmdText:
		if len(rest) != 1 {
			fmt.Fprint(stderr, linkDevUsage)
			return 2
		}
		code = rest[0]
		tty = textStdinIsTTY()
		if f.verify && !tty {
			fmt.Fprintln(stderr, "--verify was requested but stdin is not a terminal, so there is nobody to prompt.")
			return 2
		}
	}
	if code == "" || !signal.ValidCodeFormat(code) {
		fmt.Fprintf(stderr, "__link needs a pairing code (%s); it never mints one and never uses the code-less LAN room\n",
			signal.CodeFormatNote())
		return 2
	}
	if cmd == linksession.CmdSend {
		if m, paths, err = xfer.BuildManifest(srcs); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		xfer.WarnIfEmpty(m, stderr)
	}

	ctx, cancel := context.WithTimeout(context.Background(), linkDevSessionTimeout)
	defer cancel()

	res, err := linkDevDiscover(ctx, cmd, f.server, code, name, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if res.ended != "" {
		res.room.Session.Close()
		fmt.Fprintln(stderr, linkDevEndMessage(res.ended))
		return 1
	}
	if res.link {
		res.room.Session.Close()
		role := "responder"
		if linkwire.LinkRole(res.room.SelfID, res.room.PeerID) == linkcrypto.Initiator {
			role = "initiator"
		}
		fmt.Fprintf(stderr, "link would be established with the peer (link/1, %s); the link transport is not wired yet, nothing was transferred\n", role)
		return linkDevExitLinkPending
	}

	conn, err := linkDevLegacyConn(ctx, res, f, mode, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer conn.Close()
	switch cmd {
	case linksession.CmdSend:
		prog := newSendProgress(stderr)
		rep, err := xfer.Send(conn, m, paths, xfer.SendOpts{Progress: prog.report})
		prog.finish()
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return reportExit(rep, stderr)
	case linksession.CmdReceive:
		rep, err := peerReceive(conn, dest, false, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return reportExit(rep, stderr)
	default: // text
		deadline, _ := ctx.Deadline()
		if err := installDeadline(conn, deadline); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if err := pumpText(conn, textStdin(), stdout, stderr, tty, deadline); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	}
}

// linkDevDiscover joins the room and runs discovery to its outcome. On a nil
// error res.room is set and its Session is still open; the caller closes it.
func linkDevDiscover(ctx context.Context, cmd linksession.Cmd, server, code, name string, stderr io.Writer) (*linkDevResult, error) {
	room, err := rzvous.JoinRoom(ctx, server, code, name, []string{rzvous.ProtoLink})
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(stderr, "link-dev: room serverHints=%t peerHint=%t captured=%d\n",
		room.ServerHints, room.PeerHint, len(room.Captured))
	res, err := linkDevDrive(ctx, cmd, room, stderr)
	if err != nil {
		room.Session.Close()
		return nil, err
	}
	return res, nil
}

type linkDevRead struct {
	data json.RawMessage
	err  error
}

// linkDevDrive feeds the session and executes its discovery effects until the
// session reaches Link, Legacy or its end.
//
// Reads are issued one at a time and only while discovery is undecided. That
// matters for the legacy hand-off: rzvous.DoHandshake reads the same
// connection, so no read of ours may be in flight when it starts. A hand-off is
// only ever decided by a signal (a timer never chooses a wire, property P1),
// i.e. right after a read completed, so none is.
func linkDevDrive(ctx context.Context, cmd linksession.Cmd, room *rzvous.Room, stderr io.Writer) (*linkDevResult, error) {
	s, err := linksession.NewSession(linksession.Config{Cmd: cmd, Clock: linkDevClock{}})
	if err != nil {
		return nil, err
	}
	res := &linkDevResult{room: room}

	// apply executes one call's effects, in order.
	apply := func(effs []linksession.Effect) error {
		for _, e := range effs {
			switch e.Kind {
			case linksession.EffSendSignal:
				if e.To != room.PeerID {
					continue // only link establishment answers another peer (busy)
				}
				// Establishment frames (request, offer, ICE) belong to the link
				// transport, which is not wired yet (A09b): never put one on the
				// wire from here. The hello and the older-CLI notice go out.
				if ev := linksession.ClassifySignal(e.Bytes); ev == linksession.DSigLinkOffer || ev == linksession.DSigLinkOther {
					continue
				}
				if err := room.Session.SendSignal(ctx, e.Bytes); err != nil {
					return err
				}
			case linksession.EffBeginLegacy:
				res.legacy = true
				if e.Bytes != nil {
					res.first = json.RawMessage(e.Bytes)
				}
			case linksession.EffLegacyFrame:
				// Frames that arrived before the hand-off (replayed from the
				// capture). The first is the peer's commit; our commit and the
				// reveals have not been exchanged yet, so there is no second.
				if res.first != nil {
					return errors.New("the peer sent more than one handshake message before ours")
				}
				res.first = json.RawMessage(e.Bytes)
			case linksession.EffSessionEnded:
				res.ended = e.Code
			}
		}
		return nil
	}
	// decided reports whether discovery has an outcome.
	decided := func() bool {
		if ended, code := s.Ended(); ended {
			if res.ended == "" {
				res.ended = code
			}
			return true
		}
		disc, _, _, _ := s.States()
		if disc == "Link" {
			res.link = true
			return true
		}
		return res.legacy
	}
	pending := false // a RecvSignal of ours is in flight
	step := func(effs []linksession.Effect, err error) (bool, error) {
		// Effects come back even with an error and must be executed.
		if aerr := apply(effs); aerr != nil {
			return true, aerr
		}
		if err != nil && !errors.Is(err, linksession.ErrEnded) {
			return true, err
		}
		if decided() && res.legacy && pending {
			// Unreachable by P1; refuse rather than race the handshake's reads.
			return true, errors.New("link-dev: legacy hand-off with a read in flight")
		}
		return decided(), nil
	}

	// The peer's signals that beat our room view go in first: the session
	// captures them while Joining and replays them, in order, once the room
	// view arrives, exactly as it would for a signal arriving any later.
	for _, c := range room.Captured {
		if done, err := step(s.Signal(s.Epoch(), room.PeerID, c)); done || err != nil {
			return res, err
		}
	}
	if done, err := step(s.Room(s.Epoch(), linksession.RoomView{
		SelfID: room.SelfID, PeerID: room.PeerID, ServerHints: room.ServerHints, PeerHinted: room.PeerHint,
	})); done || err != nil {
		return res, err
	}

	reads := make(chan linkDevRead, 1)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		if !pending {
			pending = true
			go func() {
				// RecvSignal returns signals only. In a pairing-code room the
				// hub admits two members, so every signal is the bound peer's.
				d, err := room.Session.RecvSignal(ctx)
				reads <- linkDevRead{d, err}
			}()
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		if at, ok := s.NextDeadline(); ok {
			timer.Reset(max(time.Until(at), 0))
		} else {
			timer.Reset(time.Hour)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case r := <-reads:
			pending = false
			if r.err != nil {
				return nil, fmt.Errorf("rendezvous connection lost during discovery: %w", r.err)
			}
			if done, err := step(s.Signal(s.Epoch(), room.PeerID, r.data)); done || err != nil {
				return res, err
			}
		case <-timer.C:
			if done, err := step(s.Tick()); done || err != nil {
				return res, err
			}
		}
	}
}

// linkDevEndMessage is what a failed discovery tells the user. Developer
// wording: A10 owns the product copy.
func linkDevEndMessage(code string) string {
	switch code {
	case "peer-is-older-cli":
		return "the other side runs an older relayium CLI that cannot use link pairing; it has been told to update (pair-needs-newer-relayium)"
	case "peer-app-cannot-link":
		return "the other app cannot use link pairing (older app, or link mode is off)"
	case "peer-app-too-old":
		return "the other app is too old for link pairing"
	case "peer-used-legacy-after-our-hello":
		return "the other side used the legacy CLI handshake after our link hello (an older relayium CLI?)"
	case "peer-never-spoke":
		return "the other side joined but never spoke"
	case "no-peer-joined":
		return "no peer joined the room"
	case "capture-overflow":
		return "the other side sent too many signals before the room was complete"
	case "protocol-violation":
		return "the other side sent a message this pairing does not allow"
	default:
		return "link-pairing discovery ended: " + code
	}
}

// linkDevLegacyConn is crossnetConn after its Join: the same handshake, the
// same refusals, the same SAS line and the same direct pinned-TLS race, on
// the room discovery already joined. crossnetConn itself joins its own room,
// so it cannot take over one; its steps are repeated here verbatim.
func linkDevLegacyConn(ctx context.Context, res *linkDevResult, f crossFlags, mode string, stderr io.Writer) (*tls.Conn, error) {
	sess := res.room.Session
	defer sess.Close()
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
	if res.first != nil {
		fmt.Fprintln(stderr, "link-dev: legacy handshake, continuing from the peer's commit")
		hs, err = rzvous.DoHandshakeFromPeerCommit(ctx, sess, id, connect.LocalCandidates(port, f.advertise), mode, res.first)
	} else {
		fmt.Fprintln(stderr, "link-dev: legacy handshake, sending our commit first")
		hs, err = rzvous.DoHandshake(ctx, sess, id, connect.LocalCandidates(port, f.advertise), mode)
	}
	if err != nil {
		if errors.Is(err, rzvous.ErrPeerNotCLI) {
			return nil, errPeerNotCLI(mode)
		}
		return nil, err
	}
	if !rzvous.ModeCompatible(mode, hs.PeerMode) {
		return nil, fmt.Errorf("the other side is running %s, not %s — both ends need the same command, on a recent enough relayium",
			modeCommand(hs.PeerMode), modeCommand(mode))
	}
	fmt.Fprintf(stderr, "verification code (SAS): %s — not the pairing code; compare it on both ends to rule out a substituted endpoint\n", hs.SAS)
	if f.verify {
		if !confirmSAS(stderr) {
			return nil, fmt.Errorf("SAS not confirmed; aborting")
		}
	}
	dctx, cancel := context.WithTimeout(ctx, 4*time.Second)
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
