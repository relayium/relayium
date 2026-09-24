package linkwire

import (
	"encoding/binary"
	"fmt"
	"unicode/utf8"

	"github.com/relayium/relayium/internal/linkcrypto"
)

// TextSender seals the text lane in one direction: [0x09][seq][sealed(textKey,
// seq, utf8)], under the DERIVED text key and its own per-direction counter —
// never the file lane's key or sequence.
//
// A message is checked before its sequence number is reserved: invalid UTF-8
// and a message over TextMaxBytes are refused without burning a number, so the
// conversation survives. The counter is 64-bit, seq MaxSeq is still usable, and
// after it Seal fails with ErrSeqExhausted rather than wrapping.
//
// Not safe for concurrent use: calls must be serialised, or sealed frames
// could leave in a different order from their sequence numbers. One link owns
// exactly one TextSender for its lifetime.
type TextSender struct {
	key  [linkcrypto.SessionKeySize]byte
	next uint64
}

// NewTextSender returns a sender for the local text send key
// (SessionKeys.TextSend). The key is copied.
func NewTextSender(textSendKey []byte) (*TextSender, error) {
	k, err := sessionKey(textSendKey)
	if err != nil {
		return nil, err
	}
	return &TextSender{key: k}, nil
}

// Format prints the sequence position only, for every verb, so no formatting of
// a TextSender reaches its key.
func (s TextSender) Format(f fmt.State, _ rune) {
	fmt.Fprintf(f, "linkwire.TextSender{next:%d redacted}", s.next)
}

// NextSeq is the sequence number the next sealed message will carry.
func (s *TextSender) NextSeq() uint64 { return s.next }

// Seal seals one message's bytes exactly as given: empty, whitespace, NUL,
// multi-line, combining sequences and a leading U+FEFF are all preserved. The
// product cap is TextMaxBytes; the caller also checks TextPlainLimit for this
// connection before calling, because text never fragments.
func (s *TextSender) Seal(body []byte) ([]byte, error) {
	if !utf8.Valid(body) {
		return nil, ErrInvalidUTF8
	}
	if len(body) > TextMaxBytes {
		return nil, ErrTextTooLarge
	}
	if s.next > MaxSeq {
		return nil, ErrSeqExhausted
	}
	seq := s.next
	s.next++ // reserved before sealing
	ct, err := linkcrypto.Seal(s.key[:], seq, body)
	if err != nil {
		panic("linkwire: seal with a validated key failed")
	}
	return frame(KindText, uint32(seq), ct), nil
}

// TextReceiver opens the text lane in one direction.
//
// The expected sequence advances only after a frame authenticates: a frame that
// is malformed, oversized, out of order or fails AEAD leaves it unchanged, so a
// genuine frame at the same number still opens (the Web contract). A frame that
// authenticates and then is not valid UTF-8 has consumed its number and is
// refused — never replaced with U+FFFD. Every error is a text-lane failure for
// the caller to act on; a text-lane failure must not take the file lane.
//
// Not safe for concurrent use. One link owns exactly one TextReceiver.
type TextReceiver struct {
	key      [linkcrypto.SessionKeySize]byte
	expected uint64
}

// NewTextReceiver returns a receiver for the local text recv key
// (SessionKeys.TextRecv). The key is copied.
func NewTextReceiver(textRecvKey []byte) (*TextReceiver, error) {
	k, err := sessionKey(textRecvKey)
	if err != nil {
		return nil, err
	}
	return &TextReceiver{key: k}, nil
}

// Format prints the sequence position only, for every verb, so no formatting of
// a TextReceiver reaches its key.
func (r TextReceiver) Format(f fmt.State, _ rune) {
	fmt.Fprintf(f, "linkwire.TextReceiver{expected:%d redacted}", r.expected)
}

// ExpectedSeq is the sequence number the next message must carry.
func (r *TextReceiver) ExpectedSeq() uint64 { return r.expected }

// Open authenticates and decodes one content frame, returning its bytes
// unchanged (a leading BOM included) as a string.
func (r *TextReceiver) Open(f []byte) (string, error) {
	if len(f) < ChunkOverhead {
		return "", ErrMalformedFrame
	}
	if f[0] != KindText {
		return "", ErrUnroutable
	}
	if len(f)-ChunkOverhead > TextMaxBytes {
		return "", ErrTextTooLarge
	}
	if r.expected > MaxSeq {
		return "", ErrSeqExhausted
	}
	if uint64(binary.BigEndian.Uint32(f[1:HeaderSize])) != r.expected {
		return "", ErrOutOfOrder
	}
	plain, err := linkcrypto.Open(r.key[:], r.expected, f[HeaderSize:])
	if err != nil {
		return "", ErrOpen
	}
	r.expected++
	if !utf8.Valid(plain) {
		return "", ErrInvalidUTF8
	}
	return string(plain), nil
}
