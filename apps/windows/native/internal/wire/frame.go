// Bounded framing for the helper's stdin/stdout transport.
//
// ## Why a length prefix and not newline-delimited JSON
//
// File bytes are the bulk of this protocol and they are arbitrary binary. Base64
// inside JSON would cost a third of the transfer to encode data that is then
// immediately written to disk, and a newline framing would have to escape it
// anyway. So chunks travel as a binary frame and only control messages are JSON.
//
// ## Every bound is checked before allocation
//
// A length prefix is a request to allocate memory from a peer we are treating as
// untrusted. Each limit below is therefore validated against the header alone;
// no buffer is reserved for a frame that will be rejected. That is what stops a
// malformed four-byte header from becoming a 4 GiB allocation.
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Frame kinds.
const (
	KindRequest  byte = 1
	KindChunk    byte = 2
	KindResponse byte = 3
	KindEvent    byte = 4
)

const (
	// MaxFrameBytes is the hard ceiling on any single frame, whatever its kind.
	MaxFrameBytes = 8 << 20

	// MaxOpenRequestBytes applies only to the `open` request, which carries the
	// whole manifest. See MaxManifestNameBytes in nameguard for the aggregate
	// name budget this has to accommodate.
	MaxOpenRequestBytes = 4 << 20

	// MaxRequestBytes applies to every other JSON request. They are all a
	// handful of integers, so this is already generous.
	MaxRequestBytes = 64 << 10

	// MaxResponseBytes is ENFORCED on encode, not assumed. Publish receipts are
	// O(1) precisely so this bound can be real for a 1000-file manifest.
	MaxResponseBytes = 4096

	// MaxChunkBytes matches MAX_CHUNK_BYTES in src/main/io/receive-lease.ts.
	// Divergence between the two would mean the host can compose a chunk the
	// helper refuses, which is a stall rather than an error anyone can act on.
	MaxChunkBytes = 256 << 10

	// ChunkHeaderBytes is `u64 id` + `u32 index`.
	ChunkHeaderBytes = 12
)

// ErrFrameTooLarge is returned before any allocation is made for the frame.
var ErrFrameTooLarge = errors.New("frame exceeds maximum size")

// Frame is one decoded transport unit. Payload aliases the reader's scratch
// buffer and is only valid until the next ReadFrame, which is why the session
// copies chunk data it intends to keep.
type Frame struct {
	Kind    byte
	Payload []byte
}

// Reader decodes frames from a stream using one reusable buffer.
type Reader struct {
	r      io.Reader
	header [5]byte
	buf    []byte
}

func NewReader(r io.Reader) *Reader { return &Reader{r: r} }

// ReadFrame returns the next frame, or io.EOF at a clean frame boundary.
//
// A stream that ends part-way through a frame is io.ErrUnexpectedEOF, not EOF:
// the difference is exactly "the parent finished with us" versus "the parent
// died mid-message", and the caller settles those differently.
func (fr *Reader) ReadFrame() (Frame, error) {
	if _, err := io.ReadFull(fr.r, fr.header[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return Frame{}, io.ErrUnexpectedEOF
		}
		return Frame{}, err
	}
	length := binary.BigEndian.Uint32(fr.header[:4])
	kind := fr.header[4]

	// `length` counts the kind byte, so a zero-length frame is impossible and a
	// length of 1 is an empty payload. Checked before allocation.
	if length < 1 {
		return Frame{}, Errf(CodeProtocol, "frame length below minimum")
	}
	if length > MaxFrameBytes {
		return Frame{}, Errf(CodeProtocol, fmt.Sprintf("frame length %d exceeds %d", length, MaxFrameBytes))
	}
	payloadLen := int(length) - 1

	switch kind {
	case KindRequest, KindChunk, KindResponse, KindEvent:
	default:
		return Frame{}, Errf(CodeProtocol, fmt.Sprintf("unknown frame kind %d", kind))
	}
	if kind == KindChunk && payloadLen < ChunkHeaderBytes {
		return Frame{}, Errf(CodeProtocol, "chunk frame shorter than its header")
	}
	if kind == KindChunk && payloadLen-ChunkHeaderBytes > MaxChunkBytes {
		return Frame{}, Errf(CodeProtocol, "chunk exceeds maximum chunk size")
	}

	if cap(fr.buf) < payloadLen {
		fr.buf = make([]byte, payloadLen)
	}
	payload := fr.buf[:payloadLen]
	if _, err := io.ReadFull(fr.r, payload); err != nil {
		// Any truncation here is mid-frame by construction: the header promised
		// these bytes.
		return Frame{}, io.ErrUnexpectedEOF
	}
	return Frame{Kind: kind, Payload: payload}, nil
}

// EncodeFrame renders one frame. It returns an error rather than truncating,
// because a truncated frame is indistinguishable from a corrupt one at the peer.
func EncodeFrame(kind byte, payload []byte) ([]byte, error) {
	length := len(payload) + 1
	if length > MaxFrameBytes {
		return nil, ErrFrameTooLarge
	}
	out := make([]byte, 5+len(payload))
	binary.BigEndian.PutUint32(out[:4], uint32(length))
	out[4] = kind
	copy(out[5:], payload)
	return out, nil
}

// ChunkHeader is the fixed prefix of a kind=2 frame.
type ChunkHeader struct {
	ID    uint64
	Index uint32
}

// DecodeChunk splits a chunk payload. The returned data aliases payload.
func DecodeChunk(payload []byte) (ChunkHeader, []byte, error) {
	if len(payload) < ChunkHeaderBytes {
		return ChunkHeader{}, nil, Errf(CodeProtocol, "chunk payload shorter than header")
	}
	h := ChunkHeader{
		ID:    binary.BigEndian.Uint64(payload[:8]),
		Index: binary.BigEndian.Uint32(payload[8:12]),
	}
	// The same non-zero rule DecodeRequest applies to every other message.
	//
	// A chunk is a promise the host is waiting on, and an id of zero cannot be
	// correlated with anything, so it is unanswerable by construction. It also
	// used to be worse than merely useless: the shutdown refusal path answers a
	// queued frame on its correlation id, and a zero id meant the frame was
	// dropped with no reply emitted and no protocol failure recorded.
	if h.ID == 0 {
		return ChunkHeader{}, nil, Errf(CodeProtocol, "chunk id must be non-zero")
	}
	return h, payload[ChunkHeaderBytes:], nil
}

// EncodeChunk is used by tests and by any future host-side Go client.
func EncodeChunk(h ChunkHeader, data []byte) ([]byte, error) {
	if len(data) > MaxChunkBytes {
		return nil, ErrFrameTooLarge
	}
	payload := make([]byte, ChunkHeaderBytes+len(data))
	binary.BigEndian.PutUint64(payload[:8], h.ID)
	binary.BigEndian.PutUint32(payload[8:12], h.Index)
	copy(payload[ChunkHeaderBytes:], data)
	return EncodeFrame(KindChunk, payload)
}
