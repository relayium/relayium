package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// The harness the guardian's own tests drive `Run` through, and the regression
// that made it necessary.
//
// Deliberately NOT behind `//go:build windows`. The deadlock below is in the
// harness, not in the Windows code it usually drives, so it is reproducible —
// and therefore provable — on any host. Keeping it here means the fix is
// executed by every run of this package rather than only on a runner.

// How long a guarded run may take before the test gives up on it.
const guardianRunBudget = 90 * time.Second

// How long the command writer may take AFTER `Run` has returned. It cannot
// still be blocked at that point, so this is a leak detector rather than a wait.
const commandWriterBudget = 5 * time.Second

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

// runGuardianLive drives `Run` in a goroutine so a test can observe the live
// tree before sending the shutdown that ends it.
//
// ## The deadlock this shape used to have
//
// `io.Pipe` is unbuffered and synchronous: a `Write` blocks until a reader has
// taken the bytes, and that is true even of an EMPTY write, which still makes
// one send on the pipe's channel. The first version wrote the command on the
// TEST goroutine, before selecting on the result.
//
// `Run` only reads its command stream after a successful launch. A launch that
// FAILS reports its findings and returns without ever reading — which is a real
// path with its own test — so nothing was ever going to take those bytes. The
// write blocked forever, the timeout below was never reached because the test
// goroutine never got to it, and the package ran until `go test -timeout`
// killed it. A test asserting a prompt failure hung instead.
//
// Three things fix it, and all three are needed:
//
//   - the reader is closed as soon as `Run` returns, so a blocked write fails
//     immediately with `io.ErrClosedPipe` instead of waiting for a reader that
//     will never come;
//   - the write happens on its own goroutine, so it can never be what the test
//     is blocked on;
//   - both the run and the writer are awaited under their own bounds, and the
//     pipe is closed from `t.Cleanup` — which runs even when `whileLive` calls
//     `t.Fatal` and unwinds the test goroutine, where an inline close would be
//     skipped and would leave `Run` holding a live job.
func runGuardianLive(t *testing.T, cfg Config, commands string, whileLive func(), launch Launcher) (int, []Record) {
	t.Helper()
	var out lockedBuffer
	reader, writer := io.Pipe()
	done := make(chan int, 1)
	exited := make(chan struct{})

	go func() {
		code := Run(cfg, launch, reader, NewReporter(&out), realClock{})
		// Nothing will read this pipe again, whatever happened. Closing it here
		// is what unblocks a writer that `Run` never got as far as reading.
		_ = reader.Close()
		done <- code
		close(exited)
	}()

	// Runs even if the test goroutine unwinds through `t.Fatal`. Closing the
	// WRITER is a real shutdown: `readUntilShutdown` sees EOF and ends the job
	// rather than leaving it held.
	t.Cleanup(func() {
		_ = writer.Close()
		_ = reader.Close()
		select {
		case <-exited:
		case <-time.After(guardianRunBudget):
			t.Errorf("the guardian did not exit during cleanup; a job object may still be held")
		}
	})

	if whileLive != nil {
		whileLive()
	}

	// Bounded and off the test goroutine. A failed launch never consumes this,
	// and that is a legitimate outcome rather than a test failure.
	wrote := make(chan error, 1)
	go func() {
		_, err := writer.Write([]byte(commands))
		if closeErr := writer.Close(); err == nil {
			err = closeErr
		}
		wrote <- err
	}()

	var code int
	select {
	case code = <-done:
	case <-time.After(guardianRunBudget):
		_ = reader.Close()
		_ = writer.Close()
		t.Fatalf("the guardian did not finish within %s", guardianRunBudget)
	}

	// `Run` has returned, so the reader is closed and the writer cannot still be
	// blocked. Awaited anyway, so the goroutine is never left behind.
	select {
	case err := <-wrote:
		if err != nil && !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("the command could not be delivered: %v", err)
		}
	case <-time.After(commandWriterBudget):
		t.Fatal("the command writer was still running after the guardian returned")
	}
	return code, parseRecords(t, out.Bytes())
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

// The regression, on every platform.
//
// A launch that fails must make the harness return PROMPTLY. Before the fix
// this hung until the package's own `-timeout` killed it, so the failure did
// not even name the test that caused it.
func TestAFailedLaunchDoesNotHangTheCommandWriter(t *testing.T) {
	cfg := Config{Purpose: "self-test", JoinBudgetMs: 2_000, TerminateBudgetMs: 2_000}
	failed := &LaunchError{
		Op:       "control: the launch is refused",
		Err:      errors.New("control"),
		ChildPID: 4242,
		Disposal: DisposalUnproven,
		Findings: []string{"control: the disposal could not be observed"},
	}

	started := time.Now()
	// A shutdown command that nothing will ever read: `Run` returns before it
	// reaches its command stream.
	code, records := runGuardianLive(t, cfg, `{"command":"shutdown","mode":"join"}`+"\n", nil,
		func(Config) (Guarded, error) { return nil, failed })
	elapsed := time.Since(started)

	if elapsed > 30*time.Second {
		t.Fatalf("a failed launch took %s to report; the command writer was blocking", elapsed)
	}
	if code == 0 {
		t.Fatal("a failed launch reported success")
	}
	closed := findClosed(t, records)
	if closed.Outcome != OutcomeUnproven {
		t.Fatalf("outcome was %q, not %q: %+v", closed.Outcome, OutcomeUnproven, closed)
	}
	// The undisposed pid still has to reach the report — that is the whole
	// reason this path exists.
	var ledger *Record
	for i := range records {
		if records[i].Kind == "ledger" {
			ledger = &records[i]
		}
	}
	if ledger == nil || ledger.PID != failed.ChildPID {
		t.Fatalf("the undisposed pid was not published: %+v", records)
	}
	if ledger.JobHandleHeld {
		t.Fatal("the ledger claims a job handle over a process that was never assigned to one")
	}
}

// An EMPTY command string blocks an unbuffered pipe exactly as a non-empty one
// does — `io.Pipe.Write` makes one send even for zero bytes. Worth its own case
// because "it writes nothing, so it cannot block" is the intuition that put the
// original write on the test goroutine.
func TestAnEmptyCommandStringDoesNotHangEither(t *testing.T) {
	cfg := Config{Purpose: "self-test", JoinBudgetMs: 2_000, TerminateBudgetMs: 2_000}
	started := time.Now()
	code, _ := runGuardianLive(t, cfg, "", nil, func(Config) (Guarded, error) {
		return nil, errors.New("control: the launch is refused")
	})
	if time.Since(started) > 30*time.Second {
		t.Fatal("an empty command string blocked the writer")
	}
	if code == 0 {
		t.Fatal("a failed launch reported success")
	}
}
