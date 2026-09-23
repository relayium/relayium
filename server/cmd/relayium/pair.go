package main

// `relayium pair` (A10) and the product front end of every link session.
//
//   relayium pair          mint a code (requires login), print it, wait
//   relayium pair <code>   join a code minted anywhere: a CLI, an app, the web
//
// Once the two ends are linked (link/1: one end-to-end encrypted link with a
// file lane and a text lane), the session carries files, folders and messages
// in both directions, repeatedly, until either side leaves.
//
// `send`, `receive` and `text` reach the same session when discovery chooses
// link/1 (a new CLI or an app on the other end, on a server that supports
// pairing hints); against an older CLI they keep today's wire byte for byte
// (crossnetLegacy). The front end below renders both the same way.
//
// # Output contract
//
//   - stdout carries only what the peer said: message bodies. Everything else
//     — the code hand-off, the SAS, status, prompts, progress, errors — goes
//     to stderr.
//   - On a terminal every line of a peer's message is printed as
//     "peer> <line>", with control, line-separator and bidi characters made
//     visible or removed. A line that starts at column 0 with the verification
//     code prefix can therefore only be the real one. Off a terminal, stdout
//     gets the bytes themselves (one message per line for `pair`).
//   - Every peer-supplied file name is shown with bidi controls and C0/C1
//     removed (linkwire strips them) and any remaining control made visible.
//
// # Exit status
//
//	0    the session ended normally (our /quit or end of input, or the peer
//	     leaving) and everything we sent was delivered and everything we
//	     accepted was saved
//	1    something did not complete: a batch not delivered or not saved, a
//	     message not sent, the link lost or never established
//	2    usage
//	130  interrupted (ctrl-C): an authenticated leave was sent; whatever was
//	     in flight is reported as not delivered / not saved, never as saved

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	ossignal "os/signal"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/relayium/relayium/internal/linkrtc"
	"github.com/relayium/relayium/internal/linksession"
	"github.com/relayium/relayium/internal/linkwire"
	"github.com/relayium/relayium/internal/rzvous"
	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/termtext"
)

// sasLinePrefix starts the one verification line, at column 0, on stderr.
// Nothing a peer controls is ever printed at column 0 with this prefix.
const sasLinePrefix = "verification code (SAS): "

// linkDebug turns the developer trace of a product link session back on.
var linkDebug = os.Getenv("RELAYIUM_LINK_DEBUG") == "1"

// pairJoinWait bounds joining the room and discovery for every command that
// can link; the link itself is bounded by the session's own timers (idle,
// stalls, relay deadline), not by a wall clock.
const pairJoinWait = 10 * time.Minute

// pairRoomName is the name this CLI shows in the room's roster (an app shows
// it as the other device's name).
const pairRoomName = "relayium-cli"

// Seams: a test runs the real CLI as a process and may force a terminal.
var (
	pairStdin      = func() io.Reader { return osStdin() }
	pairStdinIsTTY = func() bool { return isTerminalFile(osStdin()) }
	stdoutIsTTY    = func(w io.Writer) bool { return isTTY(w) }
)

type pairFlags struct {
	server    string
	advertise string
	dest      string
	verify    bool
	accept    bool
}

func pairFlagSet(f *pairFlags) *flag.FlagSet {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	fs.StringVar(&f.server, "server", defaultServer, "Relayium server base URL (self-host)")
	fs.StringVar(&f.advertise, "advertise", "", "host:port whose IP address to offer as a direct candidate")
	fs.StringVar(&f.dest, "dest", ".", "directory accepted files are saved into")
	fs.BoolVar(&f.verify, "verify", false, "require SAS confirmation before anything is accepted or sent")
	fs.BoolVar(&f.accept, "accept", false, "accept every incoming batch without asking")
	return fs
}

// mintForPair mints for a pairing session: the other end joins with the same
// command, or types the code into an app or the web page.
var mintForPair = mintPurpose{
	join: func(code string) string {
		return "relayium pair " + code + "   (or type the code in the Relayium app or web page)"
	},
	waiting: "waiting for the other side to join…",
	loggedOut: func(login string) string {
		return fmt.Sprintf(
			"minting a pairing code needs an account (only the side that mints signs in; the other never does)\n"+
				"  run `%s` first, or join a code you were given:  relayium pair <code>",
			login)
	},
}

func runPair(args []string, stdout, stderr io.Writer) int {
	if wantsHelpFS(pairFlagSet(&pairFlags{}), args) {
		fmt.Fprint(stdout, pairUsage)
		return 0
	}
	var f pairFlags
	fs := pairFlagSet(&f)
	if err := parseArgs(fs, args); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	rest := fs.Args()
	if len(rest) > 1 {
		fmt.Fprintf(stderr, "relayium pair takes one code, got %d arguments: %q\n", len(rest), rest)
		return 2
	}
	var code string
	if len(rest) == 1 {
		code = rest[0]
		if !signal.ValidCodeFormat(code) {
			fmt.Fprintf(stderr,
				"pairing code %q is not a valid code: codes are %s, and are issued by the server — one cannot be made up\n",
				code, signal.CodeFormatNote())
			return 2
		}
	}
	tty := pairStdinIsTTY()
	if f.verify && !tty {
		fmt.Fprintln(stderr, "--verify was requested but stdin is not a terminal, so there is nobody to prompt.")
		fmt.Fprintln(stderr, "Drop --verify to run without the SAS comparison, or run it from a terminal.")
		return 2
	}
	if f.dest == "" {
		fmt.Fprintln(stderr, "--dest needs a directory")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), pairJoinWait)
	defer cancel()
	if code == "" {
		var err error
		if code, err = mintCode(ctx, f.server, stderr, mintForPair); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	} else {
		fmt.Fprintf(stderr, "joining pairing code %s…\n", code)
	}
	cf := crossFlags{server: f.server, advertise: f.advertise, verify: f.verify}
	h, err := crossnetDial(ctx, code, pairRoomName, cf, stderr, linksession.CmdPair, "")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	lh, ok := h.(*linkHandle)
	if !ok { // unreachable: pair never takes the legacy wire (class DCPair)
		h.Close()
		fmt.Fprintln(stderr, "internal error: pair reached the legacy handshake")
		return 1
	}
	d := lh.d
	d.dest = f.dest
	d.in = pairStdin()
	d.stayAfterEOF = !tty
	u := d.ui
	u.stdout = stdout
	u.accept = f.accept
	u.inTTY = tty
	u.readsInput = true
	u.outTTY = stdoutIsTTY(stdout)
	return lh.drive()
}

// ================================================================ discovery dial

// crossnetDial joins the code room with the link/1 hint and lets discovery
// choose the wire (A08-DESIGN §3). It returns either
//
//   - a *tls.Conn: the legacy pairing, byte-identical to every released CLI
//     (the peer is an older CLI, or the server predates pairing hints); or
//   - a *linkHandle positioned right after discovery bound link/1, whose
//     caller installs its plan and calls drive.
//
// A discovery that ends (an older CLI facing `pair`, an app on a server
// without hints, a peer that never spoke) is an error in plain words.
func crossnetDial(ctx context.Context, code, name string, f crossFlags, stderr io.Writer, cmd linksession.Cmd, mode string) (io.ReadWriteCloser, error) {
	room, err := rzvous.JoinRoom(ctx, f.server, code, name, []string{rzvous.ProtoLink})
	if err != nil {
		return nil, err
	}
	// The link is not bounded by the join's wall clock: a large transfer may
	// take longer than it. The session's own timers bound it instead.
	lctx, lcancel := context.WithCancel(context.Background())
	d, err := newLinkDevDriver(lctx, cmd, room, f, linkDevOpts{}, code, ".", io.Discard, stderr)
	if err != nil {
		lcancel()
		room.Session.Close()
		return nil, err
	}
	d.ui = &linkUI{cmd: cmd, stdout: io.Discard, stderr: stderr, peerHint: room.PeerHint}
	d.stopAtLink = true
	// Discovery is bounded by the session (a first frame within 30 s of the
	// room view); JoinRoom above was bounded by ctx.
	res, err := d.run()
	if err != nil {
		d.shutdown()
		lcancel()
		return nil, err
	}
	if res.legacy {
		// Today's handshake on the room discovery joined. Nothing of the link
		// was started (no /api/ice request, no transport).
		d.cut.fire("legacy")
		lcancel()
		conn, err := crossnetLegacy(ctx, room.Session, res.first, f, stderr, mode)
		room.Session.Close()
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
	if !res.link {
		d.shutdown()
		lcancel()
		return nil, errors.New(linkEndCopy(res.ended, cmd))
	}
	return &linkHandle{d: d, cancel: lcancel}, nil
}

// linkEndCopy is what a discovery that ended tells the user.
func linkEndCopy(code string, cmd linksession.Cmd) string {
	switch code {
	case "peer-is-older-cli":
		return "the other side runs an older relayium CLI that cannot use `relayium pair`; it was told so and has stopped\n" +
			"  update it (`relayium update`), or use `relayium send`/`relayium receive` or `relayium text` on both ends"
	case "peer-app-cannot-link":
		return "the other side is a Relayium app or web page that cannot use link pairing (an older version, or link mode is off)\n" +
			"  update the app, or turn link mode on there, and pair again"
	case "peer-app-too-old":
		return "the other side is a Relayium app or web page too old to pair with the CLI — update it and pair again"
	case "peer-used-legacy-after-our-hello":
		if cmd == linksession.CmdPair {
			return "the other side answered with the older CLI handshake: it is an older relayium, or `send`/`receive`/`text` on a server that predates pairing hints\n" +
				"  run `relayium pair <code>` on both ends with a current relayium, or ask the server's operator to update it"
		}
		return "the other side started link pairing but then used the older CLI handshake; start both ends again"
	case "peer-never-spoke":
		return "the other side joined but never answered (it may have been stopped); start both ends again"
	case "no-peer-joined":
		return "nobody joined with this code in time; start again and share a fresh code"
	case "capture-overflow", "protocol-violation":
		return "the other side sent messages this pairing does not allow; the attempt was ended"
	}
	return "pairing ended before a link was set up (" + termSafe(code) + ")"
}

// linkHandle is a link that discovery bound; drive runs it to its end. It is
// an io.ReadWriteCloser only so it can travel through the dial seams that
// return today's connection; reading or writing it is an error.
type linkHandle struct {
	d      *linkDevDriver
	cancel context.CancelFunc
}

var errLinkHandle = errors.New("a link session is driven, not read or written")

func (h *linkHandle) Read([]byte) (int, error)  { return 0, errLinkHandle }
func (h *linkHandle) Write([]byte) (int, error) { return 0, errLinkHandle }
func (h *linkHandle) Close() error {
	h.d.shutdown()
	h.cancel()
	return nil
}

// linkInterrupts delivers ctrl-C (and SIGTERM) while a link runs. A seam so a
// test can interrupt an in-process session.
var linkInterrupts = func() (<-chan os.Signal, func()) {
	ch := make(chan os.Signal, 2)
	ossignal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	return ch, func() { ossignal.Stop(ch) }
}

// drive runs the link to its end and returns the exit status. The first
// ctrl-C is an authenticated leave; a second one exits at once.
func (h *linkHandle) drive() int {
	d := h.d
	sigs, stop := linkInterrupts()
	done := make(chan struct{})
	go func() {
		n := 0
		for {
			select {
			case <-sigs:
				n++
				if n == 1 {
					d.q.push(ldItem{kind: ldInterrupt})
					continue
				}
				fmt.Fprintln(d.stderr, "interrupted again: exiting at once — what was in flight was not delivered or saved, and a partial file may be left behind")
				os.Exit(130)
			case <-done:
				return
			}
		}
	}()
	_, err := d.run()
	close(done)
	stop()
	d.shutdown()
	h.cancel()
	if err != nil {
		d.ui.problem(err.Error())
		if d.interrupted {
			return 130
		}
		return 1
	}
	return d.exitCode(d.stderr)
}

// ================================================================ front end

type earlyPrompt struct {
	prompt uint64
	files  []linkwire.FileMeta
}

// linkUI is the product front end of one link session. Every method runs on
// the session loop's goroutine, so it needs no locking.
type linkUI struct {
	cmd            linksession.Cmd
	stdout, stderr io.Writer

	outTTY     bool // stdout is a terminal: peer text rendered safely, prefixed
	exact      bool // `text` piped to a non-terminal: bodies byte for byte, no separator
	inTTY      bool // stdin is a terminal
	readsInput bool // the session reads commands/messages from input once admitted
	textPiped  bool // `text`: input is one exact message, not one per line
	accept     bool // `pair --accept`
	peerHint   bool // the peer's roster entry announced link/1

	prompt   uint64        // the file prompt awaiting /accept or /decline (0: none)
	early    []earlyPrompt // prompts that arrived before admission
	recvDest string
	recvDone int // inbound batches concluded, saved or not
	sendProg *transferProgress
	recvProg *transferProgress
	ending   bool
}

func (u *linkUI) line(format string, a ...any) {
	u.finishBars()
	fmt.Fprintf(u.stderr, format+"\n", a...)
}

func (u *linkUI) problem(what string) { u.line("%s", termSafe(what)) }

func (u *linkUI) finishBars() {
	if u.sendProg != nil {
		u.sendProg.finish()
	}
	if u.recvProg != nil {
		u.recvProg.finish()
	}
}

// connected runs when the link is keyed, just before the SAS line.
func (u *linkUI) connected(d *linkDevDriver) {
	peer := "a Relayium app or the web page"
	if u.peerHint {
		peer = "another relayium CLI"
	}
	role := "responder"
	if d.conn != nil && d.conn.Role() == linkrtc.Initiator {
		role = "initiator"
	}
	u.line("linked with %s (end-to-end encrypted link/1, %s)", peer, role)
}

func (u *linkUI) admitted(d *linkDevDriver) {
	defer func() {
		early := u.early
		u.early = nil
		for _, p := range early {
			u.promptFiles(d, p.prompt, p.files)
		}
	}()
	switch u.cmd {
	case linksession.CmdPair:
		dest := d.dest
		if abs, err := filepath.Abs(dest); err == nil {
			dest = abs
		}
		u.line("connected. Type a message and press Enter to send it.")
		u.line("  /send <path>...   send files or folders       /accept, /decline   answer incoming files (saved into %s)", termSafe(dest))
		u.line("  /quit             leave (after what is queued) Ctrl-C             leave now")
		if !u.inTTY {
			u.line("  (stdin is not a terminal: end of input does not end the session; /quit or the other side leaving does)")
		}
	case linksession.CmdText:
		if !u.textPiped {
			u.line("connected — one line per message, Ctrl-D to end. For multiline or exact bytes, pipe it instead: `… | relayium text <code>`")
		}
	case linksession.CmdReceive:
		u.line("connected — waiting for the files")
	}
}

// path is the selected candidate pair, as it changes. It says what the bytes
// actually take, never what was merely offered.
func (u *linkUI) path(p linkrtc.PathInfo) {
	switch p.Path {
	case linkrtc.PathRelay:
		u.line("path: relay — through a TURN relay, which carries only ciphertext it cannot read")
	case linkrtc.PathDirect:
		u.line("path: direct — peer to peer, no relay")
	case linkrtc.PathLAN:
		u.line("path: lan — directly on the local network")
	default:
		u.line("path: %s", p.Path)
	}
}

// ---------------------------------------------------------------- input

// feed reads the person's input once the link is admitted and turns it into
// session inputs. It runs on its own goroutine and only ever pushes items.
func (u *linkUI) feed(d *linkDevDriver, r io.Reader) {
	switch u.cmd {
	case linksession.CmdPair:
		feedPairInput(d, r)
	case linksession.CmdText:
		if u.textPiped {
			body, err := io.ReadAll(io.LimitReader(r, linkwire.TextMaxBytes+1))
			switch {
			case err != nil:
				inputFailed(d, err)
			case len(body) > linkwire.TextMaxBytes:
				d.q.push(ldItem{kind: ldItemScript, cmds: []ldCmd{{op: "note", text: tooLongNote(len(body)), n: 1}}})
			case len(body) > 0:
				d.q.push(ldItem{kind: ldItemScript, cmds: []ldCmd{{op: "text", text: string(body)}}})
			}
			d.q.push(ldItem{kind: ldScriptEOF})
			return
		}
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 4096), linkwire.TextMaxBytes+2)
		for sc.Scan() {
			line := sc.Text()
			switch {
			case len(line) > linkwire.TextMaxBytes:
				d.q.push(ldItem{kind: ldItemScript, cmds: []ldCmd{{op: "note", text: tooLongNote(len(line))}}})
			case line != "":
				d.q.push(ldItem{kind: ldItemScript, cmds: []ldCmd{{op: "text", text: line}}})
			}
		}
		inputFailed(d, sc.Err())
		d.q.push(ldItem{kind: ldScriptEOF})
	}
}

// inputFailed reports input that could not be read — a line over the bound,
// a read error — as a failure of the run (ldInputFailed, A09b round 3): the
// lines after it were never sent. A stop by shutdown is not a failure.
func inputFailed(d *linkDevDriver, err error) {
	if err == nil || d.inputStopped() || errors.Is(err, errInputStopped) {
		return
	}
	if errors.Is(err, bufio.ErrTooLong) {
		err = fmt.Errorf("%s (%w)", tooLongNote(linkwire.TextMaxBytes+2), err)
	}
	d.q.push(ldItem{kind: ldInputFailed, err: err})
}

// feedPairInput: one line is one message, unless it is a command.
func feedPairInput(d *linkDevDriver, r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), linkwire.TextMaxBytes+2)
	push := func(c ldCmd) { d.q.push(ldItem{kind: ldItemScript, cmds: []ldCmd{c}}) }
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.HasPrefix(line, "//") { // "//x" sends the message "/x"
			push(ldCmd{op: "text", text: line[1:]})
			continue
		}
		if !strings.HasPrefix(line, "/") {
			push(ldCmd{op: "text", text: line})
			continue
		}
		verb, rest, _ := strings.Cut(strings.TrimSpace(line), " ")
		switch verb {
		case "/send":
			srcs, err := splitPairPaths(rest)
			switch {
			case err != nil:
				push(ldCmd{op: "note", text: "/send: " + err.Error()})
			case len(srcs) == 0:
				push(ldCmd{op: "note", text: "/send needs at least one path"})
			default:
				push(ldCmd{op: "send", srcs: srcs})
			}
		case "/accept", "/yes":
			d.q.push(ldItem{kind: ldAnswer, ok: true})
		case "/decline", "/reject", "/no":
			d.q.push(ldItem{kind: ldAnswer, ok: false})
		case "/quit", "/leave", "/exit":
			push(ldCmd{op: "quit"})
			return // nothing after /quit is read
		case "/help":
			push(ldCmd{op: "help"})
		default:
			push(ldCmd{op: "note", text: "unknown command " + termSafe(verb) + " — /help lists them; start a message with // to send a leading /"})
		}
	}
	inputFailed(d, sc.Err())
	d.q.push(ldItem{kind: ldScriptEOF})
}

// splitPairPaths splits "/send" arguments like a shell would for the simple
// cases: whitespace separates, '…' and "…" quote, a backslash escapes.
func splitPairPaths(s string) ([]string, error) {
	var out []string
	var cur strings.Builder
	in, quote, esc := false, rune(0), false
	for _, r := range s {
		switch {
		case esc:
			cur.WriteRune(r)
			esc, in = false, true
		case r == '\\' && quote != '\'':
			esc = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote, in = r, true
		case unicode.IsSpace(r):
			if in {
				out = append(out, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteRune(r)
			in = true
		}
	}
	if quote != 0 || esc {
		return nil, errors.New("unterminated quote or escape")
	}
	if in {
		out = append(out, cur.String())
	}
	return out, nil
}

// scriptOp handles the front end's own script operations.
func (u *linkUI) scriptOp(d *linkDevDriver, c ldCmd) {
	switch c.op {
	case "help":
		u.admitted(d)
	case "note":
		u.problem(c.text)
		if c.n == 1 { // a note that means a message was not sent
			d.record("message not sent")
		}
	}
}

// poll runs every loop turn once admitted.
func (u *linkUI) poll(d *linkDevDriver) {
	// Nobody can answer a prompt once input ended: decline rather than keep
	// the sender waiting out the ten-minute window.
	if u.prompt != 0 && d.scriptEOF && !u.accept {
		p := u.prompt
		u.prompt = 0
		u.line("declining the incoming files: input has ended, so nobody can answer (--accept accepts every batch)")
		d.defer_(func() ([]linksession.Effect, error) { return d.s.RejectFiles(p) })
		_ = d.do(nil, nil)
	}
}

// ---------------------------------------------------------------- inbound files

func (u *linkUI) promptFiles(d *linkDevDriver, prompt uint64, files []linkwire.FileMeta) {
	if !d.admitted {
		// Offered while --verify still waits for the person: nothing may be
		// accepted before admission (the session refuses it anyway), so the
		// question is asked — or --accept applied — only once admitted. A
		// refused SAS rejects it instead.
		u.early = append(u.early, earlyPrompt{prompt, files})
		return
	}
	var total uint64
	for _, f := range files {
		total += f.Size
	}
	u.line("incoming: %d file(s), %s", len(files), humanBytes(int64(total)))
	for i, f := range files {
		if i == 10 {
			u.line("  … and %d more", len(files)-10)
			break
		}
		name := f.Name
		if f.HasPath && f.Path != "" {
			name = f.Path
		}
		u.line("  - %s (%s)", displayName(name), humanBytes(int64(f.Size)))
	}
	switch {
	case u.accept:
		u.line("accepting (--accept)")
		d.defer_(func() ([]linksession.Effect, error) { return d.s.AcceptFiles(prompt) })
	case d.scriptEOF:
		u.line("declining: input has ended, so nobody can answer (--accept accepts every batch)")
		d.defer_(func() ([]linksession.Effect, error) { return d.s.RejectFiles(prompt) })
	default:
		u.prompt = prompt
		u.line("type /accept to save them, or /decline")
	}
}

func (u *linkUI) answer(d *linkDevDriver, ok bool) error {
	if u.prompt == 0 {
		u.line("there are no incoming files to answer")
		return nil
	}
	p := u.prompt
	u.prompt = 0
	if ok {
		return d.do(d.s.AcceptFiles(p))
	}
	u.line("declined")
	return d.do(d.s.RejectFiles(p))
}

func (u *linkUI) withdrawn(prompt uint64) {
	if u.prompt == prompt {
		u.prompt = 0
		u.line("the incoming files were withdrawn (the sender cancelled, or the 10-minute answer window passed)")
	}
}

func (u *linkUI) receiving(d *linkDevDriver, out *linkSink) {
	u.recvDest = out.absDest
	if u.recvProg == nil {
		u.recvProg = newRecvProgress(u.stderr)
	}
	u.line("receiving %d file(s) into %s", len(out.rels), termSafe(out.absDest))
}

func (u *linkUI) recvProgress(rel string, done, total uint64) {
	if u.recvProg != nil {
		u.recvProg.report(displayName(rel), int64(done), int64(total))
	}
}

// recvFileDone: the file is verified, synced and closed under dest.
func (u *linkUI) recvFileDone(rel string, size uint64) {
	if u.recvProg != nil {
		u.recvProg.report(displayName(rel), int64(size), int64(size))
	}
}

func (u *linkUI) discarded(d *linkDevDriver) {
	u.line("the partial files of that batch were removed; nothing from it was kept")
}

// ---------------------------------------------------------------- outbound files

func (u *linkUI) offered(d *linkDevDriver, o *ldOut) {
	var total uint64
	for _, f := range o.files {
		total += f.Size
	}
	u.line("offering %d file(s), %s — waiting for the other side to accept", len(o.files), humanBytes(int64(total)))
	if u.sendProg == nil {
		u.sendProg = newSendProgress(u.stderr)
	}
}

func (u *linkUI) sendProgress(p string, done, total uint64) {
	if u.sendProg != nil {
		u.sendProg.report(termSafe(p), int64(done), int64(total))
	}
}

func (u *linkUI) sendFileDone(p string, size uint64) {
	if u.sendProg != nil {
		u.sendProg.report(termSafe(p), int64(size), int64(size))
	}
}

// ---------------------------------------------------------------- text

// text prints one inbound message.
func (u *linkUI) text(body string) {
	u.finishBars()
	switch {
	case u.outTTY:
		for _, l := range strings.Split(body, "\n") {
			fmt.Fprintf(u.stdout, "peer> %s\n", peerTextSafe(l))
		}
	case u.exact:
		_, _ = io.WriteString(u.stdout, body)
	default:
		_, _ = io.WriteString(u.stdout, body+"\n")
	}
}

// ---------------------------------------------------------------- outcomes

// inboundEnd lists the file-lane reports that conclude an inbound batch.
var inboundEnd = map[string]bool{
	"saved(verified,durable)": true, "partial-not-saved": true, "sender-withdrew": true,
	"sender-cancelled": true, "integrity": true, "stalled": true, "drain-failed": true,
	"sender-never-withdrew": true,
}

func (u *linkUI) report(d *linkDevDriver, lane, code string) {
	switch lane {
	case "file":
		if inboundEnd[code] {
			u.recvDone++
		}
		switch code {
		case "delivered-and-verified":
			u.line("delivered: the other side verified and saved the files")
		case "saved(verified,durable)":
			u.line("saved: every file verified and written to disk in %s", termSafe(u.recvDest))
		case "declined":
			u.line("not sent: the other side declined the files")
		case "no-answer":
			u.line("not sent: the other side did not answer within 10 minutes")
		case "stopped-by-receiver":
			u.line("not delivered: the other side stopped the transfer")
		case "cancelled-partial-not-delivered", "batch-not-delivered", "partial-not-delivered":
			u.line("not delivered: the transfer ended before every file arrived")
		case "cancelled-after-all-sent(receiver-may-have-saved)":
			u.line("cancelled after every byte was sent — the other side may already have saved the files")
		case "delivery-unconfirmed", "no-completion", "send-stalled":
			u.line("not confirmed: the other side never confirmed it saved the files (they may or may not be there)")
		case "receiver-failed-to-save":
			u.line("not delivered: the other side could not save the files")
		case "complete-before-done":
			u.line("not delivered: the other side answered out of order")
		case "peer-busy(batch-not-sent)":
			u.line("not sent: the other side stayed busy with its own files")
		case "partial-not-saved":
			u.line("not saved: the transfer ended before every file arrived; nothing from it was kept")
		case "sender-withdrew", "sender-cancelled":
			u.line("not saved: the sender cancelled; nothing from it was kept")
		case "integrity":
			u.line("not saved: a file failed its integrity check; nothing from that batch was kept")
		case "stalled":
			u.line("not saved: the incoming transfer stalled; nothing from it was kept")
		default:
			u.line("file transfer: %s", termSafe(code))
		}
	case "text":
		switch {
		case strings.HasPrefix(code, "conversation-ended"):
		case code == "declined":
			if !d.probe {
				u.line("the other side declined the conversation")
			}
		case code == "session-limit":
			u.line("this conversation reached its message limit; later messages open a new one")
		default:
			u.line("messages: %s", termSafe(code))
		}
	case "link":
		switch code {
		case "peer-ended-session", "idle-closed", "relay-credential-ended":
		default:
			// Anything else ends the link abnormally (a refused SAS included):
			// the run did not complete, whatever the lanes say.
			d.record("link: " + code)
		}
		switch code {
		case "peer-ended-session":
			u.line("the other side ended the session")
		case "idle-closed":
			u.line("the session ended after 10 minutes without activity")
		case "relay-credential-ended":
			// the driver's own notice says it
		case "sas-rejected":
			u.line("verification codes not confirmed: the session was ended and nothing was accepted or sent")
		case "verify-timeout":
			u.line("the verification codes were not confirmed in time: the session was ended")
		case "connection-lost(no-recovery)":
			u.line("the connection to the other side was lost")
		default:
			u.line("the link ended: %s", termSafe(code))
		}
	}
}

func (u *linkUI) interrupting(d *linkDevDriver) {
	u.line("interrupted: leaving the session")
}

func (u *linkUI) ceiling(d *linkDevDriver) {
	u.line("the session reached its %s limit and was ended", textSessionTimeout)
}

// linkNormalEnds are the link end codes that are not, by themselves, a
// failure: our leave, the peer's, the idle bound, and the relay bound.
var linkNormalEnds = map[string]bool{
	"": true, "closed": true, "local-close": true, "peer-ended-session": true,
	"idle-closed": true, "relay-credential-ended": true,
}

func (u *linkUI) exitCode(d *linkDevDriver) int {
	u.finishBars()
	if n := len(d.texts); n > 0 {
		u.line("%d message(s) not sent: the session ended first", n)
		d.record("messages not sent")
	}
	if d.cur != nil || len(d.outQ) > 0 {
		u.line("%d batch(es) not sent: the session ended first", len(d.outQ)+btoi(d.cur != nil))
		d.record("batches not sent")
	}
	if d.interrupted {
		return 130
	}
	code := d.closeCode
	if code == "" {
		code = d.res.ended
	}
	ok := len(d.failures) == 0 && linkNormalEnds[code]
	switch u.cmd {
	case linksession.CmdSend:
		ok = ok && d.sentOK > 0
	case linksession.CmdReceive:
		if d.recvOK == 0 && len(d.failures) == 0 {
			u.line("nothing was received: the other side ended the session without sending files")
		}
		ok = ok && d.recvOK > 0
	}
	if ok {
		return 0
	}
	return 1
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ================================================================ rendering

// peerTextSafe renders one line of a peer's message for a terminal: bidi
// controls removed (they reorder what is shown around them), every other
// control and line separator made visible (termtext).
func peerTextSafe(s string) string { return termtext.Safe(stripBidi(s)) }

// displayName renders a peer-supplied file name or path (already stripped of
// bidi and C0/C1 by linkwire) for a terminal line.
func displayName(s string) string { return termSafe(linkwire.SanitizeDisplayName(s)) }

func isBidiControl(r rune) bool {
	switch {
	case r == 0x061c, r == 0x200e, r == 0x200f:
		return true
	case r >= 0x202a && r <= 0x202e:
		return true
	case r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

// stripBidi removes bidi controls and leaves every other byte as it was —
// invalid UTF-8 included, so termtext.Safe can still show it as \xNN
// (strings.Map would turn it into U+FFFD and hide it).
func stripBidi(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		r, w := utf8.DecodeRuneInString(s[i:])
		if !isBidiControl(r) {
			b.WriteString(s[i : i+w])
		}
		i += w
	}
	return b.String()
}

// ================================================================ receive sink

// linkSink is one accepted batch's files on disk (A08-DESIGN §6.2):
//
//   - every path is opened through an os.Root on the destination, so nothing
//     can be created outside it, whatever the peer named;
//   - no symbolic link is followed: an existing link anywhere on the way is a
//     refusal, and a leaf that exists in any form (a link included) is never
//     opened — the file gets a " (n)" name instead (O_EXCL, no clobber);
//   - every file and directory is recorded as ours when it is created, and a
//     discard removes exactly those (directories only when empty) — never a
//     file that was there before.
//
// Peer names are display values (linkwire strips bidi and C0/C1). Here each
// "/" or "\" segment is further cleaned for the filesystem: ".", ".." and
// empty segments are dropped, a leading or trailing space or dot trimmed, and
// on Windows the reserved characters replaced.
type linkSink struct {
	root    *os.Root
	absDest string
	rels    []string // root-relative, slash-separated, as created
	sizes   []uint64
	files   []*os.File
	dirs    []string // directories this batch created, in creation order
}

func openLinkSink(dest string, files []linkwire.FileMeta) (*linkSink, error) {
	abs, err := filepath.Abs(dest)
	if err != nil {
		return nil, err
	}
	// Like `receive`'s CreateDestDir: the user's own destination argument is
	// created when missing (an existing symlink to a directory is honoured —
	// the person chose it).
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("create destination directory: %w", err)
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return nil, err
	}
	k := &linkSink{root: root, absDest: abs}
	for i, f := range files {
		segs := sinkSegments(f, i)
		dir, err := k.mkdirs(segs[:len(segs)-1])
		if err != nil {
			k.discard()
			return nil, err
		}
		fh, rel, err := k.create(dir, segs[len(segs)-1])
		if err != nil {
			k.discard()
			return nil, err
		}
		k.files = append(k.files, fh)
		k.rels = append(k.rels, rel)
		k.sizes = append(k.sizes, f.Size)
	}
	return k, nil
}

// sinkSegments turns a peer's name/path into filesystem segments (never empty).
func sinkSegments(f linkwire.FileMeta, i int) []string {
	rel := f.Name
	if f.HasPath && f.Path != "" {
		rel = f.Path
	}
	var segs []string
	for _, s := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		s = linkwire.SanitizeDisplayName(s)
		s = strings.Map(func(r rune) rune {
			if r == 0 || isBidiControl(r) || unicode.IsControl(r) || r == ' ' || r == ' ' {
				return -1
			}
			if runtime.GOOS == "windows" && strings.ContainsRune(`<>:"|?*`, r) {
				return '_'
			}
			return r
		}, s)
		s = strings.Trim(s, " ")
		if runtime.GOOS == "windows" {
			s = strings.TrimRight(s, ". ")
		}
		if s == "" || s == "." || s == ".." {
			continue
		}
		segs = append(segs, s)
	}
	if len(segs) == 0 {
		segs = []string{fmt.Sprintf("file-%d", i+1)}
	}
	return segs
}

// mkdirs creates (or walks) the directories, refusing any symbolic link.
func (k *linkSink) mkdirs(segs []string) (string, error) {
	cur := ""
	for _, s := range segs {
		cur = path.Join(cur, s)
		fi, err := k.root.Lstat(cur)
		switch {
		case err == nil && fi.Mode()&fs.ModeSymlink != 0:
			return "", fmt.Errorf("refusing to write through the symbolic link %s in %s", termSafe(cur), termSafe(k.absDest))
		case err == nil && !fi.IsDir():
			return "", fmt.Errorf("%s in %s exists and is not a directory", termSafe(cur), termSafe(k.absDest))
		case err == nil:
			continue
		case !errors.Is(err, fs.ErrNotExist):
			return "", err
		}
		if err := k.root.Mkdir(cur, 0o755); err != nil {
			return "", err
		}
		k.dirs = append(k.dirs, cur)
	}
	return cur, nil
}

// create opens a new file named base (or "base (n).ext") in dir, O_EXCL.
func (k *linkSink) create(dir, base string) (*os.File, string, error) {
	ext := path.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" { // ".profile": the whole name is the stem
		stem, ext = base, ""
	}
	for n := 0; n < 1000; n++ {
		cand := base
		if n > 0 {
			cand = fmt.Sprintf("%s (%d)%s", stem, n, ext)
		}
		rel := path.Join(dir, cand)
		fh, err := k.root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return fh, rel, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, "", err
		}
	}
	return nil, "", fmt.Errorf("no free name for %s in %s", termSafe(base), termSafe(k.absDest))
}

// path is file i's location, for the finalize hook and messages.
func (k *linkSink) path(i int) string { return filepath.Join(k.absDest, filepath.FromSlash(k.rels[i])) }

func (k *linkSink) show(i int) string {
	if i < len(k.rels) {
		return termSafe(k.rels[i])
	}
	return "a file"
}

// close releases open handles; the files stay.
func (k *linkSink) close() {
	for i, fh := range k.files {
		if fh != nil {
			_ = fh.Close()
			k.files[i] = nil
		}
	}
	if k.root != nil {
		_ = k.root.Close()
		k.root = nil
	}
}

// discard removes exactly what this batch created.
func (k *linkSink) discard() {
	for i, fh := range k.files {
		if fh != nil {
			_ = fh.Close()
			k.files[i] = nil
		}
	}
	if k.root == nil {
		return
	}
	for _, rel := range k.rels {
		_ = k.root.Remove(rel)
	}
	for i := len(k.dirs) - 1; i >= 0; i-- {
		_ = k.root.Remove(k.dirs[i]) // fails, and is kept, when not empty
	}
	_ = k.root.Close()
	k.root = nil
}
