// Package stdinpump reads this process's standard input through an
// exact-owned helper process, so that the reading can be stopped in bounded
// time on every platform without this process ever reading fd 0 itself.
//
// The problem it solves: a goroutine blocked in a read of the real standard
// input cannot be interrupted portably. Closing os.Stdin does not wake it on
// every platform, setting O_NONBLOCK on it changes a file description this
// process shares with its shell and siblings, and a poll-then-read on the shared
// descriptor leaves a window in which another reader takes the bytes. Instead,
// Start launches `<exe> __pump-stdin` with fd 0 inherited as-is (the same
// *os.File, no copy goroutine), and this process reads only a private pipe the
// helper writes framed chunks to. Stop kills that exact process (never a group,
// never by name), reaps it and closes the pipe, which releases a Read in
// progress on every platform.
//
// Nothing reads standard input before Start is called; the caller decides when
// (for `push -`, only after the receiver accepted the stream). Neither side
// changes any flag of the inherited descriptor.
//
// The helper also watches a parent-death pipe whose only write end lives in
// this process, so a parent killed without any cleanup (SIGKILL,
// TerminateProcess) cannot leave it reading the user's input: it exits as soon
// as that pipe reports end of file. At most one chunk (HelperChunk bytes) it had
// already read may be lost then, exactly as on any mid-stream kill.
package stdinpump

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// HelperArg is the hidden subcommand that runs RunHelper.
const HelperArg = "__pump-stdin"

// DeathFlag names the parent-death pipe for the helper: a file descriptor on
// Unix, an inherited handle value on Windows.
const DeathFlag = "--death-fd"

// HelperChunk is the largest single read the helper makes from fd 0, and so
// the largest data frame it sends.
const HelperChunk = 256 << 10

// Frame words on the helper's output pipe. A data frame is [u32 n][n bytes]
// with 0 < n <= HelperChunk; frameEnd alone is the end marker (fd 0 reached
// end of file); frameErr is followed by [u32 len][len bytes of message].
const (
	frameEnd       uint32 = 0
	frameErr       uint32 = 0xFFFFFFFF
	maxErrMsgBytes        = 4096
)

// Helper exit codes.
const (
	exitEOF         = 0 // end marker written
	exitStdinError  = 1 // error frame written
	exitUsage       = 2 // bad invocation; nothing read
	exitOutputGone  = 3 // the parent's pipe is gone
	exitParentDeath = 4 // the parent-death pipe reported end of file
)

// Timing bounds. Vars so tests can shorten them.
var (
	// ExitGrace is how long Stop waits, after the end marker, for the helper
	// to exit by itself before killing it.
	ExitGrace = 2 * time.Second
	// KillGrace is how long Stop waits for the helper to be reaped after
	// Kill. Only a process the kernel cannot stop (a read stuck in
	// uninterruptible sleep on a hung filesystem) reaches it.
	KillGrace = 5 * time.Second
)

// ErrHelperVanished is returned by Read when the helper's pipe ended without
// the end marker: the helper was killed or crashed. It is never io.EOF, so a
// killed reader can never pass for a complete, short input.
var ErrHelperVanished = errors.New("the stdin reader ended unexpectedly")

// ErrStopped is returned by Read after Stop.
var ErrStopped = errors.New("the stdin reader was stopped")

// StdinError is a read error the helper got from fd 0.
type StdinError struct{ Msg string }

func (e *StdinError) Error() string { return "reading stdin failed: " + e.Msg }

// Options configures StartWith. The zero value is what Start uses.
type Options struct {
	// Exe and Args are the helper command. Empty Exe means os.Executable()
	// with Args = [HelperArg]. The death flag is appended after Args.
	Exe  string
	Args []string
	// Stdin is handed to the helper as its fd 0. Nil means os.Stdin. It is
	// passed as the *os.File itself, never copied or read by this process.
	Stdin *os.File
	// Stderr is the helper's stderr. Nil means os.Stderr. It must be an
	// *os.File so that Wait does not depend on a copy goroutine.
	Stderr *os.File
}

// Pump is a running helper. Read and Stop may be called from different
// goroutines; Read itself is for one goroutine at a time.
type Pump struct {
	cmd    *exec.Cmd
	pr     *os.File // read end of the helper's output; only this process holds it
	deathW *os.File // write end of the parent-death pipe; only this process holds it

	waited  chan struct{} // closed when cmd.Wait returned
	waitErr error

	// Read state, owned by the reading goroutine.
	remaining uint32 // bytes left in the current data frame
	readErr   error  // sticky terminal result

	mu      sync.Mutex
	sawEnd  bool // the end marker was decoded
	stopped bool

	stopOnce sync.Once
	stopErr  error
}

// Start launches the helper for os.Stdin: `<this executable> __pump-stdin`.
func Start() (*Pump, error) { return StartWith(Options{}) }

// StartWith launches the helper described by o.
func StartWith(o Options) (*Pump, error) {
	exe, args := o.Exe, o.Args
	if exe == "" {
		self, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("stdin reader: locating this executable: %w", err)
		}
		exe, args = self, []string{HelperArg}
	}
	stdin := o.Stdin
	if stdin == nil {
		stdin = os.Stdin
	}
	stderr := o.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("stdin reader: %w", err)
	}
	deathR, deathW, err := os.Pipe()
	if err != nil {
		pr.Close()
		pw.Close()
		return nil, fmt.Errorf("stdin reader: %w", err)
	}

	cmd := exec.Command(exe, args...)
	cmd.Stdin = stdin // the *os.File itself: the child gets the descriptor, nothing is copied
	cmd.Stdout = pw
	cmd.Stderr = stderr
	passDeathPipe(cmd, deathR) // appends DeathFlag and its value to cmd.Args

	startErr := cmd.Start()
	// This process keeps only the read end of the output and the write end of
	// the death pipe. Closing pw here is what makes the helper's death visible
	// as end of file on pr; closing deathR makes this process's death the only
	// thing that can end the helper's death-pipe read.
	pw.Close()
	deathR.Close()
	if startErr != nil {
		pr.Close()
		deathW.Close()
		return nil, fmt.Errorf("stdin reader: starting %s: %w", HelperArg, startErr)
	}
	p := &Pump{cmd: cmd, pr: pr, deathW: deathW, waited: make(chan struct{})}
	go func() {
		p.waitErr = cmd.Wait()
		close(p.waited)
	}()
	return p, nil
}

// Pid is the helper's process ID, the only process Stop ever signals.
func (p *Pump) Pid() int { return p.cmd.Process.Pid }

// Read returns bytes the helper read from fd 0, in order. It returns io.EOF
// only after the helper's end marker, ErrHelperVanished if its pipe ended
// without one, a *StdinError for a read error on fd 0, and ErrStopped after
// Stop. Every non-nil error is terminal.
func (p *Pump) Read(b []byte) (int, error) {
	if p.readErr != nil {
		return 0, p.readErr
	}
	if len(b) == 0 {
		return 0, nil
	}
	for p.remaining == 0 {
		var hdr [4]byte
		if _, err := io.ReadFull(p.pr, hdr[:]); err != nil {
			return 0, p.fail(err)
		}
		switch n := binary.BigEndian.Uint32(hdr[:]); {
		case n == frameEnd:
			p.mu.Lock()
			p.sawEnd = true
			p.mu.Unlock()
			p.readErr = io.EOF
			return 0, io.EOF
		case n == frameErr:
			if _, err := io.ReadFull(p.pr, hdr[:]); err != nil {
				return 0, p.fail(err)
			}
			l := binary.BigEndian.Uint32(hdr[:])
			if l > maxErrMsgBytes {
				return 0, p.fail(errMalformed)
			}
			msg := make([]byte, l)
			if _, err := io.ReadFull(p.pr, msg); err != nil {
				return 0, p.fail(err)
			}
			p.readErr = &StdinError{Msg: string(msg)}
			return 0, p.readErr
		case n > HelperChunk:
			return 0, p.fail(errMalformed)
		default:
			p.remaining = n
		}
	}
	if uint32(len(b)) > p.remaining {
		b = b[:p.remaining]
	}
	n, err := io.ReadFull(p.pr, b)
	p.remaining -= uint32(n)
	if err != nil {
		return n, p.fail(err)
	}
	return n, nil
}

var errMalformed = errors.New("the stdin reader sent a malformed frame")

// fail maps a pipe failure to the terminal Read error.
func (p *Pump) fail(err error) error {
	p.mu.Lock()
	stopped := p.stopped
	p.mu.Unlock()
	switch {
	case stopped:
		p.readErr = ErrStopped
	case errors.Is(err, errMalformed):
		p.readErr = err
	default:
		// io.EOF, io.ErrUnexpectedEOF or a pipe error: the helper is gone
		// without having said it reached the end.
		p.readErr = ErrHelperVanished
	}
	return p.readErr
}

// Stop ends the helper and releases a Read in progress. It is idempotent and
// safe to call concurrently with Read and with itself.
//
// Before the end marker it kills the exact helper process at once. After the
// marker the helper is expected to exit by itself; Stop waits ExitGrace for
// that and kills it only if it has not. Either way it then waits at most
// KillGrace for the helper to be reaped, and returns an error naming the PID if
// it was not. The output pipe and the death pipe are closed last, whatever
// happened.
func (p *Pump) Stop() error {
	p.stopOnce.Do(func() { p.stopErr = p.stop() })
	return p.stopErr
}

func (p *Pump) stop() error {
	p.mu.Lock()
	p.stopped = true
	sawEnd := p.sawEnd
	p.mu.Unlock()

	defer p.deathW.Close()
	defer p.pr.Close()

	if sawEnd {
		if waitFor(p.waited, ExitGrace) {
			return nil
		}
	}
	// Kill after the child was reaped is a harmless os.ErrProcessDone: the
	// Process handle, not the numeric PID, is what is signalled.
	_ = p.cmd.Process.Kill()
	if waitFor(p.waited, KillGrace) {
		return nil
	}
	return fmt.Errorf("stdin reader (pid %d) was not reaped %v after it was killed", p.Pid(), KillGrace)
}

// Exited reports whether the helper has been reaped.
func (p *Pump) Exited() bool {
	select {
	case <-p.waited:
		return true
	default:
		return false
	}
}

func waitFor(c <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-c:
		return true
	case <-t.C:
		return false
	}
}
