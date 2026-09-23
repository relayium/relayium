// Package sshx spawns the system ssh binary and exposes its stdio as a duplex
// stream, so the transfer engine runs over the user's existing SSH config,
// agent, known_hosts, and ProxyJump. Host-key verification (known_hosts) is the
// anti-MITM mechanism for the CLI's SSH-native path.
package sshx

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

type Opts struct {
	IdentityFile string
	Port         int
	ExtraArgs    []string
}

// BuildArgs assembles the argv passed to `ssh` (excluding the leading "ssh").
func BuildArgs(e xfer.Endpoint, remoteCmd string, o Opts) []string {
	var args []string
	if o.IdentityFile != "" {
		args = append(args, "-i", o.IdentityFile)
	}
	if o.Port != 0 {
		args = append(args, "-p", strconv.Itoa(o.Port))
	}
	args = append(args, o.ExtraArgs...)
	host := e.Host
	if e.User != "" {
		host = e.User + "@" + e.Host
	}
	// "--" ends ssh option parsing so a host that looks like a flag (e.g.
	// "-oProxyCommand=...") can't be interpreted as an option. ParseEndpoint
	// also rejects such hosts; this is defense in depth for direct callers.
	args = append(args, "--", host, remoteCmd)
	return args
}

// Session is a running ssh child process presented as a duplex stream.
type Session struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	out      io.ReadCloser
	waitOnce sync.Once
	done     chan struct{} // closed once the child has been reaped
	waitErr  error         // written before done is closed
}

func (s *Session) Read(p []byte) (int, error)  { return s.out.Read(p) }
func (s *Session) Write(p []byte) (int, error) { return s.in.Write(p) }

// startWait makes sure exactly one goroutine reaps the child. Close, Wait and
// Abort all read the same cached exit error, in any order and concurrently,
// without the second caller hitting "exec: Wait was already called" and
// masking the real exit status.
func (s *Session) startWait() {
	s.waitOnce.Do(func() {
		go func() {
			s.waitErr = s.cmd.Wait()
			close(s.done)
		}()
	})
}

func (s *Session) wait() error {
	s.startWait()
	<-s.done
	return s.waitErr
}

// Close closes the child's stdin (signalling EOF to the remote) and waits.
// It trusts the peer to finish: use Abort when this side is giving up.
func (s *Session) Close() error {
	s.in.Close()
	return s.wait()
}

// Wait blocks until ssh exits.
func (s *Session) Wait() error { return s.wait() }

// Abort grace periods. Vars so tests can shorten them; the total is the bound
// on how long Abort can take for a child that ignores everything but SIGKILL.
var (
	abortGrace = 2 * time.Second // after closing both pipes
	termGrace  = 2 * time.Second // after SIGTERM
	killGrace  = 5 * time.Second // after SIGKILL: only a kernel-stuck child reaches this
)

// Abort ends the session from this side without waiting on the peer, and
// reaps the ssh child in bounded time. Use it on every path where this side
// has stopped reading: Close only closes ssh's stdin and then waits, which
// hangs behind a peer that keeps writing (a sender before v0.24.0 ignores a
// refusal and streams the whole body) or a peer that never answers at all.
//
// It closes ssh's stdout read end (ssh's next write fails) and its stdin
// (ssh forwards EOF), and gives ssh abortGrace to exit on its own. A child
// still running then gets SIGTERM — ssh's own handler tears down the channel
// and any ProxyCommand it started — and, termGrace later, SIGKILL. Signals go
// to this one owned PID only, never to a process group or by name. Killing
// ssh drops the connection, which ends the remote command's session.
//
// It returns the same cached exit error as Close and Wait, and it is safe to
// call concurrently with either — including to unblock a Close that is stuck
// waiting — and more than once.
func (s *Session) Abort() error {
	s.out.Close()
	s.in.Close()
	s.startWait()
	if s.waitFor(abortGrace) {
		return s.waitErr
	}
	if err := s.cmd.Process.Signal(syscall.SIGTERM); err == nil && s.waitFor(termGrace) {
		return s.waitErr
	}
	// Kill after the child was reaped is a harmless os.ErrProcessDone: the
	// Process handle, not the numeric PID, is what is signalled.
	_ = s.cmd.Process.Kill()
	if s.waitFor(killGrace) {
		return s.waitErr
	}
	return fmt.Errorf("ssh (pid %d) did not exit %v after SIGKILL", s.cmd.Process.Pid, killGrace)
}

func (s *Session) waitFor(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-s.done:
		return true
	case <-t.C:
		return false
	}
}

// Dial starts `ssh <args> host remoteCmd` and returns its stdio as a stream.
// ssh's own stderr is inherited so host-key prompts and errors reach the user.
func Dial(e xfer.Endpoint, remoteCmd string, o Opts) (*Session, error) {
	cmd := exec.Command("ssh", BuildArgs(e, remoteCmd, o)...)
	cmd.Stderr = os.Stderr
	return start(cmd)
}

// start runs cmd with its stdin and stdout as the session's pipes. Split from
// Dial so tests can drive a Session over a child they control.
func start(cmd *exec.Cmd) (*Session, error) {
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &Session{cmd: cmd, in: in, out: out, done: make(chan struct{})}, nil
}

// RemoteHasRelayium reports whether `relayium` is on the remote's PATH.
func RemoteHasRelayium(e xfer.Endpoint, o Opts) (bool, error) {
	cmd := exec.Command("ssh", BuildArgs(e, "command -v relayium", o)...)
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		// ssh itself exits 255 on connection/auth failure; distinguish that
		// from the remote shell's exit 1 for a missing `relayium` binary.
		if ee.ExitCode() == 255 {
			host := e.Host
			if e.User != "" {
				host = e.User + "@" + e.Host
			}
			return false, fmt.Errorf("ssh: could not connect to %s", host)
		}
		return false, nil // non-zero exit = not found
	}
	return false, fmt.Errorf("ssh probe failed: %w", err)
}
