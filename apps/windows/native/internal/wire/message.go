// The JSON schema carried inside request, response and event frames.
package wire

import (
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

// Operation names.
const (
	OpOpen    = "open"
	OpBegin   = "begin"
	OpFinish  = "finish"
	OpPublish = "publish"
	OpCancel  = "cancel"
)

// ProtocolVersion is announced in the ready event and must match what the host
// expects. It exists so an architecture or packaging mismatch settles the caller
// with a distinguishable error instead of a silent hang.
const ProtocolVersion = 1

// ManifestEntry mirrors ManifestEntry in src/main/io/plan.ts.
type ManifestEntry struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// Request is any host to helper control message.
type Request struct {
	ID       uint64          `json:"id"`
	Op       string          `json:"op"`
	Root     string          `json:"root,omitempty"`
	Manifest []ManifestEntry `json:"manifest,omitempty"`
	Index    *int            `json:"index,omitempty"`
}

// OpenResult confirms the manifest was independently accepted here.
type OpenResult struct {
	Files       int  `json:"files"`
	Directories int  `json:"directories"`
	LongPath    bool `json:"longPath"`
}

// ChunkResult reports bytes the operating system actually took, never the
// length the caller asked for.
type ChunkResult struct {
	Written  int64 `json:"written"`
	Declared int64 `json:"declared"`
}

// FinishResult confirms the staged file matched its declared length exactly.
type FinishResult struct {
	Bytes int64 `json:"bytes"`
}

// PublishFailure names the single entry that stopped publication.
type PublishFailure struct {
	Index  int    `json:"index"`
	Code   Code   `json:"code"`
	Detail string `json:"detail,omitempty"`
}

// Unattempted is the inclusive index range publication never reached. From > To
// means the range is empty.
type Unattempted struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// PublishResult is deliberately O(1) in the manifest size.
//
// Publication runs in manifest order and stops at the first failure, so the
// published set is always the prefix `0..PublishedCount-1` and never needs to be
// enumerated. That is what lets MaxResponseBytes be an enforced bound rather
// than a hope, and it is why a 1000-file receipt is the same size as a 1-file
// receipt.
//
// The success and failure shapes are distinct on purpose: Status "complete"
// never carries a Failed field, and a partial batch is never `ok: true`. There
// is no way to read a partial result as a full receipt.
type PublishResult struct {
	Status         string          `json:"status"` // "complete" | "partial"
	PublishedCount int             `json:"publishedCount"`
	Total          int             `json:"total"`
	Failed         *PublishFailure `json:"failed,omitempty"`
	Unattempted    *Unattempted    `json:"unattempted,omitempty"`
}

// CancelResult reports what cleanup actually achieved. Residue true means bytes
// were left on the user's disk and the UI must be able to say so.
type CancelResult struct {
	RemovedFiles int  `json:"removedFiles"`
	Residue      bool `json:"residue"`
}

// Response correlates to a Request by ID.
type Response struct {
	ID     uint64          `json:"id"`
	OK     bool            `json:"ok"`
	Code   Code            `json:"code,omitempty"`
	Detail string          `json:"detail,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

// Event is unsolicited helper to host. Only `ready` exists today.
type Event struct {
	Event    string `json:"event"`
	Protocol int    `json:"protocol,omitempty"`
}

// EncodeResponse marshals and enforces MaxResponseBytes.
//
// The bound is enforced here, in one place, rather than reasoned about at each
// call site. An oversize response is replaced by a bounded coded failure: losing
// the detail of one reply is recoverable, whereas emitting a frame the host will
// refuse to parse strands the request forever.
func EncodeResponse(resp Response) ([]byte, error) {
	raw, err := json.Marshal(resp)
	if err != nil {
		return nil, Errf(CodeInternal, "response marshal failed")
	}
	if len(raw) > MaxResponseBytes {
		raw, err = json.Marshal(Response{
			ID:     resp.ID,
			OK:     false,
			Code:   CodeResponseTooLarge,
			Detail: fmt.Sprintf("%d bytes", len(raw)),
		})
		if err != nil {
			return nil, Errf(CodeInternal, "fallback response marshal failed")
		}
	}
	return EncodeFrame(KindResponse, raw)
}

// EncodeEvent renders an event frame under the same response bound.
func EncodeEvent(ev Event) ([]byte, error) {
	raw, err := json.Marshal(ev)
	if err != nil {
		return nil, Errf(CodeInternal, "event marshal failed")
	}
	if len(raw) > MaxResponseBytes {
		return nil, Errf(CodeResponseTooLarge, "event")
	}
	return EncodeFrame(KindEvent, raw)
}

// DecodeRequest parses a request payload under the size rule that applies to it.
//
// The `open` request carries the manifest and gets a much larger allowance than
// every other operation, which are all a few integers. Applying the generous
// limit uniformly would let a peer send a 4 MiB `cancel`.
func DecodeRequest(payload []byte) (Request, error) {
	// JSON is defined as UTF-8 (RFC 8259), and Go's decoder does not enforce it:
	// it silently substitutes U+FFFD for invalid bytes. For a manifest name that
	// substitution is not cosmetic — it would create a file whose name differs
	// from the one the sender declared, which is the kind of quiet rewrite this
	// boundary refuses everywhere else. So the encoding is checked before the
	// decoder can paper over it.
	if !utf8.Valid(payload) {
		return Request{}, Errf(CodeProtocol, "request is not valid UTF-8")
	}
	// Rejected on length before the probe parses it, so the largest allowance
	// bounds the work done for a request that cannot be accepted under any op.
	if len(payload) > MaxOpenRequestBytes {
		return Request{}, Errf(CodeProtocol, fmt.Sprintf("request of %d bytes exceeds %d", len(payload), MaxOpenRequestBytes))
	}
	var probe struct {
		Op string `json:"op"`
	}
	// The op is needed to choose the limit, so the payload is inspected before
	// it is fully parsed. Both parses are over the same already-bounded frame.
	if err := json.Unmarshal(payload, &probe); err != nil {
		return Request{}, Errf(CodeProtocol, "request is not valid JSON")
	}
	limit := MaxRequestBytes
	if probe.Op == OpOpen {
		limit = MaxOpenRequestBytes
	}
	if len(payload) > limit {
		// The op is used to CHOOSE the limit and is never echoed. It is
		// arbitrary host-supplied text: it can be enormous, and it can be made
		// to look like a path. This detail reaches stderr, so it carries the
		// numeric bounds and nothing the peer authored.
		return Request{}, Errf(CodeProtocol, fmt.Sprintf("request of %d bytes exceeds %d", len(payload), limit))
	}
	var req Request
	dec := json.NewDecoder(newBytesReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return Request{}, Errf(CodeProtocol, "request has unexpected shape")
	}
	if req.ID == 0 {
		return Request{}, Errf(CodeProtocol, "request id must be non-zero")
	}
	// The op and its required fields are validated HERE, at the boundary that
	// already owns strict decoding, rather than in the dispatcher.
	//
	// This placement is load-bearing for shutdown. The main loop must not START
	// a queued operation once shutdown is known, but a malformed frame must
	// still produce a non-zero exit — and those two rules conflict if the only
	// way to notice a violation is to dispatch it. Validating on READ resolves
	// it: a frame still sitting in the queue at teardown was already judged, so
	// it can be dropped without executing anything and without losing the
	// failure.
	//
	// The details below carry no host-authored text. The op is arbitrary: it can
	// be enormous and it can be made to look like a path.
	switch req.Op {
	case OpOpen, OpPublish, OpCancel:
	case OpBegin, OpFinish:
		if req.Index == nil {
			return Request{}, Errf(CodeProtocol, "request omits the required index")
		}
	default:
		return Request{}, Errf(CodeProtocol, "request names an operation this protocol does not define")
	}
	return req, nil
}
