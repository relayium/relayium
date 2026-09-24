package inboxsend

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/termtext"
)

// DeviceRow is one `inbox devices` line.
type DeviceRow struct {
	ID       string
	Name     string
	Kind     string
	Current  bool
	Presence string
	Policy   string
	Sendable bool
	Block    string
	Caveats  []string
}

// Devices lists the account's devices with the send verdict for each. It
// enrols nothing and creates no local state.
func (s *Session) Devices(ctx context.Context) ([]DeviceRow, error) {
	devs, _, err := s.resolveSelf(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]DeviceRow, 0, len(devs))
	for _, d := range devs {
		av := Evaluate(d)
		presence := ""
		if d.Inbox != nil {
			presence = d.Inbox.Presence
		}
		out = append(out, DeviceRow{
			ID: d.ID, Name: d.Name, Kind: d.Kind, Current: d.Current, Presence: presence,
			Policy: av.Policy, Sendable: av.Sendable, Block: av.Block, Caveats: av.Caveats,
		})
	}
	return out, nil
}

// SentTask is one delivery as `inbox sent` reports it: never its idempotency
// key, stored object id or wrapped key.
type SentTask struct {
	TaskID         string
	TargetDeviceID string
	SourceDeviceID string
	State          string
	ErrorCode      string
	FromThisDevice bool
	CreatedAt      int64
	SavedAt        int64
	ExpiresAt      int64
	Terminal       bool
}

func sentTask(t inboxclient.Task, self string) SentTask {
	return SentTask{
		TaskID: t.ID, TargetDeviceID: t.TargetDeviceID, SourceDeviceID: t.SourceDeviceID,
		State: t.State, ErrorCode: t.ErrorCode, FromThisDevice: t.SourceDeviceID == self,
		CreatedAt: t.CreatedAt, SavedAt: t.SavedAt, ExpiresAt: t.ExpiresAt,
		Terminal: t.Terminal || inbox.IsTerminalTaskState(t.State),
	}
}

// LocalSend is one unfinished local send record.
type LocalSend struct {
	LocalSendID    string
	Phase          string
	TargetDeviceID string
	CreatedAt      int64
	// Resumable is a `send --resumable` record with a local encrypted copy.
	Resumable bool
}

// staleJournalAge is when an unfinished local record stops being useful: the
// ciphertext of an unfinished send is unbound and cleanup reclaims it long
// before this, so the record can only ever report failure.
const staleJournalAge = 7 * 24 * time.Hour

// LocalSends lists unfinished local sends and removes records too old to be of
// use (reported on Notice): non-uploading records after staleJournalAge, and a resumable
// send's local encrypted copy after spoolMaxAge (spool.go), together with its
// record if still planned. Uploading resumable records and their copies stay
// until retry resolves the server session or the user discards them. Copies
// no record owns are removed too. It never creates the journal directory.
func (s *Session) LocalSends() []LocalSend {
	ids, err := s.store.ids()
	if err != nil {
		s.notef("warning: cannot read the local send records: %s", termtext.Safe(err.Error()))
		return nil
	}
	var out []LocalSend
	for _, id := range ids {
		j, err := s.store.load(id)
		if err != nil {
			s.notef("warning: local send record %s is unreadable and was left untouched", id)
			continue
		}
		if s.expireSpooled(j) {
			continue
		}
		if !(j.Spooled() && j.Phase == PhaseUploading) && s.now().Sub(time.Unix(j.CreatedAt, 0)) > staleJournalAge {
			if lk, lerr := s.store.lock(id); lerr == nil {
				// A retry may have advanced a planned record before this lock.
				// Re-read before deleting so an uploading copy is never orphaned.
				cur, err := s.store.load(id)
				if err != nil {
					lk.release()
					if !errors.Is(err, errNoJournal) {
						s.notef("warning: local send record %s is unreadable and was left untouched", id)
					}
					continue
				}
				j = cur
				if !(j.Spooled() && j.Phase == PhaseUploading) {
					err = s.store.remove(id)
					if err == nil && j.Spooled() {
						_ = s.store.removeSpool(id)
					}
					lk.release()
					if err == nil {
						s.notef("removed the local record of an unfinished send from %s (%s); it can no longer be completed",
							time.Unix(j.CreatedAt, 0).UTC().Format(time.RFC3339), id)
						continue
					}
				} else {
					lk.release()
				}
			}
		}
		out = append(out, LocalSend{LocalSendID: id, Phase: j.Phase, TargetDeviceID: j.TargetDeviceID, CreatedAt: j.CreatedAt,
			Resumable: j.Spooled()})
	}
	for _, id := range s.store.collectOrphanSpools() {
		s.notef("removed a local encrypted copy no send record owns (%s)", id)
	}
	return out
}

// CheckRecords proves the local send record directory safe (see
// journalStore.openDir) without creating it; an absent one is fine. `inbox
// sent` calls it before any request, so an unsafe directory is reported
// before anything is read from the server or from it.
func (s *Session) CheckRecords() error {
	r, err := s.store.openDir(false)
	if errors.Is(err, errNoDir) {
		return nil
	}
	if err != nil {
		return unsafeRecords(err)
	}
	return r.Close()
}

// MaxSentLimit is the most tasks read per device.
const MaxSentLimit = 500

// Sent lists deliveries. to narrows the scan to one device (id or unique
// name); all includes deliveries other devices of the account sent.
func (s *Session) Sent(ctx context.Context, to string, all bool, limit int) ([]SentTask, error) {
	if limit <= 0 || limit > MaxSentLimit {
		limit = 50
	}
	devs, cur, err := s.resolveSelf(ctx)
	if err != nil {
		return nil, err
	}
	targets := devs
	if to != "" {
		d, err := resolveTarget(devs, to)
		if err != nil {
			return nil, err
		}
		targets = []inboxclient.Device{d}
	}
	var out []SentTask
	for _, d := range targets {
		// Not only enrolled devices: a device that has since cleared its inbox
		// still owns the (revoked) deliveries that were sent to it.
		if !isInertID(d.ID) {
			continue
		}
		tasks, err := s.client.ListTasks(ctx, d.ID, limit)
		if statusOf(err) == http.StatusNotFound {
			continue // removed between the two reads
		}
		if err != nil {
			return nil, readErr(err)
		}
		for _, t := range tasks {
			if !isInertID(t.ID) {
				continue
			}
			if all || t.SourceDeviceID == cur.ID {
				out = append(out, sentTask(t, cur.ID))
			}
		}
	}
	sort.SliceStable(out, func(i, k int) bool { return out[i].CreatedAt > out[k].CreatedAt })
	return out, nil
}

// findTask locates a task by id: on the --to device when given, else by a
// bounded scan of the account's devices.
func (s *Session) findTask(ctx context.Context, taskID, to string) (inboxclient.Task, string, error) {
	if !isInertID(taskID) {
		return inboxclient.Task{}, "", local(CodeNoSuchTask, "not a delivery id")
	}
	devs, cur, err := s.resolveSelf(ctx)
	if err != nil {
		return inboxclient.Task{}, "", err
	}
	if to != "" {
		d, err := resolveTarget(devs, to)
		if err != nil {
			return inboxclient.Task{}, "", err
		}
		t, err := s.client.GetTask(ctx, d.ID, taskID)
		if statusOf(err) == http.StatusNotFound {
			return inboxclient.Task{}, cur.ID, failed(CodeNoSuchTask, "that device has no delivery with this id (it may have been cancelled or cleaned up)")
		}
		if err != nil {
			return inboxclient.Task{}, "", readErr(err)
		}
		return t, cur.ID, nil
	}
	for _, d := range devs {
		if !isInertID(d.ID) {
			continue
		}
		tasks, err := s.client.ListTasks(ctx, d.ID, MaxSentLimit)
		if statusOf(err) == http.StatusNotFound {
			continue
		}
		if err != nil {
			return inboxclient.Task{}, "", readErr(err)
		}
		for _, t := range tasks {
			if t.ID == taskID {
				return t, cur.ID, nil
			}
		}
	}
	return inboxclient.Task{}, cur.ID, failed(CodeNoSuchTask,
		"no delivery with this id was found among the most recent deliveries to this account's devices (use --to to name the device)")
}

// Status is one task's current state.
func (s *Session) Status(ctx context.Context, taskID, to string) (SentTask, error) {
	t, self, err := s.findTask(ctx, taskID, to)
	if err != nil {
		return SentTask{}, err
	}
	return sentTask(t, self), nil
}

// cancellable are the states in which cancelling is honest — Web's
// CANCELLABLE_STATES. downloading/verifying hold a live device lease.
var cancellable = map[string]bool{
	inbox.TaskQueued: true, inbox.TaskNotified: true,
	inbox.TaskAttentionRequired: true, inbox.TaskFailedRetryable: true,
}

// Cancel results.
const (
	CancelCancelled = "cancelled"
	CancelGone      = "gone"
)

// Cancel removes a queued delivery. Central deletes the task row first and only
// then asks storage to drop the task-purpose ciphertext; that physical deletion
// can fail or be deferred to cleanup, so nothing here promises it happened.
func (s *Session) Cancel(ctx context.Context, taskID, to string) (string, error) {
	t, _, err := s.findTask(ctx, taskID, to)
	if err != nil {
		return "", err
	}
	switch {
	case t.State == inbox.TaskDownloading || t.State == inbox.TaskVerifying:
		return "", failed(CodeTaskInProgress, "the device is receiving it now; it was not cancelled")
	case !cancellable[t.State]:
		return "", failed(CodeTaskNotCancellable, "this delivery already finished ("+termtext.Safe(t.State)+"); there is nothing to cancel")
	}
	err = s.client.DeleteTask(ctx, t.TargetDeviceID, t.ID)
	switch {
	case err == nil:
		return CancelCancelled, nil
	case statusOf(err) == http.StatusNotFound:
		return CancelGone, nil
	case codeOf(err) == "invalid_transition":
		return "", failed(CodeTaskInProgress, "the device is receiving it now; it was not cancelled")
	case codeOf(err) == "task_terminal":
		return "", failed(CodeTaskNotCancellable, "this delivery already finished; there is nothing to cancel")
	}
	return "", readErr(err)
}

// ErrWaitTimeout is a wait that ended while the task was still unfinished.
var ErrWaitTimeout = errors.New("wait timed out")

// ErrTaskGone is a waited-on task that no longer exists.
var ErrTaskGone = errors.New("task gone")

// pollDelays is the status-poll cadence: Web's pollDelay (2 s doubling to a
// 30 s cap, reset on a state change). Overridable by tests.
var pollDelays = struct{ min, max time.Duration }{2 * time.Second, 30 * time.Second}

// Wait polls a task until it is terminal or timeout passes. Only central's
// "saved" — which only the target device can earn — is reported as saved.
//
// timeout bounds the WHOLE wait: the sleeps and every status request,
// including a response whose headers arrived but whose body is held open. It
// runs under its own deadline derived from ctx, so its expiry cancels an
// in-flight request and ends as ErrWaitTimeout (carrying the last state seen),
// while a cancellation of ctx itself — the user's interrupt — ends as an
// interrupted *Error. The two are told apart by which context ended, never by
// the error text.
func (s *Session) Wait(ctx context.Context, targetID, taskID string, timeout time.Duration, state string) (SentTask, error) {
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	delay := pollDelays.min
	cur := SentTask{TaskID: taskID, TargetDeviceID: targetID, State: state}
	ended := func() (SentTask, error) {
		if ctx.Err() != nil {
			return cur, ctxErr(ctx.Err())
		}
		return cur, ErrWaitTimeout
	}
	for {
		if err := sleepCtx(wctx, delay); err != nil {
			return ended()
		}
		t, err := s.client.GetTask(wctx, targetID, taskID)
		switch {
		case err == nil:
			prev := cur.State
			cur = sentTask(t, "")
			if cur.Terminal {
				return cur, nil
			}
			if t.State != prev {
				delay = pollDelays.min
				continue
			}
		case wctx.Err() != nil:
			return ended()
		case statusOf(err) == http.StatusNotFound:
			return cur, ErrTaskGone
		}
		delay = min(delay*2, pollDelays.max)
	}
}
