package storecrypto

import "testing"

// TestDecryptorConsumedCipherAndReset exercises the resume primitives: after a
// partial feed, ConsumedCipher reports the frame-aligned ciphertext offset, and
// ResetBuffer + feeding from that offset (as a Range-resumed body would)
// continues decryption seamlessly.
func TestDecryptorConsumedCipherAndReset(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	f1, err := FrameChunk(key, 1, []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	f2, err := FrameChunk(key, 2, []byte("world!!"))
	if err != nil {
		t.Fatal(err)
	}
	blob := append(append([]byte{}, f1...), f2...)

	dec := NewDecryptor(key)
	var out []byte
	collect := func(pt []byte) error { out = append(out, pt...); return nil }

	// Feed frame 1 plus 3 bytes of frame 2 (a partial frame left buffered).
	if err := dec.Push(blob[:len(f1)+3], collect); err != nil {
		t.Fatal(err)
	}
	if got := dec.ConsumedCipher(); got != int64(len(f1)) {
		t.Fatalf("ConsumedCipher = %d, want %d (must be frame-aligned)", got, len(f1))
	}
	if string(out) != "hello" {
		t.Fatalf("after frame 1: out = %q", out)
	}

	// Simulate a reconnect: drop the partial and resume from ConsumedCipher,
	// as a `Range: bytes=<offset>-` body would deliver.
	dec.ResetBuffer()
	if err := dec.Push(blob[dec.ConsumedCipher():], collect); err != nil {
		t.Fatal(err)
	}
	if got := dec.ConsumedCipher(); got != int64(len(blob)) {
		t.Fatalf("ConsumedCipher = %d, want %d", got, len(blob))
	}
	if string(out) != "helloworld!!" {
		t.Fatalf("resumed: out = %q", out)
	}
	if err := dec.End(int64(len("helloworld!!"))); err != nil {
		t.Fatalf("End after resume: %v", err)
	}
}
