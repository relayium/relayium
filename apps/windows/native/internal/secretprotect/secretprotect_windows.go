//go:build windows

// Direct user-scope DPAPI. This is the whole reason the helper exists.
//
// ## What it replaces and why
//
// Electron's `safeStorage` seals through a master key persisted in `Local
// State`. A forced kill can leave the sealed bytes on disk while that key is
// not yet persisted, and the secret is then unrecoverable while looking
// perfectly intact — a normal quit hides it completely. Calling
// CryptProtectData directly means there is no master key of ours to lose: the
// key is the user's, held by the OS.
//
// ## The flags, and the ones deliberately absent
//
//	CRYPTPROTECT_UI_FORBIDDEN  set. A prompt in a background process is a hang.
//	CRYPTPROTECT_LOCAL_MACHINE NOT set. A machine-scope blob is readable by
//	                           every account on the box, which is not what a
//	                           per-user secret means.
//	szDataDescr                nil. A description is not needed, and on
//	                           unprotect a non-nil name makes the API allocate a
//	                           string with its OWN LocalFree obligation. Passing
//	                           nil leaves exactly one allocation per call, which
//	                           is what makes the free discipline below checkable
//	                           rather than aspirational.
//	pOptionalEntropy           nil. Entropy would have to be stored, and
//	                           anywhere this process can store it is exactly as
//	                           exposed as the blob — so it adds a way to lose
//	                           the secret without addressing the threat
//	                           user-scope DPAPI covers.
//
// ## Integrity is NOT delegated to DPAPI
//
// CryptUnprotectData's documented remarks say a corrupted blob may fail with
// varying error codes, and that some corruption may succeed and return
// corrupted output. So a successful unprotect proves nothing on its own. Every
// blob carries a `secretframe` record — domain, version, exact length, SHA-256
// — inside the protected bytes, verified in constant time before any plaintext
// is returned.
package secretprotect

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/relayium/relayium/apps/windows/native/internal/secretframe"
)

// ErrRefused is the single failure this package reports.
//
// Uniform on purpose: a wrong user, a tampered blob, a blob from another
// producer and a plain DPAPI refusal are not distinguished. The API's codes
// vary, and describing which one occurred would tell a caller something about
// the protected bytes that it could not otherwise learn.
var ErrRefused = errors.New("secretprotect: refused")

// Protector is stateless. Nothing is cached between calls because nothing may
// outlive one operation.
type Protector struct{}

func New() Protector { return Protector{} }

// blobOf points a DATA_BLOB at b without copying. The caller must keep b alive
// for the duration of the call, which it does by construction here.
func blobOf(b []byte) windows.DataBlob {
	if len(b) == 0 {
		return windows.DataBlob{Size: 0, Data: nil}
	}
	return windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

// releaseBlob wipes an API-allocated blob and frees it, copying nothing.
//
// Used on every path that does not want the bytes — including the failure
// paths, where an earlier version still allocated a copy on its way to
// discarding it.
func releaseBlob(out *windows.DataBlob) {
	if out.Data == nil {
		return
	}
	if out.Size > 0 {
		secretframe.Zero(unsafe.Slice(out.Data, int(out.Size)))
	}
	// Best effort by necessity: LocalFree can only fail on a handle the API did
	// not give us, and nothing here could act on that. The wipe has already
	// happened, so a failure leaks an allocation, never plaintext.
	_, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	out.Data = nil
	out.Size = 0
}

// takeBounded copies an API-allocated blob out ONLY if it is within bound.
//
// ## Why the bound is checked before the copy
//
// The previous version allocated `out.Size` bytes and copied, then compared
// against the bound and threw the copy away. A DPAPI result larger than this
// process is willing to handle was therefore duplicated in full before being
// rejected — the allocation the bound exists to prevent. Now an oversized
// result is wiped and freed with no copy made at all.
//
// Returns ok=false for an over-bound result; the API buffer is released either
// way.
func takeBounded(out *windows.DataBlob, bound int) (copied []byte, ok bool) {
	if out.Data == nil {
		return nil, true
	}
	size := int(out.Size)
	if size < 0 || size > bound {
		releaseBlob(out)
		return nil, false
	}
	if size > 0 {
		src := unsafe.Slice(out.Data, size)
		copied = make([]byte, size)
		copy(copied, src)
	}
	releaseBlob(out)
	return copied, true
}

// Seal wraps the plaintext in an integrity record and protects it.
func (Protector) Seal(plaintext []byte) ([]byte, error) {
	if len(plaintext) > secretframe.MaxPlaintextBytes {
		return nil, ErrRefused
	}
	record, err := secretframe.SealRecord(plaintext)
	if err != nil {
		return nil, ErrRefused
	}
	// The record holds a full copy of the plaintext, so it is wiped whatever
	// happens next.
	defer secretframe.Zero(record)

	in := blobOf(record)
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		// No allocation on a failed call, but the release is unconditional so
		// every path has one exit shape.
		releaseBlob(&out)
		return nil, ErrRefused
	}
	// Bounded BEFORE the copy: a blob this side would not accept back is not one
	// to hand the host, and it is not one to duplicate on the way to saying so.
	blob, ok := takeBounded(&out, secretframe.MaxBlobBytes)
	if !ok {
		return nil, ErrRefused
	}
	return blob, nil
}

// Open unprotects and verifies before returning anything.
func (Protector) Open(blob []byte) ([]byte, error) {
	if len(blob) == 0 || len(blob) > secretframe.MaxBlobBytes {
		return nil, ErrRefused
	}
	in := blobOf(blob)
	var out windows.DataBlob
	// `name` is nil, so the API allocates no description and there is exactly
	// one buffer to release.
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		releaseBlob(&out)
		return nil, ErrRefused
	}
	// The largest legal record is a full-size plaintext plus its framing.
	// Anything larger is refused without being copied.
	record, ok := takeBounded(&out, secretframe.MaxRecordBytes)
	if !ok {
		return nil, ErrRefused
	}
	// Wiped whatever the verdict: on success the payload is copied out first,
	// on failure nothing of it may survive.
	defer secretframe.Zero(record)

	payload, err := secretframe.OpenRecord(record)
	if err != nil {
		// A successful unprotect that fails HERE is the case DPAPI's own
		// documentation warns about: corruption that decrypts. Refused with no
		// output at all rather than returned as plausible plaintext.
		return nil, ErrRefused
	}
	// Copied out of the record before the deferred wipe reaches it.
	result := make([]byte, len(payload))
	copy(result, payload)
	return result, nil
}
