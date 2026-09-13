// The helper's wire framing. Bounded, and boring on purpose.
//
// A control message is JSON; a write payload is raw bytes. They are separate
// frame kinds because base64ing a hundred-megabyte installer through JSON would
// cost a third of it in overhead and make the size bound harder to state.
//
// ## Every length is checked before it is trusted
//
// A length prefix arriving from a pipe is an attacker-controlled allocation
// request unless it is bounded first. Both directions are read with an explicit
// maximum, and a frame that claims more is a protocol error that ENDS the
// session — not a truncated read the next frame would resynchronise from.
package updio

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	// KindJSON carries one control message.
	KindJSON byte = 'J'
	// KindBytes carries the payload of the write that immediately preceded it.
	KindBytes byte = 'B'

	// MaxControlBytes bounds a JSON control frame. The largest legitimate one is
	// an install expectation: two names, a digest, a publisher subject.
	MaxControlBytes = 16 << 10
	// MaxChunkBytes bounds one write payload. The host streams; it does not hand
	// over a whole artifact.
	MaxChunkBytes = 1 << 20

	// MaxJournalBytes bounds a record read. It matches the core's
	// `MAX_JOURNAL_BYTES` exactly, because a helper that could not return a
	// document the core considers valid would fail every startup on a journal of
	// legitimate size — and 512 KiB of JSON string does not fit in a control
	// frame anyway once escaping is counted.
	MaxJournalBytes = 512 << 10
)

// ErrClosed is returned when the peer closed cleanly between frames. It is the
// ONLY end-of-input that is not an error: a partial frame is a truncation.
var ErrClosed = errors.New("updio: peer closed")

// ReadFrame reads one frame, refusing any length beyond max.
func ReadFrame(r io.Reader, max int) (kind byte, payload []byte, err error) {
	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if errors.Is(err, io.EOF) {
			return 0, nil, ErrClosed
		}
		return 0, nil, fmt.Errorf("updio: read header: %w", err)
	}
	length := binary.BigEndian.Uint32(header[:4])
	kind = header[4]
	if kind != KindJSON && kind != KindBytes {
		return 0, nil, fmt.Errorf("updio: unknown frame kind %#x", kind)
	}
	if int(length) > max {
		// Refused BEFORE the allocation, which is the whole point of the bound.
		return 0, nil, fmt.Errorf("updio: frame of %d bytes exceeds %d", length, max)
	}
	payload = make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		// A short read here is a truncated frame, never a clean close.
		return 0, nil, fmt.Errorf("updio: read payload: %w", err)
	}
	return kind, payload, nil
}

// WriteFrame writes one frame.
func WriteFrame(w io.Writer, kind byte, payload []byte) error {
	if kind == KindJSON && len(payload) > MaxControlBytes {
		return fmt.Errorf("updio: control frame of %d bytes exceeds %d", len(payload), MaxControlBytes)
	}
	if kind == KindBytes && len(payload) > MaxJournalBytes {
		return fmt.Errorf("updio: payload frame of %d bytes exceeds %d", len(payload), MaxJournalBytes)
	}
	var header [5]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(payload)))
	header[4] = kind
	if _, err := w.Write(header[:]); err != nil {
		return fmt.Errorf("updio: write header: %w", err)
	}
	if _, err := w.Write(payload); err != nil {
		return fmt.Errorf("updio: write payload: %w", err)
	}
	return nil
}

// WriteJSON marshals and writes one control frame.
func WriteJSON(w io.Writer, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("updio: marshal: %w", err)
	}
	return WriteFrame(w, KindJSON, encoded)
}
