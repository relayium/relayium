package coturnbridge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// EpochSource reads the identity of the coturn process currently running.
type EpochSource interface {
	Read() (Epoch, error)
}

// ErrNoProvider means no coturn process could be identified right now.
var ErrNoProvider = errors.New("coturnbridge: no coturn process")

// errNoProcess is processStart's answer for a PID that names no process.
var errNoProcess = errors.New("no such process")

// ProcessEpochSource identifies coturn by its main PID (from a pidfile or a
// systemd unit), that process's start time and the machine boot id. The
// process name must be turnserver, so a stale pidfile naming a reused PID is
// never mistaken for coturn.
type ProcessEpochSource struct {
	PIDFile     string // e.g. /run/turnserver/turnserver.pid
	SystemdUnit string // e.g. coturn (used when PIDFile is empty)
	Comm        string // expected process name; default "turnserver"
}

func (p *ProcessEpochSource) pid() (int, error) {
	var raw string
	switch {
	case p.PIDFile != "":
		b, err := os.ReadFile(p.PIDFile)
		if err != nil {
			return 0, fmt.Errorf("%w: %v", ErrNoProvider, err)
		}
		raw = string(b)
	case p.SystemdUnit != "":
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "systemctl", "show", "--property=MainPID", "--value", p.SystemdUnit).Output()
		if err != nil {
			return 0, fmt.Errorf("%w: systemctl: %v", ErrNoProvider, err)
		}
		raw = string(out)
	default:
		return 0, errors.New("coturnbridge: no pidfile or systemd unit configured")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("%w: pid %q", ErrNoProvider, strings.TrimSpace(raw))
	}
	return pid, nil
}

// Read returns the current epoch.
func (p *ProcessEpochSource) Read() (Epoch, error) {
	pid, err := p.pid()
	if err != nil {
		return Epoch{}, err
	}
	comm := p.Comm
	if comm == "" {
		comm = "turnserver"
	}
	boot, err := bootID()
	if err != nil {
		return Epoch{}, err
	}
	name, start, err := processStart(pid)
	if err != nil {
		return Epoch{}, fmt.Errorf("%w: pid %d: %v", ErrNoProvider, pid, err)
	}
	if name != comm {
		return Epoch{}, fmt.Errorf("%w: pid %d is %q, not %q", ErrNoProvider, pid, name, comm)
	}
	return Epoch{BootID: boot, PID: pid, StartTicks: start}, nil
}

// Alive reports whether the process of e still exists. False only when the
// boot changed or the PID now names no process or another process (a
// different start time or name); an unreadable state counts as alive.
func (p *ProcessEpochSource) Alive(e Epoch) bool {
	boot, err := bootID()
	if err != nil {
		return true
	}
	if boot != e.BootID {
		return false
	}
	comm := p.Comm
	if comm == "" {
		comm = "turnserver"
	}
	name, start, err := processStart(e.PID)
	if err != nil {
		return !errors.Is(err, os.ErrNotExist) && !errors.Is(err, errNoProcess)
	}
	return name == comm && start == e.StartTicks
}
