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
	"crypto/rand"
	"encoding/hex"
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
				// Refused whole and unsent: a lost message, so the run fails
				// (n: 1), as every other input loss does.
				d.q.push(ldItem{kind: ldItemScript, cmds: []ldCmd{{op: "note", text: tooLongNote(len(line)), n: 1}}})
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
		msg, isMsg := line, !strings.HasPrefix(line, "/")
		if strings.HasPrefix(line, "//") { // "//x" sends the message "/x"
			msg, isMsg = line[1:], true
		}
		if isMsg {
			if len(msg) > linkwire.TextMaxBytes {
				push(ldCmd{op: "note", text: tooLongNote(len(msg)), n: 1}) // unsent: the run fails
				continue
			}
			push(ldCmd{op: "text", text: msg})
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
// cases: whitespace separates, '…' and "…" quote, and — except on Windows — a
// backslash escapes.
//
// On Windows the backslash is the path separator, so it is kept literally, as
// cmd.exe and PowerShell keep it: `/send C:\Users\me\a.txt` names that file,
// and a path with spaces is quoted. Treating it as an escape there turned
// every native path into a name that does not exist (`C:Usersmea.txt`), found
// by the first A12 matrix run on a real Windows host.
func splitPairPaths(s string) ([]string, error) {
	return splitPairPathsWith(s, pairBackslashEscapes)
}

// pairBackslashEscapes: whether "/send" treats a backslash as an escape.
var pairBackslashEscapes = runtime.GOOS != "windows"

func splitPairPathsWith(s string, backslashEscapes bool) ([]string, error) {
	var out []string
	var cur strings.Builder
	in, quote, esc := false, rune(0), false
	for _, r := range s {
		switch {
		case esc:
			cur.WriteRune(r)
			esc, in = false, true
		case backslashEscapes && r == '\\' && quote != '\'':
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

func (u *linkUI) discarded(d *linkDevDriver, err error, leftDirs []string) {
	dirs := ""
	if len(leftDirs) > 0 {
		shown := make([]string, len(leftDirs))
		for i, p := range leftDirs {
			shown[i] = termSafe(p)
		}
		dirs = "; the folders created for it were left in place: " + strings.Join(shown, ", ")
	}
	switch {
	case err != nil:
		u.line("the incomplete batch could NOT be fully removed; these may still be on disk: %s%s", termSafe(err.Error()), dirs)
	case dirs != "":
		u.line("the partial files of that batch were removed%s", dirs)
	default:
		u.line("the partial files of that batch were removed; nothing from it was kept")
	}
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
//
// A write that fails or comes up short means the message was lost on our
// side; the error is returned and the caller fails the run (the legacy
// copyIncoming does the same).
func (u *linkUI) text(body string) error {
	u.finishBars()
	var out []string
	switch {
	case u.outTTY:
		for _, l := range strings.Split(body, "\n") {
			out = append(out, "peer> "+peerTextSafe(l)+"\n")
		}
	case u.exact:
		out = []string{body}
	default:
		out = []string{body + "\n"}
	}
	for _, s := range out {
		n, err := io.WriteString(u.stdout, s)
		if err == nil && n != len(s) {
			err = io.ErrShortWrite
		}
		if err != nil {
			return fmt.Errorf("a message from the other side could not be written to stdout, so it was lost: %w", err)
		}
	}
	return nil
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
			u.line("not saved: the transfer ended before every file arrived")
		case "sender-withdrew", "sender-cancelled":
			u.line("not saved: the sender cancelled")
		case "integrity":
			u.line("not saved: a file failed its integrity check")
		case "stalled":
			u.line("not saved: the incoming transfer stalled")
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

// linkSink is one accepted batch on disk (A08-DESIGN §6.2).
//
// Every filesystem operation is made RELATIVE TO A HELD DIRECTORY HANDLE and
// names a single path component, so no later rename or symbolic-link swap of
// a path on the way can redirect it:
//
//   - The destination is opened once (an os.Root). Each directory on the way
//     to a file is then walked one component at a time: created new (and
//     recorded as ours) or found existing; refused if it is a symbolic link or
//     not a directory; opened as its own handle; and that handle checked
//     (os.SameFile) to be the very directory the component named — a
//     component swapped between the check and the open is refused. The
//     handles are held for the batch's life.
//   - Incomplete bytes never sit at a final name: each file is received into
//     a hidden, new name in its own final directory
//     (".relayium-partial-<random>-<n>", O_EXCL), through that directory's
//     handle.
//   - Only once the whole batch is verified and durable is it installed: each
//     file is hard-linked, inside its directory handle, to a final name that
//     must not exist (never an overwrite; a taken name gets " (n)"), checked
//     to be the staged file, and the hidden name removed. Where the hard link
//     fails (for any reason but "name taken"), the batch is refused: there is
//     no install by rename, which could overwrite.
//   - A discard (an incomplete batch, ctrl-C, a failed install) removes only
//     FILES this batch recorded as its own — staged files and installed
//     names — each through its directory's handle and only while the name
//     still holds the recorded file. It never removes a directory: the
//     directories this batch created are left in place and named in the
//     report ("the folders created for it were left in place: a, a/b"). A
//     directory removal could, in a race, take someone else's (a directory
//     substituted between our Mkdir and our first look at it is only ever
//     used as a parent), and an empty folder left behind is harmless.
//
// Threat model (owner/root decision, A10 r6, recorded in DECISION-LOG): the
// sink never deletes an entry it has not proven to be its own, at any name it
// did not create. Every file is therefore removed through quarantine
// (quarantineRemove): moved inside its held directory to a fresh random
// hidden name, recorded as ours THERE at once, checked again there, and
// removed only if it is ours; a replacement swapped in after the first check
// is put back with the no-replace hard link or, failing that, left in
// quarantine and reported by both names — kept in report-only accounting
// (foreign) through the final discard, never a deletion candidate. A directory
// is never removed (above).
//
// Accepted residual (owner/root decision, A10 r8): portable Go has no rename
// that refuses a directory source, so if another process swaps a FOLDER in at
// one of our file names between our identity check and our quarantine rename,
// that folder — unchanged, contents and all — is displaced to our hidden
// quarantine name. Nothing in it is deleted: settle never removes a
// directory; it tries once to rename it back, only if its original name is
// absent, and otherwise keeps it report-only and names both paths ("…that
// folder was set aside unchanged as <q>; move it back if it is yours").
//
// Accepted residual: a
// same-user process that deliberately swaps the entry at OUR fresh random
// quarantine name between the second check and the removal — it has the
// same authority we have, and the race gains it nothing. Everything else
// holds without that assumption.
//
// Crash recovery: leftovers are hidden ".relayium-partial-*" entries; every
// warning names a quarantine path together with its original name. Nothing
// ever deletes them by prefix; after a crash they are for a person to inspect
// — they can hold another program's file set aside — and delete by hand.
//
// Peer names are display values (linkwire strips bidi and C0/C1). Here each
// "/" or "\" segment is further cleaned for the filesystem: ".", ".." and
// empty segments are dropped, a leading or trailing space trimmed, a segment
// that would collide with our hidden prefix renamed, and on Windows the
// reserved characters replaced.
type linkSink struct {
	absDest string
	dirs    []*sinkDir     // dirs[0] is the destination itself
	byPath  map[string]int // directory path (slash-separated, "" = dest) -> dirs index

	fileDir   []int    // file -> dirs index
	base      []string // file -> wanted final name
	tmp       []string // file -> hidden staged name
	rels      []string // file -> final (or, before install, intended) root-relative path
	sizes     []uint64
	files     []*os.File    // staged handles, until synced and closed
	staged    []fs.FileInfo // identity of each staged file
	finalName []string      // file -> the final name it holds (or reserved), "" none
	finalInfo []fs.FileInfo // identity recorded when that name was made
	// quarantined: entries moved to a quarantine name and not yet settled.
	quarantined []sinkLeft
	// foreign: entries of someone else's that cleanup set aside and could not
	// put back. Never deleted; reported again by every discard.
	foreign []error
	// leftDirs: directories created for this batch, left in place by discard
	// (the sink never removes a directory).
	leftDirs []string
	// createdPaths: every directory this batch's Mkdir created, recorded the
	// moment it was created (report-only).
	createdPaths []string
	done         bool // installed
}

type sinkDir struct {
	root    *os.Root
	parent  int // dirs index; -1 for the destination
	name    string
	path    string
	info    fs.FileInfo
	created bool
}

const sinkStagePrefix = ".relayium-partial-"

// Seams. The hooks run exactly between a check and the operation it guards,
// where a concurrent process could race; sinkLink/sinkRename let a test force
// the no-hard-link fallback and its failures.
var (
	sinkHookBeforeOpenDir func(k *linkSink, dirPath string)
	sinkHookBeforeLink    func(k *linkSink, i int)
	sinkHookBeforeRemove  func(k *linkSink, dirPath, name string)
	// sinkHookAfterQuarantine runs between moving an entry to quarantine
	// and checking what arrived there.
	sinkHookAfterQuarantine func(k *linkSink, dirPath, name, q string)
	sinkRename              = func(r *os.Root, oldname, newname string) error { return r.Rename(oldname, newname) }
	sinkStatHandle          = func(f *os.File) (fs.FileInfo, error) { return f.Stat() }
	sinkDirLstat            = func(r *os.Root, name string) (fs.FileInfo, error) { return r.Lstat(name) }
	sinkLink                = func(r *os.Root, oldname, newname string) error { return r.Link(oldname, newname) }
	sinkVerifyLstat         = func(r *os.Root, name string) (fs.FileInfo, error) { return r.Lstat(name) }
	sinkRemove              = func(r *os.Root, name string) error { return r.Remove(name) }
)

// sinkOpenError is a batch that could not be set up. What the partial setup
// left behind is cleaned up at once, and the outcome of THAT is kept apart
// (cleanup; nil when everything was removed) so the run reports it for what
// it is rather than as part of the cause.
type sinkOpenError struct {
	cause    error
	cleanup  error
	leftDirs []string // directories created for the batch, left in place
}

func (e *sinkOpenError) Error() string {
	if e.cleanup != nil {
		return e.cause.Error() + "; cleanup: " + e.cleanup.Error()
	}
	return e.cause.Error()
}

func (e *sinkOpenError) Unwrap() error { return e.cause }

// openFailed discards what a partial setup made and returns the error with
// the cleanup outcome recorded separately.
func (k *linkSink) openFailed(cause error) *sinkOpenError {
	cleanup := k.discard()
	return &sinkOpenError{cause: cause, cleanup: cleanup, leftDirs: k.leftDirs}
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
	top, err := os.OpenRoot(abs)
	if err != nil {
		return nil, err
	}
	k := &linkSink{absDest: abs, dirs: []*sinkDir{{root: top, parent: -1}}, byPath: map[string]int{"": 0}}
	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return nil, k.openFailed(err)
	}
	tag := hex.EncodeToString(rnd[:])
	for i, f := range files {
		segs := sinkSegments(f, i)
		di, err := k.openDir(segs[:len(segs)-1])
		if err != nil {
			return nil, k.openFailed(err)
		}
		tmp := fmt.Sprintf("%s%s-%d", sinkStagePrefix, tag, i)
		fh, err := k.dirs[di].root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return nil, k.openFailed(err)
		}
		st, err := sinkStatHandle(fh)
		if err != nil {
			fh.Close()
			// Created by us a moment ago, but its identity could not be
			// established: nothing may be removed without it, so the entry is
			// left where it is and reported as unresolved.
			left := fmt.Errorf("%s was left in place: it was created for this batch but could not be identified for removal",
				termSafe(path.Join(k.dirs[di].path, tmp)))
			oe := k.openFailed(err)
			oe.cleanup = errors.Join(left, oe.cleanup)
			return nil, oe
		}
		k.fileDir = append(k.fileDir, di)
		k.base = append(k.base, segs[len(segs)-1])
		k.tmp = append(k.tmp, tmp)
		k.rels = append(k.rels, path.Join(segs...))
		k.sizes = append(k.sizes, f.Size)
		k.files = append(k.files, fh)
		k.staged = append(k.staged, st)
		k.finalName = append(k.finalName, "")
		k.finalInfo = append(k.finalInfo, nil)
	}
	return k, nil
}

// openDir walks (creating as needed) one component at a time, each through
// the previous component's held handle, refusing symbolic links, and returns
// the held handle's index.
func (k *linkSink) openDir(segs []string) (int, error) {
	cur, p := 0, ""
	for _, seg := range segs {
		p = path.Join(p, seg)
		if idx, ok := k.byPath[p]; ok {
			cur = idx
			continue
		}
		parent := k.dirs[cur].root
		created := false
		fi, err := parent.Lstat(seg)
		if errors.Is(err, fs.ErrNotExist) {
			if err := parent.Mkdir(seg, 0o755); err != nil {
				return 0, err
			}
			created = true
			// Named for the report at once, before (and whatever happens to)
			// the identity capture below: a folder we created is always named
			// among what a discard leaves (report-only; never removed).
			k.createdPaths = append(k.createdPaths, p)
			fi, err = sinkDirLstat(parent, seg)
		}
		switch {
		case err != nil:
			return 0, err
		case fi.Mode()&fs.ModeSymlink != 0:
			return 0, fmt.Errorf("refusing to write through the symbolic link %s in %s", termSafe(p), termSafe(k.absDest))
		case !fi.IsDir():
			return 0, fmt.Errorf("%s in %s exists and is not a directory", termSafe(p), termSafe(k.absDest))
		}
		d := &sinkDir{parent: cur, name: seg, path: p, info: fi, created: created}
		idx := -1
		if created {
			// Recorded before anything else can fail, so a discard takes it back.
			k.dirs = append(k.dirs, d)
			idx = len(k.dirs) - 1
		}
		if sinkHookBeforeOpenDir != nil {
			sinkHookBeforeOpenDir(k, p)
		}
		sub, err := parent.OpenRoot(seg)
		if err == nil {
			if st, serr := sub.Stat("."); serr != nil || !os.SameFile(st, fi) {
				sub.Close()
				err = fmt.Errorf("%s in %s changed while it was being opened", termSafe(p), termSafe(k.absDest))
			}
		}
		if err != nil {
			return 0, err
		}
		d.root = sub
		if idx < 0 {
			k.dirs = append(k.dirs, d)
			idx = len(k.dirs) - 1
		}
		k.byPath[p] = idx
		cur = idx
	}
	return cur, nil
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
		if runtime.GOOS == "windows" {
			// Device names address Windows devices, not ordinary files. Check
			// the stem too so names with extensions remain portable across
			// Windows versions; a leading dot still names an ordinary dotfile.
			stem, _, _ := strings.Cut(s, ".")
			stem = strings.TrimRight(stem, " ")
			if !filepath.IsLocal(s) || (stem != "" && !filepath.IsLocal(stem)) {
				s = "_" + s
			}
		}
		if strings.HasPrefix(s, sinkStagePrefix) {
			s = "_" + s // never mistaken for (or colliding with) a staged file
		}
		segs = append(segs, s)
	}
	if len(segs) == 0 {
		segs = []string{fmt.Sprintf("file-%d", i+1)}
	}
	return segs
}

// install gives a complete, verified batch its final names (see linkSink).
// Every staged file must already be synced and closed. On failure everything
// this batch installed or reserved is taken back and the error returned.
func (k *linkSink) install() error {
	if k.done {
		return nil
	}
	for i := range k.tmp {
		if err := k.place(i); err != nil {
			return errors.Join(err, k.uninstall())
		}
	}
	k.done = true
	return nil
}

// errSinkUnsafeFS: a received file could not be given its name by the one
// install that can never overwrite (a hard link, which fails if the name is
// taken). The batch is refused rather than installed by rename. It says
// nothing about what was kept: the cleanup that follows reports that on its
// own, once its result is known.
var errSinkUnsafeFS = errors.New("the received files could not be installed safely; nothing was overwritten")

// sinkInstallError explains a failed no-replace install, naming the cause,
// and blames missing hard-link support only for the errors that mean it.
func sinkInstallError(rel string, err error) error {
	hint := ""
	if errors.Is(err, syscall.EXDEV) || errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EOPNOTSUPP) ||
		errors.Is(err, syscall.ENOSYS) || errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EMLINK) {
		hint = " — this destination does not appear to support the hard links relayium installs with; " +
			"a destination on another filesystem may work"
	}
	return fmt.Errorf("%w: %s: %v%s", errSinkUnsafeFS, termSafe(rel), err, hint)
}

// place installs file i inside its held directory.
func (k *linkSink) place(i int) error {
	d := k.dirs[k.fileDir[i]]
	base := k.base[i]
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
		if sinkHookBeforeLink != nil {
			sinkHookBeforeLink(k, i)
		}
		err := sinkLink(d.root, k.tmp[i], cand)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			// No atomic no-replace install here (link(2) is the one this
			// uses). A rename onto a reserved name could overwrite a file
			// swapped in under that name, so the batch is refused instead.
			return sinkInstallError(path.Join(d.path, cand), err)
		}
		// Installed: recorded at once, with the staged file's identity (a
		// hard link is that very file), before any check that can fail — so
		// a rollback always takes back what was installed.
		k.finalName[i], k.finalInfo[i] = cand, k.staged[i]
		k.rels[i] = path.Join(d.path, cand)
		fi, err := sinkVerifyLstat(d.root, cand)
		if err != nil || !os.SameFile(fi, k.staged[i]) {
			return fmt.Errorf("%s in %s changed while it was being saved", termSafe(k.rels[i]), termSafe(k.absDest))
		}
		if err := k.removeOwned(k.fileDir[i], k.tmp[i], k.staged[i]); err != nil {
			return err
		}
		return nil
	}
	return fmt.Errorf("no free name for %s in %s", termSafe(base), termSafe(k.absDest))
}

// removeOwned removes name from held directory di only while it still holds
// the file (or directory) recorded as ours.
//
// It reports what it could not settle: a name it could not inspect, or could
// not remove, is still (possibly) ours on disk. A name that is gone, or now
// holds something else, is not ours to remove and is no failure.
func (k *linkSink) removeOwned(di int, name string, info fs.FileInfo) error {
	d := k.dirs[di]
	if info == nil {
		return nil
	}
	shown := termSafe(path.Join(d.path, name))
	if d.root == nil {
		return fmt.Errorf("%s could not be removed: its directory is no longer open", shown)
	}
	fi, err := d.root.Lstat(name)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		return fmt.Errorf("%s could not be checked for removal: %w", shown, err)
	case !os.SameFile(fi, info):
		return nil
	}
	if fi.IsDir() {
		// Never: the sink does not remove directories (see linkSink).
		return fmt.Errorf("%s is a directory and was left in place", shown)
	}
	if sinkHookBeforeRemove != nil {
		sinkHookBeforeRemove(k, d.path, name)
	}
	return k.quarantineRemove(di, name, info)
}

// quarantineRemove removes an entry the check above found to be ours without
// ever deleting a replacement swapped in after that check. The entry is first
// moved, inside the held directory, to a fresh private hidden name — and from
// that moment it is recorded as ours THERE (k.quarantined), so a removal that
// fails later is still known, retried and reported by both names. Its
// identity is then checked again in quarantine, where nobody else is looking;
// only our own entry is removed. Anything else is put back under its name
// without overwriting anything, or, when that name was taken again, left in
// quarantine and reported by both names.
//
// This covers directories as well: os.Root.Remove is not directory-only (it
// unlinks a file too), so a directory is never removed at a name another
// process could have filled with a file — only at its quarantine name, after
// proving it is still our directory there.
func (k *linkSink) quarantineRemove(di int, name string, info fs.FileInfo) error {
	d := k.dirs[di]
	shown := termSafe(path.Join(d.path, name))
	q, err := sinkQuarantineName(d.root)
	if err != nil {
		return fmt.Errorf("%s could not be removed: %w", shown, err)
	}
	if err := sinkRename(d.root, name, q); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil // gone already
		}
		return fmt.Errorf("%s could not be removed: %w", shown, err)
	}
	k.keep(sinkLeft{di: di, q: q, orig: name, info: info})
	if sinkHookAfterQuarantine != nil {
		sinkHookAfterQuarantine(k, d.path, name, q)
	}
	return k.settle(len(k.quarantined) - 1)
}

// sinkLeft is an entry this batch moved into quarantine and has not yet
// settled (removed as ours, or given back as not ours).
type sinkLeft struct {
	di   int
	q    string // the quarantine name
	orig string // the name it was moved from
	info fs.FileInfo
}

func (k *linkSink) keep(l sinkLeft) { k.quarantined = append(k.quarantined, l) }

// settle resolves quarantined entry j: it is dropped from k.quarantined only
// when nothing of it remains to account for.
func (k *linkSink) settle(j int) error {
	l := k.quarantined[j]
	d := k.dirs[l.di]
	shown := termSafe(path.Join(d.path, l.orig))
	qShown := termSafe(path.Join(d.path, l.q))
	done := func(err error) error {
		k.quarantined = append(k.quarantined[:j], k.quarantined[j+1:]...)
		return err
	}
	if d.root == nil {
		return fmt.Errorf("%s (set aside as %s) could not be removed: its directory is no longer open", shown, qShown)
	}
	fi, err := d.root.Lstat(l.q)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return done(nil)
	case err != nil:
		return fmt.Errorf("%s was set aside as %s for removal, which could not then be checked: %w", shown, qShown, err)
	case os.SameFile(fi, l.info) && !fi.IsDir():
		if err := sinkRemove(d.root, l.q); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("%s (set aside as %s) could not be removed: %w", shown, qShown, err)
		}
		return done(nil)
	}
	// Not ours: another process replaced the entry after our check. Put it
	// back — never over anything — and delete nothing. A directory swapped in
	// cannot be put back without a rename that could replace something, so it
	// stays in quarantine.
	var perr error
	if fi.IsDir() {
		// Someone's folder, swapped in at a file's name after our check and
		// moved (unchanged, contents and all) into our quarantine name by our
		// rename. Never removed. One attempt to give it its name back, only if
		// that name is absent; otherwise it stays set aside, reported.
		if _, lerr := d.root.Lstat(l.orig); errors.Is(lerr, fs.ErrNotExist) && sinkRename(d.root, l.q, l.orig) == nil {
			return done(fmt.Errorf("%s was replaced by a folder while it was being removed; that folder was moved aside "+
				"and then back, unchanged, and the file of this batch it replaced may be left elsewhere", shown))
		}
		perr = fmt.Errorf("%s was replaced by a folder while it was being removed; that folder was set aside unchanged as %s; "+
			"move it back if it is yours", shown, qShown)
	} else if err := sinkLink(d.root, l.q, l.orig); err != nil {
		perr = fmt.Errorf("%s was replaced by another file while it was being removed; that file was set aside as %s "+
			"and could not be put back (%v) — both are left for you to check", shown, qShown, err)
	} else if err := sinkRemove(d.root, l.q); err != nil && !errors.Is(err, fs.ErrNotExist) {
		perr = fmt.Errorf("%s was replaced by another file while it was being removed; that file is back in place, "+
			"but its extra name %s could not be removed: %w", shown, qShown, err)
	}
	if perr != nil {
		// Not ours, so never a deletion candidate — but it is on disk because
		// of us: it stays in report-only accounting through the final discard.
		k.foreign = append(k.foreign, perr)
	}
	return done(perr)
}

// sinkQuarantineName picks a fresh hidden name in r that does not exist.
func sinkQuarantineName(r *os.Root) (string, error) {
	for tries := 0; tries < 8; tries++ {
		var rnd [8]byte
		if _, err := rand.Read(rnd[:]); err != nil {
			return "", err
		}
		q := sinkStagePrefix + "q-" + hex.EncodeToString(rnd[:])
		if _, err := r.Lstat(q); errors.Is(err, fs.ErrNotExist) {
			return q, nil
		}
	}
	return "", errors.New("no free quarantine name")
}

// uninstall takes back every final name (installed or reserved) of ours.
//
// A name it could not take back stays recorded as ours (a later attempt, and
// the report, still know about it) and is returned in the error.
func (k *linkSink) uninstall() error {
	var errs []error
	for i, name := range k.finalName {
		if name == "" {
			continue
		}
		if err := k.removeOwned(k.fileDir[i], name, k.finalInfo[i]); err != nil {
			errs = append(errs, err)
			continue
		}
		k.finalName[i], k.finalInfo[i] = "", nil
		k.rels[i] = path.Join(k.dirs[k.fileDir[i]].path, k.base[i])
	}
	return errors.Join(errs...)
}

// path is file i's (intended or final) location, for the finalize hook and
// messages.
func (k *linkSink) path(i int) string { return filepath.Join(k.absDest, filepath.FromSlash(k.rels[i])) }

func (k *linkSink) show(i int) string {
	if i < len(k.rels) {
		return termSafe(k.rels[i])
	}
	return "a file"
}

// close releases handles once the batch is installed; the files stay. An
// uninstalled batch is discarded instead: nothing half-done is left.
func (k *linkSink) close() error {
	if !k.done {
		return k.discard()
	}
	k.closeFiles()
	k.closeDirs()
	return nil
}

func (k *linkSink) closeFiles() {
	for i, fh := range k.files {
		if fh != nil {
			_ = fh.Close()
			k.files[i] = nil
		}
	}
}

func (k *linkSink) closeDirs() {
	for i := len(k.dirs) - 1; i >= 0; i-- {
		if r := k.dirs[i].root; r != nil {
			_ = r.Close()
			k.dirs[i].root = nil
		}
	}
}

// discard removes exactly what this batch owns (see linkSink).
//
// Whatever it could not remove is returned, naming each path, so the run can
// say truthfully what was left behind.
func (k *linkSink) discard() error {
	k.closeFiles()
	var errs []error
	for j := len(k.quarantined) - 1; j >= 0; j-- { // left over from an earlier attempt
		errs = append(errs, k.settle(j))
	}
	errs = append(errs, k.uninstall())
	for i, tmp := range k.tmp {
		errs = append(errs, k.removeOwned(k.fileDir[i], tmp, k.staged[i]))
	}
	// Directories are never removed: those this batch created are left in
	// place and named (leftDirs). A directory removal could, in a race, take
	// someone else's (a substituted directory is only ever used as a parent).
	k.leftDirs = append([]string(nil), k.createdPaths...)
	// Someone else's entries set aside and not put back: reported, never
	// deleted. (Our own, still in quarantine, were reported by settle.)
	errs = append(errs, k.foreign...)
	k.closeDirs()
	return errors.Join(errs...)
}
