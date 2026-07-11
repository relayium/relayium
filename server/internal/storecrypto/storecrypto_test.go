package storecrypto

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
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

func TestGenerateInteropVector(t *testing.T) {
	if testing.Short() {
		t.Skip()
	}
	// Fixed key so the vector is stable across runs.
	key, err := DecodeKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") // 32 zero bytes
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{Files: []FileEntry{{Name: "hello.txt", Size: 11}}}
	mct, _ := EncryptManifest(key, m)
	fr, _ := FrameChunk(key, 1, []byte("hello world"))
	vec := map[string]any{
		"keyB64Url":         EncodeKey(key),
		"manifestCtB64Std":  base64.StdEncoding.EncodeToString(mct),
		"chunkFramesB64Std": base64.StdEncoding.EncodeToString(fr),
		"plaintext":         "hello world",
	}
	b, _ := json.MarshalIndent(vec, "", "  ")
	if err := os.WriteFile("testdata/vector.json", b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInteropVectorRoundTrip(t *testing.T) {
	raw, err := os.ReadFile("testdata/vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vec struct {
		KeyB64Url         string `json:"keyB64Url"`
		ManifestCtB64Std  string `json:"manifestCtB64Std"`
		ChunkFramesB64Std string `json:"chunkFramesB64Std"`
		Plaintext         string `json:"plaintext"`
	}
	if err := json.Unmarshal(raw, &vec); err != nil {
		t.Fatal(err)
	}
	key, err := DecodeKey(vec.KeyB64Url)
	if err != nil {
		t.Fatal(err)
	}
	mct, _ := base64.StdEncoding.DecodeString(vec.ManifestCtB64Std)
	m, err := DecryptManifest(key, mct)
	if err != nil || len(m.Files) != 1 || m.Files[0].Name != "hello.txt" {
		t.Fatalf("manifest decrypt: %v %+v", err, m)
	}
	frames, _ := base64.StdEncoding.DecodeString(vec.ChunkFramesB64Std)
	dec := NewDecryptor(key)
	var out []byte
	if err := dec.Push(frames, func(pt []byte) error { out = append(out, pt...); return nil }); err != nil {
		t.Fatal(err)
	}
	if err := dec.End(int64(len(vec.Plaintext))); err != nil {
		t.Fatal(err)
	}
	if string(out) != vec.Plaintext {
		t.Fatalf("got %q want %q", out, vec.Plaintext)
	}
}
