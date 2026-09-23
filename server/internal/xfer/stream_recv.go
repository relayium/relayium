package xfer

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/relayium/relayium/internal/termtext"
)

// StreamPeer is the receiving end of a stream. Every read and write the
// receiver makes is bounded by a deadline set here: a real kernel deadline on
// a network connection, or, for a helper process speaking over its stdio (which
// has none), an ExitWatchdogPeer that ends the process when one expires.
//
// The receiver arms a deadline immediately before each operation and clears it
// immediately after, so an expiry always means "that operation did not finish
// in time", never "time passed while doing something local".
type StreamPeer interface {
	io.ReadWriter
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

// StreamTarget is where a stream is installed: the file Leaf inside the
// directory Parent. Every filesystem operation goes through Parent, so a path
// component swapped after it was opened cannot redirect the install, and Leaf
// can never name anything outside it.
type StreamTarget struct {
	Parent *os.Root
	Leaf   string
}

// StreamRecvOpts configures ReceiveStream. Zero durations take the defaults.
type StreamRecvOpts struct {
	// Idle bounds each read from the sender (default 2 minutes; the sender
	// sends a keepalive every 30 seconds without data).
	Idle time.Duration
	// WriteTimeout bounds each write to the sender: StreamAccept, a refusal,
	// StreamResult (default 5 seconds).
	WriteTimeout time.Duration
	// Drain bounds how long, and DrainMax how much, is read and discarded
	// after write_failed was sent, so a sender blocked in a write can see it
	// (defaults 5 seconds, 64 MiB).
	Drain    time.Duration
	DrainMax int64
	// Guard, when set, is shared with a path that may have to abandon the
	// staging from another goroutine (a signal handler, an ExitWatchdogPeer).
	Guard *StageGuard
	// Progress, when set, observes the body as it is written to staging:
	// bytes received so far. Observational only.
	Progress func(received int64)
}

func (o StreamRecvOpts) withDefaults() StreamRecvOpts {
	if o.Idle <= 0 {
		o.Idle = 2 * time.Minute
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 5 * time.Second
	}
	if o.Drain <= 0 {
		o.Drain = 5 * time.Second
	}
	if o.DrainMax <= 0 {
		o.DrainMax = 64 << 20
	}
	if o.Guard == nil {
		o.Guard = NewStageGuard()
	}
	return o
}

// StreamRecvReport describes a received stream. Installed is true exactly when
// the destination was created by this call. Notes are non-fatal observations.
type StreamRecvReport struct {
	Bytes     int64
	SHA256    string
	Installed bool
	Notes     []string
}

// streamStageWrite writes body bytes to the staging file. A var so tests can
// inject a local write failure (a full disk) after a chosen number of bytes.
var streamStageWrite = func(f *os.File, b []byte) (int, error) { return f.Write(b) }

// stagePrefix names a staging directory beside the destination.
const stagePrefix = ".relayium-recv-"

// ReceiveStream receives one file sent by SendStream and installs it as
// tgt.Leaf, never replacing anything.
//
// The order is what makes its promises hold:
//
//   - Nothing is created before the Hello and the manifest were accepted and
//     tgt.Leaf was found absent.
//   - The body goes into a private staging directory (mode 0700 on Unix; on
//     Windows it inherits the parent's ACL like any new directory) created
//     through tgt.Parent, then into a file created exclusively inside it.
//   - Only a StreamEnd whose challenge is well formed and whose size and
//     SHA-256 match every byte received leads to an install, and the install
//     is a hard link through tgt.Parent, which fails rather than replace
//     anything that appeared at tgt.Leaf in the meantime.
//   - StreamResult, echoing the End's challenge, is sent only after that link
//     exists.
//   - On every other path the removal of the staging directory is attempted
//     BEFORE anything is sent to the sender, so "nothing was installed" never
//     depends on the sender reading. A removal the filesystem refuses is not
//     reported as done: the refusal and the local error name the staging
//     directory that was left behind.
//
// The error returned is for the local console; the sender learns what it needs
// from the MsgError frames.
func ReceiveStream(p StreamPeer, tgt StreamTarget, o StreamRecvOpts) (StreamRecvReport, error) {
	o = o.withDefaults()
	r := &streamReceiver{p: p, tgt: tgt, o: o, g: o.Guard}
	defer r.g.cleanup() // idempotent; never touches an installed destination
	return r.run()
}

type streamReceiver struct {
	p   StreamPeer
	tgt StreamTarget
	o   StreamRecvOpts
	g   *StageGuard
}

// refuse removes any staging, then sends code/msg to the sender within the
// write bound, and returns the local error. A staging directory that could
// not be removed is named in both.
func (r *streamReceiver) refuse(code, msg string) error {
	msg += r.g.cleanup()
	_ = r.write(MsgError, WireError{Code: code, Msg: msg})
	return errors.New(msg)
}

func (r *streamReceiver) write(t MsgType, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_ = r.p.SetWriteDeadline(time.Now().Add(r.o.WriteTimeout))
	err = writeAll(r.p, appendFrame(nil, t, b))
	_ = r.p.SetWriteDeadline(time.Time{})
	return err
}

func (r *streamReceiver) readFull(b []byte) error {
	_ = r.p.SetReadDeadline(time.Now().Add(r.o.Idle))
	_, err := io.ReadFull(r.p, b)
	_ = r.p.SetReadDeadline(time.Time{})
	return err
}

// readControl reads one small control frame under the idle bound.
func (r *streamReceiver) readControl() (MsgType, []byte, error) {
	var hdr [streamFrameHeader]byte
	if err := r.readFull(hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > maxStreamControl {
		return MsgType(hdr[0]), nil, errOversizeControl
	}
	payload := make([]byte, n)
	if err := r.readFull(payload); err != nil {
		return 0, nil, err
	}
	return MsgType(hdr[0]), payload, nil
}

var errOversizeControl = errors.New("protocol error: oversize control frame")

// drain reads and discards what the sender still sends, within Drain and
// DrainMax, so a sender blocked in a write can go on to read the refusal.
func (r *streamReceiver) drain() {
	_ = r.p.SetReadDeadline(time.Now().Add(r.o.Drain))
	_, _ = io.CopyN(io.Discard, r.p, r.o.DrainMax)
	_ = r.p.SetReadDeadline(time.Time{})
}

func (r *streamReceiver) run() (StreamRecvReport, error) {
	leaf := termtext.Safe(r.tgt.Leaf)

	t, payload, err := r.readControl()
	if err != nil {
		return StreamRecvReport{}, fmt.Errorf("reading the stream hello: %w", err)
	}
	var hello Hello
	if t != MsgHello || json.Unmarshal(payload, &hello) != nil {
		return StreamRecvReport{}, r.refuse(ErrCodeProtocol, "protocol error: expected a hello")
	}
	if hello.Version != WireVersion || hello.Mode != "push" || !hello.Stream || hello.Sync || hello.Delete || hello.ResumeProof {
		return StreamRecvReport{}, r.refuse(ErrCodeStreamNotAccepted,
			"this receiver takes only a plain stream push (no sync, delete or resume)")
	}
	t, payload, err = r.readControl()
	if err != nil {
		return StreamRecvReport{}, fmt.Errorf("reading the stream manifest: %w", err)
	}
	var m Manifest
	if t != MsgManifest || json.Unmarshal(payload, &m) != nil {
		return StreamRecvReport{}, r.refuse(ErrCodeProtocol, "protocol error: expected a manifest")
	}
	if !validStreamLeaf(r.tgt.Leaf) || r.tgt.Parent == nil {
		return StreamRecvReport{}, r.refuse(ErrCodeInvalidDestination, "the destination is not a plain file name")
	}
	if len(m.Files) != 1 {
		return StreamRecvReport{}, r.refuse(ErrCodeProtocol, fmt.Sprintf("protocol error: a stream carries exactly one file, the manifest names %d", len(m.Files)))
	}
	if f := m.Files[0]; f.Size != -1 || f.Mode != 0 || f.ModTime != 0 || f.Path != r.tgt.Leaf {
		return StreamRecvReport{}, r.refuse(ErrCodeProtocol, "protocol error: the stream manifest does not name "+leaf+" as a stream")
	}

	// Preflight: the destination must not exist in any form. The install
	// re-checks atomically (the link fails on anything that appears later).
	if fi, err := r.tgt.Parent.Lstat(r.tgt.Leaf); err == nil {
		if fi.IsDir() {
			return StreamRecvReport{}, r.refuse(ErrCodeDestinationExists, leaf+" is a directory on the receiver; give the full file name")
		}
		return StreamRecvReport{}, r.refuse(ErrCodeDestinationExists, leaf+" already exists on the receiver")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return StreamRecvReport{}, r.refuse(ErrCodeInvalidDestination, "cannot inspect "+leaf+" on the receiver: "+rootErrText(err))
	}

	if err := r.g.begin(r.tgt.Parent); err != nil {
		return StreamRecvReport{}, r.refuse(ErrCodeWriteFailed, "cannot stage "+leaf+" on the receiver: "+rootErrText(err))
	}
	if err := r.write(MsgStreamAccept, StreamAccept{ChunkMax: StreamChunkMax}); err != nil {
		note := r.g.cleanup()
		return StreamRecvReport{}, fmt.Errorf("sending the stream accept: %w; nothing was installed%s", err, note)
	}

	h := sha256.New()
	var count int64
	body := make([]byte, StreamChunkMax)
	for {
		var hdr [streamFrameHeader]byte
		if err := r.readFull(hdr[:]); err != nil {
			// The sender is gone or silent past the idle bound: there is no
			// one to tell. Staging goes; nothing was installed.
			note := r.g.cleanup()
			return StreamRecvReport{}, fmt.Errorf("the stream ended before its end (%d bytes received): %w; nothing was installed%s", count, err, note)
		}
		t, n := MsgType(hdr[0]), binary.BigEndian.Uint32(hdr[1:])
		switch {
		case t == MsgStreamData && n <= StreamChunkMax:
			if err := r.readFull(body[:n]); err != nil {
				note := r.g.cleanup()
				return StreamRecvReport{}, fmt.Errorf("the stream ended inside a chunk (%d bytes received): %w; nothing was installed%s", count, err, note)
			}
			if n == 0 {
				continue // keepalive
			}
			if err := r.g.write(body[:n]); err != nil {
				err := r.refuse(ErrCodeWriteFailed, "writing "+leaf+" on the receiver failed: "+rootErrText(err))
				r.drain()
				return StreamRecvReport{}, err
			}
			h.Write(body[:n])
			count += int64(n)
			if r.o.Progress != nil {
				r.o.Progress(count)
			}
		case t == MsgStreamData:
			return StreamRecvReport{}, r.refuse(ErrCodeProtocol, fmt.Sprintf("protocol error: a stream chunk of %d bytes exceeds %d", n, StreamChunkMax))
		case t == MsgStreamEnd && n <= maxStreamControl:
			payload := make([]byte, n)
			if err := r.readFull(payload); err != nil {
				note := r.g.cleanup()
				return StreamRecvReport{}, fmt.Errorf("the stream ended inside its end frame: %w; nothing was installed%s", err, note)
			}
			var end StreamEnd
			if json.Unmarshal(payload, &end) != nil || !validStreamChallenge(end.Challenge) {
				return StreamRecvReport{}, r.refuse(ErrCodeProtocol, "protocol error: the stream end is malformed")
			}
			sum := hex.EncodeToString(h.Sum(nil))
			if end.Size != count || end.SHA256 != sum {
				return StreamRecvReport{}, r.refuse(ErrCodeProtocol,
					fmt.Sprintf("the stream did not verify (%d bytes received, the sender says %d); nothing was installed", count, end.Size))
			}
			return r.install(end, count, sum)
		default:
			return StreamRecvReport{}, r.refuse(ErrCodeProtocol, fmt.Sprintf("protocol error: unexpected message type %d in a stream", t))
		}
	}
}

// install makes the verified staging file tgt.Leaf, then confirms.
func (r *streamReceiver) install(end StreamEnd, count int64, sum string) (StreamRecvReport, error) {
	leaf := termtext.Safe(r.tgt.Leaf)
	if err := r.g.finishFile(); err != nil {
		return StreamRecvReport{}, r.refuse(ErrCodeWriteFailed, "writing "+leaf+" on the receiver failed: "+rootErrText(err))
	}
	switch err := r.g.install(r.tgt.Leaf); {
	case errors.Is(err, errStageAbandoned):
		return StreamRecvReport{}, errors.New("the staging was abandoned before install; nothing was installed" + r.g.cleanup())
	case errors.Is(err, fs.ErrExist):
		return StreamRecvReport{}, r.refuse(ErrCodeDestinationExists, leaf+" was created on the receiver during the transfer; it was left untouched")
	case err != nil:
		return StreamRecvReport{}, r.refuse(ErrCodeWriteFailed, "installing "+leaf+" on the receiver failed: "+rootErrText(err))
	}
	rep := StreamRecvReport{Bytes: count, SHA256: sum, Installed: true}
	if out := r.g.removeStagingAfterInstall(); out.Residual != "" {
		rep.Notes = append(rep.Notes, fmt.Sprintf("%s was installed, but %s", leaf, out.residualText()))
	}
	if err := r.write(MsgStreamResult, StreamResult{Size: count, SHA256: sum, Challenge: end.Challenge}); err != nil {
		// The install stands; the sender reports that it could not confirm.
		rep.Notes = append(rep.Notes, fmt.Sprintf("%s was installed, but the confirmation could not be sent: %v", leaf, err))
	}
	return rep, nil
}

func validStreamLeaf(s string) bool {
	return s != "" && s != "." && s != ".." && len(s) <= maxManifestPathBytes &&
		!strings.ContainsAny(s, "/\\\x00") && filepath.Base(s) == s && !strings.HasPrefix(s, stagePrefix)
}

// rootErrText is an error's text without any path: an *os.PathError from
// os.Root names only root-relative paths, but the operation and cause are
// what the sender needs.
func rootErrText(err error) string {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return termtext.Safe(pe.Op + ": " + pe.Err.Error())
	}
	var le *os.LinkError
	if errors.As(err, &le) {
		return termtext.Safe(le.Op + ": " + le.Err.Error())
	}
	return termtext.Safe(err.Error())
}

// StageGuard owns one staging directory and decides, under one lock, between
// installing it and removing it. The install proceeds only from the staging
// state; once abandoned (by the receiver, a signal handler or a watchdog) it can
// never be installed. What the staging came to — installed, removed, or left
// behind because the filesystem refused its removal — is recorded here, under
// the same lock, and is the only source of what a diagnostic may claim.
type StageGuard struct {
	mu     sync.Mutex
	state  stageState
	root   *os.Root
	stage  string   // staging directory name inside root while it exists; "" once removed
	f      *os.File // the open staging file, until finishFile
	staged bool     // a staging directory was created
	leaf   string   // the destination, once installed
	rmErr  error    // why stage is still there after a removal was attempted
}

type stageState int

const (
	stageNone stageState = iota
	stageStaging
	stageInstalled
	stageAbandoned // never installs; stage is "" or a directory left behind (rmErr)
)

var errStageAbandoned = errors.New("staging abandoned")

// StageOutcome is what a guard's staging came to, read under its lock.
type StageOutcome struct {
	// Installed: the stream was installed as Leaf. The guard never removes an
	// installed destination.
	Installed bool
	Leaf      string
	// Staged: a staging directory was created at some point.
	Staged bool
	// Residual is the staging directory (beside the destination) that is still
	// there because removing it failed, with Err saying why; "" when none is.
	Residual string
	Err      error
}

// String is the outcome as a clause of a diagnostic, claiming nothing the
// guard did not observe.
func (o StageOutcome) String() string {
	var s string
	switch {
	case o.Installed:
		s = termtext.Safe(o.Leaf) + " was installed with the verified bytes and is kept; the sender may not have received the confirmation"
		if o.Residual != "" {
			s += "; " + o.residualText()
		}
		return s
	case o.Residual != "":
		return "nothing was installed, but " + o.residualText()
	case o.Staged:
		return "nothing was installed and the staging directory was removed"
	}
	return "nothing was installed"
}

// residualText names the staging directory left behind and why.
func (o StageOutcome) residualText() string {
	why := "cause unknown"
	if o.Err != nil {
		why = rootErrText(o.Err)
	}
	return "the staging directory " + termtext.Safe(o.Residual) + " could not be removed (" + why + "); remove it by hand"
}

// residualNote is "" or residualText as a clause to append to a message.
func (o StageOutcome) residualNote() string {
	if o.Residual == "" {
		return ""
	}
	return "; " + o.residualText()
}

// NewStageGuard returns a guard with nothing staged.
func NewStageGuard() *StageGuard { return &StageGuard{} }

func (g *StageGuard) begin(root *os.Root) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state != stageNone {
		return errStageAbandoned
	}
	var stage string
	var err error
	for range 8 {
		var b [8]byte
		_, _ = rand.Read(b[:])
		stage = stagePrefix + hex.EncodeToString(b[:])
		if err = root.Mkdir(stage, 0o700); !errors.Is(err, fs.ErrExist) {
			break
		}
	}
	if err != nil {
		return err
	}
	g.root, g.stage, g.staged = root, stage, true
	f, err := root.OpenFile(filepath.Join(stage, "data"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		g.removeStageLocked() // the refusal's cleanup reports it if it stays
		return err
	}
	g.f, g.state = f, stageStaging
	return nil
}

// write appends body bytes to the staging file. The lock is not held during
// the write itself, so a local write that hangs (a stuck filesystem) cannot
// keep Abandon, and with it a process that must exit, waiting.
func (g *StageGuard) write(b []byte) error {
	g.mu.Lock()
	f, st := g.f, g.state
	g.mu.Unlock()
	if st != stageStaging || f == nil {
		return errStageAbandoned
	}
	n, err := streamStageWrite(f, b)
	if err == nil && n < len(b) {
		err = io.ErrShortWrite
	}
	return err
}

// finishFile makes the staged bytes durable and closes the file (outside the
// lock, like write).
func (g *StageGuard) finishFile() error {
	g.mu.Lock()
	f, st := g.f, g.state
	g.mu.Unlock()
	if st != stageStaging || f == nil {
		return errStageAbandoned
	}
	err := f.Sync()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state != stageStaging {
		return errStageAbandoned
	}
	g.f = nil
	return err
}

// install hard-links the staged file to leaf, which fails if anything exists
// there, only from the staging state.
func (g *StageGuard) install(leaf string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state != stageStaging {
		return errStageAbandoned
	}
	if err := g.root.Link(filepath.Join(g.stage, "data"), leaf); err != nil {
		return err
	}
	g.state, g.leaf = stageInstalled, leaf
	return nil
}

// removeStagingAfterInstall removes the staging name of the installed file
// (the destination is another link to it and stays) and the directory.
func (g *StageGuard) removeStagingAfterInstall() StageOutcome {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state == stageInstalled {
		g.removeStageLocked()
	}
	return g.outcomeLocked()
}

// removeStageLocked attempts to remove the staging file and directory, and
// records the result: stage becomes "" only when the directory is gone. It
// never touches anything but the staging directory's own names, so after an
// install the destination is untouched. g.mu is held.
func (g *StageGuard) removeStageLocked() {
	if g.stage == "" {
		return
	}
	err := g.root.Remove(filepath.Join(g.stage, "data"))
	if errors.Is(err, fs.ErrNotExist) {
		err = nil
	}
	rerr := g.root.Remove(g.stage)
	if rerr == nil || errors.Is(rerr, fs.ErrNotExist) {
		g.stage, g.rmErr = "", nil
		return
	}
	if err == nil {
		err = rerr
	}
	g.rmErr = err
}

func (g *StageGuard) outcomeLocked() StageOutcome {
	return StageOutcome{Installed: g.state == stageInstalled, Leaf: g.leaf, Staged: g.staged, Residual: g.stage, Err: g.rmErr}
}

// cleanup abandons the staging and returns "" or a clause naming a staging
// directory that could not be removed. Idempotent; never removes an installed
// destination.
func (g *StageGuard) cleanup() string { return g.Abandon().residualNote() }

// Abandon makes any later install fail, attempts to remove the staging file
// and directory if they are still there (again, if an earlier attempt was
// refused), and returns what the staging came to. After an install it removes
// only what is left of the staging, never the destination, and reports the
// install. Safe from any goroutine; a process about to exit calls it first.
func (g *StageGuard) Abandon() StageOutcome {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch g.state {
	case stageNone:
		g.state = stageAbandoned
	case stageStaging:
		if g.f != nil {
			_ = g.f.Close()
			g.f = nil
		}
		g.state = stageAbandoned
	}
	g.removeStageLocked()
	return g.outcomeLocked()
}

// ExitWatchdogPeer is a StreamPeer over a process's own stdio, for a receiver
// that is a helper process (`__recv` over SSH). Stdio pipes have no kernel
// deadlines Go can use, and their descriptors are shared with the shell that
// started the helper, so none of their flags are touched. Instead a deadline
// arms a timer, and when it fires the process ends: the guard abandons the
// staging (attempting its removal; an installed destination is kept), a
// diagnostic of what the guard recorded is attempted from another goroutine
// for at most DiagBudget, and Exit(1) runs whether or not that diagnostic got
// out. No write to stdout or stderr stands between the cleanup and the exit,
// so a sender that stopped reading (stdout full) or a full stderr cannot hold
// the process.
type ExitWatchdogPeer struct {
	In         io.Reader
	Out        io.Writer
	Guard      *StageGuard
	Diag       io.Writer      // os.Stderr in the helper
	Exit       func(code int) // os.Exit in the helper
	DiagBudget time.Duration

	mu     sync.Mutex
	timers [2]*time.Timer // read, write
}

// NewExitWatchdogPeer returns a peer over in/out whose expiries abandon the
// guard's staging, report on os.Stderr for at most 200 ms, and call os.Exit(1).
func NewExitWatchdogPeer(in io.Reader, out io.Writer, g *StageGuard) *ExitWatchdogPeer {
	return &ExitWatchdogPeer{In: in, Out: out, Guard: g, Diag: os.Stderr, Exit: os.Exit, DiagBudget: 200 * time.Millisecond}
}

func (w *ExitWatchdogPeer) Read(b []byte) (int, error)  { return w.In.Read(b) }
func (w *ExitWatchdogPeer) Write(b []byte) (int, error) { return w.Out.Write(b) }

func (w *ExitWatchdogPeer) SetReadDeadline(t time.Time) error {
	w.arm(0, t, "no data from the sender within the idle limit")
	return nil
}

func (w *ExitWatchdogPeer) SetWriteDeadline(t time.Time) error {
	w.arm(1, t, "the sender stopped reading")
	return nil
}

func (w *ExitWatchdogPeer) arm(i int, t time.Time, reason string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timers[i] != nil {
		w.timers[i].Stop()
		w.timers[i] = nil
	}
	if t.IsZero() {
		return
	}
	w.timers[i] = time.AfterFunc(time.Until(t), func() { w.fire(reason) })
}

// fire is the watchdog: cleanup, bounded diagnostic, exit. The diagnostic
// says what the guard recorded — an install that already happened, a staging
// directory the filesystem refused to remove — not what the watchdog hoped.
func (w *ExitWatchdogPeer) fire(reason string) {
	msg := "relayium: " + reason + "; " + w.Guard.Abandon().String()
	done := make(chan struct{})
	go func() {
		fmt.Fprintln(w.Diag, msg)
		close(done)
	}()
	t := time.NewTimer(w.DiagBudget)
	select {
	case <-done:
	case <-t.C:
	}
	w.Exit(1)
}
