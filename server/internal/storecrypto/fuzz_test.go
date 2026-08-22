package storecrypto

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// fuzzKey is a fixed, valid 32-byte key. Fixed because the property under test
// is the FRAMING — how Decryptor reassembles frames across arbitrary Push
// boundaries — and a key drawn from fuzz input would spend the budget on
// AES-GCM open failures that prove nothing about it. NewDecryptor takes a key
// its callers have already validated (see its comment), so handing it a short
// one here would be testing a contract violation rather than the decryptor.
var fuzzKey = bytes.Repeat([]byte{0x2a}, 32)

// maxFuzzPlaintext bounds the stream one input may build. Frames can be as
// short as one byte, so the whole plaintext is also the worst-case frame count,
// and Push re-copies its leftover buffer once per call — an unbounded input
// would be quadratic and would spend the fuzz budget on memcpy.
const maxFuzzPlaintext = 8 << 10

// splitSizes cuts n bytes into pieces whose lengths come from layout. Every
// piece is at least one byte, so it terminates for any layout, and an empty
// layout means "one piece" — which is how the one-shot side of the comparison
// below is expressed without a second code path.
func splitSizes(n int, layout []byte) []int {
	if n <= 0 {
		return nil
	}
	if len(layout) == 0 {
		return []int{n}
	}
	var out []int
	for off, i := 0, 0; off < n; i++ {
		size := 1 + int(layout[i%len(layout)])
		if size > n-off {
			size = n - off
		}
		out = append(out, size)
		off += size
	}
	return out
}

// pushResult is everything one Decryptor run observed, so two runs over the
// same stream can be compared field by field.
type pushResult struct {
	emitted  [][]byte
	joined   []byte
	err      error
	consumed int64
	n        int64
}

// feed pushes data in the given pieces and records what the Decryptor reported.
// It also asserts the per-Push invariants that only exist mid-stream: consumed
// ciphertext never goes backwards and never runs ahead of what has been fed.
func feed(t *testing.T, data []byte, pieces []int) pushResult {
	t.Helper()
	d := NewDecryptor(fuzzKey)
	var res pushResult
	var fed, prev int64
	off := 0
	for _, size := range pieces {
		piece := data[off : off+size]
		off += size
		fed += int64(size)
		err := d.Push(piece, func(pt []byte) error {
			res.emitted = append(res.emitted, append([]byte(nil), pt...))
			res.joined = append(res.joined, pt...)
			return nil
		})
		consumed := d.ConsumedCipher()
		if consumed < prev {
			t.Fatalf("ConsumedCipher went backwards: %d then %d", prev, consumed)
		}
		if consumed > fed {
			t.Fatalf("ConsumedCipher is %d after only %d bytes were pushed", consumed, fed)
		}
		prev = consumed
		if err != nil {
			res.err = err
			break
		}
	}
	res.consumed = d.ConsumedCipher()
	res.n = d.DecryptedBytes()
	return res
}

// buildStream seals plaintext into frames of the given lengths, at seq 1…,
// which is exactly what an uploader produces.
func buildStream(t *testing.T, plaintext []byte, lens []int) []byte {
	t.Helper()
	var stream []byte
	off := 0
	for i, n := range lens {
		frame, err := FrameChunk(fuzzKey, uint64(i+1), plaintext[off:off+n])
		if err != nil {
			t.Fatalf("FrameChunk: %v", err)
		}
		stream = append(stream, frame...)
		off += n
	}
	return stream
}

// FuzzDecryptorChunking is the property the resume path depends on: how a
// stream is CUT on its way into Push must not change anything the Decryptor
// reports about it.
//
// A download arrives in whatever pieces the network and the reverse proxy
// produce, and a resumed one arrives in different pieces than the interrupted
// original. If any of the plaintext, the byte counter or the frame-aligned
// ciphertext offset depended on those boundaries, a resumed download would
// request the wrong Range and silently reassemble a corrupt file — the failure
// that is invisible until the user opens it.
func FuzzDecryptorChunking(f *testing.F) {
	f.Add([]byte("hello world"), []byte{4}, []byte{1})
	f.Add([]byte(""), []byte{}, []byte{})
	f.Add(bytes.Repeat([]byte("x"), 600), []byte{0, 255, 7}, []byte{3, 1})
	f.Add([]byte("a"), []byte{0}, []byte{0})

	f.Fuzz(func(t *testing.T, plaintext, frameLayout, pushLayout []byte) {
		if len(plaintext) > maxFuzzPlaintext {
			plaintext = plaintext[:maxFuzzPlaintext]
		}
		frames := splitSizes(len(plaintext), frameLayout)
		stream := buildStream(t, plaintext, frames)

		one := feed(t, stream, splitSizes(len(stream), nil))
		many := feed(t, stream, splitSizes(len(stream), pushLayout))

		for _, c := range []struct {
			label string
			got   pushResult
		}{{"one-shot", one}, {"chunked", many}} {
			if c.got.err != nil {
				t.Fatalf("%s: a stream this test built refused to decrypt: %v", c.label, c.got.err)
			}
			if !bytes.Equal(c.got.joined, plaintext) {
				t.Fatalf("%s: emitted %d bytes of plaintext, want the %d that were sealed", c.label, len(c.got.joined), len(plaintext))
			}
			if c.got.n != int64(len(plaintext)) {
				t.Fatalf("%s: DecryptedBytes = %d, want %d", c.label, c.got.n, len(plaintext))
			}
			// Frame-aligned and complete: a fully-consumed stream leaves no
			// partial frame, so the next Range would start exactly here.
			if c.got.consumed != int64(len(stream)) {
				t.Fatalf("%s: ConsumedCipher = %d, want %d", c.label, c.got.consumed, len(stream))
			}
			// One emit per frame, in order. A decryptor that coalesced or
			// re-ordered frames would still produce the right bytes here and
			// the wrong ones for a caller writing them at an offset.
			if len(c.got.emitted) != len(frames) {
				t.Fatalf("%s: %d emits for %d frames", c.label, len(c.got.emitted), len(frames))
			}
			for i, n := range frames {
				if len(c.got.emitted[i]) != n {
					t.Fatalf("%s: emit %d carried %d bytes, want %d", c.label, i, len(c.got.emitted[i]), n)
				}
			}
		}

		// The whole point: the two chunkings must be indistinguishable.
		if !bytes.Equal(one.joined, many.joined) {
			t.Fatal("push boundaries changed the plaintext")
		}
		if one.n != many.n || one.consumed != many.consumed {
			t.Fatalf("push boundaries changed the counters: (%d,%d) vs (%d,%d)", one.n, one.consumed, many.n, many.consumed)
		}

		// End: the length assertion is the last thing standing between a
		// truncated download and a file the user believes is complete.
		for _, pieces := range [][]int{splitSizes(len(stream), nil), splitSizes(len(stream), pushLayout)} {
			d := NewDecryptor(fuzzKey)
			for off, i := 0, 0; i < len(pieces); i++ {
				if err := d.Push(stream[off:off+pieces[i]], func([]byte) error { return nil }); err != nil {
					t.Fatalf("Push: %v", err)
				}
				off += pieces[i]
			}
			if err := d.End(int64(len(plaintext))); err != nil {
				t.Fatalf("End(%d) on a complete stream: %v", len(plaintext), err)
			}
			if err := d.End(-1); err != nil {
				t.Fatalf("End(-1) skips the length check and must accept: %v", err)
			}
			if err := d.End(int64(len(plaintext)) + 1); err == nil {
				t.Fatal("End accepted a length that does not match what was decrypted")
			}
		}

		// A stream cut one byte short leaves a partial frame, and End is the
		// only thing that can notice.
		if len(stream) > 0 {
			d := NewDecryptor(fuzzKey)
			if err := d.Push(stream[:len(stream)-1], func([]byte) error { return nil }); err != nil {
				t.Fatalf("pushing a truncated stream failed early: %v", err)
			}
			if err := d.End(int64(len(plaintext))); err == nil {
				t.Fatal("End accepted a truncated stream")
			}
		}

		// An emit that fails must abort the Push rather than be swallowed: the
		// real emit writes to disk, and a full disk that reads as success is a
		// silently truncated file.
		if len(frames) > 0 {
			sentinel := errors.New("emit refused")
			d := NewDecryptor(fuzzKey)
			if err := d.Push(stream, func([]byte) error { return sentinel }); !errors.Is(err, sentinel) {
				t.Fatalf("Push returned %v, want the emit's own error", err)
			}
		}
	})
}

// FuzzDecryptorArbitraryStream is the hostile half: the bytes fed to Push come
// off the network, and the 4-byte length prefix in front of every frame is
// attacker-controlled. Nothing here may panic, and the frame bound must be
// enforced before the length is trusted.
func FuzzDecryptorArbitraryStream(f *testing.F) {
	// A real stream, so the fuzzer starts from something that decodes rather
	// than from noise it can only ever make more wrong.
	valid := buildStreamNoT(f, []byte("the quick brown fox"), []int{4, 15})
	f.Add(valid, []byte{3})
	f.Add([]byte{}, []byte{})
	f.Add([]byte{0xff, 0xff, 0xff, 0xff}, []byte{})               // a length past MaxFrameCT
	f.Add([]byte{0x00, 0x00, 0x00, 0x10}, []byte{})               // a complete-looking, unopenable frame
	f.Add(append([]byte{0x00, 0x00, 0x00, 0x40}, 1, 2), []byte{}) // a frame that never arrives

	f.Fuzz(func(t *testing.T, data, pushLayout []byte) {
		d := NewDecryptor(fuzzKey)
		var fed, prev int64
		var emitted int64
		pieces := splitSizes(len(data), pushLayout)
		for off, i := 0, 0; i < len(pieces); i++ {
			piece := data[off : off+pieces[i]]
			off += pieces[i]
			fed += int64(len(piece))
			err := d.Push(piece, func(pt []byte) error {
				emitted += int64(len(pt))
				return nil
			})
			consumed := d.ConsumedCipher()
			if consumed < prev {
				t.Fatalf("ConsumedCipher went backwards: %d then %d", prev, consumed)
			}
			if consumed > fed {
				t.Fatalf("ConsumedCipher is %d after only %d bytes were pushed", consumed, fed)
			}
			prev = consumed
			if d.DecryptedBytes() != emitted {
				t.Fatalf("DecryptedBytes = %d but %d bytes were emitted", d.DecryptedBytes(), emitted)
			}
			if err != nil {
				// A refused stream must stay refusable: pushing more at a
				// decryptor that already failed may not panic.
				_ = d.Push(piece, func([]byte) error { return nil })
				_ = d.End(-1)
				return
			}
		}
		// The buffered-frame bound, checked before the length is believed. An
		// oversized prefix at the head of a complete-enough buffer has to be a
		// refusal, not an allocation.
		if len(data) >= 4 && binary.BigEndian.Uint32(data) > MaxFrameCT {
			t.Fatalf("a %d-byte frame length was accepted; MaxFrameCT is %d", binary.BigEndian.Uint32(data), MaxFrameCT)
		}
		_ = d.End(-1)
		_ = d.End(0)
		// ResetBuffer is what a resumed download calls before feeding a
		// Range-continued body, and afterwards there is by definition no partial
		// frame left — so End must accept what was decrypted so far.
		d.ResetBuffer()
		if err := d.End(d.DecryptedBytes()); err != nil {
			t.Fatalf("End after ResetBuffer refused its own DecryptedBytes: %v", err)
		}
	})
}

// buildStreamNoT is buildStream for a seed, where there is an *testing.F rather
// than a *testing.T to fail on.
func buildStreamNoT(f *testing.F, plaintext []byte, lens []int) []byte {
	f.Helper()
	var stream []byte
	off := 0
	for i, n := range lens {
		frame, err := FrameChunk(fuzzKey, uint64(i+1), plaintext[off:off+n])
		if err != nil {
			f.Fatalf("FrameChunk: %v", err)
		}
		stream = append(stream, frame...)
		off += n
	}
	return stream
}
