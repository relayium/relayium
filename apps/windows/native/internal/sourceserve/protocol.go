// The source-read protocol: three operations, strictly validated on read.
//
// ## Why a second protocol and not three more ops on the first
//
// The receive protocol in `internal/wire` is accepted and in production. Its
// `DecodeRequest` whitelists five operations, rejects unknown fields, and sizes
// every request against the manifest-carrying `open`. Adding source operations
// there would widen the accepted validator for every receive lease that will
// never use them.
//
// So this package defines its own request grammar and its own dispatch, and
// reuses `wire` only for things that are genuinely shared and genuinely
// unchanged: the length-prefixed framing, the frame kinds, the chunk header, the
// `Response`/`Event` envelopes and the error-code type. Nothing in `wire` is
// modified, and the receive path is not reachable from here.
//
// ## Codes
//
// Each package declares the codes it raises. The ones below are protocol and
// bookkeeping failures that arise in this loop; the filesystem codes arrive
// already classified from the opener and pass through by value, so a new refusal
// in the walker does not need a matching edit here.
package sourceserve

import (
	"bytes"
	"encoding/json"
	"fmt"
	"unicode/utf8"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// Named so the reason survives: json.Decoder is used instead of json.Unmarshal
// purely for DisallowUnknownFields and More(), which turn an invented field and
// a second object hidden behind the first into explicit protocol errors.
func newBytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

// Operation names. Hyphenated and distinct from every receive op, so a frame
// sent to the wrong mode is refused by name rather than half-understood.
const (
	OpOpen  = "open-source"
	OpRead  = "read-source"
	OpClose = "close-source"
)

// ProtocolVersion is announced in the ready event. It is versioned separately
// from the receive protocol because the two evolve independently.
const ProtocolVersion = 1

// ReadyEvent is the event name emitted once, before any request is served.
const ReadyEvent = "source-ready"

const (
	// MaxOpenSources bounds handles this process holds at once. A ninth open is
	// refused rather than queued: queueing would make the bound invisible to the
	// host, which is the party that has to decide what to do about it.
	MaxOpenSources = 8

	// MaxReadBytes matches MAX_SELECTION_CHUNK in src/shared/os-entry.ts and the
	// 192 KiB chunk the transfer layer uses. Divergence would let the host ask
	// for a length the helper refuses, which is a stall rather than an error.
	MaxReadBytes = 192 << 10

	// MaxRequestBytes is generous for three integers and a path.
	MaxRequestBytes = 64 << 10

	// MaxPathBytes bounds the one variable-length field. 32767 UTF-16 units is
	// the Windows path ceiling; the byte budget below accommodates it in UTF-8
	// without allowing the frame limit to be the only bound.
	MaxPathBytes = 32767 * 3
)

// Codes raised by this package.
const (
	// CodeSourceLimit means MaxOpenSources are already held.
	CodeSourceLimit wire.Code = "E_SOURCE_LIMIT"

	// CodeUnknownSource means the id is not open. It is returned for an id that
	// was never issued AND for one already closed, because distinguishing them
	// would confirm which ids this process has used.
	CodeUnknownSource wire.Code = "E_UNKNOWN_SOURCE"

	// CodeRange means the offset or length is outside what this protocol serves.
	CodeRange wire.Code = "E_RANGE"

	// CodeFailedClose means a handle could not be released and is still held.
	// The source is gone from the table either way; this says the process did
	// not get the handle back, which is a leak the host should know about.
	CodeFailedClose wire.Code = "E_FAILED_CLOSE"
)

// Request is one host-to-helper control message.
//
// Pointer fields are pointers so "absent" and "zero" are distinguishable.
// Offset zero is a legitimate read; an omitted offset is a malformed request,
// and a non-pointer field could not tell them apart.
type Request struct {
	ID     uint64 `json:"id"`
	Op     string `json:"op"`
	Path   string `json:"path,omitempty"`
	Source uint64 `json:"source,omitempty"`
	Offset *int64 `json:"offset,omitempty"`
	Length *int   `json:"length,omitempty"`
}

// OpenResult describes an opened source.
//
// VolumeSerial and FileID are hex STRINGS. They are 64- and 128-bit values and
// the host is JavaScript, where a JSON number above 2^53 is silently rounded;
// two distinct files would then present the same identity. No numeric form of
// these fields exists anywhere in this protocol.
type OpenResult struct {
	Source       uint64 `json:"source"`
	Size         int64  `json:"size"`
	VolumeSerial string `json:"volumeSerial"`
	FileID       string `json:"fileId"`
}

// ReadResult accompanies the chunk frame and states what was actually served.
//
// Bytes is what the read produced, never what the caller asked for. EOF is a
// separate fact from a short read: a short read in the middle of a file is
// ordinary, and only EOF says there is nothing further.
type ReadResult struct {
	Bytes int  `json:"bytes"`
	EOF   bool `json:"eof"`
}

// CloseResult reports what releasing the handle actually achieved.
//
// State is "closed" when the handle came back and "failed-close" when it did
// not. A failed close still removes the source from the table — no further read
// may be served through a handle in an unknown state — so the two states differ
// in what the PROCESS still holds, not in what the host may still do.
type CloseResult struct {
	State string `json:"state"`
}

// Close states.
const (
	StateClosed      = "closed"
	StateFailedClose = "failed-close"
)

// DecodeRequest parses and fully validates one request payload.
//
// Validation happens on READ, before dispatch, for the same reason it does in
// the receive protocol: a frame still queued at shutdown has already been
// judged, so it can be dropped without executing anything and without losing the
// fact that it was malformed.
//
// No host-authored text is ever echoed into a detail. `op` and `path` are
// arbitrary: either can be enormous and either can be made to look like a
// diagnostic. Details below carry rule names and numbers only.
func DecodeRequest(payload []byte) (Request, error) {
	// JSON is UTF-8 by definition and Go's decoder silently substitutes U+FFFD
	// for invalid bytes. For a path that substitution is not cosmetic: it would
	// name a different file than the caller sent.
	if !utf8.Valid(payload) {
		return Request{}, wire.Errf(wire.CodeProtocol, "request is not valid UTF-8")
	}
	if len(payload) > MaxRequestBytes {
		return Request{}, wire.Errf(wire.CodeProtocol,
			fmt.Sprintf("request of %d bytes exceeds %d", len(payload), MaxRequestBytes))
	}
	var req Request
	dec := json.NewDecoder(newBytesReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return Request{}, wire.Errf(wire.CodeProtocol, "request has unexpected shape")
	}
	// A trailing value after the object would mean two messages arrived in one
	// frame, and only the first would ever be answered.
	if dec.More() {
		return Request{}, wire.Errf(wire.CodeProtocol, "trailing content after request")
	}
	if req.ID == 0 {
		return Request{}, wire.Errf(wire.CodeProtocol, "request id must be non-zero")
	}

	switch req.Op {
	case OpOpen:
		if req.Path == "" {
			return Request{}, wire.Errf(wire.CodeProtocol, "open omits the required path")
		}
		if len(req.Path) > MaxPathBytes {
			return Request{}, wire.Errf(wire.CodeProtocol, "path exceeds maximum")
		}
		if err := refuseUnused(req, "source", req.Source != 0); err != nil {
			return Request{}, err
		}
		if err := refuseUnused(req, "offset", req.Offset != nil); err != nil {
			return Request{}, err
		}
		if err := refuseUnused(req, "length", req.Length != nil); err != nil {
			return Request{}, err
		}
	case OpRead:
		if req.Source == 0 {
			return Request{}, wire.Errf(wire.CodeProtocol, "read omits the required source")
		}
		if req.Offset == nil || req.Length == nil {
			return Request{}, wire.Errf(wire.CodeProtocol, "read omits offset or length")
		}
		// Range rules are protocol, not policy, so they are enforced at the
		// boundary rather than by the handler. A negative length is not clamped
		// to zero and a huge one is not truncated to the maximum: both are the
		// host asking for something this protocol does not define.
		if *req.Offset < 0 {
			return Request{}, wire.Errf(CodeRange, "negative offset")
		}
		if *req.Length <= 0 {
			return Request{}, wire.Errf(CodeRange, "length must be positive")
		}
		if *req.Length > MaxReadBytes {
			return Request{}, wire.Errf(CodeRange, fmt.Sprintf("length exceeds %d", MaxReadBytes))
		}
		if err := refuseUnused(req, "path", req.Path != ""); err != nil {
			return Request{}, err
		}
	case OpClose:
		if req.Source == 0 {
			return Request{}, wire.Errf(wire.CodeProtocol, "close omits the required source")
		}
		if err := refuseUnused(req, "path", req.Path != ""); err != nil {
			return Request{}, err
		}
		if err := refuseUnused(req, "offset", req.Offset != nil); err != nil {
			return Request{}, err
		}
		if err := refuseUnused(req, "length", req.Length != nil); err != nil {
			return Request{}, err
		}
	default:
		return Request{}, wire.Errf(wire.CodeProtocol, "request names an operation this protocol does not define")
	}
	return req, nil
}

// refuseUnused rejects a field that is meaningless for the operation.
//
// DisallowUnknownFields catches a field this protocol never defines; this
// catches one it defines for a DIFFERENT operation. Ignoring those would let a
// request carry a field the sender believes is doing something.
func refuseUnused(_ Request, field string, present bool) error {
	if present {
		return wire.Errf(wire.CodeProtocol, "field not valid for this operation: "+field)
	}
	return nil
}

// EncodeOK renders a successful response with a marshalled result.
func EncodeOK(id uint64, result any) ([]byte, error) {
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, wire.Errf(wire.CodeInternal, "result marshal failed")
	}
	return wire.EncodeResponse(wire.Response{ID: id, OK: true, Result: raw})
}

// EncodeErr renders a coded failure. The detail comes from the coded error and
// is bounded by construction; an uncoded error contributes no text at all.
func EncodeErr(id uint64, err error) ([]byte, error) {
	return wire.EncodeResponse(wire.Response{
		ID:     id,
		OK:     false,
		Code:   wire.CodeOf(err),
		Detail: wire.DetailOf(err),
	})
}
