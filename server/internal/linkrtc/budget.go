package linkrtc

import (
	"fmt"

	"github.com/relayium/relayium/internal/linkwire"
)

// Budget is the per-link frame budget (A09-DESIGN §2.3, link §2).
//
// The transport's negotiated maximum is NOT a frame size on its own: Pion (and
// Firefox) advertise a=max-message-size:1073741823, and a probe that wrote a
// frame of that negotiated size saw Write accept it and the message never
// arrive. The budget is therefore clamped by this side's own advertised
// ceiling as well:
//
//	MaxFrameBytes   = min(transport outbound limit, LocalMaxMessageSize)
//	PiecePlainBytes = min(MaxFrameBytes - 21, CHUNK_SIZE)   (linkwire)
//	TextPlainLimit  = min(MaxFrameBytes - 21, 65 536)        (linkwire)
//
// The transport outbound limit is what Pion's SCTP association enforces on
// Write: the peer's a=max-message-size, or 65 535 when the peer omitted it
// (Pion's reading of "absent"; RFC 8841 says 65 536, so Pion is one byte
// stricter, never looser) or advertised 0.
type Budget struct {
	MaxFrameBytes   int64
	PiecePlainBytes int
	TextPlainLimit  int
}

// NewBudget clamps a transport's outbound limit into a frame budget. It fails
// when the result cannot carry the smallest piece link/1 fragments into.
func NewBudget(transportMax uint32, localMax uint32) (Budget, error) {
	if localMax == 0 {
		localMax = LocalMaxMessageSize
	}
	m := int64(min(transportMax, localMax))
	piece, err := linkwire.PiecePlainBytes(m)
	if err != nil {
		return Budget{}, fmt.Errorf("linkrtc: frame budget %d: %w", m, err)
	}
	return Budget{MaxFrameBytes: m, PiecePlainBytes: piece, TextPlainLimit: linkwire.TextPlainLimit(m)}, nil
}

// FitsText reports whether a text plaintext of n bytes may be sealed for this
// link. Text never fragments, so the check happens before Seal.
func (b Budget) FitsText(n int) bool { return n >= 0 && n <= b.TextPlainLimit }
