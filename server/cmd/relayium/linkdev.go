package main

// `relayium __link` is a HIDDEN developer entry point (A08d, A09b). It is not
// in the usage text, not in `relayium help`, and not a supported command: it
// exists so link pairing can be driven end to end over a real signalling hub
// before any public command depends on it (A10 owns the product commands and
// their copy).
//
// What it does:
//
//   - joins the code room with the roster hint (rzvous.JoinRoom, which keeps
//     the peer's signals that beat our own roster);
//   - drives the pure linksession state machine with the room view, the
//     captured signals and every later signal;
//   - on a legacy outcome it completes today's commit/reveal handshake and the
//     same direct pinned-TLS connection `send`/`receive`/`text` use, then runs
//     that command's normal transfer (unchanged from A08d);
//   - on a link outcome (A09b) it runs the link: the session's establishment
//     effects drive a linkrtc transport (data-only Pion WebRTC), the lanes
//     carry the session's frames, and a small script decides what to send.
//
// # Relay and money (A09b, [$-adj])
//
//   - M1: the ICE configuration comes from `/api/ice?code=<code>`, which issues
//     TURN credentials billed to the code's OWNER. It is requested only once
//     discovery has chosen link/1 (never for a legacy pairing), once per link,
//     through linkrtc.ICEFetcher (one retry for a transient failure only).
//   - M2: relay policy is the Web's chooseRtcConfig, unchanged: relay-only
//     whenever a TURN server was issued, otherwise "all" (A09-DESIGN §4.1). The
//     path is reported from the SELECTED candidate pair only.
//   - M3: a `relayDenied` (quota / unverified) is reported once, truthfully, and
//     the link continues STUN-only with policy "all". Nothing re-requests.
//   - M4: the relay deadline is derived once from the issued credentials
//     (earliest expiry − 60 s) and held in a latch that can only move earlier;
//     the session ends the link at it. Nothing extends it (renewal is A11).
//
// The pairing code is required. The code-less LAN room ignores roster hints
// (A08a), so a missing welcome echo there would read as "old hub" when it is
// not; refusing the LAN room keeps that misreading unreachable. It also means
// `/api/ice` is never asked for a code-less (LAN) configuration here.

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/relayium/relayium/internal/linkrtc"
	"github.com/relayium/relayium/internal/linksession"
	"github.com/relayium/relayium/internal/linkwire"
	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/xfer"
)

const linkDevUsage = `relayium __link is a hidden developer command (link pairing); it is not supported.
usage:
  relayium __link pair    [--server URL] [--verify] [--yes] [--dest DIR] [--script FILE] <code>
  relayium __link send    [--server URL] [--advertise HOST:PORT] [--verify] [--script FILE] <src...> <code>
  relayium __link receive [--server URL] [--advertise HOST:PORT] [--verify] [--script FILE] <code> [destdir]
  relayium __link text    [--server URL] [--advertise HOST:PORT] [--verify] [--script FILE] <code>
script (one command per line, run once the link is admitted; end of script = finish and leave):
  send <path>...   offer one batch
  text <message>   send one message (a conversation is opened first when none is)
  wait-files <n>   until n inbound batches were saved in total
  wait-texts <n>   until n inbound messages were delivered in total
  wait-sent        until every offered batch was delivered and every message sent
  hold             until the link ends
`

// linkDevSessionTimeout is the whole-run ceiling, the same as send/receive.
const linkDevSessionTimeout = 10 * time.Minute

// linkDevCloseLinger is how long the transport stays up after our leave was
// signalled, so the peer reads "ended by the peer" rather than a lost
// connection. Nothing is sent or accepted in it: the keys are already gone.
const linkDevCloseLinger = 400 * time.Millisecond

// linkDevTextGap paces outbound messages under the peer's 5/s text rate
// (linkwire.TextRatePerSecond): a scripted burst must not read as flooding.
const linkDevTextGap = 220 * time.Millisecond

type linkDevClock struct{}

func (linkDevClock) Now() time.Time { return time.Now() }

// linkDevResult is what discovery decided.
type linkDevResult struct {
	room *rzvous.Room
	// legacy: discovery handed the room to the legacy handshake. first is the
	// peer's first legacy frame when it has already arrived (the peer spoke
	// first, possibly before our room view was complete); nil means we speak
	// first and read the peer's commit from the wire.
	legacy bool
	first  json.RawMessage
	// ended is the session's end code when discovery failed.
	ended string
	// link: discovery bound link/1 and run returned because stopAtLink was
	// set; call run again to drive the link.
	link bool
}

// linkDevOpts are the dev-only flags, taken out before the shared cross flags.
type linkDevOpts struct {
	script string
	yes    bool
	dest   string
}

func splitLinkDevFlags(args []string) (linkDevOpts, []string, error) {
	var o linkDevOpts
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--yes":
			o.yes = true
		case a == "--script" || a == "--dest":
			if i+1 >= len(args) {
				return o, nil, fmt.Errorf("%s needs a value", a)
			}
			i++
			if a == "--script" {
				o.script = args[i]
			} else {
				o.dest = args[i]
			}
		case strings.HasPrefix(a, "--script="):
			o.script = strings.TrimPrefix(a, "--script=")
		case strings.HasPrefix(a, "--dest="):
			o.dest = strings.TrimPrefix(a, "--dest=")
		default:
			rest = append(rest, a)
		}
	}
	return o, rest, nil
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
	dev, args2, err := splitLinkDevFlags(args[1:])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	f, rest, err := parseCrossFlags(args2)
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
		if dev.dest != "" {
			dest = dev.dest
		}
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
	var script []ldCmd
	if dev.script != "" {
		b, err := os.ReadFile(dev.script)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
		if script, err = parseLinkDevScript(string(b)); err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), linkDevSessionTimeout)
	defer cancel()

	room, err := rzvous.JoinRoom(ctx, f.server, code, name, []string{rzvous.ProtoLink})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stderr, "link-dev: room serverHints=%t peerHint=%t captured=%d\n",
		room.ServerHints, room.PeerHint, len(room.Captured))

	d, err := newLinkDevDriver(ctx, cmd, room, f, dev, code, dest, stdout, stderr)
	if err != nil {
		room.Session.Close()
		fmt.Fprintln(stderr, err)
		return 1
	}
	switch {
	case dev.script != "":
		d.feedScript(script, true)
	case cmd == linksession.CmdSend:
		d.feedScript([]ldCmd{{op: "send", srcs: srcs}}, true)
	case cmd == linksession.CmdReceive:
		d.feedScript([]ldCmd{{op: "wait-files", n: 1}}, true)
	case cmd == linksession.CmdText:
		// Read stdin only once discovery has chosen link/1 (progress starts
		// it). A legacy outcome hands stdin to pumpText untouched: exactly one
		// reader, whichever protocol wins.
		d.stdinText = true
	default:
		d.feedScript(nil, true)
	}

	res, err := d.run()
	if err != nil {
		d.shutdown()
		fmt.Fprintln(stderr, err)
		return 1
	}
	if res.legacy {
		// Unchanged A08d path: the legacy handshake reads the room directly.
		conn, err := linkDevLegacyConn(ctx, res, f, mode, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		defer conn.Close()
		return linkDevLegacyTransfer(ctx, cmd, conn, m, paths, dest, tty, stdout, stderr)
	}
	d.shutdown()
	if disc, _, _, _ := d.s.States(); disc != "Link" {
		fmt.Fprintln(stderr, linkDevEndMessage(res.ended))
		return 1
	}
	return d.exitCode(stderr)
}

// linkDevLegacyTransfer is today's transfer over the legacy connection.
func linkDevLegacyTransfer(ctx context.Context, cmd linksession.Cmd, conn *tls.Conn, m xfer.Manifest, paths []string,
	dest string, tty bool, stdout, stderr io.Writer,
) int {
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

// linkDevLegacyConn is today's legacy pairing on the room discovery already
// joined: the same handshake, refusals, SAS line and direct pinned-TLS race
// as `send`/`receive`/`text` (crossnetLegacy, shared so the two cannot drift).
func linkDevLegacyConn(ctx context.Context, res *linkDevResult, f crossFlags, mode string, stderr io.Writer) (*tls.Conn, error) {
	sess := res.room.Session
	defer sess.Close()
	if res.first != nil {
		fmt.Fprintln(stderr, "link-dev: legacy handshake, continuing from the peer's commit")
	} else {
		fmt.Fprintln(stderr, "link-dev: legacy handshake, sending our commit first")
	}
	return crossnetLegacy(ctx, sess, res.first, f, stderr, mode)
}

// ================================================================ script

type ldCmd struct {
	op   string
	srcs []string // send
	text string   // text
	n    int      // wait-files / wait-texts
	line int
}

func parseLinkDevScript(src string) ([]ldCmd, error) {
	var out []ldCmd
	for i, raw := range strings.Split(src, "\n") {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		op, arg, _ := strings.Cut(trimmed, " ")
		c := ldCmd{op: op, line: i + 1}
		switch op {
		case "send":
			c.srcs = strings.Fields(arg)
			if len(c.srcs) == 0 {
				return nil, fmt.Errorf("script line %d: send needs a path", i+1)
			}
		case "text":
			// The message is everything after "text ", verbatim.
			c.text = strings.TrimPrefix(strings.TrimLeft(line, " \t"), "text ")
			if c.text == "" || c.text == "text" {
				return nil, fmt.Errorf("script line %d: text needs a message", i+1)
			}
		case "wait-files", "wait-texts":
			n, err := strconv.Atoi(strings.TrimSpace(arg))
			if err != nil || n < 0 {
				return nil, fmt.Errorf("script line %d: %s needs a count", i+1, op)
			}
			c.n = n
		case "wait-sent", "hold":
		default:
			return nil, fmt.Errorf("script line %d: unknown command %q", i+1, op)
		}
		out = append(out, c)
	}
	return out, nil
}

// ================================================================ driver

// ldQueue is the unbounded, ordered hand-off from transport goroutines (Pion
// event dispatch, lane readers) to the one goroutine that owns the session.
// Unbounded on purpose: a lane reader that blocked here while the loop blocks
// in a lane Write could deadlock both ends; what bounds it is the protocol
// (the 8 MiB flow window, the text send buffer) and the transport's own
// backpressure on the peer.
type ldQueue struct {
	mu    sync.Mutex
	items []ldItem
	wake  chan struct{}
}

type ldItemKind int

const (
	ldEvent ldItemKind = iota + 1
	ldFileFrame
	ldTextFrame
	ldItemScript
	ldScriptEOF
	ldVerify
	ldICEReady
	ldWriteFailed
	ldInputFailed
	ldAnswer    // A10: the person answered the current file prompt (ok)
	ldInterrupt // A10: ctrl-C — an authenticated leave, now
	ldCeiling   // A10: the whole-session ceiling of `text` passed — a normal end
)

type ldItem struct {
	kind  ldItemKind
	ev    linkrtc.Event
	ep    linksession.Epoch
	frame []byte
	cmds  []ldCmd
	ok    bool
	err   error
}

func (q *ldQueue) push(it ldItem) {
	q.mu.Lock()
	q.items = append(q.items, it)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *ldQueue) drain() []ldItem {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := q.items
	q.items = nil
	return out
}

type ldRead struct {
	data json.RawMessage
	err  error
}

// ldOut is one outbound batch.
type ldOut struct {
	files   []linkwire.FileMeta
	paths   []string
	sending bool
	idx     int
	off     uint64
	fh      *os.File
	// busy counts offers the peer answered BUSY past the session's one
	// requeue (glare: both ends offering at once, the responder yields).
	busy      int
	notBefore time.Time
}

// shown is file i's manifest path, as the peer will see it.
func (o *ldOut) shown(i int) string {
	if o.files[i].HasPath {
		return o.files[i].Path
	}
	return o.files[i].Name
}

// linkDevBusyRetries bounds how often a batch the peer kept answering BUSY is
// offered again. Each retry is a new local offer, made only once our lane is
// idle, after a short, growing pause that lets the peer's own queue drain.
const linkDevBusyRetries = 8

// ldSink is one inbound batch's files, created no-clobber under dest.
//
// Durability is reported to the session (FileDurable, which paces ACKs and
// gates COMPLETE) as every byte written EXCEPT the last byte of each file not
// yet finalized — synced, closed without error, AND installed under its final
// name with the rest of the batch. So the session can only reach "every byte
// durable" — and send COMPLETE / report saved — once the whole batch is at its
// final names; a sync or install failure withdraws the batch (REJECT) instead,
// and no COMPLETE can exist for it.
type ldSink struct {
	prompt uint64
	out    *linkSink // nil until the sink opened
	// initCleanup is what cleaning up a setup that failed partway could not
	// remove (nil: everything); reported when the batch is discarded.
	initCleanup error
	wrote       []uint64 // bytes written per file
	verified    []bool   // the session verified the file's chain (and it is synced)
	finalized   []bool   // installed under its final name
	written     uint64   // bytes written, all files
	reported    uint64   // the durable total last reported
}

// durable is written minus one held-back byte per written, unfinalized file.
func (k *ldSink) durable() uint64 {
	n := k.written
	for i, w := range k.wrote {
		if w > 0 && !k.finalized[i] {
			n--
		}
	}
	return n
}

// ldICE is the one /api/ice answer of this link (M1).
type ldICE struct {
	done chan struct{}
	cfg  linkrtc.ICEConfig
	used bool // useICE ran: the message, the policy and the deadline are set
}

type linkDevDriver struct {
	ctx            context.Context
	cmd            linksession.Cmd
	room           *rzvous.Room
	f              crossFlags
	dev            linkDevOpts
	code, dest     string
	stdout, stderr io.Writer

	s   *linksession.Session
	res *linkDevResult
	q   *ldQueue

	// transport
	ice      *ldICE
	choice   linkrtc.RTCChoice
	conn     *linkrtc.Conn
	connEp   linksession.Epoch
	commit   string
	caps     []string
	closing  sync.WaitGroup
	latch    linkrtc.DeadlineLatch
	armed    bool
	warned   bool
	lastPath linkrtc.Path

	// admission
	admitted    bool
	verifyAsked bool

	// script
	script    []ldCmd
	scriptEOF bool
	holding   bool

	// files
	outQ      []*ldOut
	cur       *ldOut
	sinks     map[uint64]*ldSink
	sentOK    int
	recvOK    int
	failures  []string
	sentBytes uint64
	recvBytes uint64

	// texts
	texts      []string
	textAsked  bool
	nextTextAt time.Time
	textsIn    int
	probe      bool

	pumpMore bool // pumpFiles stopped at its per-turn bound with credit left

	// quit
	quitting  bool
	closed    bool
	closeCode string
	// outSeq counts frames handed to the lane writers. A leave travels over
	// signalling, which can overtake frames still in flight on the link, and
	// SCTP orders delivery per STREAM only — a text-lane round trip says
	// nothing about the file lane's COMPLETE. So we leave only once every
	// lane's writer is empty and the peer's SCTP stack has acknowledged every
	// byte of every lane (linkrtc.Conn.Unacknowledged == 0).
	outSeq     uint64
	probed     bool
	drainSince time.Time
	draining   bool

	// writers carry lane frames to the transport off the session loop, so a
	// transport that stops draining (SCTP backpressure) can never stall the
	// loop; cut closes the transport independently of the loop.
	writers [2]*ldLaneWriter
	cut     *ldCutoff

	stdinText    bool // `text` without --script: stdin lines, read only once admitted
	stdinStarted bool

	// input lifecycle (readInput / stopInput)
	inputMu   sync.Mutex
	inputStop chan struct{}
	inputSrc  io.Reader
	inputWG   sync.WaitGroup

	heldLeave []byte             // a peer leave kept back by holdLeave
	heldLost  *linksession.Epoch // a transport loss kept back by holdLost
	heldUntil time.Time

	// deferred session calls, run after the current effects (never re-entered)
	later []func() ([]linksession.Effect, error)

	// ---- A10: the product front end and the resumable loop

	// ui is the product front end (`pair`, and `send`/`receive`/`text` when
	// discovery chose link/1). nil is the __link developer output, unchanged.
	ui *linkUI
	// in is where a person answers and types; nil is the default (input()).
	in io.Reader
	// stopAtLink makes run return as soon as discovery has bound link/1, so
	// the caller can install its plan (and its ctrl-C handler) and call run
	// again to drive the link.
	stopAtLink bool
	started    bool
	reads      chan ldRead
	pending    bool
	readsDead  bool
	// interrupted: ctrl-C ended the session (an authenticated leave).
	interrupted bool
	// stayAfterEOF: the end of input does not end the session; the peer's
	// leave does (`pair` with a non-terminal stdin).
	stayAfterEOF bool
	// Product `text` over link: our end of input is an empty message, and we
	// leave once the peer has sent its own (textQuitStep).
	textDone bool
	saidDone bool
	peerDone bool
	// outputFailed: a message could not be written out; the run has failed.
	outputFailed bool
}

func newLinkDevDriver(ctx context.Context, cmd linksession.Cmd, room *rzvous.Room, f crossFlags, dev linkDevOpts,
	code, dest string, stdout, stderr io.Writer,
) (*linkDevDriver, error) {
	s, err := linksession.NewSession(linksession.Config{Cmd: cmd, Clock: linkDevClock{}, Verify: f.verify})
	if err != nil {
		return nil, err
	}
	d := &linkDevDriver{
		ctx: ctx, cmd: cmd, room: room, f: f, dev: dev, code: code, dest: dest, stdout: stdout, stderr: stderr,
		s: s, res: &linkDevResult{room: room}, q: &ldQueue{wake: make(chan struct{}, 1)},
		sinks: map[uint64]*ldSink{}, cut: newLDCutoff(),
	}
	// The run's own end (whole-run timeout, cancellation) cuts the transport
	// without waiting for the loop.
	go func() {
		select {
		case <-ctx.Done():
			d.cut.fire("the run ended")
		case <-d.cut.done:
		}
	}()
	return d, nil
}

// logf is developer chatter: the __link harness prints it; the product
// commands do not (set RELAYIUM_LINK_DEBUG=1 to see it there too).
func (d *linkDevDriver) logf(format string, a ...any) {
	if d.ui != nil && !linkDebug {
		return
	}
	fmt.Fprintf(d.stderr, "link-dev: "+format+"\n", a...)
}

// notice is a line a person needs in either mode: the __link harness keeps
// its developer prefix, the product commands print it plainly.
func (d *linkDevDriver) notice(format string, a ...any) {
	if d.ui == nil {
		d.logf(format, a...)
		return
	}
	d.ui.line(format, a...)
}

func (d *linkDevDriver) fail(what string) {
	d.failures = append(d.failures, what)
	if d.ui != nil {
		d.ui.problem(what)
		return
	}
	d.logf("FAILED: %s", what)
}

// record notes a failure the front end already reported in its own words.
func (d *linkDevDriver) record(what string) {
	d.failures = append(d.failures, what)
	if d.ui == nil {
		d.logf("FAILED: %s", what)
	}
}

func (d *linkDevDriver) feedScript(cmds []ldCmd, eof bool) {
	d.q.push(ldItem{kind: ldItemScript, cmds: cmds})
	if eof {
		d.q.push(ldItem{kind: ldScriptEOF})
	}
}

// input is the source a person answers on: the text command's stdin for
// `text`, otherwise the process's stdin.
func (d *linkDevDriver) input() io.Reader {
	if d.in != nil {
		return d.in
	}
	if d.cmd == linksession.CmdText {
		return textStdin()
	}
	return osStdin()
}

// ldConfirmSAS is confirmSAS reading exactly one line from in, a byte at a
// time, so nothing after the answer is consumed: the messages that follow on
// the same input stay for their reader.
func ldConfirmSAS(w io.Writer, in io.Reader) bool {
	fmt.Fprint(w, "Do the verification codes match on both ends? [y/N] ")
	var line []byte
	b := make([]byte, 1)
	for tries := 0; len(line) < 64 && tries < 1024; tries++ {
		n, err := in.Read(b)
		if n == 1 {
			if b[0] == '\n' {
				break
			}
			line = append(line, b[0])
		}
		if err != nil {
			break
		}
	}
	ans := strings.TrimSpace(string(line))
	return ans == "y" || ans == "yes" || ans == "Y"
}

// feedTextLines turns each line of r into one message (the `text` default).
// Input that could not be read — a line over the 1 MiB bound, a read error —
// is a FAILURE of the run, never a quiet end of input: the messages after it
// were not sent. A stop by shutdown is not a failure (nothing is waiting).
func (d *linkDevDriver) feedTextLines(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		if line := sc.Text(); line != "" {
			d.q.push(ldItem{kind: ldItemScript, cmds: []ldCmd{{op: "text", text: line}}})
		}
	}
	if err := sc.Err(); err != nil && !d.inputStopped() {
		d.q.push(ldItem{kind: ldInputFailed, err: err})
	}
	d.q.push(ldItem{kind: ldScriptEOF})
}

// errInputStopped: shutdown stopped this run's input.
var errInputStopped = errors.New("link-dev: input stopped")

// ldStopReader is this run's view of its input: once the run stops its
// input, no further Read reaches the underlying reader, so an input shared
// with a later run in the same process is not consumed by this one.
type ldStopReader struct {
	r    io.Reader
	stop <-chan struct{}
}

func (s ldStopReader) Read(p []byte) (int, error) {
	select {
	case <-s.stop:
		return 0, errInputStopped
	default:
	}
	return s.r.Read(p)
}

// linkDevInputJoin bounds how long shutdown waits for an input reader.
const linkDevInputJoin = time.Second

// readInput runs fn on this run's input, off the loop, under the run's input
// lifecycle (stopInput).
func (d *linkDevDriver) readInput(fn func(io.Reader)) {
	d.inputMu.Lock()
	defer d.inputMu.Unlock()
	if d.inputStop == nil {
		d.inputStop = make(chan struct{})
		d.inputSrc = d.input()
	}
	stop := d.inputStop
	d.inputWG.Add(1)
	go func() {
		defer d.inputWG.Done()
		fn(ldStopReader{r: d.inputSrc, stop: stop})
	}()
}

func (d *linkDevDriver) inputStopped() bool {
	d.inputMu.Lock()
	defer d.inputMu.Unlock()
	if d.inputStop == nil {
		return false
	}
	select {
	case <-d.inputStop:
		return true
	default:
		return false
	}
}

// stopInput ends this run's input readers: no new Read reaches the input,
// and a Read already blocked is interrupted through the input's read
// deadline when it has one, joined (bounded), and the deadline cleared again
// for whoever reads the input next. An input that cannot be interrupted is
// not waited for beyond linkDevInputJoin; such a reader may still complete
// the one Read it is blocked in.
func (d *linkDevDriver) stopInput() {
	d.inputMu.Lock()
	if d.inputStop == nil {
		d.inputMu.Unlock()
		return
	}
	select {
	case <-d.inputStop:
		d.inputMu.Unlock()
		return
	default:
	}
	close(d.inputStop)
	src := d.inputSrc
	d.inputMu.Unlock()
	// An input whose blocked Read can be interrupted: os.File for pipes and
	// terminals (text.go's readDeadliner).
	dl, canInterrupt := src.(readDeadliner)
	if canInterrupt && dl.SetReadDeadline(time.Now()) != nil {
		canInterrupt = false // e.g. a regular file
	}
	joined := make(chan struct{})
	go func() { d.inputWG.Wait(); close(joined) }()
	select {
	case <-joined:
	case <-time.After(linkDevInputJoin):
		d.logf("an input reader is still blocked; it was left behind")
	}
	if canInterrupt {
		_ = dl.SetReadDeadline(time.Time{})
	}
}

// run drives discovery and, when discovery chooses link/1, the link, until
// the session ends or discovery hands the room to the legacy handshake.
//
// Reads are issued one at a time. That matters for the legacy hand-off:
// rzvous.DoHandshake reads the same connection, so no read of ours may be in
// flight when it starts. A hand-off is only ever decided by a signal (a timer
// never chooses a wire, property P1), i.e. right after a read completed, so
// none is.
func (d *linkDevDriver) run() (*linkDevResult, error) {
	room := d.room
	if !d.started {
		d.started = true
		d.reads = make(chan ldRead, 1)
		for _, c := range room.Captured {
			if err := d.do(d.s.Signal(d.s.Epoch(), room.PeerID, c)); err != nil {
				return nil, err
			}
			if d.decided() {
				return d.res, nil
			}
		}
		if err := d.do(d.s.Room(d.s.Epoch(), linksession.RoomView{
			SelfID: room.SelfID, PeerID: room.PeerID, ServerHints: room.ServerHints, PeerHinted: room.PeerHint,
		})); err != nil {
			return nil, err
		}
	}

	reads := d.reads
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		if d.decided() {
			if d.res.legacy && d.pending {
				// Unreachable by P1; refuse rather than race the handshake's reads.
				return nil, errors.New("link-dev: legacy hand-off with a read in flight")
			}
			return d.res, nil
		}
		if d.stopAtLink {
			if disc, _, _, _ := d.s.States(); disc == "Link" {
				// Discovery bound link/1: hand back to the caller, which installs
				// its plan and calls run again. A read may be in flight; it is
				// kept in d.reads for the next call.
				d.stopAtLink = false
				d.res.link = true
				return d.res, nil
			}
		}
		if err := d.progress(); err != nil {
			return nil, err
		}
		if d.decided() {
			continue
		}
		if err := d.releaseLeave(false); err != nil {
			return nil, err
		}
		if d.decided() {
			continue
		}
		// While a leave is held no later signal is read: signals stay in
		// order behind it.
		if !d.pending && !d.readsDead && d.heldLeave == nil {
			d.pending = true
			go func() {
				// RecvSignal returns signals only. In a pairing-code room the
				// hub admits two members, so every signal is the bound peer's.
				data, err := room.Session.RecvSignal(d.ctx)
				reads <- ldRead{data, err}
			}()
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(max(time.Until(d.nextWake()), 0))
		select {
		case <-d.ctx.Done():
			return nil, d.ctx.Err()
		case r := <-reads:
			d.pending = false
			if r.err != nil {
				if d.linkOpen() {
					// The link lives on its own transport; only signalling
					// is gone (the peer's leave can no longer arrive).
					d.logf("rendezvous connection closed: %v", r.err)
					d.readsDead = true
					continue
				}
				return nil, fmt.Errorf("rendezvous connection lost: %w", r.err)
			}
			if d.holdLeave(r.data) {
				continue
			}
			if err := d.do(d.s.Signal(d.s.Epoch(), room.PeerID, r.data)); err != nil {
				return nil, err
			}
		case <-d.q.wake:
			for _, it := range d.q.drain() {
				if err := d.item(it); err != nil {
					return nil, err
				}
				if d.decided() {
					break
				}
			}
		case <-timer.C:
			if err := d.do(d.s.Tick()); err != nil {
				return nil, err
			}
			d.warnCheck()
		}
	}
}

// linkDevLeaveHold bounds how long a peer's leave — or the loss of the
// transport the peer closed after it — waits for the frames the peer sent
// BEFORE it (see holdLeave).
const linkDevLeaveHold = 3 * time.Second

// holdLeave keeps back a peer's leave that arrives while our outbound batch is
// waiting for its COMPLETE. The peer leaves only after our transport has
// acknowledged every byte it sent (quitStep), so its COMPLETE is already in
// this process — in a lane reader or in the queue — even when this loop
// reads the leave first (a stalled loop wakes with both ready, and select
// picks either). Applying the leave first would end the batch as
// "delivery-unconfirmed" although the peer saved it, and a user told that
// may send it again, metered. So the leave is applied only once the batch
// left OutFinish, or after linkDevLeaveHold: whichever is first.
func (d *linkDevDriver) holdLeave(raw []byte) bool {
	if d.heldLeave != nil {
		return false
	}
	sig, err := linkwire.ParseSignal(raw)
	if err != nil {
		return false
	}
	if _, ok := linkwire.LeaveAuth(sig); !ok {
		return false
	}
	if fs, _ := d.laneStates(); fs != "OutFinish" {
		return false
	}
	d.heldLeave = append([]byte(nil), raw...)
	d.holdFrom()
	d.logf("holding the peer's leave until our batch's COMPLETE (sent before it) is processed")
	return true
}

// holdLost keeps back a transport loss on the same condition and the same
// bound. A peer closes its transport right after its leave; frames the lane
// readers already took off the transport are still delivered after the loss,
// and COMPLETE may be one of them.
func (d *linkDevDriver) holdLost(ep linksession.Epoch) bool {
	if fs, _ := d.laneStates(); fs != "OutFinish" || d.heldLost != nil {
		return false
	}
	d.heldLost = &ep
	d.holdFrom()
	d.logf("holding the transport loss until our batch's COMPLETE, already received, is processed")
	return true
}

// holdFrom starts the bound on the first hold; a later hold never extends it.
func (d *linkDevDriver) holdFrom() {
	if d.heldUntil.IsZero() {
		d.heldUntil = time.Now().Add(linkDevLeaveHold)
	}
}

// releaseLeave applies a held leave once the batch is settled or the bound
// passed.
// In arrival order of kind: the leave (the peer's explicit end) before the
// loss it caused.
func (d *linkDevDriver) releaseLeave(force bool) error {
	if d.heldLeave == nil && d.heldLost == nil {
		return nil
	}
	fs, _ := d.laneStates()
	if !force && fs == "OutFinish" && time.Now().Before(d.heldUntil) {
		return nil
	}
	if fs == "OutFinish" {
		d.logf("the peer's COMPLETE did not arrive within %v", linkDevLeaveHold)
	}
	raw, lost := d.heldLeave, d.heldLost
	d.heldLeave, d.heldLost = nil, nil
	if raw != nil {
		if err := d.do(d.s.Signal(d.s.Epoch(), d.room.PeerID, raw)); err != nil {
			return err
		}
	}
	if lost != nil {
		return d.do(d.s.TransportLost(*lost)) // stale, and dropped, if the leave already ended the link
	}
	return nil
}

// decided: the session ended, or discovery handed the room to the legacy wire.
func (d *linkDevDriver) decided() bool {
	if ended, code := d.s.Ended(); ended {
		if d.res.ended == "" {
			d.res.ended = code
		}
		return true
	}
	return d.res.legacy
}

func (d *linkDevDriver) linkOpen() bool {
	_, link, _, _ := d.s.States()
	return link == "Open" || link == "Restarting"
}

// nextWake is the earliest instant the loop must act without an input: the
// session's own deadline (which may be due now), or a local pacing mark that
// is still in the FUTURE — a mark already passed is acted on by progress() on
// the next input and must not re-arm the timer at zero (a busy loop while the
// lane it waits for is not open yet).
func (d *linkDevDriver) nextWake() time.Time {
	now := time.Now()
	if d.pumpMore {
		return now
	}
	if d.draining {
		return now.Add(20 * time.Millisecond) // SACKs raise no event: poll the drain
	}

	at := now.Add(time.Hour)
	if t, ok := d.s.NextDeadline(); ok && t.Before(at) {
		at = t
	}
	future := func(t time.Time) {
		if t.After(now) && t.Before(at) {
			at = t
		}
	}
	if len(d.texts) > 0 || (d.textDone && d.quitting && !d.saidDone) {
		future(d.nextTextAt) // the end-of-input marker is paced like a message
	}
	if b, ok := d.latch.Bound(); ok && d.armed && !d.warned {
		future(b.WarnAt)
	}
	if d.cur == nil && len(d.outQ) > 0 {
		future(d.outQ[0].notBefore)
	}
	if d.heldLeave != nil || d.heldLost != nil {
		future(d.heldUntil) // releaseLeave applies them once due
	}
	return at
}

func (d *linkDevDriver) warnCheck() {
	b, ok := d.latch.Bound()
	if !ok || !d.armed || d.warned || time.Now().Before(b.WarnAt) || !d.linkOpen() {
		return
	}
	d.warned = true
	d.notice("the relay credential for this link ends at %s; the link will end then (pair again to continue)",
		b.DeadlineAt.Format(time.RFC3339))
}

// do executes one session call's effects in order, then every session call
// they deferred, in order. Effects come back even with an error and must be
// executed; ErrEnded and the lane refusals are results, not failures.
func (d *linkDevDriver) do(effs []linksession.Effect, err error) error {
	if aerr := d.apply(effs); aerr != nil {
		return aerr
	}
	if err != nil && !errors.Is(err, linksession.ErrEnded) && !errors.Is(err, linksession.ErrStale) {
		d.logf("session refused an input: %v", err)
	}
	for len(d.later) > 0 {
		call := d.later[0]
		d.later = d.later[1:]
		effs, err := call()
		if aerr := d.apply(effs); aerr != nil {
			return aerr
		}
		if err != nil && !errors.Is(err, linksession.ErrEnded) && !errors.Is(err, linksession.ErrStale) {
			d.logf("session refused a local action: %v", err)
		}
	}
	return nil
}

func (d *linkDevDriver) defer_(call func() ([]linksession.Effect, error)) {
	d.later = append(d.later, call)
}

// apply executes effects in order. It never calls the session itself.
func (d *linkDevDriver) apply(effs []linksession.Effect) error {
	room := d.room
	for _, e := range effs {
		switch e.Kind {
		case linksession.EffSendSignal:
			if e.To != room.PeerID {
				continue // only link establishment answers another peer (busy); a code room has one
			}
			if err := room.Session.SendSignal(d.ctx, e.Bytes); err != nil {
				if ended, _ := d.s.Ended(); ended || d.linkOpen() {
					// A best-effort leave, or a frame for a link that no
					// longer needs signalling: the link decides, not this.
					d.logf("signal not sent: %v", err)
					continue
				}
				return err
			}
		case linksession.EffBeginLegacy:
			d.res.legacy = true
			if e.Bytes != nil {
				d.res.first = json.RawMessage(e.Bytes)
			}
		case linksession.EffLegacyFrame:
			// Frames that arrived before the hand-off (replayed from the
			// capture). The first is the peer's commit; our commit and the
			// reveals have not been exchanged yet, so there is no second.
			if d.res.first != nil {
				return errors.New("the peer sent more than one handshake message before ours")
			}
			d.res.first = json.RawMessage(e.Bytes)

		// ---- link establishment: the transport
		case linksession.EffCreateChannels:
			if err := d.ensureConn(linkrtc.Initiator); err != nil {
				return err
			}
		case linksession.EffSendOffer:
			d.commit, d.caps = e.Commit, e.Caps
			if err := d.ensureConn(linkrtc.Initiator); err != nil {
				return err
			}
			if err := d.conn.Offer(); err != nil {
				if !errors.Is(err, linkrtc.ErrClosed) {
					return fmt.Errorf("link offer: %w", err)
				}
				// Cut already (e.g. a credential inside the skew margin): the
				// session's own timers report why.
				ep := d.connEp
				d.defer_(func() ([]linksession.Effect, error) { return d.s.TransportLost(ep) })
			}
		case linksession.EffSendAnswer:
			d.commit, d.caps = e.Commit, e.Caps
			if err := d.ensureConn(linkrtc.Responder); err != nil {
				return err
			}
			if err := d.applyRemote(e.Bytes); err != nil {
				d.logf("peer offer not applied: %v", err)
				d.defer_(func() ([]linksession.Effect, error) { return d.s.TransportLost(d.connEp) })
			}
		case linksession.EffApplyAnswer, linksession.EffApplyRestartOffer:
			if d.conn != nil {
				if err := d.applyRemote(e.Bytes); err != nil {
					d.logf("peer description not applied: %v", err)
					d.defer_(func() ([]linksession.Effect, error) { return d.s.TransportLost(d.connEp) })
				}
			}
		case linksession.EffAddICE:
			if d.conn != nil {
				if cand, ok := parseLinkICE(e.Bytes); ok {
					if err := d.conn.AddICE(cand); err != nil && !errors.Is(err, linkrtc.ErrClosed) {
						d.logf("peer candidate not added: %v", err) // non-fatal by contract
					}
				}
			}
		case linksession.EffICERestart:
			d.commit, d.caps = e.Commit, e.Caps
			if d.conn != nil {
				if err := d.conn.RestartICE(); err != nil {
					d.logf("ICE restart not sent: %v", err)
				}
			}
		case linksession.EffCloseChannel:
			// linkrtc already closed the offending channel on its own.
		case linksession.EffCloseTransport:
			d.closeTransport()
		case linksession.EffAttachLanes:
			if d.conn != nil {
				ep := d.connEp
				if err := d.conn.Attach(
					func(b []byte) {
						if ldHookInbound != nil {
							ldHookInbound(d, linkrtc.LaneFile, b) // on the lane reader, after SCTP accepted b
						}
						d.q.push(ldItem{kind: ldFileFrame, ep: ep, frame: b})
					},
					func(b []byte) { d.q.push(ldItem{kind: ldTextFrame, ep: ep, frame: b}) },
				); err != nil {
					d.logf("lanes not attached: %v", err)
					d.defer_(func() ([]linksession.Effect, error) { return d.s.TransportLost(ep) })
				}
			}

		// ---- admission
		case linksession.EffSASReady:
			if d.ui != nil {
				d.ui.connected(d)
			}
			fmt.Fprintf(d.stderr, "%s%s — not the pairing code; compare it on both ends to rule out a substituted endpoint\n", sasLinePrefix, d.s.SAS())
		case linksession.EffAdmitted:
			d.admitted = true
			d.logf("link admitted")
			if d.ui != nil {
				d.ui.admitted(d)
			}

		// ---- lanes
		case linksession.EffSendFile:
			d.write(linkrtc.LaneFile, e.Bytes)
		case linksession.EffSendText:
			d.write(linkrtc.LaneText, e.Bytes)
		case linksession.EffPromptFiles:
			prompt, n := e.Prompt, len(e.Files)
			if d.ui != nil {
				d.ui.promptFiles(d, prompt, e.Files)
				continue
			}
			if d.dev.yes {
				d.logf("incoming batch of %d file(s): accepting (--yes)", n)
				d.defer_(func() ([]linksession.Effect, error) { return d.s.AcceptFiles(prompt) })
			} else {
				d.logf("incoming batch of %d file(s): declining (no --yes)", n)
				d.defer_(func() ([]linksession.Effect, error) { return d.s.RejectFiles(prompt) })
			}
		case linksession.EffPromptText:
			prompt := e.Prompt
			if d.dev.yes {
				d.defer_(func() ([]linksession.Effect, error) { return d.s.AcceptText(prompt) })
			} else {
				d.defer_(func() ([]linksession.Effect, error) { return d.s.RejectText(prompt) })
			}
		case linksession.EffAttachSink:
			if err := d.openSink(e.Prompt, e.Files); err != nil {
				d.fail("receive sink: " + err.Error())
				d.defer_(d.s.CancelIncoming)
			}
		case linksession.EffWriteChunk:
			d.writeChunk(e.Prompt, e.Index, e.Bytes)
		case linksession.EffFileVerified:
			d.finalizeFile(e.Prompt, e.Index)
		case linksession.EffDiscardPartial:
			d.discardSink(e.Prompt)
		case linksession.EffSendData:
			if d.cur != nil {
				d.cur.sending = true
			}
		case linksession.EffTextOpened:
			d.logf("conversation open")
		case linksession.EffDeliverText:
			if ldHookLoopText != nil {
				ldHookLoopText(d, d.cut.done)
			}
			if e.Text == "" && d.ui != nil && d.ui.peerHint {
				// Another relayium CLI's `text` end-of-input marker (see
				// textQuitStep): it carries nothing and is never shown.
				if d.textDone {
					d.peerDone = true
				}
				continue
			}
			d.textsIn++
			d.recvBytes += uint64(len(e.Text))
			if d.ui != nil {
				if err := d.ui.text(e.Text); err != nil && !d.outputFailed {
					// Nothing more can be shown: fail the run and leave.
					d.outputFailed = true
					d.fail(err.Error())
					d.defer_(d.s.Close)
				}
				continue
			}
			fmt.Fprintln(d.stdout, termSafe(e.Text))
		case linksession.EffReport:
			d.report(e.Lane, e.Code)
		case linksession.EffLinkClosed:
			d.closeCode = e.Code
			d.logf("link closed (%s)", e.Code)
		case linksession.EffSessionEnded:
			d.res.ended = e.Code
		case linksession.EffPromptWithdrawn:
			if d.ui != nil {
				d.ui.withdrawn(e.Prompt)
			}
		}
	}
	return nil
}

// write hands a frame to its lane's writer; it never blocks the loop.
func (d *linkDevDriver) write(lane linkrtc.Lane, b []byte) {
	if d.conn == nil || d.writers[lane] == nil {
		return
	}
	d.outSeq++
	d.writers[lane].push(b)
}

// ---------------------------------------------------------------- lane writers and the cutoff

// Test hooks. nil in production; only linkdev_test.go sets them.
var (
	// ldHookLaneWrite runs on a lane writer before each transport Write.
	ldHookLaneWrite func(d *linkDevDriver, lane linkrtc.Lane, frame []byte, stop <-chan struct{})
	// ldHookLoopText runs ON THE SESSION LOOP when a message is delivered.
	ldHookLoopText func(d *linkDevDriver, stop <-chan struct{})
	// ldHookFinalize runs before a received file is synced and closed.
	ldHookFinalize func(d *linkDevDriver, name string) error
	// ldHookInbound runs on the file lane's reader for each received frame,
	// before it is queued for the loop.
	ldHookInbound func(d *linkDevDriver, lane linkrtc.Lane, frame []byte)
)

// ldCutoff closes the transport from any goroutine, once: at the relay
// deadline (armed by armDeadline, M4), when the run's context ends, or after
// the leave's linger. It needs nothing from the session loop, so a loop that
// is stuck — in a lane write, a signal write, anything — cannot keep a TURN
// allocation alive past the credential. done is closed when it fires; lane
// writers stop on it.
type ldCutoff struct {
	mu    sync.Mutex
	conn  *linkrtc.Conn
	fired bool
	why   string
	done  chan struct{}
}

func newLDCutoff() *ldCutoff { return &ldCutoff{done: make(chan struct{})} }

// attach registers the transport; one attached after the cutoff fired is
// closed at once.
func (c *ldCutoff) attach(conn *linkrtc.Conn) {
	c.mu.Lock()
	c.conn = conn
	fired := c.fired
	c.mu.Unlock()
	if fired {
		conn.Close()
	}
}

func (c *ldCutoff) fire(why string) {
	c.mu.Lock()
	if c.fired {
		c.mu.Unlock()
		return
	}
	c.fired, c.why = true, why
	conn := c.conn
	close(c.done)
	c.mu.Unlock()
	if conn != nil {
		conn.Close() // unblocks any Write waiting on backpressure (ErrClosed)
	}
}

func (c *ldCutoff) reason() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.why
}

// ldLaneWriter is one lane's ordered frame queue and the goroutine that
// performs the (possibly blocking) transport Writes.
type ldLaneWriter struct {
	lane linkrtc.Lane
	mu   sync.Mutex
	q    [][]byte
	// pending counts bytes pushed and not yet returned from Write.
	pending int
	wake    chan struct{}
}

func (w *ldLaneWriter) push(b []byte) {
	w.mu.Lock()
	w.q = append(w.q, b)
	w.pending += len(b)
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// queued is the bytes not yet accepted by the transport.
func (w *ldLaneWriter) queued() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.pending
}

func (d *linkDevDriver) runWriter(w *ldLaneWriter, conn *linkrtc.Conn, ep linksession.Epoch) {
	defer d.closing.Done()
	for {
		w.mu.Lock()
		if len(w.q) == 0 {
			w.mu.Unlock()
			select {
			case <-w.wake:
				continue
			case <-d.cut.done:
				return
			}
		}
		frame := w.q[0]
		w.q[0] = nil
		w.q = w.q[1:]
		w.mu.Unlock()
		if ldHookLaneWrite != nil {
			ldHookLaneWrite(d, w.lane, frame, d.cut.done)
		}
		err := conn.Write(w.lane, frame)
		w.mu.Lock()
		w.pending -= len(frame)
		w.mu.Unlock()
		if err != nil {
			if !errors.Is(err, linkrtc.ErrClosed) {
				d.q.push(ldItem{kind: ldWriteFailed, ep: ep, err: fmt.Errorf("%s write: %w", w.lane, err)})
			}
			return
		}
	}
}

// report interprets the session's user-visible outcomes for this harness.
func (d *linkDevDriver) report(lane, code string) {
	d.logf("report %s %s", lane, code)
	if d.ui != nil {
		d.ui.report(d, lane, code)
	}
	switch lane {
	case "file":
		switch code {
		case "delivered-and-verified":
			d.sentOK++
			d.finishCur()
		case "saved(verified,durable)":
			d.recvOK++
			d.retireSaved()
		case "peer-busy(batch-not-sent)":
			if o := d.cur; o != nil && o.busy < linkDevBusyRetries && o.idx == 0 && o.off == 0 {
				o.busy++
				o.notBefore = time.Now().Add(time.Duration(o.busy) * 150 * time.Millisecond)
				d.cur = nil
				d.outQ = append([]*ldOut{o}, d.outQ...)
				d.logf("the peer was busy; offering the batch again (%d/%d)", o.busy, linkDevBusyRetries)
				return
			}
			d.record("outbound batch: " + code)
			d.finishCur()
		case "declined", "no-answer", "stopped-by-receiver", "cancelled-partial-not-delivered",
			"cancelled-after-all-sent(receiver-may-have-saved)", "send-stalled", "receiver-failed-to-save",
			"batch-not-delivered", "partial-not-delivered", "delivery-unconfirmed",
			"no-completion", "complete-before-done":
			d.record("outbound batch: " + code)
			d.finishCur()
		default:
			d.record("file lane: " + code)
		}
	case "text":
		if code == "declined" && d.probe {
			d.probe = false // the peer answered our probe: it is open, and that was all we asked
			return
		}
		if strings.HasPrefix(code, "conversation-ended") {
			return // the link closing ends the conversation: not a text failure by itself
		}
		d.record("text lane: " + code)
		if code == "declined" && len(d.texts) > 0 {
			d.fail(fmt.Sprintf("%d message(s) not sent: the peer declined the conversation", len(d.texts)))
			d.texts = nil
		}
	case "link":
		switch code {
		case "peer-ended-session", "idle-closed":
		case "relay-credential-ended":
			d.notice("the relay credential for this link ended; nothing more can be sent over it — pair again to continue")
		default:
			if b, ok := d.latch.Bound(); ok && d.armed && !time.Now().Before(b.DeadlineAt) {
				d.notice("the relay credential for this link ended before the link could be established — pair again")
			}
		}
	}
}

func (d *linkDevDriver) finishCur() {
	if d.cur != nil {
		if d.cur.fh != nil {
			_ = d.cur.fh.Close()
		}
		d.cur = nil
	}
}

// ---------------------------------------------------------------- transport

// ensureConn builds this link's transport once. The ICE configuration it is
// built from is fetched here — only now that discovery has bound a link —
// and never again for this link (M1).
func (d *linkDevDriver) ensureConn(role linkrtc.Role) error {
	if d.conn != nil {
		if d.conn.Role() != role {
			return errors.New("link-dev: transport role changed")
		}
		return nil
	}
	d.iceConfig()
	wcfg, err := d.choice.WebRTC()
	if err != nil {
		return fmt.Errorf("the server's ICE configuration cannot be used: %w", err)
	}
	opts := linkrtc.Options{}
	if host, _, err := net.SplitHostPort(d.f.advertise); err == nil && net.ParseIP(host) != nil {
		opts.AdvertiseIPs = []string{host}
	}
	api, err := linkrtc.NewAPI(opts)
	if err != nil {
		return err
	}
	policy := "all"
	if d.choice.RelayOnly {
		policy = "relay"
	}
	d.logf("link/1 %s; ice policy=%s servers=%d turn=%t", role, policy, len(wcfg.ICEServers), linkrtc.HasTURNServer(d.choice.ICEServers))
	ep := d.s.Epoch()
	conn, err := linkrtc.NewConn(api, wcfg, role, func(ev linkrtc.Event) {
		d.q.push(ldItem{kind: ldEvent, ev: ev, ep: ep})
	})
	if err != nil {
		return err
	}
	d.conn, d.connEp = conn, ep
	d.cut.attach(conn)
	for _, lane := range []linkrtc.Lane{linkrtc.LaneFile, linkrtc.LaneText} {
		w := &ldLaneWriter{lane: lane, wake: make(chan struct{}, 1)}
		d.writers[lane] = w
		d.closing.Add(1)
		go d.runWriter(w, conn, ep)
	}
	return nil
}

// useICE applies the link's one /api/ice answer, once: the truthful line when
// there is no relay (M3), the Web's policy (M2), and the relay bound (M4) —
// derived ONCE from the issued credentials against the clock of their
// arrival and latched. Relay-only means every selected pair relays, so the
// bound applies from now, before any transport exists: a responder still
// waiting for the offer is bounded by the same credential.
func (d *linkDevDriver) useICE() {
	if d.ice == nil || d.ice.used {
		return
	}
	select {
	case <-d.ice.done:
	default:
		return
	}
	d.ice.used = true
	cfg := d.ice.cfg
	if msg := relayStatusMessage(cfg.Status); msg != "" {
		fmt.Fprintln(d.stderr, msg) // once: there is one fetch per link
	}
	d.choice = linkrtc.ChooseRTCConfig(cfg, "")
	now := time.Now()
	if b, ok := linkrtc.RelayDeadlineFor(cfg, now); ok {
		b = d.latch.Tighten(b)
		if b.DeadlineAt.After(now) {
			d.logf("relay credential expires %s; link deadline %s", b.ExpiresAt.Format(time.RFC3339), b.DeadlineAt.Format(time.RFC3339))
		} else {
			d.logf("the relay credential expires %s, within the clock-skew margin: the link cannot be relayed", b.ExpiresAt.Format(time.RFC3339))
		}
		if d.choice.RelayOnly {
			d.armDeadline()
		}
	}
}

// armDeadline hands the latched bound to the session. The session's relay
// timer is the one that ends the link; the latch guarantees the value handed
// to it can never be later than the first bound.
func (d *linkDevDriver) armDeadline() {
	b, ok := d.latch.Bound()
	if !ok || d.armed {
		return
	}
	d.armed = true
	d.s.SetRelayDeadline(b.DeadlineAt)
	// The same bound, enforced WITHOUT the loop: whatever the loop is doing
	// at the deadline, the transport — and with it every TURN allocation —
	// is closed then.
	go func(at time.Time) {
		t := time.NewTimer(time.Until(at))
		defer t.Stop()
		select {
		case <-t.C:
			d.cut.fire("relay deadline")
		case <-d.cut.done:
		}
	}(b.DeadlineAt)
}

// iceConfig waits for the link's one /api/ice answer and applies it.
func (d *linkDevDriver) iceConfig() {
	d.startICE()
	select {
	case <-d.ice.done:
	case <-d.ctx.Done():
	}
	d.useICE()
}

// startICE issues the link's one /api/ice request (M1).
func (d *linkDevDriver) startICE() {
	if d.ice != nil {
		return
	}
	d.ice = &ldICE{done: make(chan struct{})}
	ice := d.ice
	endpoint, err := linkrtc.ICEEndpoint(d.f.server, d.code)
	if err != nil {
		ice.cfg = linkrtc.ICEConfig{Status: linkrtc.RelayUnavailable}
		close(ice.done)
		d.q.push(ldItem{kind: ldICEReady})
		return
	}
	go func() {
		ice.cfg = linkDevICEFetcher.FetchICEConfig(d.ctx, endpoint, d.code)
		close(ice.done)
		d.q.push(ldItem{kind: ldICEReady})
	}()
}

// linkDevICEFetcher is production /api/ice behaviour (ice.ts timings).
var linkDevICEFetcher = linkrtc.ICEFetcher{}

// relayStatusMessage is the one truthful line for a link without a relay
// (M3), printed once per link by __link and by the product commands alike.
func relayStatusMessage(s linkrtc.RelayStatus) string {
	const tail = "; trying a direct connection only (no relay) — across strict NATs that may fail"
	switch s {
	case linkrtc.RelayQuota:
		return "relay unavailable: the pairing code owner's monthly relay allowance is used up" + tail
	case linkrtc.RelayUnverified:
		return "relay unavailable: the pairing code owner's email address is not verified" + tail
	case linkrtc.RelayRateLimited:
		return "relay unavailable: too many relay requests from this network right now" + tail
	case linkrtc.RelayUnavailable:
		return "relay unavailable: the server's relay configuration could not be read" + tail
	case linkrtc.RelayNone:
		return "relay unavailable: the server issued no relay for this pairing code" + tail
	}
	return ""
}

func (d *linkDevDriver) applyRemote(raw []byte) error {
	var sig struct {
		SDP *webrtc.SessionDescription `json:"sdp"`
	}
	if err := json.Unmarshal(raw, &sig); err != nil || sig.SDP == nil {
		return errors.New("no session description")
	}
	return d.conn.SetRemote(*sig.SDP)
}

func parseLinkICE(raw []byte) (webrtc.ICECandidateInit, bool) {
	var sig struct {
		ICE *webrtc.ICECandidateInit `json:"ice"`
	}
	if json.Unmarshal(raw, &sig) != nil || sig.ICE == nil {
		return webrtc.ICECandidateInit{}, false
	}
	return *sig.ICE, true
}

// sdpSignal is an offer or answer frame: {link, sdp, commit, caps} (link §4.2).
func sdpSignal(sd webrtc.SessionDescription, commit string, caps []string) ([]byte, error) {
	return json.Marshal(struct {
		Link   bool                      `json:"link"`
		SDP    webrtc.SessionDescription `json:"sdp"`
		Commit string                    `json:"commit"`
		Caps   []string                  `json:"caps"`
	}{true, sd, commit, caps})
}

func iceSignal(c webrtc.ICECandidateInit) ([]byte, error) {
	return json.Marshal(struct {
		Link bool                    `json:"link"`
		ICE  webrtc.ICECandidateInit `json:"ice"`
	}{true, c})
}

// closeTransport closes the transport after a short linger (see
// linkDevCloseLinger). Idempotent.
func (d *linkDevDriver) closeTransport() {
	if d.closed {
		// Already closing: a second call (shutdown right after the session's
		// own close) must not cut the linger short, or the transport dies in
		// the same instant as the leave and the peer reads a lost connection
		// instead of our authenticated end (A10 finding).
		return
	}
	if d.conn == nil {
		d.closed = true
		d.cut.fire("closed")
		return
	}
	d.closed = true
	d.closing.Add(1)
	go func() {
		defer d.closing.Done()
		select {
		case <-time.After(linkDevCloseLinger):
		case <-d.cut.done:
		}
		d.cut.fire("closed")
	}()
}

// shutdown releases everything the driver still holds.
func (d *linkDevDriver) shutdown() {
	d.stopInput()
	d.closeTransport()
	d.closing.Wait()
	if why := d.cut.reason(); why == "relay deadline" {
		d.logf("transport closed at the relay deadline")
	}
	for p := range d.sinks {
		d.closeSink(p)
	}
	d.finishCur()
	d.room.Session.Close()
}

// ---------------------------------------------------------------- queued inputs

func (d *linkDevDriver) item(it ldItem) error {
	switch it.kind {
	case ldEvent:
		return d.event(it.ev, it.ep)
	case ldFileFrame:
		return d.do(d.s.FileFrame(it.ep, it.frame))
	case ldTextFrame:
		return d.do(d.s.TextFrame(it.ep, it.frame))
	case ldItemScript:
		d.script = append(d.script, it.cmds...)
	case ldScriptEOF:
		d.scriptEOF = true
	case ldVerify:
		return d.do(d.s.ConfirmSAS(it.ok))
	case ldICEReady:
		d.useICE()
	case ldInputFailed:
		d.fail("input could not be read (messages after it were not sent): " + it.err.Error())
		return nil
	case ldWriteFailed:
		d.logf("%v", it.err)
		return d.do(d.s.TransportLost(it.ep))
	case ldAnswer:
		if d.ui != nil {
			return d.ui.answer(d, it.ok)
		}
	case ldCeiling:
		if d.ui != nil {
			d.ui.ceiling(d)
		}
		return d.do(d.s.Close())
	case ldInterrupt:
		if !d.interrupted {
			d.interrupted = true
			if d.ui != nil {
				d.ui.interrupting(d)
			}
			return d.do(d.s.Close())
		}
	}
	return nil
}

func (d *linkDevDriver) event(ev linkrtc.Event, ep linksession.Epoch) error {
	switch ev.Kind {
	case linkrtc.EventLocalDescription:
		b, err := sdpSignal(*ev.Description, d.commit, d.caps)
		if err != nil {
			return err
		}
		if err := d.room.Session.SendSignal(d.ctx, b); err != nil {
			return err
		}
	case linkrtc.EventLocalCandidate:
		b, err := iceSignal(*ev.Candidate)
		if err != nil {
			return err
		}
		if err := d.room.Session.SendSignal(d.ctx, b); err != nil && !d.linkOpen() {
			return err
		}
	case linkrtc.EventProgress:
		// ICE progress is counted by the session itself (AAddIce); the other
		// keys re-arm its no-progress timer once each.
		if !strings.HasPrefix(ev.Key, "ice:") {
			return d.do(d.s.TransportProgress(ep, ev.Key))
		}
	case linkrtc.EventLanesOpen:
		if ev.Budget.MaxFrameBytes < linksession.DefaultMaxFrameBytes {
			// The session seals frames up to its configured ceiling; a peer
			// that accepts less cannot carry this build's pieces.
			d.notice("the peer accepts messages of at most %d bytes; this build needs %d", ev.Budget.MaxFrameBytes, linksession.DefaultMaxFrameBytes)
			return d.do(d.s.TransportLost(ep))
		}
		return d.do(d.s.LanesOpen(ep))
	case linkrtc.EventLaneBad:
		return d.do(d.s.ChannelBad(ep, ev.Label))
	case linkrtc.EventCaptureOverflow:
		return d.do(d.s.TransportLost(ep)) // fail closed: the capture was discarded
	case linkrtc.EventSetupNoProgress, linkrtc.EventSetupHardCap:
		// The session runs the same link §5.2 timers and is the authority.
	case linkrtc.EventDisconnected:
		return d.do(d.s.Disconnected(ep))
	case linkrtc.EventReconnected:
		return d.do(d.s.Reconnected(ep))
	case linkrtc.EventTransportLost:
		if d.holdLost(ep) {
			return nil
		}
		return d.do(d.s.TransportLost(ep))
	case linkrtc.EventPathChanged:
		p := ev.Path
		if p.Path != d.lastPath {
			d.lastPath = p.Path
			if d.ui != nil {
				d.ui.path(p)
			} else {
				fmt.Fprintf(d.stderr, "path: %s (selected pair local=%s remote=%s %s)\n", p.Path, p.LocalType, p.RemoteType, p.Protocol)
			}
		}
		if p.Path == linkrtc.PathRelay {
			d.armDeadline() // a relayed pair is bounded by the credential, whatever the policy
		}
	}
	return nil
}

// ---------------------------------------------------------------- progress: script, files, texts, quit

func (d *linkDevDriver) progress() error {
	if ended, _ := d.s.Ended(); ended || d.res.legacy {
		return nil
	}
	// --verify: ask once, off the loop. It reads the same input the messages
	// come from, and message input starts only after admission, so exactly
	// one reader owns that input at any time.
	if d.s.Admission() == linksession.AdmPendingSAS && !d.verifyAsked {
		d.verifyAsked = true
		d.readInput(func(in io.Reader) { d.q.push(ldItem{kind: ldVerify, ok: ldConfirmSAS(d.stderr, in)}) })
	}
	// The link's one /api/ice request starts as soon as discovery has bound a
	// link (M1: never for a legacy pairing), so the responder's is in hand by
	// the time the offer arrives.
	if disc, _, _, _ := d.s.States(); disc == "Link" {
		d.startICE()
	}
	d.warnCheck()
	if !d.admitted || d.closed {
		return nil
	}
	// Messages are read only now: discovery chose link/1 (a legacy outcome
	// leaves stdin to pumpText) AND admission is settled (a --verify answer
	// was read from the same input first).
	if d.stdinText && !d.stdinStarted {
		d.stdinStarted = true
		d.readInput(d.feedTextLines)
	}
	if d.ui != nil {
		if d.ui.readsInput && !d.stdinStarted {
			d.stdinStarted = true
			d.readInput(func(r io.Reader) { d.ui.feed(d, r) })
		}
		d.ui.poll(d)
	}
	d.advanceScript()
	if err := d.pumpFiles(); err != nil {
		return err
	}
	if err := d.pumpTexts(); err != nil {
		return err
	}
	return d.quitStep()
}

func (d *linkDevDriver) advanceScript() {
	for len(d.script) > 0 && !d.quitting {
		c := d.script[0]
		switch c.op {
		case "send":
			m, paths, err := xfer.BuildManifest(c.srcs)
			if err != nil {
				d.fail(fmt.Sprintf("send %v: %v", c.srcs, err))
			} else {
				b := &ldOut{paths: paths}
				for _, fe := range m.Files {
					meta := linkwire.FileMeta{Name: path.Base(fe.Path), Size: uint64(fe.Size)}
					if strings.Contains(fe.Path, "/") {
						meta.Path, meta.HasPath = fe.Path, true
					}
					b.files = append(b.files, meta)
				}
				d.outQ = append(d.outQ, b)
			}
		case "text":
			d.texts = append(d.texts, c.text)
		case "wait-files":
			if d.recvOK < c.n {
				return
			}
		case "wait-texts":
			if d.textsIn < c.n {
				return
			}
		case "wait-sent":
			if !d.outboundIdle() {
				return
			}
		case "hold":
			d.holding = true
			return
		case "quit":
			// `pair` /quit: what was queued before it still goes; then leave,
			// even with a non-terminal stdin, and read nothing after it.
			d.stayAfterEOF = false
			d.scriptEOF = true
			d.script = nil
			return
		case "help", "note":
			if d.ui != nil {
				d.ui.scriptOp(d, c)
			}
		case "wait-batch":
			// `receive`: one inbound batch has concluded, saved or not.
			if d.ui == nil || d.ui.recvDone < c.n {
				return
			}
		}
		d.script = d.script[1:]
	}
}

func (d *linkDevDriver) outboundIdle() bool {
	return d.cur == nil && len(d.outQ) == 0 && len(d.texts) == 0
}

func (d *linkDevDriver) laneStates() (file, text string) {
	_, _, file, text = d.s.States()
	return
}

// pumpFiles offers the next batch when the lane is idle and moves consented
// data under the session's flow window.
func (d *linkDevDriver) pumpFiles() error {
	fileState, _ := d.laneStates()
	if d.cur == nil && len(d.outQ) > 0 && fileState == "Idle" && !time.Now().Before(d.outQ[0].notBefore) {
		d.cur = d.outQ[0]
		d.outQ = d.outQ[1:]
		files := d.cur.files
		if err := d.do(d.s.OfferFiles(files)); err != nil {
			return err
		}
		if fileState, _ = d.laneStates(); fileState != "OutWait" && fileState != "OutSend" && d.cur != nil {
			d.fail("batch could not be offered (lane " + fileState + ")")
			d.finishCur()
		} else if d.ui != nil && d.cur != nil && d.cur.busy == 0 {
			d.ui.offered(d, d.cur)
		}
	}
	if fileState == "Ended" && d.cur != nil {
		d.fail("file lane ended with a batch outstanding")
		d.finishCur()
	}
	// A bounded burst per turn, so inbound ACKs and signals are not starved.
	// Hitting the bound with work left sets pumpMore, which wakes the loop at
	// once: a batch of many small files earns no ACK to wake it otherwise.
	d.pumpMore = false
	for i := 0; d.cur != nil && d.cur.sending; i++ {
		if i == 48 {
			d.pumpMore = true
			break
		}
		if fs, _ := d.laneStates(); fs != "OutSend" {
			d.cur.sending = false
			break
		}
		o := d.cur
		if o.idx >= len(o.files) {
			o.sending = false
			break
		}
		f := o.files[o.idx]
		if o.off == f.Size {
			if o.fh != nil {
				_ = o.fh.Close()
				o.fh = nil
			}
			if d.ui != nil {
				d.ui.sendFileDone(o.shown(o.idx), f.Size)
			}
			o.idx++
			o.off = 0
			if err := d.do(d.s.EndFile()); err != nil {
				return err
			}
			continue
		}
		n := min(uint64(linkwire.ChunkSize), f.Size-o.off)
		if d.s.SendCredit() < n {
			break // wait for an ACK
		}
		if o.fh == nil {
			fh, err := os.Open(o.paths[o.idx])
			if err != nil {
				d.fail("read " + o.paths[o.idx] + ": " + err.Error())
				return d.do(d.s.CancelOutgoing())
			}
			o.fh = fh
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(o.fh, buf); err != nil {
			d.fail("read " + o.paths[o.idx] + ": " + err.Error())
			return d.do(d.s.CancelOutgoing())
		}
		effs, err := d.s.SendChunk(buf)
		if errors.Is(err, linksession.ErrWindowFull) {
			return errors.New("link-dev: window accounting disagrees with the session")
		}
		if aerr := d.do(effs, err); aerr != nil {
			return aerr
		}
		if err != nil {
			// The chunk was read but not sealed: continuing would send the NEXT
			// chunk in its place. Withdraw the batch instead (BATCH_ABORT).
			d.fail("chunk: " + err.Error())
			o.sending = false
			return d.do(d.s.CancelOutgoing())
		}
		o.off += n
		d.sentBytes += n
		if d.ui != nil && o.off < f.Size {
			d.ui.sendProgress(o.shown(o.idx), o.off, f.Size)
		}
	}
	return nil
}

func (d *linkDevDriver) pumpTexts() error {
	if len(d.texts) == 0 {
		return nil
	}
	_, ts := d.laneStates()
	switch ts {
	case "Idle":
		if !d.textAsked {
			d.textAsked = true
			return d.do(d.s.RequestText())
		}
	case "Open":
		d.textAsked = false
		if now := time.Now(); now.Before(d.nextTextAt) {
			return nil
		}
		body := d.texts[0]
		buffered := d.writers[linkrtc.LaneText].queued()
		if n, err := d.conn.Unacknowledged(linkrtc.LaneText); err == nil {
			buffered += int(n)
		}
		effs, err := d.s.SendText([]byte(body), buffered)
		if errors.Is(err, linksession.ErrTextBackpressure) {
			d.nextTextAt = time.Now().Add(linkDevTextGap)
			return d.do(effs, nil)
		}
		if aerr := d.do(effs, err); aerr != nil {
			return aerr
		}
		d.texts = d.texts[1:]
		if err != nil {
			d.fail("text not sent: " + err.Error())
			return nil
		}
		d.sentBytes += uint64(len(body))
		d.nextTextAt = time.Now().Add(linkDevTextGap)
	case "Failed":
		d.fail(fmt.Sprintf("%d message(s) not sent: the text lane failed", len(d.texts)))
		d.texts = nil
	default:
		d.textAsked = false // WaitAccept, Incoming, EndWait: the lane will move
	}
	return nil
}

// linkDevDrainCap bounds the wait for the peer's acknowledgement of our last
// lane bytes. A peer whose transport stopped acknowledging is gone; the
// link's own loss detection normally ends it well before this.
const linkDevDrainCap = 30 * time.Second

// quitStep finishes after the script, in order:
//
//  1. everything offered is delivered and every message sealed;
//  2. an open conversation is ended and its END acknowledged;
//  3. if we never wrote anything, a text-lane probe the peer must answer, so
//     a leave never outruns a peer still establishing;
//  4. every lane writer is empty and the peer's SCTP stack has acknowledged
//     every byte of BOTH lanes — per stream, so this covers the file lane's
//     COMPLETE, which a text-lane round trip cannot;
//
// and only then the authenticated leave.
func (d *linkDevDriver) quitStep() error {
	d.draining = false
	if !d.scriptEOF || len(d.script) > 0 || d.holding {
		return nil
	}
	if !d.outboundIdle() {
		return nil
	}
	if d.stayAfterEOF {
		return nil // `pair` without a terminal: the peer's leave ends the session
	}
	d.quitting = true
	_, ts := d.laneStates()
	if d.textDone {
		if wait, err := d.textQuitStep(ts); wait || err != nil {
			return err
		}
		ts = "" // said and heard: go on to the acknowledgement wait
	}
	switch ts {
	case "WaitAccept":
		if d.probe {
			return nil // the peer has not answered the probe yet
		}
		return d.do(d.s.EndText())
	case "Open":
		return d.do(d.s.EndText())
	case "EndWait", "Incoming":
		return nil // the acknowledgement (or the peer's END) is on its way
	case "Idle":
		d.probe = false
		if d.outSeq == 0 && !d.probed {
			d.probed, d.probe = true, true
			return d.do(d.s.RequestText())
		}
	}
	if !d.lanesAcknowledged() {
		if d.drainSince.IsZero() {
			d.drainSince = time.Now()
		}
		if time.Since(d.drainSince) < linkDevDrainCap {
			d.draining = true
			return nil
		}
		d.fail("the peer did not acknowledge our last frames; leaving anyway")
	}
	d.logf("script done: leaving")
	return d.do(d.s.Close())
}

// textQuitStep is product `text`'s end of input over link. There is no
// half-close on a link, and an END would make the peer discard (drain) any
// message it is sending at that moment. So "I have nothing more to say" is an
// EMPTY message, sent in order on the text lane after our last one: the peer
// reads every message we sent before it, and nothing it sends is lost. We
// leave once the peer has said the same (or leave at once if it already has:
// our leave is then our "done"). Today's piped `text` likewise reads the
// peer's replies until the peer hangs up.
//
// Only another relayium CLI understands the marker (its roster entry carries
// the link/1 hint, which no app sends today). With an app we say nothing and
// wait for it to leave, the session ceiling, or ctrl-C. It reports whether to
// keep waiting.
func (d *linkDevDriver) textQuitStep(ts string) (bool, error) {
	if d.peerDone {
		return false, nil
	}
	if d.ui == nil || !d.ui.peerHint {
		if !d.saidDone {
			d.saidDone = true
			d.notice("done sending; waiting for the other side to finish (Ctrl-C leaves now)")
		}
		return true, nil
	}
	if d.saidDone {
		return true, nil
	}
	switch ts {
	case "Open":
		d.textAsked = false
		if time.Now().Before(d.nextTextAt) {
			return true, nil
		}
		buffered := d.writers[linkrtc.LaneText].queued()
		if n, err := d.conn.Unacknowledged(linkrtc.LaneText); err == nil {
			buffered += int(n)
		}
		effs, err := d.s.SendText(nil, buffered)
		if errors.Is(err, linksession.ErrTextBackpressure) {
			d.nextTextAt = time.Now().Add(linkDevTextGap)
			return true, d.do(effs, nil)
		}
		if err == nil {
			d.saidDone = true
		}
		return true, d.do(effs, err)
	case "Idle":
		if !d.textAsked {
			d.textAsked = true
			return true, d.do(d.s.RequestText())
		}
		return true, nil
	case "Failed":
		return false, nil // nothing more can be said; leave
	}
	d.textAsked = false
	return true, nil // WaitAccept, Incoming, EndWait: the lane will move
}

// lanesAcknowledged: nothing waits in a lane writer and the peer's SCTP stack
// acknowledged every byte written on either lane.
func (d *linkDevDriver) lanesAcknowledged() bool {
	if d.conn == nil {
		return true
	}
	select {
	case <-d.cut.done:
		return true // the transport is gone: nothing more can be acknowledged
	default:
	}
	for _, lane := range []linkrtc.Lane{linkrtc.LaneFile, linkrtc.LaneText} {
		if w := d.writers[lane]; w != nil && w.queued() > 0 {
			return false
		}
		n, err := d.conn.Unacknowledged(lane)
		if err == nil && n > 0 {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------- inbound files

// openSink creates every file of an accepted batch BEFORE the ACCEPT that
// follows this effect — in the batch's private staging directory
// (linkSink, pair.go). Nothing reaches its final name before the whole batch
// is verified and durable (installBatch).
func (d *linkDevDriver) openSink(prompt uint64, files []linkwire.FileMeta) error {
	k := &ldSink{prompt: prompt, wrote: make([]uint64, len(files)), finalized: make([]bool, len(files)),
		verified: make([]bool, len(files))}
	d.sinks[prompt] = k
	out, err := openLinkSink(d.dest, files)
	if err != nil {
		var oe *sinkOpenError
		if errors.As(err, &oe) {
			k.initCleanup = oe.cleanup
			return oe.cause
		}
		return err
	}
	k.out = out
	d.logf("receiving %d file(s) into %s", len(files), d.dest)
	if d.ui != nil {
		d.ui.receiving(d, out)
	}
	var total uint64
	for i, f := range files {
		total += f.Size
		if f.Size == 0 {
			// An empty file is complete now; sync and close it, checked.
			if err := d.syncStaged(k, i); err != nil {
				return err
			}
		}
	}
	if total == 0 {
		// No byte can be held back to gate COMPLETE, so a batch of empty
		// files is installed now, before the ACCEPT; a later cancel takes
		// back exactly what this installed.
		return d.installBatch(k)
	}
	return nil
}

func (d *linkDevDriver) writeChunk(prompt uint64, idx int, b []byte) {
	k := d.sinks[prompt]
	if k == nil || k.out == nil || idx >= len(k.out.files) || k.out.files[idx] == nil {
		d.fail("chunk for a file that is not open")
		d.defer_(d.s.CancelIncoming)
		return
	}
	if _, err := k.out.files[idx].Write(b); err != nil {
		d.fail("write " + k.out.show(idx) + ": " + err.Error())
		d.defer_(d.s.CancelIncoming)
		return
	}
	k.written += uint64(len(b))
	k.wrote[idx] += uint64(len(b))
	d.recvBytes += uint64(len(b))
	if d.ui != nil && k.wrote[idx] < k.out.sizes[idx] {
		d.ui.recvProgress(k.out.rels[idx], k.wrote[idx], k.out.sizes[idx])
	}
	d.reportDurable(k)
}

// reportDurable tells the session the durable total (see ldSink), when it moved.
func (d *linkDevDriver) reportDurable(k *ldSink) {
	total := k.durable()
	if total <= k.reported {
		return
	}
	k.reported = total
	d.defer_(func() ([]linksession.Effect, error) { return d.s.FileDurable(d.s.Epoch(), total) })
}

// finalizeFile runs when the session verified file idx's chain: sync and
// close it, checked; once every file of the batch is verified, install the
// batch. Only a successful install releases the held-back bytes, and with
// them the batch's COMPLETE. A failure withdraws the batch (REJECT, discard):
// the peer is told it was not saved, never that it was.
func (d *linkDevDriver) finalizeFile(prompt uint64, idx int) {
	k := d.sinks[prompt]
	if k == nil || k.out == nil || idx >= len(k.out.files) || k.verified[idx] {
		return
	}
	if k.out.files[idx] != nil {
		if err := d.syncStaged(k, idx); err != nil {
			d.fail("save " + k.out.show(idx) + ": " + err.Error())
			d.defer_(d.s.CancelIncoming)
			return
		}
	}
	k.verified[idx] = true
	for _, v := range k.verified {
		if !v {
			return
		}
	}
	if err := d.installBatch(k); err != nil {
		d.fail("save into " + termSafe(k.out.absDest) + ": " + err.Error())
		d.defer_(d.s.CancelIncoming)
		return
	}
	d.reportDurable(k)
}

// syncStaged syncs and closes staged file idx.
func (d *linkDevDriver) syncStaged(k *ldSink, idx int) error {
	fh := k.out.files[idx]
	k.out.files[idx] = nil
	if fh == nil {
		return errors.New("the file is not open")
	}
	return d.finalize(fh, k.out.path(idx))
}

// installBatch gives the batch its final names; only then is it "finalized"
// (its held-back bytes released).
func (d *linkDevDriver) installBatch(k *ldSink) error {
	if k.out.done {
		return nil
	}
	if err := k.out.install(); err != nil {
		return err
	}
	for i := range k.finalized {
		k.finalized[i] = true
		if d.ui != nil {
			d.ui.recvFileDone(k.out.rels[i], k.out.sizes[i])
		}
	}
	return nil
}

// finalize syncs and closes one received file; any error is a failed save.
func (d *linkDevDriver) finalize(fh *os.File, name string) error {
	if ldHookFinalize != nil {
		if err := ldHookFinalize(d, name); err != nil {
			_ = fh.Close()
			return err
		}
	}
	if err := fh.Sync(); err != nil {
		_ = fh.Close()
		return err
	}
	return fh.Close()
}

// closeSink releases a batch's handles and keeps its files (saved, or not
// yet discarded).
func (d *linkDevDriver) closeSink(prompt uint64) {
	k := d.sinks[prompt]
	if k == nil {
		return
	}
	delete(d.sinks, prompt)
	err := k.initCleanup
	if k.out != nil {
		err = errors.Join(err, k.out.close())
	}
	if err != nil {
		d.fail("an incomplete batch could not be fully removed: " + err.Error())
	}
}

// retireSaved closes every sink whose batch is installed, so a long session
// of many folder batches does not keep every directory handle open.
func (d *linkDevDriver) retireSaved() {
	for p, k := range d.sinks {
		if k.out != nil && k.out.done {
			d.closeSink(p)
		}
	}
}

// discardSink deletes exactly what this batch created: its files, then its
// directories if they are empty. Never a pre-existing file.
func (d *linkDevDriver) discardSink(prompt uint64) {
	k := d.sinks[prompt]
	if k == nil {
		return
	}
	err := k.initCleanup // a setup that failed partway was cleaned up then
	if k.out != nil {
		err = errors.Join(err, k.out.discard())
	}
	delete(d.sinks, prompt)
	d.logf("discarded a partial batch")
	if err != nil {
		d.record("an incomplete batch could not be fully removed: " + err.Error())
	}
	if d.ui != nil {
		d.ui.discarded(d, err)
	}
}

// ---------------------------------------------------------------- outcome

func (d *linkDevDriver) exitCode(stderr io.Writer) int {
	if d.ui != nil {
		return d.ui.exitCode(d)
	}
	fmt.Fprintf(stderr, "link-dev: moved sent=%d received=%d (payload bytes) batches sent=%d received=%d texts received=%d\n",
		d.sentBytes, d.recvBytes, d.sentOK, d.recvOK, d.textsIn)
	complete := d.scriptEOF && len(d.script) == 0 && d.outboundIdle() && !d.holding
	if len(d.failures) == 0 && complete {
		return 0
	}
	if !complete {
		fmt.Fprintf(stderr, "link-dev: the link ended (%s) before the script finished\n", d.closeCode)
	}
	return 1
}
