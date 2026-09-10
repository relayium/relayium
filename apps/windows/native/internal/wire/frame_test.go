// Portable transport tests.
//
// SCOPE: these prove framing, bounds and codec behaviour. They prove NOTHING
// about Windows filesystem semantics — no publication, no reparse refusal, no
// handle pinning, no cleanup. Those live in internal/winio and are provable only
// on a real Windows host.
package wire

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func frameBytes(t *testing.T, kind byte, payload []byte) []byte {
	t.Helper()
	buf, err := EncodeFrame(kind, payload)
	if err != nil {
		t.Fatalf("EncodeFrame: %v", err)
	}
	return buf
}

func TestReadFrameRoundTrip(t *testing.T) {
	in := frameBytes(t, KindRequest, []byte(`{"id":1,"op":"cancel"}`))
	f, err := NewReader(bytes.NewReader(in)).ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if f.Kind != KindRequest || string(f.Payload) != `{"id":1,"op":"cancel"}` {
		t.Fatalf("round trip mismatch: kind=%d payload=%q", f.Kind, f.Payload)
	}
}

func TestReadFrameCleanEOFAtBoundary(t *testing.T) {
	_, err := NewReader(bytes.NewReader(nil)).ReadFrame()
	if !errors.Is(err, io.EOF) {
		t.Fatalf("want io.EOF at a clean boundary, got %v", err)
	}
}

// A stream that stops mid-frame is a different event from a stream that ends
// cleanly: one means the parent finished with us, the other means it died
// mid-message, and the serve loop settles them differently.
func TestReadFrameTruncatedIsUnexpectedEOF(t *testing.T) {
	full := frameBytes(t, KindRequest, []byte(`{"id":1,"op":"cancel"}`))
	for _, cut := range []int{1, 3, 5, len(full) - 1} {
		_, err := NewReader(bytes.NewReader(full[:cut])).ReadFrame()
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("cut at %d: want ErrUnexpectedEOF, got %v", cut, err)
		}
	}
}

func TestReadFrameRejectsZeroLength(t *testing.T) {
	var raw [5]byte
	binary.BigEndian.PutUint32(raw[:4], 0)
	raw[4] = KindRequest
	_, err := NewReader(bytes.NewReader(raw[:])).ReadFrame()
	if CodeOf(err) != CodeProtocol {
		t.Fatalf("want E_PROTOCOL for zero length, got %v", err)
	}
}

// The bound must be enforced from the header alone. If this ever regressed into
// allocating first, a four byte header would become a multi-gigabyte allocation.
func TestReadFrameRejectsOversizeWithoutAllocating(t *testing.T) {
	var raw [5]byte
	binary.BigEndian.PutUint32(raw[:4], MaxFrameBytes+1)
	raw[4] = KindRequest
	r := NewReader(bytes.NewReader(raw[:]))
	if _, err := r.ReadFrame(); CodeOf(err) != CodeProtocol {
		t.Fatalf("want E_PROTOCOL, got %v", err)
	}
	if cap(r.buf) > MaxFrameBytes {
		t.Fatalf("reader allocated %d bytes for a rejected frame", cap(r.buf))
	}
}

func TestReadFrameRejectsUnknownKind(t *testing.T) {
	raw := make([]byte, 6)
	binary.BigEndian.PutUint32(raw[:4], 2)
	raw[4] = 99
	raw[5] = 0
	if _, err := NewReader(bytes.NewReader(raw)).ReadFrame(); CodeOf(err) != CodeProtocol {
		t.Fatalf("want E_PROTOCOL for unknown kind, got %v", err)
	}
}

func TestReadFrameRejectsShortChunkHeader(t *testing.T) {
	for _, n := range []int{0, 1, ChunkHeaderBytes - 1} {
		in := frameBytes(t, KindChunk, make([]byte, n))
		if _, err := NewReader(bytes.NewReader(in)).ReadFrame(); CodeOf(err) != CodeProtocol {
			t.Fatalf("payload of %d bytes: want E_PROTOCOL, got %v", n, err)
		}
	}
}

func TestReadFrameRejectsOversizeChunk(t *testing.T) {
	in := frameBytes(t, KindChunk, make([]byte, ChunkHeaderBytes+MaxChunkBytes+1))
	if _, err := NewReader(bytes.NewReader(in)).ReadFrame(); CodeOf(err) != CodeProtocol {
		t.Fatalf("want E_PROTOCOL for oversize chunk, got %v", err)
	}
}

// The reader reuses one buffer, so a consumer that keeps a payload across reads
// would silently observe the next frame's bytes. The serve loop copies; this
// pins the aliasing behaviour the copy exists for.
func TestReadFramePayloadAliasesScratchBuffer(t *testing.T) {
	var stream bytes.Buffer
	stream.Write(frameBytes(t, KindRequest, []byte(`{"id":1,"op":"aaaa"}`)))
	stream.Write(frameBytes(t, KindRequest, []byte(`{"id":2,"op":"bbbb"}`)))
	r := NewReader(&stream)
	first, err := r.ReadFrame()
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	held := first.Payload
	if _, err := r.ReadFrame(); err != nil {
		t.Fatalf("second: %v", err)
	}
	if !bytes.Contains(held, []byte("bbbb")) {
		t.Fatal("payload no longer aliases the scratch buffer; the serve loop's copy may now be dead code, or this reader changed contract")
	}
}

func TestChunkRoundTrip(t *testing.T) {
	data := []byte("bytes")
	buf, err := EncodeChunk(ChunkHeader{ID: 7, Index: 3}, data)
	if err != nil {
		t.Fatalf("EncodeChunk: %v", err)
	}
	f, err := NewReader(bytes.NewReader(buf)).ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	h, got, err := DecodeChunk(f.Payload)
	if err != nil {
		t.Fatalf("DecodeChunk: %v", err)
	}
	if h.ID != 7 || h.Index != 3 || string(got) != "bytes" {
		t.Fatalf("chunk round trip mismatch: %+v %q", h, got)
	}
}

// MaxResponseBytes is enforced, not documented. This is the guarantee that lets
// the publish receipt bound hold for a 1000 file manifest.
func TestEncodeResponseEnforcesBound(t *testing.T) {
	huge, err := json.Marshal(strings.Repeat("x", MaxResponseBytes*2))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	buf, err := EncodeResponse(Response{ID: 1, OK: true, Result: huge})
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}
	if len(buf) > MaxResponseBytes+5 {
		t.Fatalf("oversize response escaped the bound: %d bytes", len(buf))
	}
	var resp Response
	if err := json.Unmarshal(buf[5:], &resp); err != nil {
		t.Fatalf("fallback is not parseable: %v", err)
	}
	if resp.OK || resp.Code != CodeResponseTooLarge {
		t.Fatalf("want a bounded E_RESPONSE_TOO_LARGE failure, got %+v", resp)
	}
}

func TestDecodeRequestAppliesPerOpLimits(t *testing.T) {
	// A cancel gets the small allowance even though the frame ceiling is far
	// larger; otherwise a peer could send a multi-megabyte cancel.
	padded := `{"id":1,"op":"cancel","root":"` + strings.Repeat("p", MaxRequestBytes) + `"}`
	if _, err := DecodeRequest([]byte(padded)); CodeOf(err) != CodeProtocol {
		t.Fatalf("want E_PROTOCOL for oversize cancel, got %v", err)
	}
	// An open of the same size is within its own, larger allowance.
	open := `{"id":1,"op":"open","root":"` + strings.Repeat("p", MaxRequestBytes) + `"}`
	if _, err := DecodeRequest([]byte(open)); err != nil {
		t.Fatalf("open within MaxOpenRequestBytes was refused: %v", err)
	}
}

func TestDecodeRequestRejectsMalformed(t *testing.T) {
	cases := map[string]string{
		"not json":      `{`,
		"unknown field": `{"id":1,"op":"cancel","surprise":true}`,
		"zero id":       `{"id":0,"op":"cancel"}`,
		"wrong id type": `{"id":"one","op":"cancel"}`,
		"invalid utf8":  "{\"id\":1,\"op\":\"\xff\xfe\"}",
	}
	for name, payload := range cases {
		if _, err := DecodeRequest([]byte(payload)); err == nil {
			t.Fatalf("%s: expected refusal", name)
		}
	}
}

// ReadFrame must leave no chunk frame that DecodeChunk can reject on LENGTH.
//
// This is the demonstration behind a claim serve relies on: the reader validates
// chunk shape before admitting a frame, and it needs to know which failures are
// already impossible by then. DecodeChunk has exactly one length failure
// (payload shorter than the header) and ReadFrame refuses that case itself, so
// the only thing the reader's own check adds is the correlation id rule.
//
// Every length around both boundaries is swept rather than argued about, so a
// change to either bound that opened a gap between them would fail here.
func TestReadFrameLeavesNoDecodableChunkFailure(t *testing.T) {
	lengths := []int{0, 1, ChunkHeaderBytes - 1, ChunkHeaderBytes,
		ChunkHeaderBytes + 1, ChunkHeaderBytes + MaxChunkBytes,
		ChunkHeaderBytes + MaxChunkBytes + 1}

	for _, payloadLen := range lengths {
		payload := make([]byte, payloadLen)
		// A non-zero id everywhere, so a rejection can only be about length.
		if payloadLen >= 8 {
			payload[7] = 1
		}
		raw := frameBytes(t, KindChunk, payload)

		r := NewReader(bytes.NewReader(raw))
		frame, readErr := r.ReadFrame()
		if readErr != nil {
			continue // ReadFrame refused it; DecodeChunk is never reached.
		}
		if _, _, err := DecodeChunk(frame.Payload); err != nil {
			t.Fatalf("payload of %d bytes: ReadFrame accepted a frame DecodeChunk then rejected (%v). "+
				"serve's reader relies on these two bounds agreeing", payloadLen, err)
		}
	}
}

// The correlation id rule, which is the part ReadFrame does NOT cover.
func TestDecodeChunkRefusesAZeroID(t *testing.T) {
	buf, err := EncodeChunk(ChunkHeader{ID: 0, Index: 1}, []byte("data"))
	if err != nil {
		t.Fatal(err)
	}
	// EncodeChunk produces the payload; strip the frame header the reader adds.
	if _, _, err := DecodeChunk(buf[5:]); CodeOf(err) != CodeProtocol {
		t.Fatalf("a zero-id chunk was accepted: %v", err)
	}
	if _, _, err := DecodeChunk(buf[5:]); err == nil {
		t.Fatal("a zero-id chunk is unanswerable and must be refused")
	}
}
