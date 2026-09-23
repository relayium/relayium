package linkwire

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/linkcrypto"
)

var testKey = bytes.Repeat([]byte{0x42}, 32)

// sealed builds a protected frame by hand, independently of FileSender, so the
// receiver can be fed frames no conforming sender would produce.
func sealed(t *testing.T, kind byte, seq uint32, plain []byte) []byte {
	t.Helper()
	ct, err := linkcrypto.Seal(testKey, uint64(seq), plain)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]byte, HeaderSize, HeaderSize+len(ct))
	out[0] = kind
	binary.BigEndian.PutUint32(out[1:], seq)
	return append(out, ct...)
}

func newRecv(t *testing.T) *FileReceiver {
	t.Helper()
	r, err := NewFileReceiver(testKey)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func newSend(t *testing.T) *FileSender {
	t.Helper()
	s, err := NewFileSender(testKey)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// ---- classifier and ACK -------------------------------------------------------

func TestClassifierLengthsAreExact(t *testing.T) {
	ack, _ := AckFrame(7)
	for _, tc := range []struct {
		name  string
		frame []byte
		want  FrameClass
	}{
		{"ack 13", ack, ClassAck},
		{"ack 12", ack[:12], ClassUnroutable},
		{"ack 14", append(append([]byte{}, ack...), 0), ClassUnroutable},
		{"accept then a byte", []byte{CtrlAccept, 0}, ClassUnroutable},
		{"text request on the file lane", []byte{CtrlTextRequest}, ClassUnroutable},
		{"stored keys", []byte{KindStoredKeys, 0, 0, 0, 0}, ClassUnroutable},
		{"text kind", []byte{KindText, 0, 0, 0, 0}, ClassUnroutable},
		{"legacy done", []byte{KindDoneLegacy, 0, 0, 0, 0}, ClassProtected},
		{"resume request header only", []byte{KindResumeReq, 0, 0, 0, 0}, ClassResumeRequest},
	} {
		if got, _ := ClassifyFileFrame(tc.frame); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
	if _, ok := TextLifecycle([]byte{CtrlComplete}); ok {
		t.Error("COMPLETE is not a text control")
	}
	if _, ok := FileLifecycle([]byte{CtrlBusy, CtrlBusy}); ok {
		t.Error("a two-byte frame is not a control")
	}
}

func TestAckEncodingAndAdvance(t *testing.T) {
	if _, err := AckFrame(MaxSafeInteger + 1); !errors.Is(err, ErrInvalidAck) {
		t.Error("an ACK above MaxSafeInteger must be refused")
	}
	f, err := AckFrame(MaxSafeInteger)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := ParseAck(f); !ok || v != MaxSafeInteger {
		t.Errorf("ParseAck = %v, %v", v, ok)
	}
	for _, tc := range []struct {
		name      string
		candidate float64
		want      uint64
	}{
		{"NaN", math.NaN(), 10},
		{"+Inf", math.Inf(1), 10},
		{"-Inf", math.Inf(-1), 10},
		{"fraction", 10.5, 10},
		{"negative zero", math.Copysign(0, -1), 10},
		{"negative", -1, 10},
		{"2^53", 1 << 53, 10},
		{"above sent", 101, 10},
		{"equal to acked", 10, 10},
		{"valid", 50, 50},
		{"exactly sent", 100, 100},
	} {
		if got := AdvanceAck(10, 100, tc.candidate); got != tc.want {
			t.Errorf("%s: AdvanceAck = %d, want %d", tc.name, got, tc.want)
		}
	}
	// No credit beyond a sent count that is itself beyond the safe range.
	if got := AdvanceAck(0, 1<<60, 1<<53); got != 0 {
		t.Errorf("an unsafe candidate advanced to %d", got)
	}
}

func TestPiecePlainBytesBounds(t *testing.T) {
	for _, max := range []int64{math.MinInt64, -1, 0, MinPieceBytes + ChunkOverhead - 1} {
		if _, err := PiecePlainBytes(max); !errors.Is(err, ErrPieceTooSmall) {
			t.Errorf("PiecePlainBytes(%d) accepted", max)
		}
	}
	if pb, _ := PiecePlainBytes(math.MaxInt64); pb != ChunkSize {
		t.Errorf("an unlimited-sized connection gets %d", pb)
	}
	if TextPlainLimit(math.MinInt64) != 0 || TextPlainLimit(math.MaxInt64) != TextMaxBytes {
		t.Error("TextPlainLimit extremes")
	}
}

// ---- resume codecs ------------------------------------------------------------

func TestResumeParsingNumbersAndBounds(t *testing.T) {
	start := func(payload string) []byte { return append([]byte{KindResumeStart, 0, 0, 0, 0}, payload...) }
	req := func(payload string) []byte { return append([]byte{KindResumeReq, 0, 0, 0, 0}, payload...) }
	for _, tc := range []struct {
		payload string
		want    ResumeStart
		ok      bool
	}{
		{`{"index":0,"offset":0,"seq":4294967295}`, ResumeStart{Seq: MaxSeq}, true},
		{`{"index":0,"offset":0,"seq":4294967296}`, ResumeStart{}, false},
		// JSON spellings of safe integers, accepted exactly as the Web does.
		{`{"index":1e0,"offset":1.0e3,"seq":-0}`, ResumeStart{Point: ResumePoint{Index: 1, Offset: 1000}}, true},
		{`{"index":0,"offset":0,"seq":1.5}`, ResumeStart{}, false},
		{`{"index":-1,"offset":0,"seq":0}`, ResumeStart{}, false},
		{`{"index":0,"offset":9007199254740992,"seq":0}`, ResumeStart{}, false},
		{`{"index":0,"offset":9007199254740991,"seq":0}`, ResumeStart{Point: ResumePoint{Offset: MaxSafeInteger}}, true},
		{`{"index":0,"offset":1e400,"seq":0}`, ResumeStart{}, false},
		{`{"index":"0","offset":0,"seq":0}`, ResumeStart{}, false},
		{`{"index":0,"offset":0}`, ResumeStart{}, false},
		{`{"INDEX":0,"index":null,"offset":0,"seq":0}`, ResumeStart{}, false},
		{`{"index":5,"index":0,"offset":0,"seq":0}`, ResumeStart{}, true}, // last duplicate wins, as JSON.parse
		{`[0,0,0]`, ResumeStart{}, false},
		{`{`, ResumeStart{}, false},
		{``, ResumeStart{}, false},
	} {
		got, err := ParseResumeStart(start(tc.payload))
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("RESUME_START %s: %+v, %v", tc.payload, got, err)
		}
	}
	if _, err := ParseResumeReq(req(`{"index":0,"offset":-5}`)); err == nil {
		t.Error("a negative offset must be refused")
	}
	if p, err := ParseResumeReq(req(`{"offset":2,"index":1,"extra":true}`)); err != nil || p != (ResumePoint{1, 2}) {
		t.Errorf("key order and extra keys: %+v %v", p, err)
	}
	if _, err := ParseResumeReq([]byte{KindResumeStart, 0, 0, 0, 0}); err == nil {
		t.Error("wrong kind accepted")
	}
	if _, err := resumeStartFrame(ResumeStart{Seq: MaxSeq + 1}); err == nil {
		t.Error("an announcement past the wire field was encoded")
	}
	if _, err := ResumeReqFrame(ResumePoint{Index: MaxSafeInteger + 1}); err == nil {
		t.Error("an unsafe index was encoded")
	}
}

// ---- sender sequence ----------------------------------------------------------

func TestFileSenderSequenceNeverWraps(t *testing.T) {
	s := newSend(t)
	s.next = MaxSeq
	f, err := s.ChunkFrames([]byte("last"), 65536)
	if err != nil || len(f) != 1 || binary.BigEndian.Uint32(f[0][1:5]) != MaxSeq {
		t.Fatalf("seq MaxSeq must still be usable: %v", err)
	}
	if s.NextSeq() != MaxSeq+1 {
		t.Fatalf("NextSeq = %d", s.NextSeq())
	}
	s.AbortBatch()
	if f, err := s.ChunkFrames([]byte("more"), 65536); !errors.Is(err, ErrSeqExhausted) || f != nil {
		t.Fatal("a sender past MaxSeq sealed another frame")
	}
	if _, err := s.DoneFrame(); !errors.Is(err, ErrSeqExhausted) {
		t.Fatal("DONE after exhaustion")
	}
	if _, err := s.ResumeStartFrame(ResumePoint{}); !errors.Is(err, ErrSeqExhausted) {
		t.Fatal("RESUME_START announced an unusable sequence")
	}
	if s.NextSeq() != MaxSeq+1 {
		t.Fatal("a refused call moved the counter")
	}
}

func TestFileSenderRefusalSpendsNothing(t *testing.T) {
	s := newSend(t)
	s.next = MaxSeq // one number left, and this chunk needs two pieces
	chainBefore := s.chain
	if f, err := s.ChunkFrames(make([]byte, 8000), 4117); !errors.Is(err, ErrSeqExhausted) || f != nil {
		t.Fatalf("partial emission: %v", err)
	}
	if s.NextSeq() != MaxSeq || s.chain != chainBefore {
		t.Fatal("a refused chunk was hashed or reserved")
	}
	if f, err := s.FileFrames(make([]byte, 10), 0, 65536); !errors.Is(err, ErrSeqExhausted) || f != nil {
		t.Fatal("a file needing chunk+DONE fit in one number")
	}
	if _, err := s.DataFrames([][]byte{{1}, {2}}, nil, 65536); !errors.Is(err, ErrSeqExhausted) || s.NextSeq() != MaxSeq {
		t.Fatal("a batch that cannot finish started")
	}

	s = newSend(t)
	huge := []FileMeta{{Name: strings.Repeat("a", MaxNameBytes), Size: 1}}
	for len(huge) < 200 {
		huge = append(huge, huge[0])
	}
	if f, err := s.BatchFrames(huge, 65536); !errors.Is(err, ErrManifestTooLarge) || f != nil || s.NextSeq() != 0 {
		t.Fatalf("oversized manifest: %v, next %d", err, s.NextSeq())
	}
	if _, err := s.BatchFrames([]FileMeta{{Name: "a"}}, 4116); !errors.Is(err, ErrPieceTooSmall) || s.NextSeq() != 0 {
		t.Fatal("a too-small connection spent a number")
	}
}

func TestFileSenderChunkGrid(t *testing.T) {
	s := newSend(t)
	for _, bad := range [][]byte{nil, make([]byte, ChunkSize+1)} {
		if _, err := s.ChunkFrames(bad, 65536); !errors.Is(err, ErrInvalidChunk) {
			t.Errorf("chunk of %d bytes accepted", len(bad))
		}
	}
	if _, err := s.ChunkFrames(make([]byte, 100), 65536); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChunkFrames(make([]byte, 100), 65536); !errors.Is(err, ErrInvalidChunk) {
		t.Error("a chunk after a short chunk would leave the grid")
	}
	if err := s.SkipChunk(make([]byte, 1)); !errors.Is(err, ErrInvalidChunk) {
		t.Error("SkipChunk after a short chunk")
	}
	if _, err := s.DoneFrame(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChunkFrames(make([]byte, 100), 65536); err != nil {
		t.Error("DONE did not start a new file")
	}
	for _, from := range []uint64{1, ChunkSize - 1, ChunkSize + 1} {
		if _, err := newSend(t).FileFrames(make([]byte, 2*ChunkSize+5), from, 65536); !errors.Is(err, ErrInvalidResume) {
			t.Errorf("unaligned resume offset %d accepted", from)
		}
	}
	if _, err := newSend(t).DataFrames([][]byte{{1}}, &ResumePoint{Index: 1}, 65536); !errors.Is(err, ErrInvalidResume) {
		t.Error("resume past the last file accepted")
	}
	// A whole-file call may not continue a chain a streamed file left open.
	s = newSend(t)
	if _, err := s.ChunkFrames(make([]byte, ChunkSize), 65536); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FileFrames([]byte{1}, 0, 65536); !errors.Is(err, ErrInvalidResume) {
		t.Error("FileFrames started a file while another was open")
	}
	if _, err := s.DataFrames([][]byte{{1}}, nil, 65536); !errors.Is(err, ErrInvalidResume) {
		t.Error("DataFrames started a file while another was open")
	}
	s.AbortBatch()
	if _, err := s.FileFrames([]byte{1}, 0, 65536); err != nil {
		t.Errorf("after BATCH_ABORT: %v", err)
	}
	var zero PeerCaps
	if !zero.Record("p", sig(t, `{"caps":["link/1"]}`)) || !zero.SupportsLink("p") {
		t.Error("the zero PeerCaps is not usable")
	}
}

// ---- receiver reassembly bounds -----------------------------------------------

func expectFail(t *testing.T, r *FileReceiver, frame []byte, want error) {
	t.Helper()
	if _, err := r.Feed(frame); !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
	if _, err := r.Feed(frame); !errors.Is(err, ErrReceiverFailed) {
		t.Fatal("a failed receiver accepted another frame")
	}
}

func TestReceiverBoundBeforeShortcut(t *testing.T) {
	// No PART at all: one authenticated terminal CHUNK one byte over the
	// logical unit. The bound must hold even with nothing buffered.
	expectFail(t, newRecv(t), sealed(t, KindChunk, 0, make([]byte, ChunkSize+1)), ErrFragment)
	expectFail(t, newRecv(t), sealed(t, KindBatchEnc, 0, make([]byte, ManifestMaxBytes+1)), ErrFragment)
	// Exactly the unit is fine.
	if ev, err := newRecv(t).Feed(sealed(t, KindChunk, 0, make([]byte, ChunkSize))); err != nil || len(ev.Chunk) != ChunkSize {
		t.Fatalf("a full chunk: %v", err)
	}
}

func TestReceiverPieceCountAndBytes(t *testing.T) {
	// 48 real 4096-byte pieces plus an empty terminal CHUNK is one exact chunk.
	r := newRecv(t)
	for i := range 48 {
		if _, err := r.Feed(sealed(t, KindChunkPart, uint32(i), make([]byte, MinPieceBytes))); err != nil {
			t.Fatalf("piece %d: %v", i, err)
		}
	}
	if ev, err := r.Feed(sealed(t, KindChunk, 48, nil)); err != nil || len(ev.Chunk) != ChunkSize {
		t.Fatalf("terminal: %v", err)
	}

	// The COUNT bound, isolated from the byte bound by one-byte pieces.
	r = newRecv(t)
	for i := range 48 {
		if _, err := r.Feed(sealed(t, KindChunkPart, uint32(i), []byte{1})); err != nil {
			t.Fatalf("piece %d: %v", i, err)
		}
	}
	expectFail(t, r, sealed(t, KindChunkPart, 48, []byte{1}), ErrFragment)

	r = newRecv(t)
	for i := range 50 {
		if _, err := r.Feed(sealed(t, KindBatchPart, uint32(i), []byte{' '})); err != nil {
			t.Fatalf("manifest piece %d: %v", i, err)
		}
	}
	expectFail(t, r, sealed(t, KindBatchPart, 50, []byte{' '}), ErrFragment)

	// The byte bound on the buffered pieces and on the tail.
	r = newRecv(t)
	for i := range 47 {
		if _, err := r.Feed(sealed(t, KindChunkPart, uint32(i), make([]byte, MinPieceBytes))); err != nil {
			t.Fatal(err)
		}
	}
	expectFail(t, r, sealed(t, KindChunk, 47, make([]byte, MinPieceBytes+1)), ErrFragment)
}

func TestReceiverFragmentShapes(t *testing.T) {
	expectFail(t, newRecv(t), sealed(t, KindChunkPart, 0, nil), ErrFragment) // empty non-final piece

	r := newRecv(t)
	r.Feed(sealed(t, KindChunkPart, 0, []byte{1}))
	expectFail(t, r, sealed(t, KindBatchPart, 1, []byte{1}), ErrFragment) // interleaved PART kinds

	r = newRecv(t)
	r.Feed(sealed(t, KindBatchPart, 0, []byte{'{'}))
	expectFail(t, r, sealed(t, KindChunk, 1, []byte{1}), ErrFragment) // a CHUNK ends a manifest

	r = newRecv(t)
	r.Feed(sealed(t, KindChunkPart, 0, []byte{1}))
	expectFail(t, r, sealed(t, KindDoneEnc, 1, []byte(`{"sha256":"x"}`)), ErrFileEndedMidChunk)
}

func TestReceiverSequenceAndAuth(t *testing.T) {
	expectFail(t, newRecv(t), sealed(t, KindChunk, 1, []byte{1}), ErrOutOfOrder)
	tampered := sealed(t, KindChunk, 0, []byte{1, 2, 3})
	tampered[len(tampered)-1] ^= 1
	r := newRecv(t)
	expectFail(t, r, tampered, ErrOpen)
	if r.ExpectedSeq() != 0 {
		t.Error("a frame that did not authenticate advanced the sequence")
	}
	// The header seq is in the nonce: rewriting it is an auth failure too.
	moved := sealed(t, KindChunk, 0, []byte{1})
	moved[4] = 1
	r = newRecv(t)
	r.ResumeAt(make([]byte, 32), 1)
	expectFail(t, r, moved, ErrOpen)

	expectFail(t, newRecv(t), sealed(t, KindBatchLegacy, 0, []byte{1}), ErrLegacyPeer)
	expectFail(t, newRecv(t), []byte{KindDoneLegacy, 9, 9, 9, 9}, ErrLegacyPeer)
	for _, k := range []byte{0, KindResumeStart, KindResumeReq, KindAck, KindText, KindStoredKeys, 13} {
		expectFail(t, newRecv(t), sealed(t, k, 0, []byte{1}), ErrUnroutable)
	}
	expectFail(t, newRecv(t), []byte{KindChunk, 0, 0, 0}, ErrMalformedFrame)
}

func TestReceiverSequenceExhaustion(t *testing.T) {
	r := newRecv(t)
	if err := r.ResumeAt(make([]byte, 32), MaxSeq); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Feed(sealed(t, KindChunk, MaxSeq, []byte{1})); err != nil {
		t.Fatalf("seq MaxSeq: %v", err)
	}
	// Nothing after MaxSeq can be accepted, including a frame whose header
	// would read as a wrapped zero.
	expectFail(t, r, sealed(t, KindChunk, 0, []byte{1}), ErrSeqExhausted)
}

func TestResumeAtNeverRewinds(t *testing.T) {
	r := newRecv(t)
	r.Feed(sealed(t, KindChunk, 0, []byte{1}))
	if err := r.ResumeAt(make([]byte, 32), 0); !errors.Is(err, ErrSeqRewind) {
		t.Error("ResumeAt moved the sequence backwards")
	}
	if err := r.ResumeAt(make([]byte, 32), MaxSeq+1); err == nil {
		t.Error("ResumeAt past the wire field")
	}
	if err := r.ResumeAt(make([]byte, 31), 5); err == nil {
		t.Error("a short chain was accepted")
	}
	chain := bytes.Repeat([]byte{7}, 32)
	if err := r.ResumeAt(chain, 1); err != nil { // the same number is not a rewind
		t.Fatal(err)
	}
	chain[0] = 0 // the receiver must have copied it
	if got := r.SnapshotChain(); got[0] != 7 {
		t.Error("ResumeAt kept the caller's slice")
	}
	// A resume drops partial fragments from the dead transport.
	r.Feed(sealed(t, KindChunkPart, 1, []byte{1}))
	if err := r.ResumeAt(make([]byte, 32), 10); err != nil {
		t.Fatal(err)
	}
	if ev, err := r.Feed(sealed(t, KindDoneEnc, 10, []byte(`{"sha256":"`+strings.Repeat("0", 64)+`"}`))); err != nil || !ev.Verified {
		t.Errorf("parts survived a resume: %v", err)
	}
}

func TestAbortBatchKeepsSequence(t *testing.T) {
	r := newRecv(t)
	r.Feed(sealed(t, KindChunk, 0, []byte("abc")))
	r.Feed(sealed(t, KindChunkPart, 1, []byte{1}))
	r.AbortBatch()
	if r.ExpectedSeq() != 2 || r.SnapshotChain() != [32]byte{} {
		t.Fatal("BATCH_ABORT must reset the chain and fragments, never the sequence")
	}
	if ev, err := r.Feed(sealed(t, KindDoneEnc, 2, []byte(`{"sha256":"`+strings.Repeat("0", 64)+`"}`))); err != nil || !ev.Verified {
		t.Errorf("after abort: %v", err)
	}
}

func TestDonePayloads(t *testing.T) {
	zero := strings.Repeat("0", 64)
	for _, tc := range []struct {
		payload  string
		verified bool
		ok       bool
	}{
		{`{"sha256":"` + zero + `"}`, true, true},
		{`{"sha256":"` + strings.ToUpper("a"+zero[1:]) + `"}`, false, true},
		{`{"sha256":"` + strings.Repeat("A", 64) + `"}`, false, true}, // exact lower-case compare
		{`{}`, false, true},
		{`{"sha256":5}`, false, true},
		{`{"SHA256":"` + zero + `"}`, false, true}, // keys are exact
		{`[]`, false, false},
		{`"x"`, false, false},
		{`{`, false, false},
		{"{\"sha256\":\"\xff\"}", false, false},
	} {
		ev, err := newRecv(t).Feed(sealed(t, KindDoneEnc, 0, []byte(tc.payload)))
		if (err == nil) != tc.ok || ev.Verified != tc.verified {
			t.Errorf("DONE %q: verified=%v err=%v", tc.payload, ev.Verified, err)
		}
	}
}

// ---- manifest -----------------------------------------------------------------

func TestManifestDecodeIsExactAndFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		ok   bool
	}{
		{"minimal", `{"files":[{"name":"a","size":0}]}`, true},
		{"numeric spellings", `{"files":[{"name":"a","size":1e3},{"name":"b","size":2.0},{"name":"c","size":-0}]}`, true},
		{"fraction", `{"files":[{"name":"a","size":0.5}]}`, false},
		{"negative", `{"files":[{"name":"a","size":-1}]}`, false},
		{"unsafe size", `{"files":[{"name":"a","size":9007199254740992}]}`, false},
		{"unsafe total", `{"files":[{"name":"a","size":9007199254740991},{"name":"b","size":1}]}`, false},
		{"string size", `{"files":[{"name":"a","size":"1"}]}`, false},
		{"case-variant name key", `{"files":[{"NAME":"a","size":0}]}`, false},
		{"case-variant files key", `{"FILES":[{"name":"a","size":0}]}`, false},
		{"null path", `{"files":[{"name":"a","size":0,"path":null}]}`, false},
		{"numeric path", `{"files":[{"name":"a","size":0,"path":1}]}`, false},
		{"empty path", `{"files":[{"name":"a","size":0,"path":""}]}`, true},
		{"null name", `{"files":[{"name":null,"size":0}]}`, false},
		{"entry not an object", `{"files":["a"]}`, false},
		{"files not an array", `{"files":{"name":"a","size":0}}`, false},
		{"top level array", `[{"name":"a","size":0}]`, false},
		{"duplicate key, last wins valid", `{"files":[{"name":"a","size":-1,"size":1}]}`, true},
		{"duplicate key, last wins invalid", `{"files":[{"name":"a","size":1,"size":-1}]}`, false},
		{"invalid UTF-8", "{\"files\":[{\"name\":\"a\xffb\",\"size\":0}]}", false},
		{"lone high surrogate escape", `{"files":[{"name":"a\ud800","size":0}]}`, false},
		{"lone low surrogate escape", `{"files":[{"name":"a\udc00","size":0}]}`, false},
		{"reversed pair", `{"files":[{"name":"\udc00\ud800","size":0}]}`, false},
		{"valid surrogate pair", `{"files":[{"name":"\ud83c\udf0d","size":0}]}`, true},
		{"escaped backslash then u", `{"files":[{"name":"\\ud800","size":0}]}`, true},
		{"trailing junk", `{"files":[{"name":"a","size":0}]}x`, false},
	} {
		_, err := DecodeManifest([]byte(tc.body))
		if (err == nil) != tc.ok {
			t.Errorf("%s: err=%v, want ok=%v", tc.name, err, tc.ok)
		}
	}
	if _, err := DecodeManifest(make([]byte, ManifestMaxBytes+1)); !errors.Is(err, ErrManifestTooLarge) {
		t.Error("an oversized plaintext reached the parser")
	}
}

func TestManifestSanitisesAfterValidating(t *testing.T) {
	// A raw U+202E in the JSON text and an escaped U+0007 (a raw C0 byte is
	// not valid JSON at all).
	rlo := "\u202e"
	body := `{"files":[{"name":"` + rlo + `","size":0,"path":"a` + rlo + `/\u0007b/\u0007"}]}`
	files, err := DecodeManifest([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	// A name that sanitises to nothing was validated as non-empty first; the
	// cleaned value is a display value, not a filesystem path.
	if files[0].Name != "" || files[0].Path != "a/b/" || !files[0].HasPath {
		t.Errorf("sanitised %+v", files[0])
	}
	all := "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u0000\u001f\u007f\u0085\u009f"
	if got := SanitizeDisplayName("x" + all + "y\u00a0\u2028z"); got != "xy\u00a0\u2028z" {
		t.Errorf("SanitizeDisplayName = %q", got)
	}
	// A raw 1024-byte name that is all controls is accepted, then emptied; a
	// raw 1025-byte one is refused before any cleaning.
	if _, err := DecodeManifest([]byte(`{"files":[{"name":"` + strings.Repeat(`\u0001`, 1025) + `","size":0}]}`)); err == nil {
		t.Error("the length bound ran after sanitising")
	}
}

func TestManifestEncodingIsJavaScriptJSON(t *testing.T) {
	name := "<>&\u2028\u2029\u007f\u0085\U0001F30D\"\\\b\t\n\f\r\u0001\u001f"
	b, err := EncodeManifest([]FileMeta{{Name: name, Size: 3, Path: "", HasPath: true}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"files":[{"name":"<>&` + "\u2028\u2029\u007f\u0085\U0001F30D" + `\"\\\b\t\n\f\r\u0001\u001f","size":3,"path":""}]}`
	if string(b) != want {
		t.Errorf("EncodeManifest =\n%s\nwant\n%s", b, want)
	}
	// encoding/json's default would escape <, >, & and U+2028/U+2029 and so
	// change the bytes a manifest seals.
	std, _ := json.Marshal(name)
	if bytes.Contains(b, std) {
		t.Error("the manifest encoder matches encoding/json's escaping")
	}
	for _, bad := range []FileMeta{
		{Name: ""}, {Name: "a\xff"}, {Name: "a", Path: "\xff", HasPath: true},
		{Name: strings.Repeat("a", MaxNameBytes+1)}, {Name: "a", Size: MaxSafeInteger + 1},
	} {
		if _, err := EncodeManifest([]FileMeta{bad}); err == nil {
			t.Errorf("EncodeManifest accepted %+v", bad)
		}
	}
	if _, err := EncodeManifest([]FileMeta{{Name: "a", Size: MaxSafeInteger}, {Name: "b", Size: 1}}); err == nil {
		t.Error("an unsafe total was encoded")
	}
}

// ---- text ---------------------------------------------------------------------

func textPair(t *testing.T) (*TextSender, *TextReceiver) {
	t.Helper()
	s, err := NewTextSender(testKey)
	if err != nil {
		t.Fatal(err)
	}
	r, err := NewTextReceiver(testKey)
	if err != nil {
		t.Fatal(err)
	}
	return s, r
}

func TestTextPreservesBytes(t *testing.T) {
	s, r := textPair(t)
	for _, body := range []string{"", " ", "\x00", "a\r\n\tb\n", "e\u0301", "\ufeffleading BOM", "\ufeff", "\U0001F30D", strings.Repeat("\u00e9", TextMaxBytes/2)} {
		f, err := s.Seal([]byte(body))
		if err != nil {
			t.Fatalf("%q: %v", body, err)
		}
		got, err := r.Open(f)
		if err != nil || got != body {
			t.Errorf("%q came back as %q (%v)", body, got, err)
		}
	}
}

func TestTextRefusalsBurnNothing(t *testing.T) {
	s, _ := textPair(t)
	if _, err := s.Seal(make([]byte, TextMaxBytes+1)); !errors.Is(err, ErrTextTooLarge) {
		t.Error("an oversized message was sealed")
	}
	if _, err := s.Seal([]byte("a\xffb")); !errors.Is(err, ErrInvalidUTF8) {
		t.Error("invalid UTF-8 was sealed")
	}
	if _, err := s.Seal([]byte("\xed\xa0\x80")); !errors.Is(err, ErrInvalidUTF8) {
		t.Error("an encoded surrogate was sealed")
	}
	if s.NextSeq() != 0 {
		t.Fatal("a refused message burned a sequence number")
	}
	s.next = MaxSeq
	if _, err := s.Seal([]byte("last")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Seal([]byte("wrap")); !errors.Is(err, ErrSeqExhausted) {
		t.Fatal("the text counter wrapped")
	}
}

func TestTextReceiverAdvancesOnlyOnAuthentication(t *testing.T) {
	s, r := textPair(t)
	good, _ := s.Seal([]byte("hello"))
	bad := bytes.Clone(good)
	bad[len(bad)-1] ^= 1
	if _, err := r.Open(bad); !errors.Is(err, ErrOpen) || r.ExpectedSeq() != 0 {
		t.Fatal("a tampered frame advanced the sequence")
	}
	if _, err := r.Open(good[:ChunkOverhead-1]); !errors.Is(err, ErrMalformedFrame) || r.ExpectedSeq() != 0 {
		t.Fatal("a short kind-9 frame")
	}
	next, _ := s.Seal([]byte("second"))
	if _, err := r.Open(next); !errors.Is(err, ErrOutOfOrder) || r.ExpectedSeq() != 0 {
		t.Fatal("an out-of-order frame advanced the sequence")
	}
	if got, err := r.Open(good); err != nil || got != "hello" {
		t.Fatal("the genuine frame at the same number must still open")
	}
	notText := bytes.Clone(next)
	notText[0] = KindChunk
	if _, err := r.Open(notText); !errors.Is(err, ErrUnroutable) {
		t.Error("a non-text kind reached the AEAD")
	}
	huge := make([]byte, ChunkOverhead+TextMaxBytes+1)
	huge[0] = KindText
	binary.BigEndian.PutUint32(huge[1:], 1)
	if _, err := r.Open(huge); !errors.Is(err, ErrTextTooLarge) || r.ExpectedSeq() != 1 {
		t.Error("an oversized text frame")
	}
}

func TestTextInvalidUTF8ConsumesItsNumber(t *testing.T) {
	_, r := textPair(t)
	ct, _ := linkcrypto.Seal(testKey, 0, []byte("a\xffb"))
	f := append([]byte{KindText, 0, 0, 0, 0}, ct...)
	if _, err := r.Open(f); !errors.Is(err, ErrInvalidUTF8) {
		t.Fatalf("invalid UTF-8 opened: %v", err)
	}
	if r.ExpectedSeq() != 1 {
		t.Fatal("an authenticated frame must consume its number even when refused")
	}
	if _, err := r.Open(f); !errors.Is(err, ErrOutOfOrder) {
		t.Error("the refused frame replayed")
	}
}

func TestTextReceiverExhaustion(t *testing.T) {
	s, r := textPair(t)
	s.next, r.expected = MaxSeq, MaxSeq
	f, _ := s.Seal([]byte("x"))
	if _, err := r.Open(f); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Open(f); !errors.Is(err, ErrSeqExhausted) {
		t.Error("a receiver past MaxSeq accepted a frame")
	}
}

// ---- signals ------------------------------------------------------------------

func sig(t *testing.T, raw string) Signal {
	t.Helper()
	s, err := ParseSignal([]byte(raw))
	if err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return s
}

func TestGenerationIsExactTrue(t *testing.T) {
	for raw, want := range map[string]Generation{
		`{"LINK":true}`:              GenerationFile,
		`{"link":1}`:                 GenerationFile,
		`{"link":"true"}`:            GenerationFile,
		`{"link" : true }`:           GenerationLink,
		`{"link":false,"link":true}`: GenerationLink,
		`{"link":true,"link":false}`: GenerationFile,
		`{"resume":1,"link":true}`:   GenerationLink,
		`[{"link":true}]`:            GenerationFile,
		`"link"`:                     GenerationFile,
		`null`:                       GenerationFile,
	} {
		if got := SignalGeneration(sig(t, raw)); got != want {
			t.Errorf("%s: %v, want %v", raw, got, want)
		}
	}
	for _, raw := range []string{`{"link":tru}`, "{\"link\":\"\xff\"}", `{"x":"\ud800"}`, ``, `{} {}`} {
		if _, err := ParseSignal([]byte(raw)); err == nil {
			t.Errorf("%q parsed", raw)
		}
	}
}

func TestLinkOfferAndRequest(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"link":true,"sdp":{"type":"offer"}}`:               true,
		`{"link":true,"sdp":{"type":"OFFER","sdp":""}}`:      false,
		`{"link":true,"sdp":"offer"}`:                        false,
		`{"link":true,"sdp":{"type":["offer"]}}`:             false,
		`{"link":true,"resume":true,"sdp":{"type":"offer"}}`: false,
	} {
		if IsLinkOffer(sig(t, raw)) != want {
			t.Errorf("IsLinkOffer(%s) != %v", raw, want)
		}
	}
	for raw, want := range map[string]bool{
		`{"link":true,"linkRequest":true}`:            true,
		`{"link":true,"linkRequest":true,"sdp":null}`: false,
		`{"link":true,"linkRequest":1}`:               false,
	} {
		if IsLinkRequest(sig(t, raw)) != want {
			t.Errorf("IsLinkRequest(%s) != %v", raw, want)
		}
	}
}

func TestLeaveShapeIsExact(t *testing.T) {
	tag := strings.Repeat("A", 43) + "="
	for raw, want := range map[string]bool{
		`{"link":true,"leave":true,"auth":"` + tag + `"}`:                              true,
		`{"link":true,"leave":true,"auth":"` + tag + `","Link":true}`:                  false, // a case variant is an extra key
		`{"link":true,"leave":true,"auth":"x","auth":"` + tag + `"}`:                   true,  // duplicate collapses, last wins
		`{"link":true,"leave":true,"auth":"` + tag + `","auth":"x"}`:                   false,
		`{"link":true,"leave":true,"AUTH":"` + tag + `"}`:                              false,
		`{"link":true,"leave":1,"auth":"` + tag + `"}`:                                 false,
		`{"link":true,"leave":true,"auth":"` + strings.Repeat("\u00e9", 44) + `"}`:     true, // 44 UTF-16 units, as .length
		`{"link":true,"leave":true,"auth":"` + strings.Repeat("\U0001F30D", 22) + `"}`: true,
		`{"link":true,"leave":true,"auth":"` + strings.Repeat("\U0001F30D", 44) + `"}`: false,
	} {
		if _, ok := LeaveAuth(sig(t, raw)); ok != want {
			t.Errorf("LeaveAuth(%s) = %v", raw, ok)
		}
	}
	// A non-ASCII tag passes the shape and must then fail verification.
	if VerifyLeave(testKey, "a", "b", strings.Repeat("\u00e9", 44)) {
		t.Error("a non-ASCII tag verified")
	}
	if _, err := LeaveSignal(strings.Repeat("\u00e9", 44)); err == nil {
		t.Error("LeaveSignal built a non-ASCII tag")
	}
}

func TestLeavePayloadRefusesInvalidUTF8(t *testing.T) {
	for _, bad := range []string{"\xff", "\xed\xa0\x80"} { // the second is an encoded lone surrogate
		if _, err := LinkLeavePayload(bad, "x"); err == nil {
			t.Errorf("LinkLeavePayload(%q) rendered", bad)
		}
		if _, err := SignLeave(testKey, "x", bad); err == nil {
			t.Error("SignLeave signed invalid UTF-8")
		}
		if VerifyLeave(testKey, bad, "x", strings.Repeat("A", 43)+"=") {
			t.Error("VerifyLeave accepted invalid UTF-8")
		}
	}
	if p, _ := LinkLeavePayload("<&>", "\u2028"); p != `{"kind":"link-leave","from":"<&>","to":"`+"\u2028"+`"}` {
		t.Errorf("payload %q", p)
	}
}

func TestAuthFieldsOfFailsClosed(t *testing.T) {
	for raw, ok := range map[string]bool{
		`{"ice":{"candidate":"c","sdpMLineIndex":1.0}}`:   true,
		`{"ice":{"candidate":"c","sdpMLineIndex":-0}}`:    true,
		`{"ice":{"candidate":"c","sdpMLineIndex":0.5}}`:   false,
		`{"ice":{"candidate":"c","sdpMLineIndex":1e300}}`: false,
		`{"ice":{"candidate":"c","sdpMLineIndex":"0"}}`:   false,
		`{"ice":{"candidate":7}}`:                         false,
		`{"sdp":{"type":5,"sdp":"v=0"}}`:                  false,
		`{"sdp":"v=0"}`:                                   false,
		`{"sdp":null,"ice":null}`:                         true,
		`{"sdp":{"type":"offer"}}`:                        true,
		`{"ice":{"sdpMid":null,"usernameFragment":"u"}}`:  true,
	} {
		f, err := AuthFieldsOf(sig(t, raw))
		if (err == nil) != ok {
			t.Errorf("AuthFieldsOf(%s): %v", raw, err)
			continue
		}
		if ok {
			if _, err := AuthPayload(f); err != nil {
				t.Errorf("AuthPayload after %s: %v", raw, err)
			}
		}
	}
	f, _ := AuthFieldsOf(sig(t, `{"ice":{"candidate":"c","sdpMLineIndex":-0}}`))
	p, _ := AuthPayload(f)
	if !strings.Contains(p, `"sdpMLineIndex":0,`) {
		t.Errorf("-0 rendered as %s", p)
	}
	f, _ = AuthFieldsOf(sig(t, `{"sdp":{"type":"offer"}}`))
	if p, _ := AuthPayload(f); p != `{"sdpType":"offer","sdp":null,"candidate":null,"sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}` {
		t.Errorf("field-by-field rendering %s", p)
	}
	big := int64(MaxSafeInteger + 1)
	if _, err := AuthPayload(AuthFields{SDPMLineIndex: &big}); err == nil {
		t.Error("an unsafe index rendered")
	}
}

func TestConstructedSignalsCarryNoKind(t *testing.T) {
	leave, _ := LeaveSignal(strings.Repeat("A", 43) + "=")
	for _, raw := range [][]byte{RequestSignal(), BusySignal(), leave} {
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		if _, has := m["kind"]; has {
			t.Errorf("%s carries a top-level kind", raw)
		}
		if SignalGeneration(sig(t, string(raw))) != GenerationLink {
			t.Errorf("%s is not on the link generation", raw)
		}
	}
}

func TestLinkRole(t *testing.T) {
	if LinkRole("a", "a") != linkcrypto.Responder {
		t.Error("a self-collision must resolve to responder")
	}
	if LinkRole("0a", "0b") != linkcrypto.Initiator || LinkRole("0b", "0a") != linkcrypto.Responder {
		t.Error("the smaller id initiates")
	}
}

func TestPeerCapsSnapshots(t *testing.T) {
	p := NewPeerCaps()
	if !p.Record("x", sig(t, `{"caps":["link/1",3,null,"text/1",{"a":1}],"relayRtt":{}}`)) {
		t.Fatal("a hello with extra keys is still a hello")
	}
	if got, _ := p.Announced("x"); strings.Join(got, ",") != "link/1,text/1" {
		t.Errorf("non-string entries must be dropped: %v", got)
	}
	got, _ := p.Announced("x")
	got[0] = "mutated"
	if !p.SupportsLink("x") {
		t.Error("Announced returned the registry's own slice")
	}
	for _, raw := range []string{`{"caps":null}`, `{"caps":"link/1"}`, `["link/1"]`, `{"CAPS":[]}`} {
		if p.Record("x", sig(t, raw)) || !p.SupportsLink("x") {
			t.Errorf("%s changed the announcement", raw)
		}
	}
	for _, c := range []string{"LINK/1", "link/2", "link/1 ", ""} {
		if CapsIncludeLink([]string{c}) {
			t.Errorf("%q counted as link/1", c)
		}
	}
	p.Record("x", sig(t, `{"caps":[]}`))
	if p.SupportsLink("x") || p.RecordProvenLink("x", sig(t, `{"link":true}`)) {
		t.Error("an empty snapshot was overruled")
	}
	p.Forget("x")
	if p.RecordProvenLink("x", sig(t, `{"resume":true,"link":true}`)) {
		t.Error("a resume frame is not link proof")
	}
	if !p.RecordProvenLink("x", sig(t, `{"link":true}`)) || !p.SupportsLink("x") {
		t.Error("a forgotten peer is silent again")
	}
}
