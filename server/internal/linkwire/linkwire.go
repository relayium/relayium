// Package linkwire is the Go implementation of the `link/1` wire vocabulary:
// the file-lane and text-lane frame codecs, the total frame-class partition,
// the manifest, resume and ACK codecs, and the pure signalling and capability
// classifiers. It is byte-pinned to docs/protocol/relayium-link-v1.md,
// relayium-realtime-wire-v1.md and relayium-text-v1.md, and to the shared
// vectors in apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json that the
// Web, Swift and Android suites also read.
//
// # What this package is not
//
// It is a codec library, not a connection. It owns no transport, timer, consent
// gate, handshake order, leave budget, text-session bound or lifecycle state
// machine; those belong to a later layer (W-N18 Phase 2a3). In particular:
//
//   - Nothing imports it. The relayium CLI keeps its own separate wire, and
//     passing this package's vectors says nothing about whether any Go program
//     interoperates with another client over a network.
//   - It builds no roster hello and announces no capability. A future Go
//     composition that uses it may announce `link/1` only, and only once it has
//     handlers for both lanes.
//   - A codec accepting a frame is not proof that the frame was allowed at that
//     moment: whether content arrived before consent, whether the bytes written
//     exceed a file's declared size, and whether a RESUME_START was asked for
//     are decisions of the layer that owns the lane.
//   - A sanitised manifest name or path is a display value, not a safe
//     filesystem path. Nothing here opens, creates or writes a file.
//
// The constants in timing.go (deadlines, cadence, leave budget, text-session
// bounds, flow window, capture and held-signal caps) are values only. Nothing
// in this package enforces them.
//
// # Concurrency and key lifetime
//
// FileSender, FileReceiver, TextSender, TextReceiver and PeerCaps are stateful
// and not safe for concurrent use; the caller serialises every call on one
// value. The caller also owns key uniqueness: one link owns exactly one
// instance of each codec for its lifetime (link §5.5), a new batch or an
// authenticated rebuild reuses it, and constructing a second one under a key
// that has already sealed frames reuses nonces.
//
// Each codec formats as its type and sequence position only, under every fmt
// verb, so its key and any buffered plaintext stay out of logs and errors. fmt
// cannot call that method on a value reached through an unexported field of
// another struct; a composition holding a codec in one must not print that
// struct with fmt.
//
// # Deliberate differences from the shipped peers
//
// Recorded rather than silently resolved. Each is at least as strict as the
// Web and never widens what is accepted from a conforming peer.
//
//   - Untrusted JSON must be valid UTF-8 and may not contain an unpaired
//     UTF-16 surrogate escape. The Web decodes such input with replacement or
//     keeps the lone surrogate; this package refuses it instead of claiming
//     byte-preserving parity after a replacement.
//   - A RESUME_START announcing seq >= 2^32 is refused, per the realtime-wire
//     document (link §12.1); the Web accepts it and then stalls.
//   - A DONE payload must be a JSON object. A missing or non-string `sha256` is
//     "not verified" exactly as on the Web.
//   - Generation tags, `isLinkOffer` included, are matched as exact JSON
//     `true` (spec §4.1 and Swift); the Web uses JavaScript truthiness.
//   - A link request is recognised only when the `sdp` key is absent (Swift);
//     the Web also treats a falsy `sdp` such as null as absent.
//   - AuthPayload renders field by field like the Web, but refuses a present
//     non-null field of the wrong JSON type, or a non-integral or unsafe
//     `sdpMLineIndex`, so a verifier fails closed rather than rendering it.
//   - The text receiver refuses a frame whose plaintext would exceed
//     TextMaxBytes before opening it; the Web receiver has no such check.
//
// Text is returned byte for byte, including a leading U+FEFF, as the spec
// requires. That is not a difference: the Web decodes text with ignoreBOM and
// keeps the BOM too.
package linkwire

import "errors"

// Frame kinds on the file lane (relayium-realtime-wire-v1.md §Kinds) and the
// text lane's content kind.
const (
	KindChunk       byte = 1
	KindDoneLegacy  byte = 2 // refused: a peer on an older wire, never parsed
	KindBatchLegacy byte = 3 // refused: a peer on an older wire, never parsed
	KindResumeStart byte = 4
	KindResumeReq   byte = 5
	KindAck         byte = 6
	KindBatchEnc    byte = 7
	KindDoneEnc     byte = 8
	KindText        byte = 9
	KindChunkPart   byte = 10
	KindBatchPart   byte = 11
	// KindStoredKeys is the pre-upload handoff. This package does not implement
	// `preupload/1`, so a kind-12 frame classifies as unroutable (link §6.1).
	KindStoredKeys byte = 12
)

// One-byte lifecycle controls (link §6.2 and §7.1).
const (
	CtrlAccept      byte = 0xfe
	CtrlReject      byte = 0xff
	CtrlComplete    byte = 0xfd
	CtrlBusy        byte = 0xf9
	CtrlBatchAbort  byte = 0xf8
	CtrlTextRequest byte = 0xfa
	CtrlTextEnd     byte = 0xfb
)

// Wire sizes and bounds.
const (
	HeaderSize = 5  // [kind][uint32 BE seq]
	TagSize    = 16 // AES-GCM tag
	// ChunkOverhead is the per-message overhead of a sealed frame.
	ChunkOverhead = HeaderSize + TagSize
	// ChunkSize is the LOGICAL unit: what the integrity chain hashes, what a
	// receiver writes and checkpoints, and therefore where a resume point lands.
	// It never varies with the connection.
	ChunkSize = 192 * 1024
	// MinPieceBytes is the smallest plaintext piece a sender will fragment into.
	MinPieceBytes = 4096
	// ManifestMaxBytes bounds a manifest in two places, deliberately differently:
	// a sender refuses a manifest whose plaintext plus the 16-byte tag exceeds it
	// (the sealed bytes must fit), and a receiver refuses a reassembled plaintext
	// that exceeds it. See FileSender.BatchFrames and FileReceiver.Feed.
	ManifestMaxBytes = 200 * 1024
	MaxFiles         = 1000
	// MaxNameBytes bounds both a manifest name and a manifest path, in UTF-8 bytes.
	MaxNameBytes = 1024
	// TextMaxBytes is the product cap on one message's plaintext, in UTF-8 bytes.
	TextMaxBytes = 64 * 1024
	// AckFrameSize is the exact length of an ACK frame.
	AckFrameSize = 13
	// MaxSeq is the largest sequence number the uint32 wire field can carry.
	MaxSeq = 1<<32 - 1
	// MaxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER, the bound on every
	// size, total, index, offset and ACK value.
	MaxSafeInteger = 1<<53 - 1
	// LinkAuthTagLength is the base64 length of a leave or resume tag.
	LinkAuthTagLength = 44
)

// Capability is the only capability string this protocol recognises, matched
// by byte equality.
const Capability = "link/1"

// ChannelLabels is the exact lane tuple, primary first.
var ChannelLabels = [2]string{"relayium", "relayium-text"}

var (
	ErrMalformedFrame    = errors.New("linkwire: malformed frame")
	ErrUnroutable        = errors.New("linkwire: frame kind is not routable on this lane")
	ErrLegacyPeer        = errors.New("linkwire: peer is running an older version")
	ErrOutOfOrder        = errors.New("linkwire: frame sequence is not the expected one")
	ErrOpen              = errors.New("linkwire: frame did not authenticate")
	ErrSeqExhausted      = errors.New("linkwire: sequence space exhausted")
	ErrSeqRewind         = errors.New("linkwire: sequence may not move backwards")
	ErrFragment          = errors.New("linkwire: invalid fragmentation")
	ErrManifestTooLarge  = errors.New("linkwire: manifest too large")
	ErrInvalidManifest   = errors.New("linkwire: invalid manifest")
	ErrInvalidResume     = errors.New("linkwire: invalid resume point")
	ErrInvalidChunk      = errors.New("linkwire: invalid logical chunk")
	ErrInvalidUTF8       = errors.New("linkwire: not valid UTF-8")
	ErrTextTooLarge      = errors.New("linkwire: message too large")
	ErrPieceTooSmall     = errors.New("linkwire: maximum message size is too small to send files")
	ErrInvalidAck        = errors.New("linkwire: invalid ACK value")
	ErrInvalidJSON       = errors.New("linkwire: invalid JSON")
	ErrInvalidSignal     = errors.New("linkwire: invalid signal field")
	ErrInvalidKey        = errors.New("linkwire: invalid key")
	ErrReceiverFailed    = errors.New("linkwire: file receiver already failed")
	ErrMalformedDone     = errors.New("linkwire: malformed DONE payload")
	ErrFileEndedMidChunk = errors.New("linkwire: file ended in the middle of a chunk")
)
