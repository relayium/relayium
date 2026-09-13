package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// The driver's rules, tested against a job whose behaviour is dictated rather
// than observed. These run on any host: what they cover is the DECISION — what
// this program is willing to call clean — and that decision must not be
// reachable only on the platform where it is hardest to run a test.

// fakeJob answers a scripted sequence of censuses.
type fakeJob struct {
	mu sync.Mutex
	// Successive answers from ActiveProcesses. The last is repeated.
	counts []uint32
	// Answers to substitute once Terminate has been called.
	afterTerminate []uint32
	countErr       error
	terminateErr   error
	closeErr       error
	terminated     bool
	closed         bool
	reads          int
}

func (f *fakeJob) PID() int { return 4242 }

func (f *fakeJob) ActiveProcesses() (uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.countErr != nil {
		return 0, f.countErr
	}
	f.reads++
	source := f.counts
	if f.terminated && f.afterTerminate != nil {
		source = f.afterTerminate
	}
	if len(source) == 0 {
		return 0, nil
	}
	if f.reads-1 < len(source) {
		return source[f.reads-1], nil
	}
	return source[len(source)-1], nil
}

func (f *fakeJob) Terminate() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.terminateErr != nil {
		return f.terminateErr
	}
	f.terminated = true
	f.reads = 0
	return nil
}

func (f *fakeJob) Close() error {
	f.closed = true
	return f.closeErr
}

// instantClock spends budgets without spending wall clock.
type instantClock struct{ now time.Time }

func (c *instantClock) Now() time.Time { return c.now }
func (c *instantClock) Sleep(d time.Duration) {
	c.now = c.now.Add(d)
}

func drive(t *testing.T, job Guarded, launchErr error, commands string) (int, []Record) {
	t.Helper()
	var out bytes.Buffer
	cfg := Config{Purpose: "self-test", JoinBudgetMs: 2_000, TerminateBudgetMs: 2_000}
	code := Run(cfg, func(Config) (Guarded, error) {
		if launchErr != nil {
			return nil, launchErr
		}
		return job, nil
	}, strings.NewReader(commands), NewReporter(&out), &instantClock{now: time.Unix(0, 0)})

	var records []Record
	for _, line := range bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			t.Fatalf("the helper emitted a line that is not a record: %q (%v)", line, err)
		}
		records = append(records, rec)
	}
	return code, records
}

func closedRecord(t *testing.T, records []Record) Record {
	t.Helper()
	for _, rec := range records {
		if rec.Kind == "closed" {
			return rec
		}
	}
	t.Fatalf("no closed record was emitted; got %+v", records)
	return Record{}
}

func TestLedgerIsEmittedBeforeAnythingIsWaitedOn(t *testing.T) {
	job := &fakeJob{counts: []uint32{0}}
	_, records := drive(t, job, nil, `{"command":"shutdown","mode":"join"}`+"\n")
	if len(records) == 0 || records[0].Kind != "ledger" {
		t.Fatalf("the ledger was not the first thing written: %+v", records)
	}
	if records[0].PID != 4242 || !records[0].JobHandleHeld {
		t.Fatalf("the ledger does not identify what was started: %+v", records[0])
	}
}

func TestAGracefulJoinThatEmptiesTheJobIsClean(t *testing.T) {
	job := &fakeJob{counts: []uint32{3, 1, 0}}
	code, records := drive(t, job, nil, `{"command":"shutdown","mode":"join"}`+"\n")
	closed := closedRecord(t, records)
	if code != 0 || closed.Outcome != OutcomeJoined {
		t.Fatalf("a tree that left on its own was not reported as joined: code=%d %+v", code, closed)
	}
	if job.terminated {
		t.Fatal("a job that emptied itself was terminated anyway")
	}
	if !job.closed {
		t.Fatal("the job handle was not released")
	}
}

// The central rule. A browser that ignores `Browser.close` must never be
// reported as a clean graceful teardown just because the request was sent.
func TestAJoinThatNeverEmptiesEscalatesAndIsNotClean(t *testing.T) {
	job := &fakeJob{counts: []uint32{5}, afterTerminate: []uint32{0}}
	code, records := drive(t, job, nil, `{"command":"shutdown","mode":"join"}`+"\n")
	closed := closedRecord(t, records)
	if !job.terminated {
		t.Fatal("a graceful join that never emptied the job did not escalate to termination")
	}
	if code == 0 {
		t.Fatal("a run whose graceful path failed reported success")
	}
	if len(closed.Findings) == 0 {
		t.Fatalf("the failed graceful path left no finding: %+v", closed)
	}
	// It still cleaned up, and says so — the machine is not left dirty because
	// the polite request was ignored.
	if closed.ActiveAfter == nil || *closed.ActiveAfter != 0 {
		t.Fatalf("the escalation did not empty the job: %+v", closed)
	}
}

func TestATerminationThatDoesNotEmptyTheJobIsUNPROVEN(t *testing.T) {
	job := &fakeJob{counts: []uint32{2}, afterTerminate: []uint32{2}}
	code, records := drive(t, job, nil, `{"command":"shutdown","mode":"terminate"}`+"\n")
	closed := closedRecord(t, records)
	if closed.Outcome != OutcomeUnproven || code == 0 {
		t.Fatalf("a job that stayed occupied after termination was not reported unproven: code=%d %+v", code, closed)
	}
}

// A census this program cannot read is not a census of zero.
func TestAJobThatCannotBeCountedIsNeverReportedClean(t *testing.T) {
	job := &fakeJob{countErr: errors.New("the job handle is invalid")}
	code, records := drive(t, job, nil, `{"command":"shutdown","mode":"terminate"}`+"\n")
	closed := closedRecord(t, records)
	if code == 0 || closed.Outcome == OutcomeTerminated {
		t.Fatalf("an unreadable job was reported as cleaned up: code=%d %+v", code, closed)
	}
}

func TestATerminationThatFailsIsUNPROVEN(t *testing.T) {
	job := &fakeJob{counts: []uint32{1}, terminateErr: errors.New("access denied")}
	code, records := drive(t, job, nil, `{"command":"shutdown","mode":"terminate"}`+"\n")
	closed := closedRecord(t, records)
	if closed.Outcome != OutcomeUnproven || code == 0 {
		t.Fatalf("a termination that failed was not reported unproven: code=%d %+v", code, closed)
	}
}

// A launch that never happened is a failure, not an empty success. Reporting
// zero active processes here would be true and completely misleading.
func TestAFailedLaunchIsAFailure(t *testing.T) {
	code, records := drive(t, nil, errors.New("could not assign the suspended process to the job"), "")
	closed := closedRecord(t, records)
	if code == 0 || closed.Outcome != OutcomeUnproven {
		t.Fatalf("a launch that failed was not a failure: code=%d %+v", code, closed)
	}
	if len(closed.Findings) == 0 || !strings.Contains(closed.Findings[0], "not launched") {
		t.Fatalf("the failed launch was not named: %+v", closed)
	}
}

// The owner going away must not leave the tree running. This is the case a
// fixture crash produces, and "carry on" would be exactly the wrong default.
func TestAnEndedCommandStreamEndsTheJob(t *testing.T) {
	job := &fakeJob{counts: []uint32{4}, afterTerminate: []uint32{0}}
	code, records := drive(t, job, nil, "")
	closed := closedRecord(t, records)
	if !job.terminated {
		t.Fatal("the command stream ending did not end the job")
	}
	if code == 0 {
		t.Fatal("losing the owner without a shutdown was reported as a clean run")
	}
	if len(closed.Findings) == 0 {
		t.Fatalf("no finding recorded the lost command stream: %+v", closed)
	}
}

func TestAnUnknownCommandIsRefusedAndNotGuessedAt(t *testing.T) {
	job := &fakeJob{counts: []uint32{0}}
	code, records := drive(t, job, nil,
		"not json\n"+`{"command":"destroy"}`+"\n"+`{"command":"shutdown","mode":"nonsense"}`+"\n"+
			`{"command":"shutdown","mode":"join"}`+"\n")
	closed := closedRecord(t, records)
	if len(closed.Findings) < 3 {
		t.Fatalf("three unusable commands produced %d findings: %+v", len(closed.Findings), closed)
	}
	// Refusing them is not the same as being unable to work afterwards.
	if closed.Outcome != OutcomeJoined {
		t.Fatalf("a well-formed shutdown after refused input did not work: %+v", closed)
	}
	if code == 0 {
		t.Fatal("findings did not reach the exit code")
	}
}

func TestAccountingIsAnsweredWhileTheJobIsHeld(t *testing.T) {
	job := &fakeJob{counts: []uint32{7, 7, 0}}
	_, records := drive(t, job, nil,
		`{"command":"accounting"}`+"\n"+`{"command":"shutdown","mode":"join"}`+"\n")
	var seen bool
	for _, rec := range records {
		if rec.Kind == "accounting" {
			seen = true
			if rec.ActiveProcesses == nil || *rec.ActiveProcesses != 7 {
				t.Fatalf("the census was not reported: %+v", rec)
			}
		}
	}
	if !seen {
		t.Fatalf("no accounting record was emitted: %+v", records)
	}
}

func TestParseCommandRefusesAShutdownWithNoMode(t *testing.T) {
	if _, err := ParseCommand([]byte(`{"command":"shutdown"}`)); err == nil {
		t.Fatal("a shutdown with no mode was accepted; the program would have to guess between waiting and killing")
	}
}

func TestReporterWritesOneObjectPerLine(t *testing.T) {
	var out bytes.Buffer
	reporter := NewReporter(&out)
	for i := 0; i < 3; i++ {
		if err := reporter.Emit(Record{Kind: "finding", Finding: fmt.Sprintf("n%d", i)}); err != nil {
			t.Fatalf("emit failed: %v", err)
		}
	}
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if len(lines) != 3 {
		t.Fatalf("expected three lines, got %d: %q", len(lines), out.String())
	}
	for _, line := range lines {
		var rec Record
		if err := json.Unmarshal(line, &rec); err != nil {
			t.Fatalf("a line was not one JSON object: %q", line)
		}
	}
}
