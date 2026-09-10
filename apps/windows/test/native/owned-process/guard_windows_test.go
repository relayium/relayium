//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// lockedBuffer collects the helper's report while it is being written from the
// goroutine running the driver.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

// The real thing, on the platform where it is the only thing that works.
//
// Every target here is THIS TEST BINARY, re-entered with an argument this file
// owns. Nothing in these tests starts anything a config could name, and nothing
// terminates anything by PID: the only teardown exercised is closing or ending
// the job that the test itself created.

const (
	roleFlag   = "--owned-process-role="
	markerFlag = "--owned-process-marker="

	roleIdle            = "idle"
	roleSpawnGrandchild = "spawn-grandchild"
	roleQuick           = "quick"
	// Runs the guardian itself, so a test can kill it as a process.
	roleGuardian = "guardian"
)

// TestMain re-enters this binary as the guarded target when it is asked to.
func TestMain(m *testing.M) {
	role, marker := "", ""
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, roleFlag) {
			role = strings.TrimPrefix(arg, roleFlag)
		}
		if strings.HasPrefix(arg, markerFlag) {
			marker = strings.TrimPrefix(arg, markerFlag)
		}
	}
	if role == "" {
		os.Exit(m.Run())
	}
	os.Exit(playRole(role, marker))
}

// playRole is the guarded process. It announces itself by writing its PID where
// the test can see it, which is what lets a test prove a GRANDCHILD died —
// independently of the job's own accounting.
func playRole(role, marker string) int {
	switch role {
	case roleQuick:
		// Deliberately never announces: an early death is a real case and the
		// test must see the accounting, not a marker.
		return 0
	case roleSpawnGrandchild:
		self, err := os.Executable()
		if err != nil {
			return 1
		}
		grandchild := exec.Command(self, roleFlag+roleIdle, markerFlag+marker+".grandchild")
		if err := grandchild.Start(); err != nil {
			return 1
		}
		announce(marker + ".parent")
		select {}
	case roleIdle:
		announce(marker)
		select {}
	case roleGuardian:
		self, err := os.Executable()
		if err != nil {
			return 1
		}
		cfg := Config{
			Purpose:           "self-test",
			Executable:        self,
			Args:              []string{roleFlag + roleSpawnGrandchild, markerFlag + marker},
			JoinBudgetMs:      60_000,
			TerminateBudgetMs: 60_000,
		}
		if err := cfg.Validate(); err != nil {
			return 1
		}
		guarded, err := Launch(cfg)
		if err != nil {
			return 1
		}
		// Holds the job handle and never returns. Whoever kills this process is
		// relying on the OS to close that handle for it.
		_ = guarded
		select {}
	}
	return 3
}

func announce(path string) {
	_ = os.WriteFile(path, []byte(fmt.Sprintf("%d", os.Getpid())), 0o600)
}

func selfConfig(t *testing.T, role, marker string, joinMs, killMs int) Config {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("could not find this test binary: %v", err)
	}
	cfg := Config{
		Purpose:           "self-test",
		Executable:        self,
		Args:              []string{roleFlag + role, markerFlag + marker},
		JoinBudgetMs:      joinMs,
		TerminateBudgetMs: killMs,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("the self-test config did not validate: %v", err)
	}
	return cfg
}

func waitForFile(t *testing.T, path string, budget time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(path); err == nil && len(raw) > 0 {
			var pid int
			if _, err := fmt.Sscanf(string(raw), "%d", &pid); err == nil {
				return pid
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never appeared within %s", path, budget)
	return 0
}

// stillRunning asks WINDOWS whether a pid is alive, without the job's help.
// This is how a test proves a grandchild is gone without trusting the accounting
// that is itself under test.
func stillRunning(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}

func waitUntilGone(pid int, budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if !stillRunning(pid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return !stillRunning(pid)
}

// The positive: a real child, a real grandchild, both held alive, and the job
// accounting for BOTH. This is the claim `ChildProcess.kill` cannot make.
func TestTheJobHoldsAChildAndItsGrandchildAndAccountsForBoth(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "role")
	guarded, err := Launch(selfConfig(t, roleSpawnGrandchild, marker, 5_000, 5_000))
	if err != nil {
		t.Fatalf("the guarded launch failed: %v", err)
	}
	t.Cleanup(func() { _ = guarded.Close() })

	childPID := waitForFile(t, marker+".parent", 30*time.Second)
	grandchildPID := waitForFile(t, marker+".grandchild", 30*time.Second)
	if childPID != guarded.PID() {
		t.Fatalf("the announced child pid %d is not the one the ledger recorded, %d", childPID, guarded.PID())
	}
	if grandchildPID == childPID {
		t.Fatal("the grandchild is the child; this test is not testing a tree")
	}

	active, err := guarded.ActiveProcesses()
	if err != nil {
		t.Fatalf("the job could not be counted: %v", err)
	}
	if active < 2 {
		t.Fatalf("the job accounted for %d process(es); a child and its grandchild are two", active)
	}
	if !stillRunning(grandchildPID) {
		t.Fatal("the grandchild was not alive while the job was held")
	}

	// And closing the job — with nothing else asked of it — takes the whole
	// tree, grandchild included. That is KILL_ON_JOB_CLOSE, and it is what
	// covers this program itself being killed.
	if err := guarded.Close(); err != nil {
		t.Fatalf("closing the job failed: %v", err)
	}
	if !waitUntilGone(grandchildPID, 20*time.Second) {
		t.Fatalf("the grandchild (pid %d) survived the job handle being closed", grandchildPID)
	}
	if !waitUntilGone(childPID, 20*time.Second) {
		t.Fatalf("the child (pid %d) survived the job handle being closed", childPID)
	}
}

// The forced path, end to end through the driver, with the tree's death proven
// against Windows rather than against the job's own report.
func TestAForcedShutdownEmptiesTheWholeTree(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "role")
	cfg := selfConfig(t, roleSpawnGrandchild, marker, 5_000, 20_000)

	var childPID, grandchildPID int
	code, records := runGuardian(t, cfg, `{"command":"shutdown","mode":"terminate"}`+"\n", func() {
		childPID = waitForFile(t, marker+".parent", 30*time.Second)
		grandchildPID = waitForFile(t, marker+".grandchild", 30*time.Second)
	})

	closed := findClosed(t, records)
	if code != 0 {
		t.Fatalf("a forced shutdown that should have been provable exited %d: %+v", code, closed)
	}
	if closed.Outcome != OutcomeTerminated {
		t.Fatalf("the outcome was %q, not %q: %+v", closed.Outcome, OutcomeTerminated, closed)
	}
	if closed.ActiveAfter == nil || *closed.ActiveAfter != 0 {
		t.Fatalf("the job was not empty afterwards: %+v", closed)
	}
	if !waitUntilGone(grandchildPID, 20*time.Second) {
		t.Fatalf("the grandchild (pid %d) outlived a run that reported a clean teardown", grandchildPID)
	}
	if !waitUntilGone(childPID, 20*time.Second) {
		t.Fatalf("the child (pid %d) outlived a run that reported a clean teardown", childPID)
	}
}

// Cannot-join: a target that will not leave on request. The graceful path must
// be reported as having FAILED — with a finding and a non-zero exit — even
// though the escalation then cleans up successfully.
func TestATargetThatWillNotLeaveIsReportedAndThenEnded(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "role")
	cfg := selfConfig(t, roleIdle, marker, 2_000, 20_000)

	var pid int
	code, records := runGuardian(t, cfg, `{"command":"shutdown","mode":"join"}`+"\n", func() {
		pid = waitForFile(t, marker, 30*time.Second)
	})

	closed := findClosed(t, records)
	if code == 0 {
		t.Fatal("a graceful join that never happened was reported as a clean run")
	}
	if len(closed.Findings) == 0 {
		t.Fatalf("no finding recorded the graceful path failing: %+v", closed)
	}
	if closed.ActiveAfter == nil || *closed.ActiveAfter != 0 {
		t.Fatalf("the escalation did not empty the job: %+v", closed)
	}
	if !waitUntilGone(pid, 20*time.Second) {
		t.Fatalf("the target (pid %d) survived the escalation", pid)
	}
}

// An early death is a real state of the world, and the honest report of it is
// that the job is empty — reached by counting the job, not by assuming.
func TestAChildThatExitsImmediatelyLeavesAnEmptyJob(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "role")
	cfg := selfConfig(t, roleQuick, marker, 20_000, 20_000)
	code, records := runGuardian(t, cfg, `{"command":"shutdown","mode":"join"}`+"\n", nil)
	closed := findClosed(t, records)
	if code != 0 || closed.Outcome != OutcomeJoined {
		t.Fatalf("a target that exited on its own was not reported as joined: code=%d %+v", code, closed)
	}
}

// The branch that decides whether an unaccountable process may run.
//
// The assignment is forced to fail while the target is still SUSPENDED. Three
// things must all hold: it is terminated rather than resumed (its marker file,
// the first thing it does when it runs, never appears); its exit is actually
// OBSERVED rather than assumed from TerminateProcess returning; and the failure
// carries the pid, so a disposal that had not worked would still be
// attributable.
func TestAFailedAssignmentTerminatesTheProcessAndObservesItsExit(t *testing.T) {
	restore := ops
	ops.assignProcessToJobObject = func(windows.Handle, windows.Handle) error {
		return errors.New("control: the assignment is refused")
	}
	t.Cleanup(func() { ops = restore })

	marker := filepath.Join(t.TempDir(), "role")
	guarded, err := Launch(selfConfig(t, roleIdle, marker, 5_000, 10_000))
	if err == nil {
		_ = guarded.Close()
		t.Fatal("a process that could not be put in the job was handed back as if it were guarded")
	}
	var failure *LaunchError
	if !errors.As(err, &failure) {
		t.Fatalf("the failure was not structured, so the pid it created is lost: %v", err)
	}
	if failure.ChildPID == 0 {
		t.Fatalf("a process was created and the failure does not name it: %+v", failure)
	}
	if failure.Disposal != DisposalExited {
		t.Fatalf("the disposal was %q, not an OBSERVED exit: %+v", failure.Disposal, failure)
	}
	if stillRunning(failure.ChildPID) {
		t.Fatalf("pid %d was reported as exited and is still running", failure.ChildPID)
	}
	// Suspended when the assignment failed, so it has never run. If it had been
	// resumed, this file would exist.
	time.Sleep(2 * time.Second)
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Fatal("the unassignable process ran anyway; it would have been outside the job entirely")
	}
}

// The disposal itself failing. Nothing may be reported as ended, and the pid
// must survive into the report — this is the exact case where a bare error
// would erase the only thing anybody could act on.
func TestAFailedAssignmentWhoseTerminationCANNOTBeObservedIsUNPROVEN(t *testing.T) {
	restore := ops
	ops.assignProcessToJobObject = func(windows.Handle, windows.Handle) error {
		return errors.New("control: the assignment is refused")
	}
	// The termination is refused AND the wait never signals: the process is
	// genuinely still there, and this program must say so.
	ops.terminateProcess = func(windows.Handle, uint32) error {
		return errors.New("control: TerminateProcess is refused")
	}
	ops.waitForSingleObject = func(windows.Handle, uint32) (uint32, error) {
		return uint32(windows.WAIT_TIMEOUT), nil
	}
	t.Cleanup(func() { ops = restore })

	marker := filepath.Join(t.TempDir(), "role")
	guarded, err := Launch(selfConfig(t, roleIdle, marker, 5_000, 1_000))
	if err == nil {
		_ = guarded.Close()
		t.Fatal("a launch whose disposal failed was reported as a success")
	}
	var failure *LaunchError
	if !errors.As(err, &failure) {
		t.Fatalf("the failure was not structured: %v", err)
	}
	if failure.Disposal != DisposalUnproven {
		t.Fatalf("a disposal that never happened was reported as %q: %+v", failure.Disposal, failure)
	}
	if failure.ChildPID == 0 {
		t.Fatalf("the undisposed process is not named, so nothing can clean it up: %+v", failure)
	}
	if len(failure.Findings) == 0 {
		t.Fatalf("the refused termination left no finding: %+v", failure)
	}

	// The driver must publish that pid rather than answer "there is no tree".
	code, records := runGuardianWithLauncher(t, selfConfig(t, roleIdle, marker, 5_000, 1_000), "",
		func(Config) (Guarded, error) { return nil, failure })
	if code == 0 {
		t.Fatal("a launch with an undisposed process exited 0")
	}
	var ledger *Record
	for i := range records {
		if records[i].Kind == "ledger" {
			ledger = &records[i]
		}
	}
	if ledger == nil || ledger.PID != failure.ChildPID {
		t.Fatalf("the undisposed pid was not published in a ledger: %+v", records)
	}
	if ledger.JobHandleHeld {
		t.Fatal("the ledger claims a job handle is held over a process that was never assigned to one")
	}

	// This test really did leave a process running. It owns exactly that one
	// process, by the handle it still has, and ends it here — no pattern, no
	// sweep, no pid it did not create.
	restore.terminateProcess(mustOpen(t, failure.ChildPID), 1)
	if !waitUntilGone(failure.ChildPID, 20*time.Second) {
		t.Fatalf("this test could not clean up the pid %d it created", failure.ChildPID)
	}
}

// A resume that fails leaves a process that IS in the job. The job is the
// disposal — but only once its census actually reads zero.
func TestAFailedResumeDisposesThroughTheJobAndProvesIt(t *testing.T) {
	restore := ops
	ops.resumeThread = func(windows.Handle) (uint32, error) {
		return 0, errors.New("control: the resume is refused")
	}
	t.Cleanup(func() { ops = restore })

	marker := filepath.Join(t.TempDir(), "role")
	guarded, err := Launch(selfConfig(t, roleIdle, marker, 5_000, 10_000))
	if err == nil {
		_ = guarded.Close()
		t.Fatal("a process that could not be resumed was handed back as if it were running")
	}
	var failure *LaunchError
	if !errors.As(err, &failure) {
		t.Fatalf("the failure was not structured: %v", err)
	}
	if failure.ChildPID == 0 {
		t.Fatalf("the created process is not named: %+v", failure)
	}
	if failure.Disposal != DisposalExited {
		t.Fatalf("the job disposal was %q rather than a proven exit: %+v", failure.Disposal, failure)
	}
	if stillRunning(failure.ChildPID) {
		t.Fatalf("pid %d was reported as ended and is still running", failure.ChildPID)
	}
}

// The case no explicit teardown can cover: THIS PROGRAM being killed.
//
// A guardian re-entered from this binary launches a child that launches a
// grandchild, and is then killed outright — no shutdown command, no chance to
// run any cleanup of its own. Windows closes its handles, the job's last handle
// goes with them, and KILL_ON_JOB_CLOSE collects the whole tree. Without that
// flag the grandchild would simply keep running, which is the leak this program
// exists to prevent and the one a graceful path can never cover.
func TestKillingTheGuardianItselfStillCollectsTheTree(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("could not find this test binary: %v", err)
	}
	marker := filepath.Join(t.TempDir(), "role")
	guardian := exec.Command(self, roleFlag+roleGuardian, markerFlag+marker)
	if err := guardian.Start(); err != nil {
		t.Fatalf("could not start the guardian: %v", err)
	}
	t.Cleanup(func() { _ = guardian.Process.Kill() })

	childPID := waitForFile(t, marker+".parent", 60*time.Second)
	grandchildPID := waitForFile(t, marker+".grandchild", 60*time.Second)
	if !stillRunning(grandchildPID) {
		t.Fatal("the grandchild was not alive before the guardian was killed")
	}

	// Killed, not asked. This is a crash, not a shutdown.
	if err := guardian.Process.Kill(); err != nil {
		t.Fatalf("could not kill the guardian: %v", err)
	}
	_ = guardian.Wait()

	if !waitUntilGone(grandchildPID, 30*time.Second) {
		t.Fatalf("the grandchild (pid %d) outlived the guardian being killed; "+
			"KILL_ON_JOB_CLOSE did not collect the tree", grandchildPID)
	}
	if !waitUntilGone(childPID, 30*time.Second) {
		t.Fatalf("the child (pid %d) outlived the guardian being killed", childPID)
	}
}

// Killing the GUARDED CHILD directly — by the exact pid the ledger published,
// never by a pattern — must take its descendants with it, because they are all
// in the same job. This is the `peerExit` control's Windows meaning: an early
// death of the parent cannot leave a tree behind.
func TestKillingTheGuardedChildTakesItsDescendantsToo(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "role")
	cfg := selfConfig(t, roleSpawnGrandchild, marker, 20_000, 20_000)

	var childPID, grandchildPID int
	code, records := runGuardian(t, cfg, `{"command":"shutdown","mode":"join"}`+"\n", func() {
		childPID = waitForFile(t, marker+".parent", 30*time.Second)
		grandchildPID = waitForFile(t, marker+".grandchild", 30*time.Second)
		handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(childPID))
		if err != nil {
			t.Errorf("could not open the child this test created: %v", err)
			return
		}
		defer windows.CloseHandle(handle)
		if err := windows.TerminateProcess(handle, 1); err != nil {
			t.Errorf("could not terminate the child this test created: %v", err)
		}
	})

	closed := findClosed(t, records)
	if !waitUntilGone(grandchildPID, 30*time.Second) {
		t.Fatalf("the grandchild (pid %d) outlived its parent being killed", grandchildPID)
	}
	if closed.ActiveAfter == nil || *closed.ActiveAfter != 0 {
		t.Fatalf("the job was not empty after the parent was killed: %+v", closed)
	}
	if code != 0 {
		t.Logf("exit %d with findings %v — acceptable if the graceful budget was spent; "+
			"the tree being gone is asserted above and is the claim that matters", code, closed.Findings)
	}
}

func mustOpen(t *testing.T, pid int) windows.Handle {
	t.Helper()
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatalf("could not open the pid %d this test created: %v", pid, err)
	}
	t.Cleanup(func() { windows.CloseHandle(handle) })
	return handle
}

// A launch this program cannot perform is a failure, never an empty success.
func TestAnExecutableThatCannotStartIsAFailure(t *testing.T) {
	notAProgram := filepath.Join(t.TempDir(), "not-a-program.exe")
	if err := os.WriteFile(notAProgram, []byte("this is not a PE image"), 0o700); err != nil {
		t.Fatalf("could not write the decoy: %v", err)
	}
	cfg := Config{Purpose: "self-test", Executable: notAProgram, JoinBudgetMs: 2_000, TerminateBudgetMs: 2_000}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("the decoy config did not validate: %v", err)
	}
	if guarded, err := Launch(cfg); err == nil {
		_ = guarded.Close()
		t.Fatal("a file that is not a program was launched")
	}
}

// ---- harness ---------------------------------------------------------------

// runGuardian drives Run in a goroutine so a test can observe the live tree
// before sending the shutdown that ends it.
func runGuardian(t *testing.T, cfg Config, commands string, whileLive func()) (int, []Record) {
	t.Helper()
	return runGuardianLive(t, cfg, commands, whileLive, Launch)
}

// runGuardianWithLauncher drives the decision layer over a dictated launch
// outcome, so the report a real failure would produce can be asserted without
// having to reproduce the failure a second time.
func runGuardianWithLauncher(t *testing.T, cfg Config, commands string, launch Launcher) (int, []Record) {
	t.Helper()
	return runGuardianLive(t, cfg, commands, nil, launch)
}

func runGuardianLive(t *testing.T, cfg Config, commands string, whileLive func(), launch Launcher) (int, []Record) {
	t.Helper()
	var out lockedBuffer
	reader, writer := io.Pipe()
	done := make(chan int, 1)
	go func() {
		done <- Run(cfg, launch, reader, NewReporter(&out), realClock{})
	}()
	if whileLive != nil {
		whileLive()
	}
	if _, err := writer.Write([]byte(commands)); err != nil {
		t.Fatalf("could not send the command: %v", err)
	}
	_ = writer.Close()

	select {
	case code := <-done:
		return code, parseRecords(t, out.Bytes())
	case <-time.After(90 * time.Second):
		t.Fatal("the guardian did not finish within 90s")
		return 1, nil
	}
}

func parseRecords(t *testing.T, raw []byte) []Record {
	t.Helper()
	var records []Record
	for _, line := range bytes.Split(bytes.TrimSpace(raw), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			t.Fatalf("the helper emitted a line that is not a record: %q", line)
		}
		records = append(records, rec)
	}
	return records
}

func findClosed(t *testing.T, records []Record) Record {
	t.Helper()
	for _, rec := range records {
		if rec.Kind == "closed" {
			return rec
		}
	}
	t.Fatalf("no closed record was emitted: %+v", records)
	return Record{}
}
