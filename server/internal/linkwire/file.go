package linkwire

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"

	"github.com/relayium/relayium/internal/linkcrypto"
)

// ChainSize is the length of the per-file integrity chain.
const ChainSize = sha256.Size

// chainStep is h' = SHA-256(h || chunk). Every file's chain starts at 32 zero
// bytes and advances once per LOGICAL chunk, however many messages carried it.
func chainStep(h [ChainSize]byte, chunk []byte) [ChainSize]byte {
	d := sha256.New()
	d.Write(h[:])
	d.Write(chunk)
	var out [ChainSize]byte
	d.Sum(out[:0])
	return out
}

func sessionKey(key []byte) ([linkcrypto.SessionKeySize]byte, error) {
	var k [linkcrypto.SessionKeySize]byte
	if len(key) != linkcrypto.SessionKeySize {
		return k, ErrInvalidKey
	}
	copy(k[:], key)
	return k, nil
}

// FileSender seals the file lane in one direction under one session key.
//
// Its sequence counter is 64-bit and only ever increases. A sequence number is
// reserved before the frame that carries it is sealed, and is never handed out
// twice: frames lost with a transport burn their numbers. Seq MaxSeq is still
// usable; after it every sealing call fails with ErrSeqExhausted and the
// counter does not wrap. A call that would run out part-way emits nothing and
// reserves nothing.
//
// Not safe for concurrent use. One link owns exactly one FileSender for its
// lifetime, including across batches and authenticated rebuilds.
type FileSender struct {
	key   [linkcrypto.SessionKeySize]byte
	next  uint64
	chain [ChainSize]byte
	// inFile records that the current file has hashed at least one chunk and
	// not yet ended; short, that it hashed a chunk shorter than ChunkSize, which
	// can only be its last, so any further chunk would leave the chain off the
	// grid.
	inFile, short bool
}

// NewFileSender returns a sender for the local send key (SessionKeys.Send). The
// key is copied.
func NewFileSender(sendKey []byte) (*FileSender, error) {
	k, err := sessionKey(sendKey)
	if err != nil {
		return nil, err
	}
	return &FileSender{key: k}, nil
}

// Format prints the sequence position only, for every verb: key and chain are
// plain byte arrays, so without it a %v, %x or %#v of a FileSender would print
// the session key.
func (s FileSender) Format(f fmt.State, _ rune) {
	fmt.Fprintf(f, "linkwire.FileSender{next:%d redacted}", s.next)
}

// NextSeq is the sequence number the next sealed frame will carry.
func (s *FileSender) NextSeq() uint64 { return s.next }

// reserveN checks that n more sequence numbers exist. It reserves nothing.
func (s *FileSender) reserveN(n uint64) error {
	if n == 0 || s.next > MaxSeq || MaxSeq-s.next < n-1 {
		return ErrSeqExhausted
	}
	return nil
}

func (s *FileSender) seal(kind byte, plain []byte) []byte {
	seq := s.next
	s.next++ // reserved before sealing
	ct, err := linkcrypto.Seal(s.key[:], seq, plain)
	if err != nil {
		// Only reachable with an invalid key, which NewFileSender refuses.
		panic("linkwire: seal with a validated key failed")
	}
	return frame(kind, uint32(seq), ct)
}

func pieceCount(n, pieceBytes int) uint64 {
	if n == 0 {
		return 1 // an empty plaintext is still one (final) frame
	}
	return uint64((n + pieceBytes - 1) / pieceBytes)
}

// pieces cuts plain into frames of at most pieceBytes plaintext, the last one
// carrying finalKind and the rest partKind; the caller has reserved the count.
func (s *FileSender) pieces(plain []byte, pieceBytes int, partKind, finalKind byte) [][]byte {
	out := make([][]byte, 0, pieceCount(len(plain), pieceBytes))
	for off := 0; ; {
		end := min(off+pieceBytes, len(plain))
		last := end >= len(plain)
		kind := partKind
		if last {
			kind = finalKind
		}
		out = append(out, s.seal(kind, plain[off:end]))
		if last {
			return out
		}
		off = end
	}
}

// BatchFrames seals a manifest as BATCH_PART… BATCH_ENC at the current
// sequence. The SENDER bound is on the sealed size: a manifest whose plaintext
// plus the 16-byte tag exceeds ManifestMaxBytes is refused before any sequence
// number is spent (compare FileReceiver, which bounds the reassembled
// plaintext).
func (s *FileSender) BatchFrames(files []FileMeta, maxFrameBytes int64) ([][]byte, error) {
	payload, err := EncodeManifest(files)
	if err != nil {
		return nil, err
	}
	if len(payload)+TagSize > ManifestMaxBytes {
		return nil, ErrManifestTooLarge
	}
	pb, err := PiecePlainBytes(maxFrameBytes)
	if err != nil {
		return nil, err
	}
	if err := s.reserveN(pieceCount(len(payload), pb)); err != nil {
		return nil, err
	}
	return s.pieces(payload, pb, KindBatchPart, KindBatchEnc), nil
}

func (s *FileSender) checkChunk(chunk []byte) error {
	if len(chunk) == 0 || len(chunk) > ChunkSize || s.short {
		return ErrInvalidChunk
	}
	return nil
}

func (s *FileSender) hashChunk(chunk []byte) {
	s.chain = chainStep(s.chain, chunk)
	s.inFile = true
	s.short = len(chunk) < ChunkSize
}

// ChunkFrames hashes one logical chunk into the current file's chain and seals
// it as CHUNK_PART… CHUNK. A chunk is 1..ChunkSize bytes, and only a file's
// last chunk may be shorter than ChunkSize. On error nothing is hashed, sealed
// or reserved.
func (s *FileSender) ChunkFrames(chunk []byte, maxFrameBytes int64) ([][]byte, error) {
	if err := s.checkChunk(chunk); err != nil {
		return nil, err
	}
	pb, err := PiecePlainBytes(maxFrameBytes)
	if err != nil {
		return nil, err
	}
	if err := s.reserveN(pieceCount(len(chunk), pb)); err != nil {
		return nil, err
	}
	s.hashChunk(chunk)
	return s.pieces(chunk, pb, KindChunkPart, KindChunk), nil
}

// SkipChunk hashes one logical chunk that a resumed stream does not send. The
// chain covers the whole file from byte 0 even when a resume skips its head,
// so the per-file DONE still describes the whole file.
func (s *FileSender) SkipChunk(chunk []byte) error {
	if err := s.checkChunk(chunk); err != nil {
		return err
	}
	s.hashChunk(chunk)
	return nil
}

// DoneFrame seals the current file's DONE_ENC, {"sha256":"<lower-case hex>"},
// and resets the chain for the next file.
func (s *FileSender) DoneFrame() ([]byte, error) {
	if err := s.reserveN(1); err != nil {
		return nil, err
	}
	f := s.seal(KindDoneEnc, donePayload(s.chain))
	s.chain = [ChainSize]byte{}
	s.inFile, s.short = false, false
	return f, nil
}

func donePayload(chain [ChainSize]byte) []byte {
	b := []byte(`{"sha256":"`)
	b = hex.AppendEncode(b, chain[:])
	return append(b, `"}`...)
}

// AbortBatch resets only the per-file chain, for a batch retired by
// BATCH_ABORT. The sequence deliberately continues.
func (s *FileSender) AbortBatch() {
	s.chain = [ChainSize]byte{}
	s.inFile, s.short = false, false
}

// ResumeStartFrame announces a resumed stream: plaintext RESUME_START carrying
// p and the sequence the first resumed protected frame will carry. It consumes
// no sequence number. Send it immediately before the resumed frames.
func (s *FileSender) ResumeStartFrame(p ResumePoint) ([]byte, error) {
	if s.next > MaxSeq {
		return nil, ErrSeqExhausted
	}
	return resumeStartFrame(ResumeStart{Point: p, Seq: s.next})
}

// FileFrames emits one whole in-memory file: every logical chunk is hashed
// from byte 0, chunks at or after from are sealed, and DONE_ENC follows. from
// must be the file's size or a multiple of ChunkSize. A streaming caller
// composes ChunkFrames, SkipChunk and DoneFrame itself instead.
//
// It starts a file, so it refuses while a file begun with ChunkFrames or
// SkipChunk has not ended. The whole call's sequence need is checked up front,
// so an exhausted sender emits and reserves nothing.
func (s *FileSender) FileFrames(body []byte, from uint64, maxFrameBytes int64) ([][]byte, error) {
	size := uint64(len(body))
	if s.inFile || from > size || (from != size && from%ChunkSize != 0) {
		return nil, ErrInvalidResume
	}
	pb, err := PiecePlainBytes(maxFrameBytes)
	if err != nil {
		return nil, err
	}
	if err := s.reserveN(fileSeqNeed(size, from, pb)); err != nil {
		return nil, err
	}
	var out [][]byte
	for off := uint64(0); off < size; off += ChunkSize {
		chunk := body[off:min(off+ChunkSize, size)]
		s.hashChunk(chunk)
		if off >= from {
			out = append(out, s.pieces(chunk, pb, KindChunkPart, KindChunk)...)
		}
	}
	done, _ := s.DoneFrame() // capacity reserved above
	return append(out, done), nil
}

// fileSeqNeed is how many sequence numbers FileFrames spends: every sent
// chunk's pieces plus the DONE.
func fileSeqNeed(size, from uint64, pb int) uint64 {
	need := uint64(1)
	for off := uint64(0); off < size; off += ChunkSize {
		if off >= from {
			need += pieceCount(int(min(size-off, ChunkSize)), pb)
		}
	}
	return need
}

// DataFrames emits a batch's files after its manifest, as the Web sender does.
// With resume set, files before resume.Index are skipped entirely and file
// resume.Index restarts at resume.Offset, which must be in range and aligned.
// The whole batch's sequence need is checked first, so an exhausted sender
// emits and reserves nothing.
func (s *FileSender) DataFrames(bodies [][]byte, resume *ResumePoint, maxFrameBytes int64) ([][]byte, error) {
	start := ResumePoint{}
	if resume != nil {
		sizes := make([]uint64, len(bodies))
		for i, b := range bodies {
			sizes[i] = uint64(len(b))
		}
		if !ResumeInRange(*resume, sizes) || !ResumeAligned(*resume, sizes) {
			return nil, ErrInvalidResume
		}
		start = *resume
	}
	if s.inFile {
		return nil, ErrInvalidResume
	}
	pb, err := PiecePlainBytes(maxFrameBytes)
	if err != nil {
		return nil, err
	}
	var need uint64
	for i := start.Index; i < uint64(len(bodies)); i++ {
		from := uint64(0)
		if i == start.Index {
			from = start.Offset
		}
		need += fileSeqNeed(uint64(len(bodies[i])), from, pb)
	}
	if need > 0 {
		if err := s.reserveN(need); err != nil {
			return nil, err
		}
	}
	var out [][]byte
	for i := start.Index; i < uint64(len(bodies)); i++ {
		from := uint64(0)
		if i == start.Index {
			from = start.Offset
		}
		frames, err := s.FileFrames(bodies[i], from, maxFrameBytes)
		if err != nil {
			// Unreachable: alignment, piece size and capacity were checked above.
			panic("linkwire: pre-checked FileFrames failed: " + err.Error())
		}
		out = append(out, frames...)
	}
	return out, nil
}

// FileEventKind is what a protected frame produced.
type FileEventKind int

const (
	// EventPart: a non-final piece was authenticated and buffered.
	EventPart FileEventKind = iota
	// EventManifest: a complete, validated, display-sanitised manifest.
	EventManifest
	// EventChunk: one complete logical chunk, already folded into the chain.
	EventChunk
	// EventDone: a file ended; Verified reports whether its DONE hash matched.
	EventDone
)

// FileEvent is the result of feeding one protected frame.
type FileEvent struct {
	Kind     FileEventKind
	Manifest []FileMeta
	Chunk    []byte
	Verified bool
}

// FileReceiver opens the file lane in one direction under one session key.
//
// It enforces seq == expected on every protected frame, authenticates each
// piece, reassembles PART pieces into the logical unit before hashing or
// parsing, keeps the per-file chain, and refuses the legacy kinds. The expected
// sequence advances only after a frame authenticates, and never moves
// backwards. After ANY error the receiver is failed and refuses every further
// call: each of these errors is a lane failure (the peer counted the frame, so
// skipping it strands the sequence).
//
// It does not decide WHEN a frame is allowed. Content before consent, a
// RESUME_START nobody asked for, and bytes beyond a file's declared size are
// the lane's decisions; it must not feed a frame this receiver should not see.
//
// Not safe for concurrent use. One link owns exactly one FileReceiver.
type FileReceiver struct {
	key       [linkcrypto.SessionKeySize]byte
	expected  uint64
	chain     [ChainSize]byte
	parts     [][]byte
	partBytes int
	partKind  byte
	failed    error
}

// NewFileReceiver returns a receiver for the local recv key
// (SessionKeys.Recv). The key is copied.
func NewFileReceiver(recvKey []byte) (*FileReceiver, error) {
	k, err := sessionKey(recvKey)
	if err != nil {
		return nil, err
	}
	return &FileReceiver{key: k}, nil
}

// Format prints the sequence position only, for every verb, so no formatting of
// a FileReceiver reaches its session key, its chain or the authenticated
// plaintext pieces it is buffering.
func (r FileReceiver) Format(f fmt.State, _ rune) {
	fmt.Fprintf(f, "linkwire.FileReceiver{expected:%d redacted}", r.expected)
}

// ExpectedSeq is the sequence number the next protected frame must carry.
func (r *FileReceiver) ExpectedSeq() uint64 { return r.expected }

// Failed reports the error that failed the receiver, or nil.
func (r *FileReceiver) Failed() error { return r.failed }

// SnapshotChain returns a copy of the current file's running chain, to be
// checkpointed next to the bytes durably written for it.
func (r *FileReceiver) SnapshotChain() [ChainSize]byte { return r.chain }

// AbortBatch handles an ordered BATCH_ABORT: only the per-file chain and any
// partial fragments are reset. The sequence deliberately continues.
func (r *FileReceiver) AbortBatch() {
	r.chain = [ChainSize]byte{}
	r.dropParts()
}

// ResumeAt restores a checkpointed chain (copied, exactly ChainSize bytes) and
// aligns the expected sequence to a sender's announced resume seq. The
// sequence may skip forward over burned numbers but may never move backwards —
// that would make an old ciphertext valid again — and must fit the wire field.
// Partial fragments from the dead transport are discarded.
func (r *FileReceiver) ResumeAt(chain []byte, seq uint64) error {
	if r.failed != nil {
		return ErrReceiverFailed
	}
	if len(chain) != ChainSize {
		return ErrInvalidResume
	}
	if seq < r.expected {
		return ErrSeqRewind
	}
	if seq > MaxSeq {
		return ErrInvalidResume
	}
	copy(r.chain[:], chain)
	r.expected = seq
	r.dropParts()
	return nil
}

func (r *FileReceiver) dropParts() {
	r.parts, r.partBytes, r.partKind = nil, 0, 0
}

func (r *FileReceiver) fail(err error) (FileEvent, error) {
	r.failed = err
	r.dropParts()
	return FileEvent{}, err
}

// Feed consumes one protected frame (ClassifyFileFrame == ClassProtected). Any
// other frame fails the receiver. The RECEIVER manifest bound is on the
// reassembled plaintext (at most ManifestMaxBytes and 50 pieces), as on the Web
// and Android; compare FileSender.BatchFrames, which bounds plaintext + tag.
func (r *FileReceiver) Feed(f []byte) (FileEvent, error) {
	if r.failed != nil {
		return FileEvent{}, ErrReceiverFailed
	}
	if len(f) < HeaderSize {
		return r.fail(ErrMalformedFrame)
	}
	kind := f[0]
	switch kind {
	case KindBatchLegacy, KindDoneLegacy:
		return r.fail(ErrLegacyPeer)
	case KindChunk, KindChunkPart, KindBatchEnc, KindBatchPart, KindDoneEnc:
	default:
		return r.fail(ErrUnroutable)
	}
	if r.expected > MaxSeq {
		return r.fail(ErrSeqExhausted)
	}
	if uint64(binary.BigEndian.Uint32(f[1:HeaderSize])) != r.expected {
		return r.fail(ErrOutOfOrder)
	}
	plain, err := linkcrypto.Open(r.key[:], r.expected, f[HeaderSize:])
	if err != nil {
		return r.fail(ErrOpen)
	}
	r.expected++

	switch kind {
	case KindChunkPart:
		if err := r.addPart(kind, plain, ChunkSize); err != nil {
			return r.fail(err)
		}
		return FileEvent{Kind: EventPart}, nil
	case KindBatchPart:
		if err := r.addPart(kind, plain, ManifestMaxBytes); err != nil {
			return r.fail(err)
		}
		return FileEvent{Kind: EventPart}, nil
	case KindBatchEnc:
		whole, err := r.joinParts(KindBatchPart, plain, ManifestMaxBytes)
		if err != nil {
			return r.fail(err)
		}
		files, err := DecodeManifest(whole)
		if err != nil {
			return r.fail(err)
		}
		return FileEvent{Kind: EventManifest, Manifest: files}, nil
	case KindChunk:
		whole, err := r.joinParts(KindChunkPart, plain, ChunkSize)
		if err != nil {
			return r.fail(err)
		}
		r.chain = chainStep(r.chain, whole)
		return FileEvent{Kind: EventChunk, Chunk: whole}, nil
	default: // KindDoneEnc
		// A file cannot end in the middle of a chunk. "Buffered" means a piece
		// exists, not that its bytes are non-zero.
		if len(r.parts) > 0 {
			return r.fail(ErrFileEndedMidChunk)
		}
		verified, err := verifyDone(plain, r.chain)
		if err != nil {
			return r.fail(err)
		}
		r.chain = [ChainSize]byte{}
		return FileEvent{Kind: EventDone, Verified: verified}, nil
	}
}

// addPart buffers one non-final piece. Three bounds, because bytes alone bound
// nothing: an empty non-final piece is refused (no conforming sender emits
// one), the piece COUNT is capped at limit/MinPieceBytes (48 for a chunk, 50
// for a manifest), and the byte total is capped at limit. PART kinds may not
// interleave.
func (r *FileReceiver) addPart(kind byte, plain []byte, limit int) error {
	if r.partKind != 0 && r.partKind != kind {
		return ErrFragment
	}
	if len(plain) == 0 {
		return ErrFragment
	}
	if len(r.parts)+1 > limit/MinPieceBytes {
		return ErrFragment
	}
	if r.partBytes+len(plain) > limit {
		return ErrFragment
	}
	r.partKind = kind
	r.parts = append(r.parts, plain)
	r.partBytes += len(plain)
	return nil
}

// joinParts completes a logical unit. The byte bound is checked BEFORE the
// nothing-buffered shortcut: it bounds the logical unit, not the
// fragmentation, so one oversized unfragmented terminal frame is refused too.
func (r *FileReceiver) joinParts(partKind byte, tail []byte, limit int) ([]byte, error) {
	if r.partKind != 0 && r.partKind != partKind {
		return nil, ErrFragment
	}
	if r.partBytes+len(tail) > limit {
		return nil, ErrFragment
	}
	if len(r.parts) == 0 {
		return tail, nil
	}
	out := make([]byte, 0, r.partBytes+len(tail))
	for _, p := range r.parts {
		out = append(out, p...)
	}
	out = append(out, tail...)
	r.dropParts()
	return out, nil
}

// verifyDone reads {"sha256": "<hex>"} and compares it, exactly and in lower
// case, with the chain. A missing or non-string sha256 is "not verified", as on
// the Web; a payload that is not a JSON object fails the lane.
func verifyDone(plain []byte, chain [ChainSize]byte) (bool, error) {
	fields, ok, err := jsonObject(plain)
	if err != nil || !ok {
		return false, ErrMalformedDone
	}
	got, ok := jsonString(fields["sha256"])
	if !ok {
		return false, nil
	}
	return got == hex.EncodeToString(chain[:]), nil
}
