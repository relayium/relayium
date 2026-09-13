package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"time"
)

// Guarded is the one job this process owns, and everything it is permitted to
// do to it. There is deliberately no "terminate this PID" on this interface.
type Guarded interface {
	// PID of the direct child. For the ledger only — nothing terminates by it.
	PID() int
	// ActiveProcesses is how many processes are still in the job, descendants
	// included. This is the whole-tree proof; a parent's exit status is not.
	ActiveProcesses() (uint32, error)
	// Terminate ends every process in the job.
	Terminate() error
	// Close releases the job handle. With KILL_ON_JOB_CLOSE set, this is also
	// what makes an unexpected death of THIS process clean up the tree.
	Close() error
}

// Launcher starts a guarded process. Replaced in tests; the production
// implementation is the Windows one.
type Launcher func(Config) (Guarded, error)

// Disposals a failed launch may report about the process it created.
const (
	// Nothing was ever created.
	DisposalNone = "none"
	// A process was created and this program OBSERVED it end.
	DisposalExited = "exited"
	// A process was created and this program cannot show it is gone.
	DisposalUnproven = "unproven"
)

// LaunchError is a launch that failed, and everything this program can say
// about what it left behind.
//
// # Why a failed launch has a ledger at all
//
// The first version of this returned a bare error, and the driver answered it
// with "there is no tree to account for". That is only true when nothing was
// created. A launch fails most interestingly AFTER `CreateProcess` has
// succeeded — the assignment is refused, or the resume is — and at that instant
// a real process exists with a real PID. If its disposal then fails too, a bare
// error erases the one piece of information anybody would need to clean it up,
// and the run reports an empty world while a suspended process sits outside
// every job this program owns.
//
// So a failed launch carries the PID it created, what was actually observed
// about ending it, and the findings. `Run` publishes that ledger exactly as it
// publishes a successful one.
type LaunchError struct {
	// Which step failed, for the report.
	Op string
	// The underlying failure.
	Err error
	// Non-zero when a process was actually created — recorded ESPECIALLY when
	// it could not be disposed of.
	ChildPID int
	// One of DisposalNone, DisposalExited, DisposalUnproven.
	Disposal string
	// Everything observed along the way, including a termination that failed.
	Findings []string
}

func (e *LaunchError) Error() string {
	return fmt.Sprintf("%s: %v", e.Op, e.Err)
}

func (e *LaunchError) Unwrap() error { return e.Err }

// Clock is injected so the driver's budgets are testable without spending them.
type Clock interface {
	Now() time.Time
	Sleep(time.Duration)
}

type realClock struct{}

func (realClock) Now() time.Time        { return time.Now() }
func (realClock) Sleep(d time.Duration) { time.Sleep(d) }

// Run drives one guarded process from launch to a proven outcome.
//
// Returns the process exit code. It is 0 only when the job is provably EMPTY
// and nothing was found along the way; every other path is non-zero, including
// the ones where the direct child exited cleanly. A green parent is not
// whole-tree closure and this program never reports it as one.
func Run(cfg Config, launch Launcher, in io.Reader, reporter *Reporter, clock Clock) int {
	if clock == nil {
		clock = realClock{}
	}
	var findings []string
	note := func(format string, args ...any) {
		finding := fmt.Sprintf(format, args...)
		findings = append(findings, finding)
		_ = reporter.Emit(Record{Kind: "finding", Finding: finding})
	}

	guarded, err := launch(cfg)
	if err != nil {
		note("the guarded process was not launched: %v", err)
		// A launch that failed after creating a process still owns that
		// process's identity, and publishing it is the whole difference between
		// "clean up pid N" and "something may be running somewhere".
		var failure *LaunchError
		if errors.As(err, &failure) {
			for _, finding := range failure.Findings {
				note("%s", finding)
			}
			if failure.ChildPID != 0 {
				if err := reporter.Emit(Record{
					Kind:       "ledger",
					PID:        failure.ChildPID,
					Executable: cfg.Executable,
					ArgCount:   len(cfg.Args),
					// False, and said so: the process is NOT in a job this
					// program holds, so no handle close will collect it.
					JobHandleHeld: false,
				}); err != nil {
					note("the ledger for the undisposed process could not be written: %v", err)
				}
			}
			switch failure.Disposal {
			case DisposalExited:
				// Created, and its exit OBSERVED. Nothing is outstanding.
				note("the process created by the failed launch (pid %d) was ended and its exit observed",
					failure.ChildPID)
			case DisposalUnproven:
				note("pid %d was created by the failed launch and this program CANNOT show it ended; "+
					"it is outside every job held here, so no handle close will collect it",
					failure.ChildPID)
			}
		}
		_ = reporter.Emit(Record{Kind: "closed", Outcome: OutcomeUnproven, Findings: findings})
		return 1
	}

	// The ledger, BEFORE anything is waited on. If this program is killed in
	// the next instant, this line is what makes the process it started
	// attributable — and KILL_ON_JOB_CLOSE is what makes it cleaned up.
	if err := reporter.Emit(Record{
		Kind:          "ledger",
		PID:           guarded.PID(),
		Executable:    cfg.Executable,
		ArgCount:      len(cfg.Args),
		JobHandleHeld: true,
	}); err != nil {
		note("the ledger could not be written: %v", err)
	}

	mode, err := readUntilShutdown(in, guarded, reporter, note)
	if err != nil {
		note("%v", err)
	}

	active, outcome := settle(guarded, mode, cfg, clock, note)

	// Always released. With KILL_ON_JOB_CLOSE this is the last backstop, and it
	// runs whether the outcome above was proven or not.
	if err := guarded.Close(); err != nil {
		note("the job handle could not be closed: %v", err)
	}

	_ = reporter.Emit(Record{
		Kind:        "closed",
		Outcome:     outcome,
		ActiveAfter: &active,
		Findings:    findings,
	})
	if outcome == OutcomeUnproven || active != 0 || len(findings) > 0 {
		return 1
	}
	return 0
}

// readUntilShutdown serves accounting queries until it is told to shut down.
//
// End of input is NOT "carry on": the owner has gone away, so the tree is ended
// rather than left running. That is the opposite of the default a fixture wants
// from a crash.
func readUntilShutdown(in io.Reader, guarded Guarded, reporter *Reporter, note func(string, ...any)) (string, error) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		cmd, err := ParseCommand(line)
		if err != nil {
			// Refused, not guessed. The command stream stays open so the owner
			// can send a well-formed one.
			note("%v", err)
			continue
		}
		switch cmd.Command {
		case CommandAccounting:
			active, err := guarded.ActiveProcesses()
			if err != nil {
				note("the job could not be counted: %v", err)
				continue
			}
			_ = reporter.Emit(Record{Kind: "accounting", ActiveProcesses: &active})
		case CommandShutdown:
			return cmd.Mode, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return ModeTerminate, fmt.Errorf("the command stream failed, so the job is being ended: %w", err)
	}
	return ModeTerminate, errors.New("the command stream ended without a shutdown, so the job is being ended")
}

// settle brings the job to a state this program can prove, and names it.
func settle(guarded Guarded, mode string, cfg Config, clock Clock, note func(string, ...any)) (uint32, string) {
	if mode == ModeJoin {
		// The caller has already asked the target to shut itself down — for a
		// browser, CDP `Browser.close`, which is the only teardown that lets
		// Chrome account for its own children. This waits for that to be TRUE,
		// rather than assuming it worked.
		active, ok := waitForEmpty(guarded, cfg.JoinBudgetMs, clock, note)
		if ok {
			return active, OutcomeJoined
		}
		note("the job still held %d process(es) after the %dms graceful budget; escalating to termination",
			active, cfg.JoinBudgetMs)
		// Fall through: a graceful path that did not work is reported AND
		// followed by the forced one, so the machine is not left dirty because
		// the polite request was ignored.
	}

	if err := guarded.Terminate(); err != nil {
		note("the job could not be terminated: %v", err)
		active, _ := guarded.ActiveProcesses()
		return active, OutcomeUnproven
	}
	active, ok := waitForEmpty(guarded, cfg.TerminateBudgetMs, clock, note)
	if !ok {
		note("the job still held %d process(es) after termination and %dms", active, cfg.TerminateBudgetMs)
		return active, OutcomeUnproven
	}
	return active, OutcomeTerminated
}

// waitForEmpty polls the job's own accounting. A count it cannot read is not
// zero: an unreadable job is reported as unproven, never as clean.
func waitForEmpty(guarded Guarded, budgetMs int, clock Clock, note func(string, ...any)) (uint32, bool) {
	deadline := clock.Now().Add(time.Duration(budgetMs) * time.Millisecond)
	var last uint32
	var readFailed bool
	for {
		active, err := guarded.ActiveProcesses()
		if err != nil {
			if !readFailed {
				readFailed = true
				note("the job could not be counted: %v", err)
			}
		} else {
			last = active
			readFailed = false
			if active == 0 {
				return 0, true
			}
		}
		if !clock.Now().Before(deadline) {
			if readFailed {
				// Unknown, and said so. Reporting the last successful reading
				// as the current one would be inventing a count.
				return last, false
			}
			return last, false
		}
		clock.Sleep(100 * time.Millisecond)
	}
}
