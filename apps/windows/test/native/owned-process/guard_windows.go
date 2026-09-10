//go:build windows

package main

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// jobAccounting is the job's own census of itself.
//
// Declared here because `x/sys/windows` binds the query but not this structure.
// The layout is `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` exactly as Windows
// documents it; the fields before ActiveProcesses are present so the offset is
// right, not because anything reads them.
type jobAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

// The Windows calls the failure paths depend on, in one place so a test can
// refuse them.
//
// # Why this indirection exists
//
// The branches below are the ones that decide whether a process this program
// cannot account for is ever allowed to run, and whether a disposal it could
// not complete is ever reported as done. A healthy Windows will not refuse a
// legitimate `AssignProcessToJobObject`, will not fail `TerminateProcess`
// against a handle it just created, and will not leave a terminated process
// unsignalled — so without this those branches could only be reviewed, never
// executed, and "it looks right" is not the standard this fixture is held to.
//
// This is a test-only program. None of these fields is reachable from its
// config, its command stream or its command line; only its own tests set them.
type windowsOps struct {
	assignProcessToJobObject func(job windows.Handle, process windows.Handle) error
	terminateProcess         func(process windows.Handle, exitCode uint32) error
	waitForSingleObject      func(handle windows.Handle, waitMs uint32) (uint32, error)
	resumeThread             func(thread windows.Handle) (uint32, error)
}

var ops = windowsOps{
	assignProcessToJobObject: windows.AssignProcessToJobObject,
	terminateProcess:         windows.TerminateProcess,
	waitForSingleObject:      windows.WaitForSingleObject,
	resumeThread:             windows.ResumeThread,
}

// terminateAndObserve ends one process and waits until Windows says it ended.
//
// `TerminateProcess` is ASYNCHRONOUS. It requests termination and returns as
// soon as the request is made; the process is still running when the call
// succeeds. Treating that return as proof of death — which the first version of
// this file did — is the same mistake as treating a parent's exit as a tree's
// closure, one layer down. The process handle becoming SIGNALLED is what
// actually says the process is gone, and nothing here reports a disposal it did
// not observe.
func terminateAndObserve(process windows.Handle, budgetMs int) (string, []string) {
	var findings []string
	if err := ops.terminateProcess(process, 1); err != nil {
		// Not fatal by itself — the process may already have been on its way
		// out — but it is recorded, and the wait below still has to succeed.
		findings = append(findings, fmt.Sprintf("TerminateProcess was refused: %v", err))
	}
	event, err := ops.waitForSingleObject(process, uint32(budgetMs))
	if err != nil {
		findings = append(findings, fmt.Sprintf(
			"the process could not be waited on, so its exit was never observed: %v", err))
		return DisposalUnproven, findings
	}
	if event != uint32(windows.WAIT_OBJECT_0) {
		findings = append(findings, fmt.Sprintf(
			"the process was not signalled within %dms (wait returned 0x%x), so its exit was never observed",
			budgetMs, event))
		return DisposalUnproven, findings
	}
	return DisposalExited, findings
}

type windowsJob struct {
	job     windows.Handle
	process windows.Handle
	pid     int
	closed  bool
}

// Launch starts the target INSIDE a job it can never have escaped.
//
// # The ordering is the guarantee
//
// The process is created SUSPENDED, assigned to the job, and only then resumed.
// That order is the whole mechanism. `exec.Start` followed by an assignment is
// the obvious alternative and it is racy in exactly the way that matters: the
// target runs for the interval between those two calls, and a browser started
// that way can fork its first renderer before it is ever put in the job. Such a
// child belongs to no job, is not accounted for by this program's census, and
// survives every teardown it performs — a leak that a green run would report as
// a clean one.
//
// Created suspended, the target has not executed one instruction when the
// assignment happens, so there is no interval in which a descendant can be born
// outside the job.
//
// # If the assignment fails
//
// The target is still suspended and has still never run. It is terminated
// outright rather than resumed: a process this program cannot account for must
// not be allowed to start, and least of all be handed back to a caller that
// would believe it was guarded.
func Launch(cfg Config) (Guarded, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("could not create a job object: %w", err)
	}
	// KILL_ON_JOB_CLOSE: when the last handle to this job goes, every process
	// still in it is terminated. That covers the case no explicit teardown can
	// — THIS program being killed — because the OS closes the handle for it.
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("could not set KILL_ON_JOB_CLOSE on the job: %w", err)
	}

	appName, err := windows.UTF16PtrFromString(cfg.Executable)
	if err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("the executable path is not usable: %w", err)
	}
	// The application name is passed SEPARATELY from the command line, so the
	// executable that runs is the validated absolute path and never the result
	// of Windows' search of an unquoted command line.
	commandLine, err := windows.UTF16PtrFromString(
		windows.ComposeCommandLine(append([]string{cfg.Executable}, cfg.Args...)))
	if err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("the command line is not usable: %w", err)
	}
	var workingDirectory *uint16
	if cfg.WorkingDirectory != "" {
		if workingDirectory, err = windows.UTF16PtrFromString(cfg.WorkingDirectory); err != nil {
			windows.CloseHandle(job)
			return nil, fmt.Errorf("the working directory is not usable: %w", err)
		}
	}

	var startup windows.StartupInfo
	startup.Cb = uint32(unsafe.Sizeof(startup))
	var info windows.ProcessInformation
	if err := windows.CreateProcess(
		appName,
		commandLine,
		nil, nil, false,
		windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT,
		nil,
		workingDirectory,
		&startup,
		&info,
	); err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("could not start %q suspended: %w", cfg.Executable, err)
	}

	if err := ops.assignProcessToJobObject(job, info.Process); err != nil {
		// The process is suspended, so it has run nothing and has no
		// descendants. But it is NOT in the job, so closing the job protects
		// nothing at all here: this one process has to be ended on its own, and
		// its exit has to be OBSERVED before anything claims it is gone.
		windows.CloseHandle(info.Thread)
		disposal, findings := terminateAndObserve(info.Process, cfg.TerminateBudgetMs)
		failure := &LaunchError{
			Op:       "assign the suspended process to the job",
			Err:      err,
			ChildPID: int(info.ProcessId),
			Disposal: disposal,
			Findings: findings,
		}
		if disposal == DisposalExited {
			windows.CloseHandle(info.Process)
			windows.CloseHandle(job)
			return nil, failure
		}
		// Deliberately NOT closed. The process handle is what keeps this pid
		// unambiguous for whoever disposes of it — a pid whose handle has been
		// released can be reused by Windows for something else, and a cleanup
		// aimed at a recycled pid is exactly the unattributable kill this whole
		// program exists to make impossible. The handles are released by the OS
		// when this program exits, moments from now.
		failure.Findings = append(failure.Findings,
			"the process handle is retained rather than closed, so this pid cannot be recycled "+
				"under whoever disposes of it")
		return nil, failure
	}

	if _, err := ops.resumeThread(info.Thread); err != nil {
		windows.CloseHandle(info.Thread)
		// It IS in the job now, so the job is the disposal — but a job that has
		// been terminated is not a job that has been shown to be empty, and
		// KILL_ON_JOB_CLOSE is a promise about the future rather than an
		// observation about now. Both are checked before anything is claimed.
		guarded := &windowsJob{job: job, process: info.Process, pid: int(info.ProcessId)}
		disposal, findings := disposeJob(guarded, cfg.TerminateBudgetMs)
		failure := &LaunchError{
			Op:       "resume the guarded process",
			Err:      err,
			ChildPID: int(info.ProcessId),
			Disposal: disposal,
			Findings: findings,
		}
		if disposal == DisposalExited {
			_ = guarded.Close()
			return nil, failure
		}
		failure.Findings = append(failure.Findings,
			"the job and process handles are retained rather than closed, so the pid cannot be recycled; "+
				"KILL_ON_JOB_CLOSE will still collect the job when this program exits, but that is not "+
				"something this run observed")
		return nil, failure
	}
	// The thread handle has done its work; the process handle is retained so
	// the direct child can still be identified.
	windows.CloseHandle(info.Thread)

	return &windowsJob{job: job, process: info.Process, pid: int(info.ProcessId)}, nil
}

// disposeJob ends a job and waits until its own census says it is EMPTY.
//
// Used on the launch-failure path, where the alternative is to close the handle
// and rely on KILL_ON_JOB_CLOSE. That flag is real, but it is a guarantee about
// what happens after the last handle goes — not an observation this run can
// report. A disposal is only "exited" here when the count actually reached zero.
func disposeJob(guarded *windowsJob, budgetMs int) (string, []string) {
	var findings []string
	if err := guarded.Terminate(); err != nil {
		findings = append(findings, fmt.Sprintf("the job could not be terminated: %v", err))
		return DisposalUnproven, findings
	}
	deadline := time.Now().Add(time.Duration(budgetMs) * time.Millisecond)
	for {
		active, err := guarded.ActiveProcesses()
		if err != nil {
			findings = append(findings, fmt.Sprintf("the job could not be counted: %v", err))
			return DisposalUnproven, findings
		}
		if active == 0 {
			return DisposalExited, findings
		}
		if !time.Now().Before(deadline) {
			findings = append(findings, fmt.Sprintf(
				"the job still held %d process(es) %dms after termination", active, budgetMs))
			return DisposalUnproven, findings
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (w *windowsJob) PID() int { return w.pid }

// ActiveProcesses asks the JOB, not the parent.
//
// This is the only reading in this program that can support a claim about the
// whole tree. `WaitForSingleObject` on the parent says the parent has gone and
// says nothing whatever about the renderer and GPU children that outlive it.
func (w *windowsJob) ActiveProcesses() (uint32, error) {
	if w.closed {
		return 0, fmt.Errorf("the job handle is already closed, so it can no longer be counted")
	}
	var accounting jobAccounting
	if err := windows.QueryInformationJobObject(
		w.job,
		windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&accounting)),
		uint32(unsafe.Sizeof(accounting)),
		nil,
	); err != nil {
		return 0, fmt.Errorf("could not query the job's accounting: %w", err)
	}
	return accounting.ActiveProcesses, nil
}

// Terminate ends every process in the job — the only thing this program can
// terminate at all. There is no path here that takes a PID.
func (w *windowsJob) Terminate() error {
	if w.closed {
		return fmt.Errorf("the job handle is already closed, so it can no longer be terminated")
	}
	if err := windows.TerminateJobObject(w.job, 1); err != nil {
		return fmt.Errorf("could not terminate the job: %w", err)
	}
	return nil
}

func (w *windowsJob) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	var first error
	if err := windows.CloseHandle(w.process); err != nil {
		first = fmt.Errorf("could not close the process handle: %w", err)
	}
	// Last: with KILL_ON_JOB_CLOSE this is itself a teardown of anything still
	// inside.
	if err := windows.CloseHandle(w.job); err != nil && first == nil {
		first = fmt.Errorf("could not close the job handle: %w", err)
	}
	return first
}
