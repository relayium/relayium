package inboxclient

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"runtime"
	"slices"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

// The foreground worker.
//
// `relayium inbox run` IS this loop. It is deliberately a plain foreground
// process that reads its configuration, holds one lock, talks only outbound, and
// exits when its context is cancelled — because that is simultaneously the right
// shape for an interactive terminal, for `systemd`/`launchd` (which supervise a
// foreground child and own restarts themselves), and for a container entrypoint.
// Adding a self-daemonising mode would give all three of them something worse
// than what they already do well.
//
// WHAT KEEPS IT HONEST:
//
//   - Presence is asserted only while the worker is actually able to receive.
//     Paused, or a receive directory that fails its write probe, is reported as
//     such rather than papered over with a heartbeat.
//   - Nothing is claimed that will not be worked: tasks are processed one at a
//     time, and the claim batch is sized to what one pass can finish.
//   - It never busy-loops. Every path through the loop either does work or
//     sleeps on a jittered backoff, and every sleep is cancellable.

// Worker bounds.
const (
	// pollBase/pollMax bracket the idle poll interval. The lower bound keeps an
	// idle device from polling faster than a person would notice; the upper bound
	// keeps a long-idle device from taking minutes to notice a new file. Backoff
	// climbs between them so a fleet of idle devices costs central little.
	pollBase = 3 * time.Second
	pollMax  = 60 * time.Second
	// pollJitter spreads a fleet that all restarted together (a host reboot, a
	// container rollout) so they do not synchronise into a thundering herd.
	pollJitter = 0.25
	// claimBatch is one because tasks are worked sequentially and their sizes
	// are unbounded until TTL. Claiming a second task before the first finishes
	// could let the second task's lease expire without ever starting it.
	claimBatch = 1
	// errorBackoffMax bounds the retry delay after a central-side failure.
	errorBackoffMax = 2 * time.Minute
)

// Options configures a Worker.
type Options struct {
	Client *Client
	Store  *Store
	Config Config
	// Platform and AppVersion are announced at enrolment. Both are bounded
	// display metadata; neither is used for any authorization decision.
	Platform   string
	AppVersion string
	Clock      Clock
	Log        Logger
	// Rand returns a value in [0,1) for backoff jitter. Injected so a test gets a
	// deterministic schedule instead of a flaky one.
	Rand func() float64
	// Once drains the queue and returns instead of looping. Used by tests and by
	// operators who want a cron-style single pass rather than a resident service.
	Once bool
	// IdleTimeout bounds a stalled ciphertext body; 0 uses the default.
	IdleTimeout time.Duration
	// RenewInterval overrides the progress-report cadence; 0 uses a third of the
	// lease central advertises.
	RenewInterval time.Duration
}

// Worker is the resident receive loop for one device.
type Worker struct {
	opt   Options
	clock Clock
	log   Logger
	rnd   func() float64

	// leaseSeconds is what CENTRAL says a lease lasts, learned from the claim
	// response rather than assumed from the compiled-in constant, so a server
	// that shortens it is followed instead of contradicted.
	leaseSeconds int
	// heartbeatInterval likewise follows what central advertises.
	heartbeatInterval time.Duration
	// dirReady is the last probe result, reported on every heartbeat.
	dirReady bool
	// recovered marks a false->true transition of dirReady, which is the only
	// thing that re-queues this device's own attention_required tasks.
	recovered bool
}

// NewWorker builds a worker. It does no I/O; Run performs enrolment.
func NewWorker(opt Options) *Worker {
	w := &Worker{opt: opt, clock: opt.Clock, log: opt.Log, rnd: opt.Rand}
	if w.clock == nil {
		w.clock = RealClock{}
	}
	if w.rnd == nil {
		w.rnd = rand.Float64
	}
	w.leaseSeconds = int(inbox.TaskLeaseTTL.Seconds())
	w.heartbeatInterval = inbox.HeartbeatInterval
	return w
}

// ErrNotEnabled means `relayium inbox enable --dir` has not been run. Automatic
// receive is default-off (PRD §8) and the worker refuses to invent an opt-in.
var ErrNotEnabled = errors.New("relayium inbox: automatic receive is not enabled on this device (run `relayium inbox enable --dir <folder>`)")

// ErrUnsupportedByServer means central and this build share no protocol version
// or no receive capability. Fail closed: an unrecognised negotiation result is
// never degraded to a default, because a device central cannot describe must not
// appear to a sender as a working target.
var ErrUnsupportedByServer = errors.New("relayium inbox: this Relayium server and this CLI do not share a supported Device Inbox protocol version or receive capability")

// Capabilities is what this build announces. It is a fixed list rather than a
// computed one: adding a token has to be a deliberate edit that forces a look at
// whether the behaviour behind it is actually implemented here.
//
// inbox.text.v1 is deliberately ABSENT. This build receives v2 file deliveries;
// it has no message store and no way to show a message as a message, so
// announcing the token would tell a sender that "send text to this server" ends
// somewhere a person can read it. The absence is the truthful answer, and it is
// what keeps a text send from being offered against a CLI target at all.
func Capabilities() []string {
	return []string{inbox.CapReceiveV2, inbox.CapAutoAcceptV1, inbox.CapResumeV1}
}

// ProtocolVersions is the set this build speaks.
func ProtocolVersions() []int { return []int{inbox.ProtocolV2} }

// Platform returns the announced platform label.
func Platform() string { return runtime.GOOS }

// Run enrols, then serves until ctx is cancelled. It returns nil on a clean
// shutdown, so a supervisor sees a normal exit for an ordinary stop and a
// non-zero one only for a real failure.
func (w *Worker) Run(ctx context.Context) error {
	cfg := w.opt.Config
	if !cfg.Enabled {
		return ErrNotEnabled
	}
	if err := w.enrol(ctx); err != nil {
		return err
	}
	defer w.sayGoodbye()

	next := pollBase
	lastHeartbeat := time.Time{}
	for {
		if err := ctx.Err(); err != nil {
			return nil // cancellation is a clean stop, not a failure
		}
		// Re-read the configuration each pass so `pause`/`resume` take effect on
		// a running worker without a restart, which is what makes them usable
		// under a supervisor that would otherwise fight a manual stop.
		if cfg, found, err := w.opt.Store.LoadConfig(); err == nil && found {
			w.opt.Config = cfg
		}
		if !w.opt.Config.Enabled {
			w.log.logf("inbox: automatic receive was disabled; stopping")
			return nil
		}

		w.probeDir()

		if w.opt.Config.Paused {
			// Paused means "not receiving". Saying so — by letting presence lapse
			// rather than heartbeating — is what keeps a sender's UI truthful:
			// the file queues and waits instead of appearing about to land.
			if !lastHeartbeat.IsZero() {
				w.sayGoodbye()
				lastHeartbeat = time.Time{}
			}
			if w.opt.Once {
				return nil
			}
			if err := w.clock.Sleep(ctx, w.jitter(pollBase)); err != nil {
				return nil
			}
			continue
		}

		if w.clock.Now().Sub(lastHeartbeat) >= w.heartbeatInterval {
			if err := w.heartbeat(ctx); err != nil {
				if fatal := w.fatalServerError(err); fatal != nil {
					return fatal
				}
				w.log.logf("inbox: heartbeat failed: %v", redact(err))
				next = backoff(next, errorBackoffMax)
				if w.opt.Once {
					return err
				}
				if serr := w.clock.Sleep(ctx, w.jitter(next)); serr != nil {
					return nil
				}
				continue
			}
			lastHeartbeat = w.clock.Now()
		}

		worked, err := w.pass(ctx)
		if err != nil {
			if fatal := w.fatalServerError(err); fatal != nil {
				return fatal
			}
			w.log.logf("inbox: poll failed: %v", redact(err))
			next = backoff(next, errorBackoffMax)
		} else if worked {
			next = pollBase // work found: come back promptly, there may be more
		} else {
			next = backoff(next, pollMax)
		}

		if w.opt.Once {
			return err
		}
		if err := w.clock.Sleep(ctx, w.jitter(next)); err != nil {
			return nil
		}
	}
}

// enrol announces this build's protocol versions and capabilities, then makes
// sure a usable key pair exists and is published.
func (w *Worker) enrol(ctx context.Context) error {
	res, err := w.opt.Client.Enrol(ctx, EnrolRequest{
		Platform:         w.opt.Platform,
		AppVersion:       w.opt.AppVersion,
		ProtocolVersions: ProtocolVersions(),
		Capabilities:     Capabilities(),
		AutoAccept:       inbox.AutoAcceptAuto,
		ReceiveDirReady:  CheckReceiveDir(w.opt.Config.Dir) == nil,
	})
	if err != nil {
		if fatal := w.fatalServerError(err); fatal != nil {
			return fatal
		}
		return err
	}
	// Fail closed on anything this build cannot actually do. Central selected
	// these; proceeding with a version or capability we do not implement would be
	// exactly the silent degradation invariant 2 forbids.
	if !slices.Contains(ProtocolVersions(), res.ProtocolVersion) {
		return fmt.Errorf("%w: central selected protocol v%d", ErrUnsupportedByServer, res.ProtocolVersion)
	}
	if !slices.Contains(Capabilities(), res.ReceiveCapability) {
		return fmt.Errorf("%w: central selected receive capability %q", ErrUnsupportedByServer, res.ReceiveCapability)
	}
	if res.KeyAlgorithm != inbox.KeyAlgX25519SealedBoxV1 {
		return fmt.Errorf("%w: central expects key algorithm %q", ErrUnsupportedByServer, res.KeyAlgorithm)
	}
	if res.Inbox.HeartbeatIntervalSeconds > 0 {
		w.heartbeatInterval = time.Duration(res.Inbox.HeartbeatIntervalSeconds) * time.Second
	}
	_, err = EnsureUsableKey(ctx, w.opt.Client, w.opt.Store.Keys(), res.Inbox.Key, w.clock.Now())
	return err
}

// heartbeat refreshes presence with a freshly probed directory state.
func (w *Worker) heartbeat(ctx context.Context) error {
	res, err := w.opt.Client.Heartbeat(ctx, w.dirReady)
	if err != nil {
		return err
	}
	if res.HeartbeatIntervalSeconds > 0 {
		w.heartbeatInterval = time.Duration(res.HeartbeatIntervalSeconds) * time.Second
	}
	return nil
}

// probeDir refreshes the receive-directory verdict and notices a recovery.
func (w *Worker) probeDir() {
	ready := CheckReceiveDir(w.opt.Config.Dir) == nil
	w.recovered = ready && !w.dirReady
	if ready != w.dirReady {
		w.log.logf("inbox: receive directory is now %s", readyWord(ready))
	}
	w.dirReady = ready
}

func readyWord(ok bool) string {
	if ok {
		return "usable"
	}
	return "unusable"
}

// sayGoodbye expires presence immediately on shutdown or pause. Best effort: a
// worker that cannot reach central still stops, and central's presence TTL
// expires it within ninety seconds anyway.
func (w *Worker) sayGoodbye() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.opt.Client.Offline(ctx); err != nil {
		w.log.logf("inbox: could not report going offline: %v", redact(err))
	}
}

// pass does one poll/claim/deliver cycle and reports whether it did any work.
func (w *Worker) pass(ctx context.Context) (bool, error) {
	if !w.dirReady {
		// Refuse to claim into a directory that just failed its write probe.
		// Claiming would take a lease this worker cannot honour and would leave
		// the sender watching a task that is not progressing.
		return false, nil
	}
	if w.recovered {
		// The local blocker cleared. Re-queue the tasks THIS device parked for a
		// local reason, and nothing else: a task held under the `ask` policy is
		// waiting for a person, and auto-accepting it would be this machine
		// answering a question that was asked of its owner (PRD §8).
		w.requeueLocallyBlocked(ctx)
		w.recovered = false
	}

	pending, err := w.opt.Client.Pending(ctx, claimBatch)
	if err != nil {
		return false, err
	}
	if len(pending) == 0 {
		_ = w.opt.Store.Journals().Prune(w.clock.Now())
		return false, nil
	}
	// A write probe says the root is writable; it does not say it now has enough
	// room for a task that was parked as disk_full. Re-check that task's declared
	// size on every (backed-off) poll and re-queue it only once the same preflight
	// the receiver uses would pass. This makes "free some space" self-healing
	// without turning a still-full disk into a claim/report busy loop.
	w.requeueRecoveredDiskSpace(ctx, pending)

	deliveries, leaseSeconds, err := w.opt.Client.Claim(ctx, claimBatch)
	if err != nil {
		return false, err
	}
	if leaseSeconds > 0 {
		w.leaseSeconds = leaseSeconds
	}
	if len(deliveries) == 0 {
		// Pending said there was work but the claim leased none: another worker
		// took it, or it expired between the two calls. Not an error.
		return false, nil
	}

	// Deliveries are worked strictly one at a time. Concurrency here would buy
	// little (one disk, one network path) and would cost the simple invariant
	// that at most one delivery is touching the receive directory at a time.
	worked := false
	for _, d := range deliveries {
		if ctx.Err() != nil {
			return worked, nil
		}
		w.deliver(ctx, d)
		worked = true
	}
	return worked, nil
}

func (w *Worker) requeueRecoveredDiskSpace(ctx context.Context, tasks []Task) {
	for _, t := range tasks {
		if t.State != inbox.TaskAttentionRequired || t.ErrorCode != inbox.TaskErrDiskFull {
			continue
		}
		if err := checkFreeSpace(w.opt.Config.Dir, t.CiphertextBytes); err != nil {
			continue
		}
		if _, err := w.opt.Client.Accept(ctx, t.ID, true); err != nil {
			w.log.logf("inbox: task %s could not be re-queued after space recovery: %v", t.ID, redact(err))
			continue
		}
		w.log.logf("inbox: task %s re-queued after enough disk space became available", t.ID)
	}
}

// deliver runs one task and reports the outcome exactly once.
func (w *Worker) deliver(ctx context.Context, d Delivery) {
	w.log.logf("inbox: task %s claimed (%d ciphertext byte(s))", d.ID, d.CiphertextBytes)
	r := &Receiver{
		Client: w.opt.Client, Store: w.opt.Store, Root: w.opt.Config.Dir,
		Clock: w.clock, Log: w.log, IdleTimeout: w.opt.IdleTimeout,
		RenewInterval: w.opt.RenewInterval,
		Renew: func(ctx context.Context, state string) error {
			_, err := w.opt.Client.Report(ctx, d.ID, d.ClaimToken, state, inbox.TaskErrNone, false)
			return err
		},
	}
	if w.opt.RenewInterval == 0 && w.leaseSeconds > 0 {
		r.RenewInterval = time.Duration(w.leaseSeconds) * time.Second / 3
	}

	err := r.Deliver(ctx, d)
	if err == nil {
		w.reportSaved(ctx, d)
		return
	}
	if errors.Is(err, ErrAbandon) {
		w.log.logf("inbox: task %s released without a report: %v", d.ID, redact(err))
		return
	}
	if ctx.Err() != nil {
		// A cancelled worker says nothing: the lease lapses and central returns
		// the task to the queue with its own `lease_expired`, which is the
		// truthful account of what happened.
		w.log.logf("inbox: task %s interrupted by shutdown; leaving it to the lease", d.ID)
		return
	}
	f := AsFailure(err)
	if f == nil {
		f = retryable(inbox.TaskErrInternal, err)
	}
	w.log.logf("inbox: task %s -> %s (%s)", d.ID, f.State, f.Code)
	if _, rerr := w.opt.Client.Report(ctx, d.ID, d.ClaimToken, f.State, f.Code, false); rerr != nil {
		w.log.logf("inbox: task %s could not report %s: %v", d.ID, f.State, redact(rerr))
	}
}

// reportSaved asserts the commit, then records that central acknowledged it.
//
// The journal is what makes this idempotent across a lost response: it already
// says `completed`, so a re-claimed task skips straight back to here rather than
// downloading and committing a second time.
func (w *Worker) reportSaved(ctx context.Context, d Delivery) {
	journals := w.opt.Store.Journals()
	// `saved` is reachable only from `verifying`, so assert that first. Reporting
	// the state a task is already in is an idempotent no-op, which makes this
	// safe on a retry.
	if _, err := w.opt.Client.Report(ctx, d.ID, d.ClaimToken, inbox.TaskVerifying, inbox.TaskErrNone, false); err != nil {
		if code := ErrorCode(err); code == "task_terminal" {
			w.markReported(journals, d.ID)
			return
		}
		w.log.logf("inbox: task %s committed locally but could not report verifying: %v", d.ID, redact(err))
		return
	}
	if _, err := w.opt.Client.Report(ctx, d.ID, d.ClaimToken, inbox.TaskSaved, inbox.TaskErrNone, true); err != nil {
		if code := ErrorCode(err); code == "task_terminal" {
			// Central already recorded the outcome — this is the retry converging.
			w.markReported(journals, d.ID)
			return
		}
		// The files ARE on disk. The report is retried on the next claim from the
		// journal, never by re-delivering.
		w.log.logf("inbox: task %s committed locally but the saved report did not land: %v", d.ID, redact(err))
		return
	}
	w.log.logf("inbox: task %s saved", d.ID)
	w.markReported(journals, d.ID)
}

func (w *Worker) markReported(journals *JournalStore, taskID string) {
	j, found, err := journals.Load(taskID)
	if err != nil || !found {
		return
	}
	j.SavedReported = true
	_ = journals.Save(&j, w.clock.Now())
}

// requeueLocallyBlocked re-queues the attention_required tasks this device
// parked for a local reason that has now cleared.
//
// The filter is deliberately narrow. Disk space is handled separately using
// the task's size, because an empty-file readiness probe can succeed while the
// task still does not fit. A `name_conflict` needs a person to look at the
// directory, and a task held under the `ask` policy carries no error code at
// all, so neither is touched automatically.
func (w *Worker) requeueLocallyBlocked(ctx context.Context) {
	tasks, err := w.opt.Client.Pending(ctx, 0)
	if err != nil {
		return
	}
	blockedLocally := []string{
		inbox.TaskErrPermissionDenied, inbox.TaskErrDirectoryUnavailabl,
	}
	for _, t := range tasks {
		if t.State != inbox.TaskAttentionRequired || !slices.Contains(blockedLocally, t.ErrorCode) {
			continue
		}
		if _, err := w.opt.Client.Accept(ctx, t.ID, true); err != nil {
			w.log.logf("inbox: task %s could not be re-queued: %v", t.ID, redact(err))
			continue
		}
		w.log.logf("inbox: task %s re-queued after the local blocker cleared", t.ID)
	}
}

// fatalServerError recognises the rejections that mean "stop", not "retry".
//
// A revoked enrolment, an unshared protocol version and a credential that is no
// longer bound to this device are all conditions a human must resolve. Retrying
// them forever would hide the problem behind a log nobody reads while the sender
// keeps being told the device is fine.
func (w *Worker) fatalServerError(err error) error {
	if errors.Is(err, ErrNoCurrentDevice) {
		return err
	}
	switch ErrorCode(err) {
	case "device_inbox_revoked":
		return fmt.Errorf("this device's inbox was revoked; clear it from another device or re-enable it here: %w", err)
	case "unsupported_protocol_version", "unsupported_capability", "unsupported_key_algorithm":
		return fmt.Errorf("%w: %v", ErrUnsupportedByServer, err)
	case "unsupported_auto_accept_capability":
		return fmt.Errorf("%w: %v", ErrUnsupportedByServer, err)
	}
	if ErrorStatus(err) == 401 {
		return fmt.Errorf("this device's credential is no longer accepted; run `relayium login` again: %w", err)
	}
	if ErrorStatus(err) == 404 {
		// The device row is gone: it was deleted from the web, or a re-login
		// minted a different one. Continuing would poll an id that no longer
		// exists forever.
		return fmt.Errorf("this device no longer exists on the server; run `relayium inbox enable --dir <folder>` again: %w", err)
	}
	return nil
}

// backoff doubles d up to max.
func backoff(d, max time.Duration) time.Duration {
	d *= 2
	if d > max || d <= 0 {
		return max
	}
	return d
}

// jitter spreads a scheduled delay by ±pollJitter so restarted fleets desynchronise.
func (w *Worker) jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return d
	}
	factor := 1 + pollJitter*(2*w.rnd()-1)
	out := time.Duration(float64(d) * factor)
	if out <= 0 {
		return d
	}
	return out
}

// redact bounds what an error contributes to a log line.
//
// Errors from this package are constructed here and carry only ids, codes and
// counts, but a transport error's text is composed by net/http from a URL — and
// a URL is under this device's own control, not a sender's. The guard is the
// length bound: an error is never allowed to dump an unbounded remote string
// into an operator's journal.
func redact(err error) string {
	if err == nil {
		return ""
	}
	const maxLen = 300
	s := err.Error()
	if len(s) > maxLen {
		return s[:maxLen] + "…"
	}
	return s
}
