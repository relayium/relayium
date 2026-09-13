package main

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// Record is one line of this helper's report.
//
// A stream of JSON lines rather than a summary at the end, because the thing
// most worth knowing — the identity of the process that was started — has to
// survive the helper being killed a moment later. The ledger is written and
// flushed BEFORE anything is waited on, for the same reason the Node side
// records its own ledger before its first await: attribution that only exists
// after a clean finish is attribution that is absent exactly when it is needed.
type Record struct {
	Kind string `json:"kind"`

	// kind=ledger
	PID           int    `json:"pid,omitempty"`
	Executable    string `json:"executable,omitempty"`
	ArgCount      int    `json:"argCount,omitempty"`
	JobHandleHeld bool   `json:"jobHandleHeld,omitempty"`

	// kind=accounting, kind=closed
	ActiveProcesses *uint32 `json:"activeProcesses,omitempty"`
	ActiveBefore    *uint32 `json:"activeBefore,omitempty"`
	ActiveAfter     *uint32 `json:"activeAfter,omitempty"`

	// kind=closed
	Outcome string `json:"outcome,omitempty"`

	// kind=finding, and carried on kind=closed
	Finding  string   `json:"finding,omitempty"`
	Findings []string `json:"findings,omitempty"`
}

// Outcomes this helper is allowed to report. Anything not in this set is a bug
// in this program rather than a state of the world.
const (
	// The tree went away on its own after the caller's graceful shutdown.
	OutcomeJoined = "joined"
	// The job was terminated and is provably empty.
	OutcomeTerminated = "terminated"
	// The job could not be shown to be empty. NEVER reported as success.
	OutcomeUnproven = "unproven"
)

// Reporter writes records, one JSON object per line, flushing each.
type Reporter struct {
	mu  sync.Mutex
	out io.Writer
}

func NewReporter(out io.Writer) *Reporter { return &Reporter{out: out} }

func (r *Reporter) Emit(rec Record) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	encoded, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("could not encode a %q record: %w", rec.Kind, err)
	}
	if _, err := r.out.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("could not write a %q record: %w", rec.Kind, err)
	}
	if flusher, ok := r.out.(interface{ Sync() error }); ok {
		// Best effort: an unflushed ledger is the failure this exists to avoid,
		// but a pipe that cannot be synced is not itself an error.
		_ = flusher.Sync()
	}
	return nil
}

// Command is one instruction from the owner on stdin.
type Command struct {
	Command string `json:"command"`
	// mode=join waits for the tree to leave on its own; mode=terminate ends it.
	Mode string `json:"mode"`
}

const (
	CommandAccounting = "accounting"
	CommandShutdown   = "shutdown"
	ModeJoin          = "join"
	ModeTerminate     = "terminate"
)

// ParseCommand refuses anything it does not recognise rather than defaulting to
// one of the two shutdown behaviours. Guessing between "wait for it" and "kill
// it" is not a recoverable mistake.
func ParseCommand(line []byte) (Command, error) {
	var cmd Command
	if err := json.Unmarshal(line, &cmd); err != nil {
		return cmd, fmt.Errorf("malformed command: %w", err)
	}
	switch cmd.Command {
	case CommandAccounting:
		return cmd, nil
	case CommandShutdown:
		if cmd.Mode != ModeJoin && cmd.Mode != ModeTerminate {
			return cmd, fmt.Errorf("shutdown mode %q is neither %q nor %q", cmd.Mode, ModeJoin, ModeTerminate)
		}
		return cmd, nil
	default:
		return cmd, fmt.Errorf("unknown command %q", cmd.Command)
	}
}
