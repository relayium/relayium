// Portable framing and record tests.
//
// SCOPE: these prove byte handling and nothing else. No DPAPI call is made
// here, so nothing in this file is evidence about Windows behaviour.
package secretframe

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func requestFrame(t *testing.T, op byte, payload []byte) []byte {
	t.Helper()
	frame, err := EncodeRequest(op, payload)
	if err != nil {
		t.Fatalf("EncodeRequest: %v", err)
	}
	return frame
}

func TestHeaderIsTenBytes(t *testing.T) {
	// Fixed by the protocol root chose: magic(4) version(1) op(1) length(4).
	frame := requestFrame(t, OpSeal, nil)
	if len(frame) != HeaderBytes || HeaderBytes != 10 {
		t.Fatalf("header is %d bytes, want 10", len(frame))
	}
	if string(frame[0:4]) != "RLSQ" || frame[4] != 1 {
		t.Fatalf("unexpected request header % x", frame[0:5])
	}
	response, err := EncodeResponse(StatusOK, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(response[0:4]) != "RLSR" || response[4] != 1 {
		t.Fatalf("unexpected response header % x", response[0:5])
	}
}

func TestRoundTrip(t *testing.T) {
	payload := []byte("secret material")
	request, err := ReadRequest(bytes.NewReader(requestFrame(t, OpSeal, payload)))
	if err != nil {
		t.Fatalf("ReadRequest: %v", err)
	}
	if request.Op != OpSeal || !bytes.Equal(request.Payload, payload) {
		t.Fatalf("round trip lost the request")
	}
}

// Trailing bytes must be a failure. A second request smuggled after the first
// would otherwise sit unread, and a future change that looped would run it.
func TestTrailingBytesAreRefused(t *testing.T) {
	frame := requestFrame(t, OpSeal, []byte("a"))
	stream := append(append([]byte{}, frame...), frame...)
	if _, err := ReadRequest(bytes.NewReader(stream)); !errors.Is(err, ErrTrailing) {
		t.Fatalf("two frames in one stream returned %v, want ErrTrailing", err)
	}
	// One stray byte is the same failure.
	if _, err := ReadRequest(bytes.NewReader(append(append([]byte{}, frame...), 0x00))); !errors.Is(err, ErrTrailing) {
		t.Fatal("a stray trailing byte was accepted")
	}
}

func TestMalformedRequestsAreRefused(t *testing.T) {
	good := requestFrame(t, OpSeal, []byte("abc"))
	cases := map[string][]byte{
		"empty":               {},
		"shorter than header": good[:HeaderBytes-1],
		"wrong magic":         append([]byte("XXXX"), good[4:]...),
		"unknown version":     func() []byte { c := append([]byte{}, good...); c[4] = 2; return c }(),
		"unknown op":          func() []byte { c := append([]byte{}, good...); c[5] = 9; return c }(),
		"truncated payload":   good[:len(good)-1],
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ReadRequest(bytes.NewReader(raw)); err == nil {
				t.Fatal("accepted a malformed request")
			}
		})
	}
}

// The bound is per operation: a seal carries plaintext in, an open carries a
// blob in, and they are different sizes.
func TestPerOperationBounds(t *testing.T) {
	if _, err := EncodeRequest(OpSeal, make([]byte, MaxPlaintextBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatal("a seal above the plaintext bound was encoded")
	}
	if _, err := EncodeRequest(OpOpen, make([]byte, MaxBlobBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatal("an open above the blob bound was encoded")
	}
	// At the bound is legal in both directions.
	if _, err := EncodeRequest(OpSeal, make([]byte, MaxPlaintextBytes)); err != nil {
		t.Fatalf("a seal at the bound was refused: %v", err)
	}
	if _, err := EncodeRequest(OpOpen, make([]byte, MaxBlobBytes)); err != nil {
		t.Fatalf("an open at the bound was refused: %v", err)
	}
}

// The declared length is checked BEFORE anything is sliced, so a lying header
// cannot make this allocate.
func TestOversizeDeclaredLengthIsRefusedWithoutAllocating(t *testing.T) {
	frame := make([]byte, HeaderBytes)
	copy(frame[0:4], []byte("RLSQ"))
	frame[4] = Version
	frame[5] = OpSeal
	binary.BigEndian.PutUint32(frame[6:HeaderBytes], 0xFFFFFFFF)
	if _, err := ReadRequest(bytes.NewReader(frame)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("a 4 GiB declared length returned %v, want ErrTooLarge", err)
	}
}

func TestStreamAboveTheFrameCeilingIsRefused(t *testing.T) {
	// Refused on the magic, before the length is even reached — which is
	// earlier than the old ceiling check and is the point of validating the
	// header first.
	if _, err := ReadRequest(bytes.NewReader(make([]byte, MaxFrameBytes+1))); err == nil {
		t.Fatal("a stream past the frame ceiling was accepted")
	}
}

// countingReader records how much of the stream was actually consumed, so a
// test can prove the payload was never read.
type countingReader struct {
	data []byte
	off  int
	read int
}

func (c *countingReader) Read(p []byte) (int, error) {
	if c.off >= len(c.data) {
		return 0, io.EOF
	}
	n := copy(p, c.data[c.off:])
	c.off += n
	c.read += n
	return n, nil
}

// The header-before-allocation rule, proven by observation rather than by
// comment.
//
// An earlier implementation used io.ReadAll, which drained and grew the whole
// input before looking at the header — so a 4 GiB declared length was refused
// only after the reader had already been consumed.
func TestInvalidDeclaredLengthConsumesNoPayload(t *testing.T) {
	// A header claiming 4 GiB, followed by real bytes that must never be read.
	header := make([]byte, HeaderBytes)
	copy(header[0:4], []byte("RLSQ"))
	header[4] = Version
	header[5] = OpSeal
	binary.BigEndian.PutUint32(header[6:HeaderBytes], 0xFFFFFFFF)
	trailer := bytes.Repeat([]byte("PAYLOAD-THAT-MUST-NOT-BE-READ"), 512)

	reader := &countingReader{data: append(append([]byte{}, header...), trailer...)}
	if _, err := ReadRequest(reader); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("returned %v, want ErrTooLarge", err)
	}
	if reader.read != HeaderBytes {
		t.Fatalf("consumed %d bytes, want exactly the %d-byte header", reader.read, HeaderBytes)
	}
}

func TestUnknownOperationConsumesNoPayload(t *testing.T) {
	header := make([]byte, HeaderBytes)
	copy(header[0:4], []byte("RLSQ"))
	header[4] = Version
	header[5] = 0x7f
	binary.BigEndian.PutUint32(header[6:HeaderBytes], 16)
	reader := &countingReader{data: append(append([]byte{}, header...), bytes.Repeat([]byte("x"), 16)...)}
	if _, err := ReadRequest(reader); err == nil {
		t.Fatal("accepted an unknown operation")
	}
	if reader.read != HeaderBytes {
		t.Fatalf("consumed %d bytes for an unknown op, want %d", reader.read, HeaderBytes)
	}
}

// Buffers that held request material must be wiped on every failure path.
// The buffers are internal, so this observes the wipes rather than the memory.
func TestFailurePathsWipeOwnedBuffers(t *testing.T) {
	payload := []byte("SECRET-REQUEST-MATERIAL-4f21")
	good := requestFrame(t, OpSeal, payload)

	cases := map[string][]byte{
		// Declared length exceeds what follows: the payload buffer is filled
		// partially and must still be wiped.
		"truncated payload": good[:len(good)-4],
		"trailing bytes":    append(append([]byte{}, good...), 0x00),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			var wiped []int
			wipeObserver = func(n int) { wiped = append(wiped, n) }
			defer func() { wipeObserver = nil }()

			if _, err := ReadRequest(bytes.NewReader(raw)); err == nil {
				t.Fatal("accepted a malformed request")
			}
			// The payload buffer is allocated at the DECLARED length, so that is
			// the wipe to look for.
			want := len(payload)
			found := false
			for _, n := range wiped {
				if n == want {
					found = true
				}
			}
			if !found {
				t.Fatalf("the %d-byte payload buffer was not wiped; wipes were %v", want, wiped)
			}
		})
	}
}

func TestSuccessTransfersOnlyTheValidatedPayload(t *testing.T) {
	payload := []byte("exactly this")
	request, err := ReadRequest(bytes.NewReader(requestFrame(t, OpOpen, payload)))
	if err != nil {
		t.Fatal(err)
	}
	if len(request.Payload) != len(payload) || cap(request.Payload) != len(payload) {
		// A slice of a larger buffer would carry bytes the caller never asked
		// for and that nothing would wipe.
		t.Fatalf("payload is len %d cap %d, want both %d",
			len(request.Payload), cap(request.Payload), len(payload))
	}
}

// ---------------------------------------------------------------------------
// The protected inner record
// ---------------------------------------------------------------------------

func TestRecordRoundTrip(t *testing.T) {
	for _, size := range []int{0, 1, 32, 4096, MaxPlaintextBytes} {
		payload := make([]byte, size)
		for i := range payload {
			payload[i] = byte(i * 7)
		}
		record, err := SealRecord(payload)
		if err != nil {
			t.Fatalf("SealRecord(%d): %v", size, err)
		}
		if len(record) != RecordOverheadBytes+size {
			t.Fatalf("record for %d bytes is %d bytes", size, len(record))
		}
		out, err := OpenRecord(record)
		if err != nil {
			t.Fatalf("OpenRecord(%d): %v", size, err)
		}
		if !bytes.Equal(out, payload) {
			t.Fatalf("record round trip lost %d bytes", size)
		}
	}
}

// The reason the record exists: CryptUnprotectData's documented remarks say a
// corrupted blob may fail with varying codes, and that some corruption may
// SUCCEED and return corrupted output. These are the cases a successful
// unprotect would otherwise hand back as plausible plaintext.
func TestRecordRefusesEveryCorruption(t *testing.T) {
	payload := []byte("the quick brown fox")
	good, err := SealRecord(payload)
	if err != nil {
		t.Fatal(err)
	}

	mutate := func(f func([]byte) []byte) []byte { return f(append([]byte{}, good...)) }

	cases := map[string][]byte{
		"flipped payload byte": mutate(func(c []byte) []byte {
			c[len(c)-1] ^= 0x01
			return c
		}),
		"flipped digest byte": mutate(func(c []byte) []byte {
			c[14] ^= 0x01
			return c
		}),
		"wrong domain": mutate(func(c []byte) []byte {
			c[0] ^= 0x01
			return c
		}),
		"wrong version": mutate(func(c []byte) []byte {
			c[8] = 9
			return c
		}),
		"reserved byte set": mutate(func(c []byte) []byte {
			c[9] = 1
			return c
		}),
		"length shorter than payload": mutate(func(c []byte) []byte {
			binary.BigEndian.PutUint32(c[10:14], uint32(len(payload)-1))
			return c
		}),
		"length longer than payload": mutate(func(c []byte) []byte {
			binary.BigEndian.PutUint32(c[10:14], uint32(len(payload)+1))
			return c
		}),
		"truncated record":      good[:len(good)-1],
		"truncated into header": good[:RecordOverheadBytes-1],
		"empty":                 {},
		"appended byte":         append(append([]byte{}, good...), 0x00),
		// A raw DPAPI blob from another producer has no domain of ours.
		"foreign blob": []byte("this is somebody else's protected data padded out to length"),
	}
	for name, record := range cases {
		t.Run(name, func(t *testing.T) {
			if out, err := OpenRecord(record); err == nil {
				t.Fatalf("accepted a corrupted record, returning %d bytes", len(out))
			} else if !errors.Is(err, ErrRecord) {
				t.Fatalf("unexpected error %v", err)
			}
		})
	}
}

// The failure is uniform: which field mismatched is not something a caller
// needs, and reporting it would describe the protected bytes.
func TestRecordFailureIsUniform(t *testing.T) {
	good, err := SealRecord([]byte("abc"))
	if err != nil {
		t.Fatal(err)
	}
	wrongDomain := append([]byte{}, good...)
	wrongDomain[0] ^= 0x01
	wrongDigest := append([]byte{}, good...)
	wrongDigest[14] ^= 0x01
	_, a := OpenRecord(wrongDomain)
	_, b := OpenRecord(wrongDigest)
	if a.Error() != b.Error() {
		t.Fatalf("a domain mismatch and a digest mismatch report differently: %v vs %v", a, b)
	}
}

func TestRecordRefusesOversizePlaintext(t *testing.T) {
	if _, err := SealRecord(make([]byte, MaxPlaintextBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatal("sealed a record above the plaintext bound")
	}
}

func TestZeroWipes(t *testing.T) {
	b := []byte{1, 2, 3, 4}
	Zero(b)
	for i, v := range b {
		if v != 0 {
			t.Fatalf("byte %d survived the wipe: %d", i, v)
		}
	}
}
