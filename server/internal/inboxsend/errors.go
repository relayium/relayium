// Package inboxsend is the CLI-side Device Inbox SENDER: it plans a files/folders
// delivery, encrypts it once under a fresh content key, uploads the ciphertext
// through the ordinary resumable upload path (purpose=device_task), seals the
// content key to the target device's published X25519 key, and queues the task.
//
// It speaks the existing v3 protocol unchanged (docs/protocol/
// relayium-device-inbox-v3.md). Central derives the source device from the
// bearer; nothing here names it.
//
// PRE-IMPLEMENTATION INVARIANTS. Each is asserted by a test in this package or
// in cmd/relayium.
//
//	N1 NONCE UNIQUENESS. For every content key, each seq (0 = manifest, 1.. =
//	   frames) is sealed at most once. storecrypto's nonce is deterministic in
//	   seq, so sealing changed bytes at a used seq would leak their XOR.
//	N2 KEY CONFINEMENT. The content key exists only in the memory of the process
//	   that generated it, and outside it only as the sealed box addressed to the
//	   target device. It is never written to the journal, stdout, stderr or an
//	   error, and the types that hold it do not print it.
//	N3 NO RESTART ENCRYPTION. Nothing reachable after a restart (retry, sent,
//	   journal cleanup) can seal anything: only a fresh send generates a key.
//	N4 CIPHERTEXT IDENTITY ON REPLAY. A byte re-sent for an existing upload
//	   session is a copy of ciphertext produced by the single sealing pass (the
//	   in-memory unacknowledged buffer). Nothing is re-read and re-sealed.
//	N5 NO AUTOMATIC RE-UPLOAD. An ambiguous finalize or create never starts a
//	   second upload. The outcome is reported as unknown and the local journal is
//	   kept; only an explicit new `inbox send` uploads again. Once an attempt
//	   may have taken effect, a later definitive refusal answers only its own
//	   request: it stays unknown and the journal is kept.
//	N6 WRAPPED KEY BEFORE CREATE. The sealed content key is journalled before the
//	   first create, and a lost create response is answered by replaying the same
//	   request bytes, never by re-sealing under the same idempotency key.
//	N7 QUEUED IS NOT SAVED. Only central's State == "saved", which only the
//	   target device can earn, is ever reported as saved.
//	N8 DURABLE PHASE BEFORE EACH IRREVERSIBLE STEP. The journal phase a later
//	   `inbox retry` relies on is on disk BEFORE the request it describes is
//	   sent: the upload id before any byte is appended, phase finalizing before
//	   finalize, the stored object id before the create. A failed checkpoint
//	   stops the send there. So a record in phase planned proves no finalize was
//	   ever sent, and retry, reading an older phase, can never report "nothing
//	   happened" after something did.
package inboxsend

import (
	"errors"
	"fmt"
)

// Class is how a failure ends the command. The CLI maps it onto an exit code,
// so a script can tell "nothing happened, fix your input" from "it failed" from
// "we cannot tell whether it happened".
type Class int

const (
	// ClassFailed is a definitive failure: the server refused, or the send could
	// not be completed, and the report says what (if anything) was left behind.
	ClassFailed Class = iota
	// ClassLocal is a refusal before any network WRITE: bad arguments, content
	// no receiver would accept, an unknown or ambiguous --to.
	ClassLocal
	// ClassUnknown means the outcome could not be established. The local journal
	// is kept so `inbox retry` can ask again; nothing is uploaded again.
	ClassUnknown
	// ClassInterrupted is a cancelled command (SIGINT/SIGTERM).
	ClassInterrupted
)

// Error is every failure this package reports. Code is a closed, machine-
// readable token (see the Code* constants) and Msg is fixed, terminal-safe
// prose written here — never server text, never a key, never an upload or
// object id.
type Error struct {
	Class Class
	Code  string
	Msg   string
	// LocalSendID names the journal kept for `inbox retry`, when one is.
	LocalSendID string
	err         error
}

func (e *Error) Error() string { return e.Msg }
func (e *Error) Unwrap() error { return e.err }

// Codes. The central-refusal tokens are the ones Web's SEND_ERROR_CODES names;
// an unrecognised server token becomes CodeUnknown and is never echoed.
const (
	CodeUnknown                 = "unknown"
	CodeUnknownOutcome          = "unknown_outcome"
	CodeAmbiguousTarget         = "ambiguous_target"
	CodeNoSuchTarget            = "no_such_target"
	CodeTargetUnavailable       = "target_unavailable"
	CodeUnsupportedKey          = "unsupported_key"
	CodeNoFiles                 = "no_files"
	CodeUnsendableContent       = "unsendable_content"
	CodeSourceChanged           = "source_changed"
	CodeSignedOut               = "signed_out"
	CodeNetwork                 = "network"
	CodeCancelled               = "cancelled"
	CodeUploadTooLarge          = "upload_too_large"
	CodeQuotaExceeded           = "quota_exceeded"
	CodeRedirectRefused         = "redirect_refused"
	CodeUploadLost              = "upload_lost"
	CodeProtocol                = "protocol_error"
	CodeNotResumable            = "not_resumable"
	CodeStaleAfterRestart       = "stale_after_restart"
	CodeJournalMismatch         = "journal_mismatch"
	CodeJournalInvalid          = "journal_invalid"
	CodeJournalBusy             = "journal_busy"
	CodeJournalWrite            = "journal_write_failed"
	CodeNoSuchSend              = "no_such_send"
	CodeLocalState              = "local_state"
	CodeStaleTargetKey          = "stale_target_key"
	CodeIdempotencyKeyConflict  = "idempotency_key_conflict"
	CodeNoSuchTask              = "no_such_task"
	CodeTaskInProgress          = "task_in_progress"
	CodeTaskNotCancellable      = "task_not_cancellable"
	CodeServerError             = "server_error"
	CodeSenderDeviceRequired    = "sender_device_required"
	CodeAutoReceiveDisabled     = "auto_receive_disabled"
	CodeDeviceCannotReceive     = "device_cannot_receive"
	CodeDeviceInboxRevoked      = "device_inbox_revoked"
	CodeStoredObjectUnavailable = "stored_object_unavailable"
	CodeStoredObjectBound       = "stored_object_already_bound"
	CodeInboxQueueFull          = "inbox_queue_full"
	// CodeFinalizeRefused: the server confirmed, when asked again, that it did
	// not complete the upload (a finalize-recovery "failed" answer).
	CodeFinalizeRefused = "finalize_refused"
)

// CodeUsage is a command line the CLI could not accept. This package never
// returns it; it names that outcome in the CLI's --json document.
const CodeUsage = "usage"

// serverTokens is the closed set of central `error` tokens this client will
// repeat. Anything else collapses to CodeUnknown.
var serverTokens = map[string]bool{
	CodeAutoReceiveDisabled: true, CodeDeviceCannotReceive: true,
	CodeDeviceInboxRevoked: true, CodeStaleTargetKey: true,
	CodeIdempotencyKeyConflict: true, CodeStoredObjectUnavailable: true,
	CodeStoredObjectBound: true, CodeInboxQueueFull: true,
	"unsupported_key_algorithm": true, "unsupported_auto_accept_capability": true,
	"malformed_wrapped_key": true, "invalid_idempotency_key": true,
	CodeSenderDeviceRequired: true, "unsupported_protocol_version": true,
	"invalid_transition": true, "task_terminal": true,
}

func newErr(class Class, code, msg string, cause error) *Error {
	return &Error{Class: class, Code: code, Msg: msg, err: cause}
}

func failed(code, msg string) *Error { return newErr(ClassFailed, code, msg, nil) }

func local(code, msg string) *Error { return newErr(ClassLocal, code, msg, nil) }

func localf(code, format string, a ...any) *Error {
	return newErr(ClassLocal, code, fmt.Sprintf(format, a...), nil)
}

// AsError returns err as an *Error, if it is one.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// Copy shared by several paths. Each sentence is the honest one for its case
// (design §6): no "within an hour" promise, nothing about bytes never sent,
// and the two things central counts kept apart — transfer is metered per
// append as the bytes arrive, while the daily upload quota is reserved only by
// a finalize that succeeds (a refused one reserves nothing, or refunds what it
// reserved).
const (
	msgMetered = "Bytes already uploaded count as transfer, as for any upload; only an upload " +
		"the server completes uses the daily upload quota."
	// msgOrphanPartial is an upload session left open: nothing but cleanup
	// ends it.
	msgOrphanPartial = "The partial upload stays on the server until cleanup removes it. It becomes " +
		"eligible after about an hour; cleanup runs periodically and can be delayed. " + msgMetered
	// msgFinalizeRefused is the only finalize ever sent, refused. Central
	// discards the ciphertext itself when its finalize gates refuse, but a
	// refusal before the handler (a login it no longer accepts) leaves the
	// session open, and this client cannot tell which one answered.
	msgFinalizeRefused = "Depending on where the server refused it, the uploaded ciphertext was already " +
		"discarded or stays on the server until cleanup removes it (eligible after about an hour; cleanup " +
		"runs periodically and can be delayed). " + msgMetered
	msgCountedComplete = "The completed upload was counted like any completed upload."
	// msgOrphanObject is a completed upload that no delivery holds.
	msgOrphanObject = "The uploaded ciphertext is not attached to any delivery and stays on the server " +
		"until cleanup removes it. It becomes eligible after about an hour; cleanup runs periodically " +
		"and can be delayed. " + msgCountedComplete
	msgUnknownOutcome = "The server may have received the complete upload, but this could not be " +
		"confirmed. Nothing will be uploaded again automatically. Run `relayium inbox retry %s` later; " +
		"a new `relayium inbox send` is a new upload and is counted again."
	msgUnknownDelivery = "The upload was completed and the delivery may have been queued, but this could not " +
		"be confirmed. Nothing will be uploaded again automatically. Check `relayium inbox sent`, or run " +
		"`relayium inbox retry %s` later; a new `relayium inbox send` is a new upload and is counted again."
	msgSendAgain         = "Run `relayium inbox send` again; that is a new upload and is counted again."
	msgStaleAfterRestart = "The device's receiving key changed and this send can no longer be completed. " +
		"Run `relayium inbox send` again (a new upload, counted again)."
)
