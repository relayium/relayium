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
	args = append(args, host, remoteCmd)
	return args
}

// Session is a running ssh child process presented as a duplex stream.
type Session struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	out      io.ReadCloser
	waitOnce sync.Once
	waitErr  error
}

func (s *Session) Read(p []byte) (int, error)  { return s.out.Read(p) }
func (s *Session) Write(p []byte) (int, error) { return s.in.Write(p) }

// wait reaps the child exactly once and caches its exit error, so Close and
// Wait can both be called (in any order) without the second one hitting
// "exec: Wait was already called" and masking the real exit status.
func (s *Session) wait() error {
	s.waitOnce.Do(func() { s.waitErr = s.cmd.Wait() })
	return s.waitErr
}

// Close closes the child's stdin (signalling EOF to the remote) and waits.
func (s *Session) Close() error {
	s.in.Close()
	return s.wait()
}

// Wait blocks until ssh exits.
func (s *Session) Wait() error { return s.wait() }

// Dial starts `ssh <args> host remoteCmd` and returns its stdio as a stream.
// ssh's own stderr is inherited so host-key prompts and errors reach the user.
func Dial(e xfer.Endpoint, remoteCmd string, o Opts) (*Session, error) {
	cmd := exec.Command("ssh", BuildArgs(e, remoteCmd, o)...)
	cmd.Stderr = os.Stderr
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
	return &Session{cmd: cmd, in: in, out: out}, nil
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
