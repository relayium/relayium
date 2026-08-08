package inboxclient

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storecrypto"
)

// Mapping local reality onto the closed set of things a device may tell central.
//
// Two decisions are made here and nowhere else, and both are product decisions
// rather than plumbing:
//
//   - WHICH CODE. inbox.TaskErr* is a closed vocabulary precisely so a file name
//     or a path can never reach central through an error message (protocol §16).
//     Every local error is therefore classified into a category, and the local
//     detail stays in the local log.
//   - WHICH STATE. `failed_retryable` says "try me again"; `attention_required`
//     says "a person at this machine must do something"; `failed_terminal` says
//     "this will never work". Getting that wrong is worse than a wrong code: a
//     terminal misclassification silently drops a delivery, and a retryable one
//     burns eight attempts against a full disk nobody was told about.
//
// The rule used throughout: if a RETRY OF THE SAME BYTES could plausibly succeed
// without anyone doing anything, it is retryable. If it needs a human at this
// machine (space, permissions, a directory, a name), it is attention_required.
// If the bytes themselves are the problem, it is terminal.

// Failure is a classified local failure. Code and State are what central is
// told; Err is local detail that never leaves the machine.
type Failure struct {
	Code  string
	State string
	Err   error
}

func (f *Failure) Error() string {
	if f.Err == nil {
		return fmt.Sprintf("relayium inbox: %s (%s)", f.Code, f.State)
	}
	return fmt.Sprintf("relayium inbox: %s (%s): %v", f.Code, f.State, f.Err)
}

func (f *Failure) Unwrap() error { return f.Err }

// AsFailure extracts a classified failure from err, or nil.
func AsFailure(err error) *Failure {
	var f *Failure
	if errors.As(err, &f) {
		return f
	}
	return nil
}

func retryable(code string, err error) *Failure {
	return &Failure{Code: code, State: inbox.TaskFailedRetryable, Err: err}
}

func terminal(code string, err error) *Failure {
	return &Failure{Code: code, State: inbox.TaskFailedTerminal, Err: err}
}

func attention(code string, err error) *Failure {
	return &Failure{Code: code, State: inbox.TaskAttentionRequired, Err: err}
}

// classifyFS turns a filesystem error into the honest category.
//
// The three attention_required outcomes are the PRD §10 item 8 list verbatim —
// directory permissions, disk space, or a name a human has to resolve — because
// each of them is a condition the device genuinely cannot clear on its own, and
// retrying would just consume the attempt budget while the sender's UI showed
// nothing actionable.
func classifyFS(err error) *Failure {
	switch {
	case err == nil:
		return nil
	case isNoSpace(err):
		return attention(inbox.TaskErrDiskFull, err)
	case isPermission(err):
		return attention(inbox.TaskErrPermissionDenied, err)
	case errors.Is(err, ErrDestinationOccupied), errors.Is(err, ErrNameConflict):
		return attention(inbox.TaskErrNameConflict, err)
	case errors.Is(err, ErrDirectoryUnavailable), errors.Is(err, fs.ErrNotExist):
		return attention(inbox.TaskErrDirectoryUnavailabl, err)
	case errors.Is(err, ErrUnsafeName):
		// The manifest itself is the problem, and the same manifest will be the
		// same problem on every retry.
		return terminal(inbox.TaskErrVerifyFailed, err)
	default:
		return retryable(inbox.TaskErrInternal, err)
	}
}

// classifyCrypto categorises a decryption or verification failure.
//
// AEAD rejection is TERMINAL: the ciphertext on central does not change between
// attempts, so a frame that failed authentication once fails identically eight
// more times. A length/framing mismatch is RETRYABLE: that is what a truncated
// TRANSFER looks like, and the next attempt gets a fresh stream.
func classifyCrypto(err error) *Failure {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrUnseal):
		return terminal(inbox.TaskErrDecryptFailed, err)
	case errors.Is(err, ErrTruncatedStream):
		return retryable(inbox.TaskErrVerifyFailed, err)
	case errors.Is(err, ErrManifestInvalid):
		return terminal(inbox.TaskErrVerifyFailed, err)
	case errors.Is(err, ErrDecryptFailed):
		return terminal(inbox.TaskErrDecryptFailed, err)
	default:
		return retryable(inbox.TaskErrInternal, err)
	}
}

// classifyTransport categorises a failure to obtain the ciphertext. Everything
// here is retryable by definition; a permanently missing object is central's
// judgement to make (`stored_object_unavailable`), not the device's.
func classifyTransport(err error) *Failure {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return retryable(inbox.TaskErrDownloadFailed, err)
	}
	return retryable(inbox.TaskErrDownloadFailed, err)
}

// Sentinel errors this package classifies on.
var (
	// ErrDestinationOccupied is a planned destination that something else took
	// after the plan was journalled. Never overwritten, never re-planned in
	// place: a human decides.
	ErrDestinationOccupied = errors.New("relayium inbox: a file appeared at a planned destination")
	// ErrDirectoryUnavailable is a receive directory that is missing, is not a
	// directory, or contains a symlinked/non-directory component where a
	// directory must be created.
	ErrDirectoryUnavailable = errors.New("relayium inbox: the receive directory is unavailable")
	// ErrTruncatedStream is a ciphertext stream that ended early or carried
	// trailing bytes — a transport symptom, not an authentication failure.
	ErrTruncatedStream = errors.New("relayium inbox: ciphertext stream was truncated or over-long")
	// ErrDecryptFailed is an authentication failure on the manifest or a frame.
	ErrDecryptFailed = errors.New("relayium inbox: authenticated decryption failed")
	// ErrManifestInvalid is a manifest that decrypted but describes something
	// this device refuses to act on.
	ErrManifestInvalid = errors.New("relayium inbox: manifest failed validation")
	// ErrInsufficientSpace is the preflight refusal, raised before a byte is
	// downloaded so a doomed transfer does not fill the disk on its way to
	// failing.
	ErrInsufficientSpace = errors.New("relayium inbox: not enough free space for this delivery")
	// ErrAbandon means: stop working this task and report NOTHING.
	//
	// It is raised when central has already taken the task away — the lease was
	// reclaimed and handed to another worker (`stale_claim`), or the task reached
	// a terminal state. A report in either case would be rejected at best, and at
	// worst would be a stale worker asserting something about work it no longer
	// holds. Silence is the correct and only safe response.
	ErrAbandon = errors.New("relayium inbox: this worker no longer holds the task")
)

// checkManifest re-validates a decrypted manifest against both storecrypto's
// structural bounds and this task's own ciphertext size.
//
// The size cross-check is the one that matters: a manifest is sender-controlled,
// and AEAD only proves who wrote it. Declared plaintext can never exceed the
// ciphertext byte count central measured itself (every frame adds a length
// prefix and a Poly1305 tag), so a manifest claiming terabytes behind a 4 KiB
// object is a lie central can be used to catch — before any space is reserved
// for it.
func checkManifest(m storecrypto.Manifest, ciphertextBytes int64) (int64, error) {
	if err := storecrypto.ValidateManifest(m); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrManifestInvalid, err)
	}
	var total int64
	for _, f := range m.Files {
		total += f.Size
	}
	if ciphertextBytes > 0 && total > ciphertextBytes {
		return 0, fmt.Errorf("%w: declares %d plaintext bytes behind %d ciphertext bytes",
			ErrManifestInvalid, total, ciphertextBytes)
	}
	return total, nil
}

// checkFreeSpace refuses a delivery that cannot fit, before anything is
// downloaded.
//
// Slack is added because "exactly enough" is not enough: the staging copy, the
// journal and the filesystem's own metadata all need room, and a receive
// directory driven to zero free bytes takes the rest of the machine with it.
// Where the platform cannot report free space the check is SKIPPED rather than
// guessed — the commit path still fails closed on a real ENOSPC.
func checkFreeSpace(root string, need int64) error {
	const slack = 16 << 20
	free, ok := freeBytes(root)
	if !ok {
		return nil
	}
	if uint64(need)+slack > free {
		return fmt.Errorf("%w: need %d bytes plus headroom, %d free", ErrInsufficientSpace, need, free)
	}
	return nil
}

// probeName is the fixed name of the writability probe. Fixed rather than
// random so a crashed probe leaves at most one recognisable file, and it lives
// beside the staging area rather than among the user's received files.
const probeName = ".relayium-inbox-probe"

// CheckReceiveDir reports whether root can receive right now: it exists, it is a
// real directory (not a symlink to one, not a device node), and this process can
// actually create and remove a file in it.
//
// The probe is deliberately a real create+remove rather than a permission-bit
// inspection. Mode bits lie: a read-only remount, a full disk, an ACL, an
// immutable flag, a container's user namespace and a revoked macOS TCC grant all
// leave the bits looking fine. `receiveDirReady` is reported to central on every
// heartbeat and decides whether a sender is told their file will land, so it has
// to be the truth, not an inference.
func CheckReceiveDir(root string) error {
	fi, err := os.Lstat(root)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrDirectoryUnavailable, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: the receive directory is a symlink; re-run `relayium inbox enable --dir` with its resolved path", ErrDirectoryUnavailable)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%w: not a directory", ErrDirectoryUnavailable)
	}
	probe := root + string(os.PathSeparator) + probeName
	f, err := os.OpenFile(probe, os.O_RDWR|os.O_CREATE|os.O_EXCL|oNoFollow, secretFileMode)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			// A previous probe died before cleanup. Remove it and try once more
			// rather than declaring the directory unusable forever.
			_ = os.Remove(probe)
			f, err = os.OpenFile(probe, os.O_RDWR|os.O_CREATE|os.O_EXCL|oNoFollow, secretFileMode)
		}
		if err != nil {
			return fmt.Errorf("%w: %v", ErrDirectoryUnavailable, err)
		}
	}
	closeErr := f.Close()
	rmErr := os.Remove(probe)
	if closeErr != nil {
		return fmt.Errorf("%w: %v", ErrDirectoryUnavailable, closeErr)
	}
	if rmErr != nil {
		return fmt.Errorf("%w: %v", ErrDirectoryUnavailable, rmErr)
	}
	return nil
}
