package inbox

import (
	"errors"
	"slices"
	"time"
)

// Device Inbox task queue vocabulary (Phase 1B). This file is the ONE place the
// task state machine is defined; the store and the HTTP layer consult it and
// never re-implement a transition rule of their own.
//
// PRE-IMPLEMENTATION INVARIANTS (Phase 1B). Each is asserted by a test in
// task_test.go or account/deviceinbox_task_test.go.
//
//  1. SERVER STATES ONLY. `encrypting` and `uploading` (PRD §10 items 1-2)
//     describe work happening on the SENDER's machine. Central never observes
//     them, so it must never store them: a row claiming "uploading" would be
//     central asserting something it cannot know. ValidateServerState rejects
//     them by name rather than as unknown strings, so the rejection stays
//     truthful if a client sends the PRD's own vocabulary.
//  2. FAIL CLOSED ON TRANSITIONS. CanTransitionTask consults an explicit table.
//     An unknown state, a terminal source, or an unlisted pair is refused. There
//     is no default-allow branch anywhere.
//  3. SAVED IS EARNED. `saved` is reachable ONLY from `verifying`, and only with
//     an explicit device assertion that decryption, verification and the atomic
//     local commit all completed. Ciphertext arriving at central is never it.
//  4. ERRORS ARE OPAQUE. A device reports a code from a closed set, never free
//     text. A file name or path cannot reach central through an error message
//     because there is no field that would carry one.
//  5. RETRY IS BOUNDED. Backoff grows and is capped, and attempts are capped, so
//     a permanently failing task becomes terminal instead of cycling forever.

// Server-visible task states (PRD §10 items 3-12). These are the only values
// that may appear in the `state` column; the database CHECK constraint repeats
// this list so a future write path cannot invent one.
const (
	TaskQueued            = "queued"
	TaskNotified          = "notified"
	TaskDownloading       = "downloading"
	TaskVerifying         = "verifying"
	TaskSaved             = "saved"
	TaskAttentionRequired = "attention_required"
	TaskExpired           = "expired"
	TaskRevoked           = "revoked"
	TaskFailedRetryable   = "failed_retryable"
	TaskFailedTerminal    = "failed_terminal"
)

// Sender-local phases (PRD §10 items 1-2). Named here so they can be REFUSED by
// name: they are real product states, but they belong to the sending client's
// own UI, and central has no way to observe either one. See invariant 1.
const (
	SenderStateEncrypting = "encrypting"
	SenderStateUploading  = "uploading"
)

// taskStates is the closed set of server states, in PRD order.
var taskStates = []string{
	TaskQueued, TaskNotified, TaskDownloading, TaskVerifying, TaskSaved,
	TaskAttentionRequired, TaskExpired, TaskRevoked,
	TaskFailedRetryable, TaskFailedTerminal,
}

// terminalTaskStates never transition again. A row in one of these is done, and
// the only thing that may still happen to it is deletion by its owner or by the
// retention sweep.
var terminalTaskStates = []string{
	TaskSaved, TaskExpired, TaskRevoked, TaskFailedTerminal,
}

// taskTransitions is the whole legal transition graph. Absent pair = refused.
//
// Reading it: the left column is the current stored state and the set is every
// state the task may move to. Terminal states have no entry at all, which is why
// CanTransitionTask can refuse them without a special case.
//
// Two shapes deserve the explicit note:
//
//   - `saved` appears ONLY under `verifying` (invariant 3). No path exists from
//     `downloading` — "the bytes arrived" is not "the file is on disk".
//   - `queued` is reachable from `notified`, `downloading`, `verifying`,
//     `attention_required` and `failed_retryable`, because all five are ways a
//     delivery attempt can end without the task being finished: a lease that
//     expired, a user who accepted a held task, a transient failure that has
//     served its backoff. Re-queuing is the recovery path, not an anomaly.
var taskTransitions = map[string][]string{
	TaskQueued: {
		TaskNotified, TaskDownloading, TaskAttentionRequired,
		TaskExpired, TaskRevoked, TaskFailedTerminal,
	},
	TaskNotified: {
		TaskQueued, TaskDownloading, TaskAttentionRequired,
		TaskExpired, TaskRevoked, TaskFailedTerminal,
	},
	TaskDownloading: {
		TaskVerifying, TaskQueued, TaskAttentionRequired,
		TaskFailedRetryable, TaskFailedTerminal, TaskExpired, TaskRevoked,
	},
	TaskVerifying: {
		TaskSaved, TaskQueued, TaskAttentionRequired,
		TaskFailedRetryable, TaskFailedTerminal, TaskExpired, TaskRevoked,
	},
	TaskAttentionRequired: {
		TaskQueued, TaskFailedTerminal, TaskExpired, TaskRevoked,
	},
	TaskFailedRetryable: {
		TaskQueued, TaskFailedTerminal, TaskExpired, TaskRevoked,
	},
}

// deviceReportableStates is what a TARGET DEVICE may assert about a task it
// holds a lease on. It is deliberately narrower than the transition table:
// `expired` and `revoked` are central's decisions about time and authorization,
// and `queued`/`notified` are central's decisions about scheduling. A device
// that could report `revoked` could not do anything useful with it, but a device
// that could report `queued` could reset its own backoff.
var deviceReportableStates = []string{
	TaskDownloading, TaskVerifying, TaskSaved,
	TaskAttentionRequired, TaskFailedRetryable, TaskFailedTerminal,
}

// Task error codes. A CLOSED set (invariant 4): a device says which category of
// thing went wrong and central stores the token, so no free-text field exists
// through which a file name, a path or a plaintext fragment could arrive.
const (
	TaskErrNone                = ""
	TaskErrDownloadFailed      = "download_failed"
	TaskErrDecryptFailed       = "decrypt_failed"
	TaskErrVerifyFailed        = "verify_failed"
	TaskErrDiskFull            = "disk_full"
	TaskErrPermissionDenied    = "permission_denied"
	TaskErrDirectoryUnavailabl = "directory_unavailable"
	TaskErrNameConflict        = "name_conflict"
	TaskErrUserDeclined        = "user_declined"
	TaskErrUnsupported         = "unsupported"
	TaskErrInternal            = "internal"
	// TaskErrLeaseExpired is written by CENTRAL, not by a device: it records why
	// a leased task went back to the queue when its claimant stopped reporting.
	TaskErrLeaseExpired = "lease_expired"
	// TaskErrAttemptsExhausted is likewise central's: the retry budget ran out.
	TaskErrAttemptsExhausted = "attempts_exhausted"
	// TaskErrKeyRevoked records a task terminated because the key it was sealed
	// to was withdrawn. Nothing can decrypt it any more, including the device.
	TaskErrKeyRevoked = "key_revoked"
	// TaskErrStoredObjectUnavailable is written by central when the encrypted
	// object backing an unfinished task is deleted before the device saves it.
	TaskErrStoredObjectUnavailable = "stored_object_unavailable"
)

// deviceErrorCodes is what a device may submit. The three central-only codes
// above are excluded so a device cannot forge central's own account of events.
var deviceErrorCodes = []string{
	TaskErrNone, TaskErrDownloadFailed, TaskErrDecryptFailed, TaskErrVerifyFailed,
	TaskErrDiskFull, TaskErrPermissionDenied, TaskErrDirectoryUnavailabl,
	TaskErrNameConflict, TaskErrUserDeclined, TaskErrUnsupported, TaskErrInternal,
}

// Queue operational bounds.
//
// None of these is a commercial quota. The queue's BYTE volume is already bound
// by the account's existing storage quota, because a task references a Stored
// Object the account already paid for under the existing plan limits; and a
// task's lifetime is the referenced object's own expiry. What is left to bound
// is row count and retry work, which is what these constants do.
const (
	// TaskLeaseTTL is how long a claim holds a task before central assumes the
	// claimant died. A device that is still working renews it by reporting
	// progress, so the value bounds how long a CRASHED device strands a task,
	// not how long a legitimate download may take.
	TaskLeaseTTL = 5 * time.Minute

	// MaxTaskAttempts caps delivery attempts. Reached => failed_terminal with
	// TaskErrAttemptsExhausted, so a task that can never succeed (a corrupt
	// object, a device that always dies at the same point) stops consuming
	// claims instead of cycling until its TTL.
	MaxTaskAttempts = 8

	// Retry backoff: base << (attempts-1), capped. Bounded on both ends so a
	// flapping device neither hammers central nor waits out its whole TTL.
	TaskRetryBaseBackoff = 30 * time.Second
	TaskRetryMaxBackoff  = 30 * time.Minute

	// MaxPendingTasksPerDevice bounds unfinished rows per target device. This is
	// an abuse/DoS bound on ROW count, not a product quota: bytes are already
	// bounded by the account's storage plan.
	MaxPendingTasksPerDevice = 256

	// MaxClaimBatch bounds how many tasks one claim may lease, so a single call
	// cannot lease a device's whole queue and then strand it for TaskLeaseTTL.
	MaxClaimBatch     = 32
	DefaultClaimBatch = 8

	// MaxIdempotencyKeyLen bounds the sender-chosen creation key.
	MaxIdempotencyKeyLen = 128

	// SealedBoxBytes is the EXACT raw length of a KeyAlgX25519SealedBoxV1
	// wrapped key: a crypto_box_seal of the 32-byte AES-256-GCM content key is
	// a 32-byte ephemeral public key + 32 bytes of ciphertext + a 16-byte
	// Poly1305 tag.
	//
	// Validated exactly rather than as an upper bound. What is wrapped is fixed
	// by this protocol version (see the Phase 1A doc §2), so any other length is
	// a client that is sealing something else — and a change to what is sealed
	// has to be a new algorithm token, not a silently larger blob.
	SealedBoxBytes = 32 + 32 + 16

	// MaxWrappedKeyLen bounds the base64 text of ANY wrapped key. Kept
	// independently of SealedBoxBytes so a future algorithm has headroom without
	// the column ever becoming an unbounded blob.
	MaxWrappedKeyLen = 512

	// TerminalTaskRetention is how long a finished task row is kept after it
	// stops being interesting, so a sender's UI can still explain what happened
	// to yesterday's transfer without the table growing without bound.
	TerminalTaskRetention = 7 * 24 * time.Hour
)

var (
	ErrInvalidTaskState = errors.New("inbox: unknown task state")
	// ErrSenderLocalState is returned specifically for `encrypting`/`uploading`:
	// they are valid PRD states that central must never store (invariant 1).
	ErrSenderLocalState  = errors.New("inbox: sender-local state is not a server state")
	ErrInvalidTransition = errors.New("inbox: illegal task state transition")
	ErrInvalidErrorCode  = errors.New("inbox: unknown task error code")
	// ErrSavedNotAsserted guards the one transition that may not be inferred:
	// `saved` requires the device to say, explicitly, that it committed.
	ErrSavedNotAsserted = errors.New("inbox: saved requires an explicit commit assertion")
)

// TaskStates returns the closed server-state set (PRD order). Used by the
// schema-constraint test so the CHECK constraint and this package cannot drift.
func TaskStates() []string { return slices.Clone(taskStates) }

// IsTaskState reports whether s is a state central may store.
func IsTaskState(s string) bool { return slices.Contains(taskStates, s) }

// IsTerminalTaskState reports whether s can never transition again.
func IsTerminalTaskState(s string) bool { return slices.Contains(terminalTaskStates, s) }

// ValidateServerState rejects sender-local phases by name and anything unknown.
// The two errors are distinct so the API can tell a client "that state is real
// but it is yours to track" instead of "unknown state", which would be true but
// unhelpful.
func ValidateServerState(s string) error {
	switch s {
	case SenderStateEncrypting, SenderStateUploading:
		return ErrSenderLocalState
	}
	if !IsTaskState(s) {
		return ErrInvalidTaskState
	}
	return nil
}

// CanTransitionTask reports whether from -> to is legal.
//
// Fails closed (invariant 2): unknown states, terminal sources and unlisted
// pairs are all refused. from == to is refused too — a repeat of the current
// state is an idempotent no-op for the caller to recognise, not a transition,
// and letting it through here would make "saved -> saved" look like a fresh
// commit and overwrite an honest saved timestamp.
func CanTransitionTask(from, to string) bool {
	if !IsTaskState(from) || !IsTaskState(to) || from == to {
		return false
	}
	return slices.Contains(taskTransitions[from], to)
}

// ValidateTaskTransition is CanTransitionTask with a reason, for API callers.
func ValidateTaskTransition(from, to string) error {
	if err := ValidateServerState(from); err != nil {
		return err
	}
	if err := ValidateServerState(to); err != nil {
		return err
	}
	if !CanTransitionTask(from, to) {
		return ErrInvalidTransition
	}
	return nil
}

// IsDeviceReportableState reports whether a target device may assert this state.
func IsDeviceReportableState(s string) bool {
	return slices.Contains(deviceReportableStates, s)
}

// ValidateDeviceErrorCode accepts only the closed device-submittable set,
// so free text — and with it any file name or path — has no way in.
func ValidateDeviceErrorCode(code string) error {
	if !slices.Contains(deviceErrorCodes, code) {
		return ErrInvalidErrorCode
	}
	return nil
}

// TaskRetryBackoff returns the delay before attempt n+1 may be claimed, given
// that n attempts have been made. Exponential from TaskRetryBaseBackoff, capped
// at TaskRetryMaxBackoff; attempts <= 1 gets the base delay.
//
// The shift is guarded rather than trusted: attempts is persisted state, and a
// large value would otherwise shift a duration into negative territory and turn
// the backoff into "retry immediately, forever".
func TaskRetryBackoff(attempts int64) time.Duration {
	if attempts <= 1 {
		return TaskRetryBaseBackoff
	}
	shift := attempts - 1
	if shift > 32 {
		return TaskRetryMaxBackoff
	}
	d := TaskRetryBaseBackoff << uint(shift)
	if d > TaskRetryMaxBackoff || d <= 0 {
		return TaskRetryMaxBackoff
	}
	return d
}

// InitialTaskState decides the state a NEW task starts in from the target
// device's automatic-receive policy (PRD §8), and refuses to create one at all
// when the policy is `off`.
//
// The three answers, and why:
//
//   - `off`  => refused. The owner turned automatic receive off; queuing a task
//     the device will never take is a lie in the sender's UI.
//   - `ask`  => attention_required. The device holds it until a person on THAT
//     machine explicitly accepts. Nothing is written to disk on the sender's
//     say-so.
//   - `auto` => queued, but ONLY if the device both announced the versioned
//     inbox.autoaccept.v1 behaviour and last reported a usable receive
//     directory. An `auto` device with a broken directory starts in
//     attention_required, because the honest reason it will not land is a local
//     problem the user must fix — not a queue that silently never drains.
func InitialTaskState(policy string, caps []string, receiveDirReady bool) (string, error) {
	switch policy {
	case AutoAcceptOff:
		return "", ErrAutoReceiveDisabled
	case AutoAcceptAsk:
		return TaskAttentionRequired, nil
	case AutoAcceptAuto:
		if !slices.Contains(caps, CapAutoAcceptV1) {
			return "", ErrUnsupportedAutoAcceptCapability
		}
		if !receiveDirReady {
			return TaskAttentionRequired, nil
		}
		return TaskQueued, nil
	default:
		return "", ErrInvalidAutoAccept
	}
}

// ErrAutoReceiveDisabled is the refusal for a target whose policy is `off`.
var ErrAutoReceiveDisabled = errors.New("inbox: device automatic receive is disabled")
