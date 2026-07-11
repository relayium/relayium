package storecrypto

import (
	"bytes"
	"testing"
)

func TestManifestRoundTrip(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{Files: []FileEntry{{Name: "a.txt", Size: 3}, {Name: "b/c.bin", Size: 5}}}
	ct, err := EncryptManifest(key, m)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecryptManifest(key, ct)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 2 || got.Files[1].Name != "b/c.bin" || got.Files[1].Size != 5 {
		t.Fatalf("bad manifest round-trip: %+v", got)
	}
}

func TestChunkStreamRoundTrip(t *testing.T) {
	key, _ := GenerateKey()
	// three chunks of plaintext across a stream (seq starts at 1)
	parts := [][]byte{bytes.Repeat([]byte("x"), 10), bytes.Repeat([]byte("y"), ChunkSize), []byte("tail")}
	var wire bytes.Buffer
	var seq uint64 = 1
	var total int64
	for _, p := range parts {
		fr, err := FrameChunk(key, seq, p)
		if err != nil {
			t.Fatal(err)
		}
		wire.Write(fr)
		seq++
		total += int64(len(p))
	}
	dec := NewDecryptor(key)
	var out bytes.Buffer
	// feed the wire in awkward slices to exercise frame reassembly
	buf := wire.Bytes()
	for i := 0; i < len(buf); i += 7 {
		end := i + 7
		if end > len(buf) {
			end = len(buf)
		}
		if err := dec.Push(buf[i:end], func(pt []byte) error { out.Write(pt); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if err := dec.End(total); err != nil {
		t.Fatal(err)
	}
	if int64(out.Len()) != total {
		t.Fatalf("got %d bytes, want %d", out.Len(), total)
	}
}

func TestDecryptorRejectsTruncation(t *testing.T) {
	key, _ := GenerateKey()
	fr, _ := FrameChunk(key, 1, []byte("hello"))
	dec := NewDecryptor(key)
	// drop the last 2 bytes → dangling partial frame
	_ = dec.Push(fr[:len(fr)-2], func([]byte) error { return nil })
	if err := dec.End(5); err == nil {
		t.Fatal("expected truncation error, got nil")
	}
}
