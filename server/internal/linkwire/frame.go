package linkwire

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"strconv"
)

// frame builds [kind][uint32 BE seq][payload] into a new slice.
func frame(kind byte, seq uint32, payload []byte) []byte {
	out := make([]byte, HeaderSize+len(payload))
	out[0] = kind
	binary.BigEndian.PutUint32(out[1:HeaderSize], seq)
	copy(out[HeaderSize:], payload)
	return out
}

// FrameClass is where a file-lane frame is routed (link §6.1). The partition is
// total: every byte string lands in exactly one class. The zero value is
// ClassUnroutable, so an unset class fails closed.
type FrameClass int

const (
	ClassUnroutable FrameClass = iota
	ClassLifecycle
	ClassAck
	ClassResumeRequest
	ClassResumeStart
	ClassProtected
)

func (c FrameClass) String() string {
	switch c {
	case ClassLifecycle:
		return "lifecycle"
	case ClassAck:
		return "ack"
	case ClassResumeRequest:
		return "resumeRequest"
	case ClassResumeStart:
		return "resumeStart"
	case ClassProtected:
		return "protected"
	}
	return "unroutable"
}

// FileControl is a file-lane lifecycle byte.
type FileControl byte

const (
	FileAccept     = FileControl(CtrlAccept)
	FileReject     = FileControl(CtrlReject)
	FileComplete   = FileControl(CtrlComplete)
	FileBusy       = FileControl(CtrlBusy)
	FileBatchAbort = FileControl(CtrlBatchAbort)
)

func (c FileControl) String() string {
	switch c {
	case FileAccept:
		return "accept"
	case FileReject:
		return "reject"
	case FileComplete:
		return "complete"
	case FileBusy:
		return "busy"
	case FileBatchAbort:
		return "batchAbort"
	}
	return "FileControl(" + strconv.Itoa(int(c)) + ")"
}

// FileLifecycle reports the file-lane control in f. A control is EXACTLY one
// byte: a longer frame that merely starts with one of these values is not
// consent, and the text lane's 0xfa/0xfb mean nothing here.
func FileLifecycle(f []byte) (FileControl, bool) {
	if len(f) != 1 {
		return 0, false
	}
	switch c := FileControl(f[0]); c {
	case FileAccept, FileReject, FileComplete, FileBusy, FileBatchAbort:
		return c, true
	}
	return 0, false
}

// TextControl is a text-lane lifecycle byte.
type TextControl byte

const (
	TextRequest = TextControl(CtrlTextRequest)
	TextAccept  = TextControl(CtrlAccept)
	TextReject  = TextControl(CtrlReject)
	TextEnd     = TextControl(CtrlTextEnd)
)

func (c TextControl) String() string {
	switch c {
	case TextRequest:
		return "request"
	case TextAccept:
		return "accept"
	case TextReject:
		return "reject"
	case TextEnd:
		return "end"
	}
	return "TextControl(" + strconv.Itoa(int(c)) + ")"
}

// TextLifecycle reports the text-lane control in f: exactly one byte, and the
// file lane's COMPLETE, BUSY and BATCH_ABORT mean nothing here.
func TextLifecycle(f []byte) (TextControl, bool) {
	if len(f) != 1 {
		return 0, false
	}
	switch c := TextControl(f[0]); c {
	case TextRequest, TextAccept, TextReject, TextEnd:
		return c, true
	}
	return 0, false
}

// IsTextFrame is the text lane's content discriminator: at least a header plus
// a tag, and kind 9. A kind-9 frame shorter than that is malformed, not
// content, and the lane that sees it fails (link §7.3).
func IsTextFrame(f []byte) bool {
	return len(f) >= ChunkOverhead && f[0] == KindText
}

// ClassifyFileFrame is the total file-lane partition of link §6.1. For a
// lifecycle frame it also returns the control. Kind 12 is unroutable because
// this package does not implement `preupload/1`; the legacy kinds 2 and 3 are
// protected on purpose, so the receiver can report an older peer loudly.
func ClassifyFileFrame(f []byte) (FrameClass, FileControl) {
	if c, ok := FileLifecycle(f); ok {
		return ClassLifecycle, c
	}
	if len(f) < HeaderSize {
		return ClassUnroutable, 0
	}
	switch f[0] {
	case KindAck:
		if len(f) == AckFrameSize {
			return ClassAck, 0
		}
		return ClassUnroutable, 0
	case KindResumeReq:
		return ClassResumeRequest, 0
	case KindResumeStart:
		return ClassResumeStart, 0
	case KindChunk, KindChunkPart, KindBatchEnc, KindBatchPart, KindDoneEnc, KindBatchLegacy, KindDoneLegacy:
		return ClassProtected, 0
	}
	return ClassUnroutable, 0
}

// PiecePlainBytes is the plaintext one DataChannel message may carry given the
// connection's maximum message size: min(max - ChunkOverhead, ChunkSize), and
// an error below MinPieceBytes. Zero is refused like any other small value; a
// transport whose SCTP limit means "unlimited" must pass an explicit large
// value instead.
func PiecePlainBytes(maxFrameBytes int64) (int, error) {
	if maxFrameBytes < MinPieceBytes+ChunkOverhead {
		return 0, ErrPieceTooSmall
	}
	return int(min(maxFrameBytes-ChunkOverhead, ChunkSize)), nil
}

// TextPlainLimit is the plaintext one message may carry on this connection:
// TextMaxBytes lowered to what a sealed frame must fit in, never negative.
func TextPlainLimit(maxFrameBytes int64) int {
	if maxFrameBytes <= ChunkOverhead {
		return 0
	}
	return int(min(maxFrameBytes-ChunkOverhead, TextMaxBytes))
}

// AckFrame encodes a cumulative durably-written byte count as
// [0x06][uint32 0][Float64 BE n]. A value above MaxSafeInteger is refused
// because a float64 cannot carry it exactly.
func AckFrame(bytesWritten uint64) ([]byte, error) {
	if bytesWritten > MaxSafeInteger {
		return nil, ErrInvalidAck
	}
	var p [8]byte
	binary.BigEndian.PutUint64(p[:], math.Float64bits(float64(bytesWritten)))
	return frame(KindAck, 0, p[:]), nil
}

// ParseAck decodes an ACK frame's value exactly as the wire carries it. It
// makes no judgement about the value; see AdvanceAck.
func ParseAck(f []byte) (float64, bool) {
	if len(f) != AckFrameSize || f[0] != KindAck {
		return 0, false
	}
	return math.Float64frombits(binary.BigEndian.Uint64(f[HeaderSize:])), true
}

// AdvanceAck returns the new acknowledged count: candidate if it is a
// non-negative safe integer strictly greater than acked and no greater than
// sent (the bytes this attempt actually emitted), otherwise acked unchanged.
// NaN, infinities, fractions, negative values and anything above
// MaxSafeInteger never advance it, so a forged, stale or duplicated ACK can
// open no credit this attempt did not create.
func AdvanceAck(acked, sent uint64, candidate float64) uint64 {
	c, ok := safeUint(candidate)
	if !ok || c <= acked || c > sent {
		return acked
	}
	return c
}

// ResumePoint is a durable checkpoint: Offset bytes of file Index are held.
type ResumePoint struct {
	Index  uint64
	Offset uint64
}

// ResumeStart is a sender's realignment announcement: the resumed stream
// continues from Point and its first protected frame carries Seq.
type ResumeStart struct {
	Point ResumePoint
	Seq   uint64
}

func (p ResumePoint) valid() bool {
	return p.Index <= MaxSafeInteger && p.Offset <= MaxSafeInteger
}

// ResumeAligned reports whether p lies on the chain-hash grid of its file:
// Offset equal to the file's size, or a multiple of ChunkSize. A point naming
// no file is not aligned.
func ResumeAligned(p ResumePoint, sizes []uint64) bool {
	if p.Index >= uint64(len(sizes)) {
		return false
	}
	return p.Offset == sizes[p.Index] || p.Offset%ChunkSize == 0
}

// ResumeInRange reports whether p names a file of the batch and does not lie
// past its end.
func ResumeInRange(p ResumePoint, sizes []uint64) bool {
	return p.Index < uint64(len(sizes)) && p.Offset <= sizes[p.Index]
}

// ResumeReqFrame encodes RESUME_REQ: plaintext {"index":N,"offset":N}, seq 0.
func ResumeReqFrame(p ResumePoint) ([]byte, error) {
	if !p.valid() {
		return nil, ErrInvalidResume
	}
	b := []byte(`{"index":`)
	b = strconv.AppendUint(b, p.Index, 10)
	b = append(b, `,"offset":`...)
	b = strconv.AppendUint(b, p.Offset, 10)
	b = append(b, '}')
	return frame(KindResumeReq, 0, b), nil
}

// resumeStartFrame encodes RESUME_START: plaintext
// {"index":N,"offset":N,"seq":N}, seq field 0. It consumes no sequence number.
func resumeStartFrame(s ResumeStart) ([]byte, error) {
	if !s.Point.valid() || s.Seq > MaxSeq {
		return nil, ErrInvalidResume
	}
	b := []byte(`{"index":`)
	b = strconv.AppendUint(b, s.Point.Index, 10)
	b = append(b, `,"offset":`...)
	b = strconv.AppendUint(b, s.Point.Offset, 10)
	b = append(b, `,"seq":`...)
	b = strconv.AppendUint(b, s.Seq, 10)
	b = append(b, '}')
	return frame(KindResumeStart, 0, b), nil
}

// ParseResumeReq decodes RESUME_REQ. The payload must be a JSON object whose
// index and offset are non-negative safe integers; other keys are ignored, as
// on the Web. Range and alignment against the batch are the caller's checks
// (ResumeInRange, ResumeAligned), because only it knows the files.
func ParseResumeReq(f []byte) (ResumePoint, error) {
	if len(f) < HeaderSize || f[0] != KindResumeReq {
		return ResumePoint{}, ErrMalformedFrame
	}
	fields, ok, err := jsonObject(f[HeaderSize:])
	if err != nil || !ok {
		return ResumePoint{}, ErrInvalidResume
	}
	return resumePointFields(fields)
}

// ParseResumeStart decodes RESUME_START. Besides the RESUME_REQ rules, seq must
// fit the uint32 wire field: an announcement at or above 2^32 can never match a
// real frame and is refused (relayium-realtime-wire-v1.md, link §12.1). Whether
// the announcement was asked for, and whether its point matches the receiver's
// own checkpoint, are the lane's checks.
func ParseResumeStart(f []byte) (ResumeStart, error) {
	if len(f) < HeaderSize || f[0] != KindResumeStart {
		return ResumeStart{}, ErrMalformedFrame
	}
	fields, ok, err := jsonObject(f[HeaderSize:])
	if err != nil || !ok {
		return ResumeStart{}, ErrInvalidResume
	}
	p, err := resumePointFields(fields)
	if err != nil {
		return ResumeStart{}, err
	}
	seq, ok := jsonSafeUint(fields["seq"])
	if !ok || seq > MaxSeq {
		return ResumeStart{}, ErrInvalidResume
	}
	return ResumeStart{Point: p, Seq: seq}, nil
}

func resumePointFields(fields map[string]json.RawMessage) (ResumePoint, error) {
	index, ok1 := jsonSafeUint(fields["index"])
	offset, ok2 := jsonSafeUint(fields["offset"])
	if !ok1 || !ok2 {
		return ResumePoint{}, ErrInvalidResume
	}
	return ResumePoint{Index: index, Offset: offset}, nil
}
