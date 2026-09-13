// Framing for the secret helper: one request per process, and the integrity
// record that travels INSIDE the DPAPI blob.
//
// ## Two separate layers, deliberately in one place
//
//  1. The WIRE frame between the host and this process. Bounded, versioned,
//     and rejected rather than repaired.
//  2. The INNER RECORD that is protected by DPAPI. This is not wire crypto and
//     adds no key or entropy of its own — it is storage integrity framing.
//
// Both are pure byte handling, so both are testable on any host. That matters
// most for the inner record: its truncation, length and digest negatives are
// exactly the cases a Windows-only test would leave unproven.
//
// ## Why the inner record exists
//
// Microsoft's own CryptUnprotectData remarks warn that a corrupted blob may
// FAIL WITH VARYING ERROR CODES, and that some corruption can succeed and
// return corrupted output:
// https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata
//
// So a successful unprotect is not, on its own, evidence that the bytes are the
// bytes that were sealed. The record pins the domain, the version, the exact
// plaintext length and a SHA-256 of the payload, all inside the protected blob,
// and all of it is checked before a single plaintext byte is returned. A blob
// that is not our record — including a raw DPAPI blob written by something
// else — is refused rather than interpreted.
package secretframe

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Wire constants. Chosen by root; this package does not get to reinterpret them.
const (
	// HeaderBytes is magic(4) + version(1) + op-or-status(1) + length(4).
	HeaderBytes = 10

	Version byte = 1

	OpSeal byte = 1
	OpOpen byte = 2

	StatusOK       byte = 0
	StatusProtocol byte = 1
	StatusRefused  byte = 2
	StatusInternal byte = 3
)

var (
	magicRequest  = [4]byte{'R', 'L', 'S', 'Q'}
	magicResponse = [4]byte{'R', 'L', 'S', 'R'}
)

// Bounds. Exact, and applied per direction rather than as one number: a `seal`
// carries plaintext in and a blob out, and `open` is the reverse.
const (
	MaxPlaintextBytes = 65536
	MaxBlobBytes      = 69632
)

// MaxFrameBytes is the largest frame either direction can legally carry.
const MaxFrameBytes = HeaderBytes + MaxBlobBytes

// Errors are values so callers map them to a status without string matching.
var (
	ErrProtocol = errors.New("secretframe: protocol")
	ErrTooLarge = errors.New("secretframe: payload exceeds the bound for its operation")
	ErrTrailing = errors.New("secretframe: trailing bytes after the declared payload")
	ErrRecord   = errors.New("secretframe: protected record failed verification")
)

// Request is one decoded, bounds-checked request.
type Request struct {
	Op      byte
	Payload []byte
}

// RequestBound is the largest payload an op may carry inbound.
func RequestBound(op byte) (int, bool) {
	switch op {
	case OpSeal:
		return MaxPlaintextBytes, true
	case OpOpen:
		return MaxBlobBytes, true
	default:
		return 0, false
	}
}

// ResponseBound is the largest payload an op may produce outbound.
func ResponseBound(op byte) (int, bool) {
	switch op {
	case OpSeal:
		return MaxBlobBytes, true
	case OpOpen:
		return MaxPlaintextBytes, true
	default:
		return 0, false
	}
}

// ReadRequest reads exactly one request, validating before it allocates.
//
// ## Order matters, and an earlier version got it wrong
//
// This used to be `io.ReadAll(io.LimitReader(...))`, which grows and copies the
// whole input BEFORE the header is looked at — so a declared length of 4 GiB was
// refused only after the reader had already been drained, and the growth
// reallocated the buffer repeatedly, leaving copies of request material behind.
// That contradicted the header-before-allocation rule this file claims.
//
// The order now is: read the fixed 10-byte header, validate the magic, version,
// operation and declared length against that operation's bound, and only then
// make ONE allocation of exactly the declared size. An invalid length consumes
// no payload and allocates nothing.
//
// Every owned buffer is wiped on every failure path, including a partial read:
// a request payload is plaintext on the seal path, and a buffer that failed to
// fill is still a buffer that holds some of it.
//
// The trailing check is a single further read. Reading to EOF is what makes
// "one request per process" enforceable — a second frame smuggled behind the
// first would otherwise sit unread, and a future change that looped would run
// it. The parent's contract is to close stdin; it also owns a deadline and a
// kill, which is what bounds a parent that does not.
func ReadRequest(r io.Reader) (Request, error) {
	header := make([]byte, HeaderBytes)
	if _, err := io.ReadFull(r, header); err != nil {
		Zero(header)
		return Request{}, fmt.Errorf("%w: reading the header: %v", ErrProtocol, err)
	}
	defer Zero(header)

	if header[0] != magicRequest[0] || header[1] != magicRequest[1] ||
		header[2] != magicRequest[2] || header[3] != magicRequest[3] {
		return Request{}, fmt.Errorf("%w: not a request frame", ErrProtocol)
	}
	if header[4] != Version {
		return Request{}, fmt.Errorf("%w: version %d is not supported", ErrProtocol, header[4])
	}
	op := header[5]
	bound, known := RequestBound(op)
	if !known {
		// Refused before the length is even read: an unknown op has no bound to
		// check a length against.
		return Request{}, fmt.Errorf("%w: unknown operation", ErrProtocol)
	}
	length := binary.BigEndian.Uint32(header[6:HeaderBytes])
	if uint64(length) > uint64(bound) {
		// NOTHING is read or allocated for the payload. This is the check the
		// previous implementation performed too late to matter.
		return Request{}, ErrTooLarge
	}

	// One allocation, of exactly the validated size.
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		// A partial read still put request material in this buffer.
		Zero(payload)
		return Request{}, fmt.Errorf("%w: payload shorter than its declared length", ErrProtocol)
	}

	var probe [1]byte
	n, err := io.ReadFull(r, probe[:])
	if n > 0 {
		Zero(probe[:])
		Zero(payload)
		return Request{}, ErrTrailing
	}
	if !errors.Is(err, io.EOF) {
		Zero(payload)
		return Request{}, fmt.Errorf("%w: reading past the payload: %v", ErrProtocol, err)
	}
	// Only the validated payload is transferred to the caller.
	return Request{Op: op, Payload: payload}, nil
}

// EncodeResponse frames one response, enforcing the bound on encode.
func EncodeResponse(status byte, payload []byte) ([]byte, error) {
	if len(payload) > MaxBlobBytes {
		return nil, ErrTooLarge
	}
	out := make([]byte, HeaderBytes+len(payload))
	copy(out[0:4], magicResponse[:])
	out[4] = Version
	out[5] = status
	binary.BigEndian.PutUint32(out[6:HeaderBytes], uint32(len(payload)))
	copy(out[HeaderBytes:], payload)
	return out, nil
}

// EncodeRequest is the inverse, used by tests and by any future host-side Go
// client. The shipped helper never calls it.
func EncodeRequest(op byte, payload []byte) ([]byte, error) {
	bound, known := RequestBound(op)
	if !known {
		return nil, fmt.Errorf("%w: unknown operation", ErrProtocol)
	}
	if len(payload) > bound {
		return nil, ErrTooLarge
	}
	out := make([]byte, HeaderBytes+len(payload))
	copy(out[0:4], magicRequest[:])
	out[4] = Version
	out[5] = op
	binary.BigEndian.PutUint32(out[6:HeaderBytes], uint32(len(payload)))
	copy(out[HeaderBytes:], payload)
	return out, nil
}

// DecodeResponse parses one response frame. Tests and host clients only.
func DecodeResponse(raw []byte) (status byte, payload []byte, err error) {
	if len(raw) < HeaderBytes {
		return 0, nil, fmt.Errorf("%w: response shorter than a header", ErrProtocol)
	}
	if raw[0] != magicResponse[0] || raw[1] != magicResponse[1] || raw[2] != magicResponse[2] || raw[3] != magicResponse[3] {
		return 0, nil, fmt.Errorf("%w: not a response frame", ErrProtocol)
	}
	if raw[4] != Version {
		return 0, nil, fmt.Errorf("%w: version %d is not supported", ErrProtocol, raw[4])
	}
	length := binary.BigEndian.Uint32(raw[6:HeaderBytes])
	end := HeaderBytes + int(length)
	if len(raw) < end {
		return 0, nil, fmt.Errorf("%w: response payload shorter than its declared length", ErrProtocol)
	}
	if len(raw) > end {
		return 0, nil, ErrTrailing
	}
	return raw[5], raw[HeaderBytes:end], nil
}

// ---------------------------------------------------------------------------
// The protected inner record
// ---------------------------------------------------------------------------

// recordDomain separates this record from any other protected blob on the
// machine. It is not a secret and it is not entropy: it is a name, so a blob
// that is not ours is refused instead of being interpreted as ours.
var recordDomain = [8]byte{'R', 'L', 'Y', 'M', 'S', 'E', 'C', '1'}

const (
	recordVersion byte = 1
	digestBytes        = sha256.Size
	// domain(8) + version(1) + reserved(1) + length(4) + digest(32)
	RecordOverheadBytes = 8 + 1 + 1 + 4 + digestBytes
)

// SealRecord builds the record that DPAPI will protect.
//
// The length is explicit rather than implied by the slice, so a truncation
// inside the protected bytes is detectable: a shortened record still parses as
// bytes, and only the declared length disagrees.
func SealRecord(plaintext []byte) ([]byte, error) {
	if len(plaintext) > MaxPlaintextBytes {
		return nil, ErrTooLarge
	}
	out := make([]byte, RecordOverheadBytes+len(plaintext))
	copy(out[0:8], recordDomain[:])
	out[8] = recordVersion
	out[9] = 0
	binary.BigEndian.PutUint32(out[10:14], uint32(len(plaintext)))
	sum := sha256.Sum256(plaintext)
	copy(out[14:14+digestBytes], sum[:])
	copy(out[14+digestBytes:], plaintext)
	return out, nil
}

// OpenRecord verifies a record and returns its payload.
//
// Every field is checked BEFORE any plaintext is returned, and the digest
// comparison is constant time. A successful CryptUnprotectData is not evidence
// the bytes are the bytes that were sealed — the API's own documentation says
// corruption may fail with varying codes or succeed with corrupted output — so
// this is what actually establishes integrity.
//
// The returned error is deliberately uniform for every kind of mismatch: which
// field failed is not something a caller needs, and reporting it would describe
// the protected bytes.
func OpenRecord(record []byte) ([]byte, error) {
	if len(record) < RecordOverheadBytes {
		return nil, ErrRecord
	}
	if subtle.ConstantTimeCompare(record[0:8], recordDomain[:]) != 1 {
		// Not our record. A raw DPAPI blob from another producer lands here.
		return nil, ErrRecord
	}
	if record[8] != recordVersion {
		return nil, ErrRecord
	}
	if record[9] != 0 {
		return nil, ErrRecord
	}
	length := binary.BigEndian.Uint32(record[10:14])
	if uint64(length) > uint64(MaxPlaintextBytes) {
		return nil, ErrRecord
	}
	end := RecordOverheadBytes + int(length)
	// Exact, not "at least": trailing bytes inside the protected record are as
	// much a mismatch as missing ones.
	if len(record) != end {
		return nil, ErrRecord
	}
	payload := record[RecordOverheadBytes:end]
	sum := sha256.Sum256(payload)
	if subtle.ConstantTimeCompare(record[14:14+digestBytes], sum[:]) != 1 {
		return nil, ErrRecord
	}
	return payload, nil
}

// wipeObserver is nil in every build. Tests in this package set it to record
// that a buffer really was wiped on a failure path, which is otherwise
// invisible: the buffers are internal and a caller never sees them.
var wipeObserver func(n int)

// Zero overwrites b. Used on every buffer that has held plaintext or a digest.
func Zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
	if wipeObserver != nil {
		wipeObserver(len(b))
	}
}

// MaxRecordBytes is the largest protected record: a full-size plaintext plus
// this file's own framing. It bounds what an unprotect may hand back before the
// result is copied anywhere.
const MaxRecordBytes = RecordOverheadBytes + MaxPlaintextBytes
