package inboxclient

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxmanifest"
)

// testClock advances only when the code under test sleeps, so schedules are
// deterministic and the suite never waits on a wall clock.
type testClock struct {
	mu     sync.Mutex
	now    time.Time
	slept  []time.Duration
	cancel func()
	// cancelAfter cancels the worker's context after this many sleeps, which is
	// how the resident-loop tests stop without a timer race.
	cancelAfter int
	// hook runs at each sleep with the 1-based sleep count. Changing the world
	// HERE rather than from a goroutine is what makes "the directory came back
	// on pass 2" a deterministic fact instead of a race.
	hook func(n int)
}

func newTestClock() *testClock {
	return &testClock{now: time.Unix(1_800_000_000, 0)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.slept = append(c.slept, d)
	n, cancel := len(c.slept), c.cancel
	after, hook := c.cancelAfter, c.hook
	c.mu.Unlock()
	if hook != nil {
		hook(n)
	}
	if after > 0 && n >= after && cancel != nil {
		cancel()
		return context.Canceled
	}
	return nil
}

func (c *testClock) sleeps() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Duration(nil), c.slept...)
}

// fixture is a worker wired to a fake central, a real receive directory and a
// real state directory.
type fixture struct {
	t      *testing.T
	fc     *fakeCentral
	store  *Store
	root   string
	client *Client
	clock  *testClock
	logs   []string
	mu     sync.Mutex
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	fc := newFakeCentral(t)
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "inbox")
	store := NewStore(state)
	if err := store.Ensure(); err != nil {
		t.Fatalf("state dir: %v", err)
	}
	c := NewClient(fc.server.URL, fc.token)
	c.DeviceID = fc.deviceID
	c.HTTP = fc.server.Client()
	f := &fixture{t: t, fc: fc, store: store, root: root, client: c, clock: newTestClock()}
	if err := store.SaveConfig(Config{
		DeviceID: fc.deviceID, Server: fc.server.URL, Dir: root,
		Enabled: true, AutoAccept: inbox.AutoAcceptAuto,
	}, f.clock.Now()); err != nil {
		t.Fatalf("config: %v", err)
	}
	return f
}

func (f *fixture) log(format string, a ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, strings.TrimSpace(fmt.Sprintf(format, a...)))
}

func (f *fixture) logText() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.logs, "\n")
}

// enrol performs the same enrolment the worker does, so a test can queue a task
// against a real registered public key before running the worker.
func (f *fixture) enrol() {
	f.t.Helper()
	res, err := f.client.Enrol(context.Background(), EnrolRequest{
		Platform: "test", AppVersion: "test",
		ProtocolVersions: ProtocolVersions(), Capabilities: Capabilities(),
		AutoAccept: inbox.AutoAcceptAuto, ReceiveDirReady: true,
	})
	if err != nil {
		f.t.Fatalf("enrol: %v", err)
	}
	if _, err := EnsureUsableKey(context.Background(), f.client, f.store.Keys(), res.Inbox.Key, f.clock.Now()); err != nil {
		f.t.Fatalf("key: %v", err)
	}
}

func (f *fixture) worker(opts ...func(*Options)) *Worker {
	f.t.Helper()
	cfg, _, err := f.store.LoadConfig()
	if err != nil {
		f.t.Fatalf("config: %v", err)
	}
	o := Options{
		Client: f.client, Store: f.store, Config: cfg,
		Platform: "test", AppVersion: "test",
		Clock: f.clock, Log: f.log, Once: true,
		Rand: func() float64 { return 0.5 }, // no jitter, deterministic schedules
	}
	for _, fn := range opts {
		fn(&o)
	}
	return NewWorker(o)
}

func (f *fixture) runOnce() error {
	f.t.Helper()
	return f.worker().Run(context.Background())
}

// TestWorkerDeliversRealEncryptedBytes is the end-to-end happy path through the
// exact wire format a sender produces: claim -> ciphertext stream -> per-frame
// authenticated decrypt -> staging -> atomic commit -> verifying -> saved.
func TestWorkerDeliversRealEncryptedBytes(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	body := strings.Repeat("relayium device inbox payload\n", 5000) // spans several frames
	id := f.fc.enqueue(t,
		srcFile{Name: "notes.txt", Data: []byte(body)},
		srcFile{Name: "photos/holiday.jpg", Data: []byte("JPEGDATA")},
		srcFile{Name: "empty.bin", Data: nil},
	)
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}

	if got := read(t, filepath.Join(f.root, "notes.txt")); got != body {
		t.Fatalf("notes.txt round-tripped %d bytes, want %d", len(got), len(body))
	}
	if got := read(t, filepath.Join(f.root, "photos/holiday.jpg")); got != "JPEGDATA" {
		t.Fatalf("nested file content = %q", got)
	}
	if got := read(t, filepath.Join(f.root, "empty.bin")); got != "" {
		t.Fatalf("zero-size entry content = %q", got)
	}

	// `saved` must be reported, and only after `verifying`: it is not reachable
	// from `downloading`, because "the bytes arrived" is not "the file is on disk".
	states := f.fc.reportedStates(id)
	if len(states) < 2 || states[len(states)-1] != inbox.TaskSaved || states[len(states)-2] != inbox.TaskVerifying {
		t.Fatalf("report sequence = %v, want ... verifying, saved", states)
	}
	if state, code := f.fc.taskState(id); state != inbox.TaskSaved || code != inbox.TaskErrNone {
		t.Fatalf("server task state = %s/%s, want saved", state, code)
	}
	// The staging area must not survive a completed delivery.
	if _, err := os.Stat(StagingRoot(f.root, id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging directory survived: %v", err)
	}
}

// A worker processes deliveries serially, while an individual task may be
// arbitrarily large. It therefore must never lease later tasks before it is
// ready to start them: the first transfer could outlive their whole lease.
func TestWorkerClaimsOnlyTheTaskItCanStart(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	f.fc.enqueue(t, srcFile{Name: "first.txt", Data: []byte("first")})
	f.fc.enqueue(t, srcFile{Name: "second.txt", Data: []byte("second")})

	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := f.fc.requestedClaimMaxes(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("claim max requests = %v, want [1] so no queued task is leased early", got)
	}
	if state, _ := f.fc.taskState(f.fc.tasks[1].ID); state != inbox.TaskNotified {
		t.Fatalf("second task state = %s, want notified and unleased", state)
	}
}

// TestWorkerLogsNoFileNames is the invariant-6 assertion at the layer that
// actually writes to an operator's journal. Manifest names and destinations are
// plaintext-derived; a log line carrying one leaks exactly what the zero-
// knowledge promise says Relayium never learns — and journals get shipped.
func TestWorkerLogsNoFileNames(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	const secretName = "salary-review-2026.pdf"
	f.fc.enqueue(t, srcFile{Name: secretName, Data: []byte("x")})
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	logs := f.logText()
	if strings.Contains(logs, secretName) {
		t.Fatalf("the worker log contains a received file name:\n%s", logs)
	}
	if strings.Contains(logs, f.root) {
		t.Fatalf("the worker log contains a destination path:\n%s", logs)
	}
	if !strings.Contains(logs, "saved") {
		t.Fatalf("the worker log says nothing about the delivery:\n%s", logs)
	}
}

// TestWorkerRefusesToOverwriteAndRenamesDeterministically is the PRD §9
// collision rule through the whole pipeline, with a real existing user file.
func TestWorkerRefusesToOverwriteAndRenamesDeterministically(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	write(t, filepath.Join(f.root, "report.pdf"), "MY OWN FILE")
	f.fc.enqueue(t, srcFile{Name: "report.pdf", Data: []byte("delivered")})
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := read(t, filepath.Join(f.root, "report.pdf")); got != "MY OWN FILE" {
		t.Fatalf("an existing user file was overwritten: %q", got)
	}
	if got := read(t, filepath.Join(f.root, "report (2).pdf")); got != "delivered" {
		t.Fatalf("collision rename content = %q", got)
	}
}

// TestWorkerRejectsTamperedCiphertext: one flipped bit inside an authenticated
// frame must leave NOTHING on disk. This is the assertion that a corrupted or
// substituted blob can never masquerade as a complete file.
func TestWorkerRejectsTamperedCiphertext(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "doc.txt", Data: []byte(strings.Repeat("A", 4096))})
	f.fc.corruptBlobByte = 100 // inside the first frame's ciphertext
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	state, code := f.fc.taskState(id)
	if state != inbox.TaskFailedTerminal || code != inbox.TaskErrDecryptFailed {
		t.Fatalf("task = %s/%s, want failed_terminal/decrypt_failed (a tampered blob will not improve on retry)", state, code)
	}
}

// TestWorkerRejectsTruncatedCiphertext: the stream ends early. Nothing may be
// left on disk, and the outcome must be RETRYABLE — a truncated transfer is a
// transport symptom, and the next attempt gets a fresh stream.
func TestWorkerRejectsTruncatedCiphertext(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "doc.txt", Data: []byte(strings.Repeat("B", 4096))})
	f.fc.truncateBlobTo = 100
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	state, code := f.fc.taskState(id)
	if state != inbox.TaskFailedRetryable || code != inbox.TaskErrVerifyFailed {
		t.Fatalf("task = %s/%s, want failed_retryable/verify_failed", state, code)
	}
}

// TestWorkerRejectsWrongSealedKey: the content key was sealed to a key this
// device does not hold. Terminal, and nothing on disk.
func TestWorkerRejectsWrongSealedKey(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "doc.txt", Data: []byte("hello")})

	// Destroy the local private key history: central's published key is now one
	// this device cannot open, which is exactly the restored-backup case.
	if err := f.store.Keys().Destroy(); err != nil {
		t.Fatalf("destroy keys: %v", err)
	}
	// Re-enrolment must not rescue the already-sealed task by rotating: the task
	// stays bound to the key it was sealed to.
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	state, code := f.fc.taskState(id)
	if state != inbox.TaskFailedTerminal || code != inbox.TaskErrDecryptFailed {
		t.Fatalf("task = %s/%s, want failed_terminal/decrypt_failed", state, code)
	}
}

// TestWorkerRejectsMaliciousManifestNames drives a traversal attempt through the
// whole pipeline: real ciphertext, real AEAD, hostile name.
func TestWorkerRejectsMaliciousManifestNames(t *testing.T) {
	outsideDir := t.TempDir()
	for _, name := range []string{"../escaped.txt", "/tmp/absolute.txt", "a/../../escaped.txt"} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.enrol()
			id := f.fc.enqueueHostile(t, name)
			if err := f.runOnce(); err != nil {
				t.Fatalf("run: %v", err)
			}
			assertReceiveDirEmpty(t, f.root)
			if _, err := os.Stat(filepath.Join(outsideDir, "escaped.txt")); err == nil {
				t.Fatal("a file escaped the receive directory")
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(f.root), "escaped.txt")); err == nil {
				t.Fatal("a file was written to the receive directory's parent")
			}
			state, code := f.fc.taskState(id)
			if state != inbox.TaskFailedTerminal || code != inbox.TaskErrVerifyFailed {
				t.Fatalf("task = %s/%s, want failed_terminal/verify_failed", state, code)
			}
		})
	}
}

// TestWorkerRejectsADeliveryAimedAtItsOwnStagingArea drives the reserved-name
// rule end to end. Without it the commit would link the file to its own staged
// source and then unlink it: `saved` reported, nothing on disk. That is the
// worst possible failure — a confident lie — so it is checked through the whole
// pipeline, not only at the planner.
func TestWorkerRejectsADeliveryAimedAtItsOwnStagingArea(t *testing.T) {
	for _, name := range []string{stagingDirName + "/x/0.part", probeName} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.enrol()
			id := f.fc.enqueue(t, srcFile{Name: name, Data: []byte("would vanish")})
			if err := f.runOnce(); err != nil {
				t.Fatalf("run: %v", err)
			}
			assertReceiveDirEmpty(t, f.root)
			state, code := f.fc.taskState(id)
			if state != inbox.TaskFailedTerminal || code != inbox.TaskErrVerifyFailed {
				t.Fatalf("task = %s/%s, want failed_terminal/verify_failed — reporting saved here would be a lie", state, code)
			}
		})
	}
}

// TestWorkerRefusesADeliveryLargerThanTheDisk is the preflight: a doomed
// transfer must be refused BEFORE it fills the filesystem on its way to failing,
// and it must be attention_required, because only a human can free space.
func TestWorkerRefusesADeliveryLargerThanTheDisk(t *testing.T) {
	if _, ok := freeBytes(t.TempDir()); !ok {
		t.Skip("free space is not reportable on this platform")
	}
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueueOversized(t, 1<<50) // 1 PiB
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if _, _, _, blobs := f.fc.counts(); blobs != 0 {
		t.Fatalf("the ciphertext was fetched %d time(s) despite failing preflight", blobs)
	}
	state, code := f.fc.taskState(id)
	if state != inbox.TaskAttentionRequired || code != inbox.TaskErrDiskFull {
		t.Fatalf("task = %s/%s, want attention_required/disk_full", state, code)
	}
	assertReceiveDirEmpty(t, f.root)
}

// TestWorkerResumesAcrossAnInterruptedStream exercises Range resume: the server
// drops the first attempts, and the worker reconnects from the last COMPLETE
// frame boundary rather than restarting or splicing.
func TestWorkerResumesAcrossAnInterruptedStream(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	body := strings.Repeat("resume me\n", 60000) // several 192 KiB chunks
	f.fc.enqueue(t, srcFile{Name: "big.txt", Data: []byte(body)})
	f.fc.failBlobTimes = 2
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := read(t, filepath.Join(f.root, "big.txt")); got != body {
		t.Fatalf("resumed content is %d bytes, want %d", len(got), len(body))
	}
	if _, _, _, blobs := f.fc.counts(); blobs < 3 {
		t.Fatalf("blob requests = %d, expected the two induced failures plus a success", blobs)
	}
}

// TestWorkerRestartsAndCommitsExactlyOnce is the restart/resume requirement.
// The first run is interrupted after the ciphertext is staged; the second run
// re-claims the same task id and must produce ONE file, not two, and no
// "name (2)" duplicate from a recomputed plan.
func TestWorkerRestartsAndCommitsExactlyOnce(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "once.txt", Data: []byte("exactly once")})

	// Run 1: cancel the context the moment the ciphertext read starts, which
	// leaves a journalled plan and a staging directory but no commit.
	ctx, cancel := context.WithCancel(context.Background())
	f.fc.mu.Lock()
	f.fc.failBlobTimes = 0
	f.fc.mu.Unlock()
	go func() {
		for {
			if _, _, _, blobs := f.fc.counts(); blobs > 0 {
				cancel()
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	_ = f.worker().Run(ctx)

	// Central reclaims the abandoned lease.
	f.fc.requeue(id)

	// Run 2 completes it.
	if err := f.runOnce(); err != nil {
		t.Fatalf("second run: %v", err)
	}
	assertDirContains(t, f.root, "once.txt")
	if got := read(t, filepath.Join(f.root, "once.txt")); got != "exactly once" {
		t.Fatalf("content = %q", got)
	}
}

// TestWorkerReCommitsNothingWhenTheSavedResponseIsLost is the response-loss
// requirement. The commit succeeded and central never learned; the task is
// re-queued and re-claimed. The worker must recognise its own receipt, report
// saved WITHOUT downloading again, and leave exactly one file.
func TestWorkerReCommitsNothingWhenTheSavedResponseIsLost(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "receipt.txt", Data: []byte("delivered once")})
	f.fc.dropSavedReport = true
	if err := f.runOnce(); err != nil {
		t.Fatalf("first run: %v", err)
	}
	assertDirContains(t, f.root, "receipt.txt")
	_, _, _, blobsAfterFirst := f.fc.counts()

	// Central's lease sweep returns the task to the queue.
	f.fc.mu.Lock()
	f.fc.dropSavedReport = false
	f.fc.mu.Unlock()
	f.fc.requeue(id)

	if err := f.runOnce(); err != nil {
		t.Fatalf("second run: %v", err)
	}
	// One task id, one local commit — no "receipt (2).txt".
	assertDirContains(t, f.root, "receipt.txt")
	if state, _ := f.fc.taskState(id); state != inbox.TaskSaved {
		t.Fatalf("task state = %s, want saved after the retried report", state)
	}
	if _, _, _, blobs := f.fc.counts(); blobs != blobsAfterFirst {
		t.Fatalf("the ciphertext was fetched again (%d -> %d); a completed task must not re-download",
			blobsAfterFirst, blobs)
	}
}

// TestWorkerAbandonsAStaleClaimWithoutReporting: the lease was reclaimed. A
// stale worker must say nothing at all — a report would be a machine asserting
// something about work it no longer holds.
func TestWorkerAbandonsAStaleClaimWithoutReporting(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "gone.txt", Data: []byte("x")})
	f.fc.staleClaimOnBlob = true
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	for _, s := range f.fc.reportedStates(id) {
		if s != inbox.TaskDownloading {
			t.Fatalf("a stale worker reported %q; it must report nothing", s)
		}
	}
}

// TestWorkerStopsOnRevocation: a revoked enrolment is terminal for the device
// and must end the process with a message, not become an infinite retry loop
// while senders keep seeing a device that looks fine.
func TestWorkerStopsOnRevocation(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	f.fc.mu.Lock()
	f.fc.revoked = true
	f.fc.mu.Unlock()

	err := f.worker(func(o *Options) { o.Once = false }).Run(context.Background())
	if err == nil {
		t.Fatal("a revoked device kept running")
	}
	if !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("error = %v, want it to name the revocation", err)
	}
}

// TestWorkerFailsClosedOnAnUnsupportedProtocol: a server that shares no version
// must stop the worker, never degrade to a default.
func TestWorkerFailsClosedOnAnUnsupportedProtocol(t *testing.T) {
	f := newFixture(t)
	f.fc.mu.Lock()
	f.fc.protocolVersions = []int{99}
	f.fc.mu.Unlock()
	err := f.runOnce()
	if !errors.Is(err, ErrUnsupportedByServer) {
		t.Fatalf("error = %v, want ErrUnsupportedByServer", err)
	}
}

// TestWorkerFailsClosedOnAnUnsupportedCapability is the same rule for the
// receive family.
func TestWorkerFailsClosedOnAnUnsupportedCapability(t *testing.T) {
	f := newFixture(t)
	f.fc.mu.Lock()
	f.fc.receiveCaps = []string{"inbox.receive.v9"}
	f.fc.mu.Unlock()
	if err := f.runOnce(); !errors.Is(err, ErrUnsupportedByServer) {
		t.Fatalf("error = %v, want ErrUnsupportedByServer", err)
	}
}

// TestWorkerRefusesToRunWithoutAnExplicitOptIn: automatic receive is default-off
// and the worker never invents the opt-in.
func TestWorkerRefusesToRunWithoutAnExplicitOptIn(t *testing.T) {
	f := newFixture(t)
	cfg, _, _ := f.store.LoadConfig()
	cfg.Enabled = false
	if err := f.store.SaveConfig(cfg, f.clock.Now()); err != nil {
		t.Fatalf("config: %v", err)
	}
	if err := f.runOnce(); !errors.Is(err, ErrNotEnabled) {
		t.Fatalf("error = %v, want ErrNotEnabled", err)
	}
	if hb, pending, _, _ := f.fc.counts(); hb != 0 || pending != 0 {
		t.Fatalf("a disabled worker still talked to central (%d heartbeats, %d polls)", hb, pending)
	}
}

// TestPausedWorkerNeitherClaimsNorAssertsPresence. Pause is durable local
// scheduling state: it must stop work AND stop the heartbeat, so a sender is
// told the device is offline rather than watching a file that will not land.
func TestPausedWorkerNeitherClaimsNorAssertsPresence(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	f.fc.enqueue(t, srcFile{Name: "later.txt", Data: []byte("x")})
	cfg, _, _ := f.store.LoadConfig()
	cfg.Paused = true
	if err := f.store.SaveConfig(cfg, f.clock.Now()); err != nil {
		t.Fatalf("config: %v", err)
	}
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	hb, pending, claims, _ := f.fc.counts()
	if hb != 0 || pending != 0 || claims != 0 {
		t.Fatalf("a paused worker heartbeated %d, polled %d, claimed %d times; all must be 0", hb, pending, claims)
	}

	// Resume: the same queued task is delivered without any server round trip to
	// re-enable it, which is what makes pause reversible at zero cost.
	cfg.Paused = false
	if err := f.store.SaveConfig(cfg, f.clock.Now()); err != nil {
		t.Fatalf("config: %v", err)
	}
	if err := f.runOnce(); err != nil {
		t.Fatalf("run after resume: %v", err)
	}
	assertDirContains(t, f.root, "later.txt")
}

// TestWorkerDoesNotClaimIntoAnUnusableDirectory: the directory disappeared. The
// worker must report it as unusable on the heartbeat and refuse to take a lease
// it cannot honour.
func TestWorkerDoesNotClaimIntoAnUnusableDirectory(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	f.fc.enqueue(t, srcFile{Name: "x.txt", Data: []byte("x")})
	if err := os.RemoveAll(f.root); err != nil {
		t.Fatalf("remove receive dir: %v", err)
	}
	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	_, pending, claims, _ := f.fc.counts()
	if claims != 0 {
		t.Fatalf("the worker claimed %d task(s) with no receive directory", claims)
	}
	if pending != 0 {
		t.Fatalf("the worker polled %d time(s) with no receive directory", pending)
	}
	f.fc.mu.Lock()
	ready := f.fc.dirReady
	f.fc.mu.Unlock()
	if ready {
		t.Fatal("the worker told central its receive directory was usable when it was gone")
	}
}

// TestWorkerRequeuesItsOwnLocallyBlockedTasksOnRecovery, and ONLY those. A task
// held under the `ask` policy is waiting for a person, and auto-accepting it
// would be this machine answering a question asked of its owner.
func TestWorkerRequeuesOnlyItsOwnLocallyBlockedTasks(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	blocked := f.fc.enqueue(t, srcFile{Name: "blocked.txt", Data: []byte("later")})
	waiting := f.fc.enqueue(t, srcFile{Name: "asked.txt", Data: []byte("ask me")})

	f.fc.mu.Lock()
	f.fc.find(blocked).State = inbox.TaskAttentionRequired
	f.fc.find(blocked).ErrorCode = inbox.TaskErrDiskFull
	f.fc.find(waiting).State = inbox.TaskAttentionRequired
	f.fc.find(waiting).ErrorCode = inbox.TaskErrNone // the `ask` policy: no error
	f.fc.mu.Unlock()

	// First pass with a missing directory establishes "not ready"; restoring it
	// is the false->true transition that triggers exactly one requeue sweep.
	if err := os.RemoveAll(f.root); err != nil {
		t.Fatalf("remove: %v", err)
	}
	w := f.worker(func(o *Options) { o.Once = false })
	tc := f.clock
	ctx, cancel := context.WithCancel(context.Background())
	tc.mu.Lock()
	tc.cancel, tc.cancelAfter = cancel, 4
	// Restore the directory exactly between pass 1 and pass 2, so the worker
	// observes a false->true transition rather than a lucky one.
	tc.hook = func(n int) {
		if n == 1 {
			_ = os.MkdirAll(f.root, 0o700)
		}
	}
	tc.mu.Unlock()
	_ = w.Run(ctx)

	if state, _ := f.fc.taskState(waiting); state != inbox.TaskAttentionRequired {
		t.Fatalf("a task awaiting a PERSON was moved to %s by the worker", state)
	}
	if state, _ := f.fc.taskState(blocked); state == inbox.TaskAttentionRequired {
		t.Fatal("the worker's own disk_full task was not re-queued after the directory returned")
	}
}

// A zero-byte readiness probe can succeed on a disk that still cannot fit the
// parked task, so disk recovery is checked against the task size rather than a
// directory false->true transition.
func TestWorkerRequeuesDiskFullTaskWhenItFitsAgain(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "fits-now.txt", Data: []byte("small")})
	f.fc.mu.Lock()
	f.fc.find(id).State = inbox.TaskAttentionRequired
	f.fc.find(id).ErrorCode = inbox.TaskErrDiskFull
	f.fc.mu.Unlock()

	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if state, code := f.fc.taskState(id); state != inbox.TaskSaved || code != inbox.TaskErrNone {
		t.Fatalf("task = %s/%s, want saved after the size-aware space check", state, code)
	}
	if got := read(t, filepath.Join(f.root, "fits-now.txt")); got != "small" {
		t.Fatalf("delivered content = %q", got)
	}
}

// TestWorkerBacksOffWhenIdleAndNeverBusyLoops. An idle device must not poll in a
// tight loop: every pass either does work or sleeps, and the idle delay climbs
// to a cap.
func TestWorkerBacksOffWhenIdleAndNeverBusyLoops(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	w := f.worker(func(o *Options) { o.Once = false })
	tc := f.clock
	ctx, cancel := context.WithCancel(context.Background())
	tc.mu.Lock()
	tc.cancel, tc.cancelAfter = cancel, 6
	tc.mu.Unlock()

	if err := w.Run(ctx); err != nil {
		t.Fatalf("run: %v", err)
	}
	sleeps := tc.sleeps()
	if len(sleeps) < 6 {
		t.Fatalf("the loop slept %d times before cancellation; a busy loop would sleep 0", len(sleeps))
	}
	for i, d := range sleeps {
		if d <= 0 {
			t.Fatalf("sleep %d was %v: the loop can spin", i, d)
		}
	}
	if sleeps[len(sleeps)-1] <= sleeps[0] {
		t.Fatalf("idle backoff did not grow: %v then %v", sleeps[0], sleeps[len(sleeps)-1])
	}
	if sleeps[len(sleeps)-1] > pollMax {
		t.Fatalf("idle backoff %v exceeded the cap %v", sleeps[len(sleeps)-1], pollMax)
	}
}

// TestWorkerShutsDownGracefully: SIGTERM-equivalent cancellation must return
// promptly, report going offline so senders stop being told the device is here,
// and leave no partial output.
func TestWorkerShutsDownGracefully(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	w := f.worker(func(o *Options) { o.Once = false })
	ctx, cancel := context.WithCancel(context.Background())
	tc := f.clock
	tc.mu.Lock()
	tc.cancel, tc.cancelAfter = cancel, 1
	tc.mu.Unlock()

	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancellation returned %v; a clean stop must be nil so a supervisor does not restart-loop", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the worker did not stop within 10s of cancellation")
	}
	f.fc.mu.Lock()
	offline := f.fc.offlineHits
	f.fc.mu.Unlock()
	if offline == 0 {
		t.Fatal("shutdown did not report going offline; senders would wait out the presence TTL")
	}
	assertReceiveDirEmpty(t, f.root)
}

// TestWorkerHonoursALostThenRestoredHeartbeat: transient central failures must
// back off, not spin, and must not be mistaken for a fatal condition.
func TestWorkerTransientHeartbeatFailureIsRetried(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	f.fc.mu.Lock()
	f.fc.failHeartbeat = 1
	f.fc.mu.Unlock()
	w := f.worker(func(o *Options) { o.Once = false })
	tc := f.clock
	ctx, cancel := context.WithCancel(context.Background())
	tc.mu.Lock()
	tc.cancel, tc.cancelAfter = cancel, 3
	tc.mu.Unlock()
	if err := w.Run(ctx); err != nil {
		t.Fatalf("a transient heartbeat failure ended the worker: %v", err)
	}
	if hb, _, _, _ := f.fc.counts(); hb < 2 {
		t.Fatalf("heartbeats = %d; the worker did not retry after the induced failure", hb)
	}
}

// TestDuplicateNotificationsDoNotDoubleSave: the same task offered twice in one
// run must produce one commit. The journal is the guard.
func TestDuplicateNotificationsDoNotDoubleSave(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	id := f.fc.enqueue(t, srcFile{Name: "single.txt", Data: []byte("one")})
	if err := f.runOnce(); err != nil {
		t.Fatalf("first: %v", err)
	}
	// Central offers it again (a duplicate notification, or a sweep that
	// mistakenly re-queued a finished task).
	f.fc.requeue(id)
	if err := f.runOnce(); err != nil {
		t.Fatalf("second: %v", err)
	}
	assertDirContains(t, f.root, "single.txt")
}

// TestManifestSizeCrossCheck: a manifest declaring more plaintext than the
// ciphertext it sits behind is impossible (every frame adds a length prefix and
// a tag), so it is a lie central's own byte count catches.
func TestManifestSizeCrossCheck(t *testing.T) {
	m := inboxmanifest.Manifest{
		V:     inboxmanifest.Version,
		Items: []inboxmanifest.Item{{Kind: inboxmanifest.KindFile, Name: "a", Size: 1000}},
	}
	if _, err := checkManifest(m, 100); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("checkManifest = %v, want ErrManifestInvalid", err)
	}
	if _, err := checkManifest(m, 2000); err != nil {
		t.Fatalf("a legitimate manifest was refused: %v", err)
	}
}

func assertReceiveDirEmpty(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatalf("read receive dir: %v", err)
	}
	for _, e := range entries {
		// The staging area is this package's own; anything else is output that
		// should not exist.
		if e.Name() == stagingDirName {
			continue
		}
		t.Fatalf("the receive directory contains %q after a failed delivery; nothing may be left behind", e.Name())
	}
}
