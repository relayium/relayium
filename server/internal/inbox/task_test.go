package inbox

import (
	"errors"
	"slices"
	"testing"
	"time"
)

// Device Inbox Phase 1B state-machine acceptance.
//
// The invariants under test, stated before the implementation:
//
//  1. `encrypting` and `uploading` are SENDER-LOCAL. Central must refuse them by
//     name, because storing either would be central asserting something about a
//     machine it cannot observe.
//  2. The transition table fails CLOSED: unknown states, terminal sources and
//     unlisted pairs are all refused, with no default-allow anywhere.
//  3. `saved` is reachable ONLY from `verifying`. "The ciphertext arrived" is
//     never "the file is on disk".
//  4. Device-submittable error codes are a CLOSED set, so no free-text field
//     exists through which a file name or path could reach central.
//  5. Retry backoff is bounded above and never degenerates to zero.
//  6. `off` refuses; `ask` holds; `auto` queues only with the announced
//     capability AND a usable receive directory.

func TestSenderLocalStatesAreNotServerStates(t *testing.T) {
	for _, s := range []string{SenderStateEncrypting, SenderStateUploading} {
		if IsTaskState(s) {
			t.Fatalf("%q must not be a storable server state: central cannot observe it", s)
		}
		if err := ValidateServerState(s); !errors.Is(err, ErrSenderLocalState) {
			t.Fatalf("ValidateServerState(%q) = %v, want ErrSenderLocalState", s, err)
		}
		// Named refusal, not "unknown": the state is real, it is simply not ours.
		if errors.Is(ValidateServerState(s), ErrInvalidTaskState) {
			t.Fatalf("%q should be refused as sender-local, not as unknown", s)
		}
	}
}

func TestTaskStateSetIsTheClosedPRDSet(t *testing.T) {
	want := []string{
		"queued", "notified", "downloading", "verifying", "saved",
		"attention_required", "expired", "revoked", "failed_retryable", "failed_terminal",
	}
	got := TaskStates()
	if !slices.Equal(got, want) {
		t.Fatalf("server state set drifted from PRD §10:\n got %v\nwant %v", got, want)
	}
	for _, s := range []string{"", "sent", "done", "uploaded", "QUEUED", "saved "} {
		if IsTaskState(s) {
			t.Fatalf("%q must not be a task state", s)
		}
		if err := ValidateServerState(s); !errors.Is(err, ErrInvalidTaskState) {
			t.Fatalf("ValidateServerState(%q) = %v, want ErrInvalidTaskState", s, err)
		}
	}
}

func TestTerminalStatesNeverTransition(t *testing.T) {
	terminals := []string{TaskSaved, TaskExpired, TaskRevoked, TaskFailedTerminal}
	for _, from := range terminals {
		if !IsTerminalTaskState(from) {
			t.Fatalf("%q should be terminal", from)
		}
		for _, to := range TaskStates() {
			if CanTransitionTask(from, to) {
				t.Fatalf("terminal %q must not transition to %q", from, to)
			}
		}
	}
	for _, s := range []string{TaskQueued, TaskNotified, TaskDownloading, TaskVerifying,
		TaskAttentionRequired, TaskFailedRetryable} {
		if IsTerminalTaskState(s) {
			t.Fatalf("%q must not be terminal: it still has work to do", s)
		}
	}
}

// TestSavedOnlyFromVerifying is the state-machine half of the product's central
// promise: a file is "saved" only after the target device decrypted, verified
// and committed it. Every other source state must be refused.
func TestSavedOnlyFromVerifying(t *testing.T) {
	for _, from := range TaskStates() {
		got := CanTransitionTask(from, TaskSaved)
		want := from == TaskVerifying
		if got != want {
			t.Fatalf("CanTransitionTask(%q, saved) = %v, want %v", from, got, want)
		}
	}
}

// TestEveryTransitionPairIsDecidedExplicitly walks the full N×N matrix and
// checks each cell against the table this test states independently. A new
// permitted pair therefore cannot appear without being written down here too.
func TestEveryTransitionPairIsDecidedExplicitly(t *testing.T) {
	legal := map[string][]string{
		TaskQueued:            {TaskNotified, TaskDownloading, TaskAttentionRequired, TaskExpired, TaskRevoked, TaskFailedTerminal},
		TaskNotified:          {TaskQueued, TaskDownloading, TaskAttentionRequired, TaskExpired, TaskRevoked, TaskFailedTerminal},
		TaskDownloading:       {TaskVerifying, TaskQueued, TaskAttentionRequired, TaskFailedRetryable, TaskFailedTerminal, TaskExpired, TaskRevoked},
		TaskVerifying:         {TaskSaved, TaskQueued, TaskAttentionRequired, TaskFailedRetryable, TaskFailedTerminal, TaskExpired, TaskRevoked},
		TaskAttentionRequired: {TaskQueued, TaskFailedTerminal, TaskExpired, TaskRevoked},
		TaskFailedRetryable:   {TaskQueued, TaskFailedTerminal, TaskExpired, TaskRevoked},
	}
	for _, from := range TaskStates() {
		for _, to := range TaskStates() {
			want := slices.Contains(legal[from], to)
			if got := CanTransitionTask(from, to); got != want {
				t.Fatalf("CanTransitionTask(%q, %q) = %v, want %v", from, to, got, want)
			}
			err := ValidateTaskTransition(from, to)
			if want && err != nil {
				t.Fatalf("ValidateTaskTransition(%q, %q) = %v, want nil", from, to, err)
			}
			if !want && !errors.Is(err, ErrInvalidTransition) {
				t.Fatalf("ValidateTaskTransition(%q, %q) = %v, want ErrInvalidTransition", from, to, err)
			}
		}
	}
}

// TestSelfTransitionIsNotATransition keeps "report the state you are already in"
// out of the transition table. It is an idempotent no-op for the caller to
// recognise; treating it as a transition would let a repeated `saved` report
// overwrite the honest timestamp of the original commit.
func TestSelfTransitionIsNotATransition(t *testing.T) {
	for _, s := range TaskStates() {
		if CanTransitionTask(s, s) {
			t.Fatalf("%q -> %q must not be a transition", s, s)
		}
	}
}

func TestUnknownStatesFailClosed(t *testing.T) {
	for _, pair := range [][3]string{
		{"queued", "nonsense"}, {"nonsense", "queued"}, {"", "queued"}, {"queued", ""},
		{SenderStateUploading, TaskQueued}, {TaskQueued, SenderStateUploading},
	} {
		if CanTransitionTask(pair[0], pair[1]) {
			t.Fatalf("CanTransitionTask(%q, %q) must be false", pair[0], pair[1])
		}
	}
}

// TestDeviceReportableStatesExcludeCentralsOwnDecisions: a device may say what
// it is doing, not what central decided. `expired` and `revoked` are central's
// judgements about time and authorization; `queued`/`notified` are central's
// scheduling, and a device that could report `queued` could reset its own
// backoff and re-claim immediately.
func TestDeviceReportableStatesExcludeCentralsOwnDecisions(t *testing.T) {
	for _, s := range []string{TaskExpired, TaskRevoked, TaskQueued, TaskNotified} {
		if IsDeviceReportableState(s) {
			t.Fatalf("a device must not be able to report %q", s)
		}
	}
	for _, s := range []string{TaskDownloading, TaskVerifying, TaskSaved,
		TaskAttentionRequired, TaskFailedRetryable, TaskFailedTerminal} {
		if !IsDeviceReportableState(s) {
			t.Fatalf("a device must be able to report %q", s)
		}
	}
}

// TestDeviceErrorCodesAreClosed is the zero-knowledge guard on the error path:
// with no free-text field, a file name or path has no way to reach central even
// when a device is reporting exactly why saving failed.
func TestDeviceErrorCodesAreClosed(t *testing.T) {
	for _, c := range []string{
		TaskErrNone, TaskErrDownloadFailed, TaskErrDecryptFailed, TaskErrVerifyFailed,
		TaskErrDiskFull, TaskErrPermissionDenied, TaskErrDirectoryUnavailabl,
		TaskErrNameConflict, TaskErrUserDeclined, TaskErrUnsupported, TaskErrInternal,
	} {
		if err := ValidateDeviceErrorCode(c); err != nil {
			t.Fatalf("ValidateDeviceErrorCode(%q) = %v, want nil", c, err)
		}
	}
	for _, c := range []string{
		"could not write /Users/lily/Documents/taxes.pdf",
		"disk_full ", "DISK_FULL", "arbitrary", "../../etc/passwd",
		// Central's own codes are not device-submittable: a device must not be
		// able to forge central's account of what happened.
		TaskErrLeaseExpired, TaskErrAttemptsExhausted, TaskErrKeyRevoked,
		TaskErrStoredObjectUnavailable,
	} {
		if err := ValidateDeviceErrorCode(c); !errors.Is(err, ErrInvalidErrorCode) {
			t.Fatalf("ValidateDeviceErrorCode(%q) = %v, want ErrInvalidErrorCode", c, err)
		}
	}
}

func TestRetryBackoffIsBounded(t *testing.T) {
	if got := TaskRetryBackoff(0); got != TaskRetryBaseBackoff {
		t.Fatalf("backoff(0) = %v, want %v", got, TaskRetryBaseBackoff)
	}
	prev := time.Duration(0)
	for n := int64(1); n <= 64; n++ {
		got := TaskRetryBackoff(n)
		if got <= 0 {
			t.Fatalf("backoff(%d) = %v: a non-positive backoff is an instant-retry loop", n, got)
		}
		if got > TaskRetryMaxBackoff {
			t.Fatalf("backoff(%d) = %v exceeds the cap %v", n, got, TaskRetryMaxBackoff)
		}
		if got < prev {
			t.Fatalf("backoff(%d) = %v went backwards from %v", n, got, prev)
		}
		prev = got
	}
	// A persisted attempt count large enough to overflow a naive shift must
	// saturate at the cap rather than wrap to zero or negative.
	if got := TaskRetryBackoff(1 << 40); got != TaskRetryMaxBackoff {
		t.Fatalf("backoff(huge) = %v, want the cap %v", got, TaskRetryMaxBackoff)
	}
}

func TestInitialTaskStateFollowsThePolicy(t *testing.T) {
	withAuto := []string{CapReceiveV3, CapAutoAcceptV1}
	noAuto := []string{CapReceiveV3}

	// off: refused outright. Queuing a task a device will never take would be a
	// lie in the sender's UI.
	if _, err := InitialTaskState(AutoAcceptOff, withAuto, true); !errors.Is(err, ErrAutoReceiveDisabled) {
		t.Fatalf("off policy = %v, want ErrAutoReceiveDisabled", err)
	}
	// ask: held for a person at the device, whatever the directory says.
	for _, ready := range []bool{true, false} {
		got, err := InitialTaskState(AutoAcceptAsk, noAuto, ready)
		if err != nil || got != TaskAttentionRequired {
			t.Fatalf("ask policy (dirReady=%v) = %q, %v; want attention_required", ready, got, err)
		}
	}
	// auto without the announced capability: refused, not silently downgraded.
	if _, err := InitialTaskState(AutoAcceptAuto, noAuto, true); !errors.Is(err, ErrUnsupportedAutoAcceptCapability) {
		t.Fatalf("auto without inbox.autoaccept.v1 = %v, want ErrUnsupportedAutoAcceptCapability", err)
	}
	// auto with an unusable receive directory: held, because the honest reason
	// it will not land is a local problem the user must fix.
	if got, err := InitialTaskState(AutoAcceptAuto, withAuto, false); err != nil || got != TaskAttentionRequired {
		t.Fatalf("auto with no usable dir = %q, %v; want attention_required", got, err)
	}
	// auto, capability announced, directory usable: the only path to queued.
	if got, err := InitialTaskState(AutoAcceptAuto, withAuto, true); err != nil || got != TaskQueued {
		t.Fatalf("auto ready = %q, %v; want queued", got, err)
	}
	if _, err := InitialTaskState("sometimes", withAuto, true); !errors.Is(err, ErrInvalidAutoAccept) {
		t.Fatalf("unknown policy = %v, want ErrInvalidAutoAccept", err)
	}
	// A starting state is never a state that has to be earned.
	for _, policy := range []string{AutoAcceptAsk, AutoAcceptAuto} {
		got, _ := InitialTaskState(policy, withAuto, true)
		if got == TaskSaved || got == TaskDownloading || got == TaskVerifying {
			t.Fatalf("policy %q started a task in %q", policy, got)
		}
	}
}

// TestNoPrivateKeyOrContentKeySurfaceInThisPackage restates Phase 1A's zero
// knowledge invariant for the queue: nothing here handles a secret. The bound
// on the wrapped key exists so the column cannot become an unbounded blob, and
// it must still be big enough for a real sealed box.
func TestWrappedKeyBoundFitsASealedBox(t *testing.T) {
	// crypto_box_seal of a 32-byte content key: 32-byte ephemeral public key +
	// 32 bytes + 16-byte MAC = 80 raw, 107 unpadded base64url.
	const realSealedBoxBase64 = 108
	if MaxWrappedKeyLen < realSealedBoxBase64 {
		t.Fatalf("MaxWrappedKeyLen=%d is too small for a real sealed box", MaxWrappedKeyLen)
	}
	if MaxWrappedKeyLen > 4096 {
		t.Fatalf("MaxWrappedKeyLen=%d is an unbounded blob, not a key", MaxWrappedKeyLen)
	}
}

func TestValidateTaskProtocolVersionFailsClosed(t *testing.T) {
	// The version a SENDER declares at create. Fail closed on every value that
	// is not exactly what central defines — most importantly on 0, which is the
	// zero value of an omitted JSON field. A create that forgot `protocolVersion`
	// must be refused, never treated as the current version by default.
	for _, tc := range []struct {
		name string
		in   int
		want error
	}{
		{"omitted", 0, ErrUnsupportedProtocol},
		{"negative", -1, ErrUnsupportedProtocol},
		{"historical v1", ProtocolV1, ErrUnsupportedProtocol},
		{"future", ProtocolV3 + 1, ErrUnsupportedProtocol},
		{"far future", 1 << 30, ErrUnsupportedProtocol},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateTaskProtocolVersion(tc.in); !errors.Is(err, tc.want) {
				t.Fatalf("ValidateTaskProtocolVersion(%d) = %v, want %v", tc.in, err, tc.want)
			}
		})
	}
	if err := ValidateTaskProtocolVersion(ProtocolV3); err != nil {
		t.Fatalf("the current version must be accepted: %v", err)
	}
}
