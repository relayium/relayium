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

// interopVector is the shared shape of the cross-language test vectors. The
// chunk frames concatenate one frame per file at a GLOBAL seq starting at 1
// (manifest is seq 0), so a multi-file vector exercises seq continuity ACROSS a
// file boundary — the property most likely to diverge between the two impls.
type interopVector struct {
	KeyB64Url         string `json:"keyB64Url"`
	ManifestCtB64Std  string `json:"manifestCtB64Std"`
	ChunkFramesB64Std string `json:"chunkFramesB64Std"`
	Plaintext         string `json:"plaintext"`
	Files             []struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	} `json:"files"`
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
	// Two files so the frame stream crosses a file boundary (seq 1 → seq 2) and
	// the vector tests cross-file global-seq continuity, not just one frame.
	f1, f2 := []byte("hello world"), []byte("second-file-payload")
	m := Manifest{Files: []FileEntry{{Name: "hello.txt", Size: int64(len(f1))}, {Name: "sub/data.bin", Size: int64(len(f2))}}}
	mct, _ := EncryptManifest(key, m)
	fr1, _ := FrameChunk(key, 1, f1)
	fr2, _ := FrameChunk(key, 2, f2)
	frames := append(append([]byte{}, fr1...), fr2...)
	vec := map[string]any{
		"keyB64Url":         EncodeKey(key),
		"manifestCtB64Std":  base64.StdEncoding.EncodeToString(mct),
		"chunkFramesB64Std": base64.StdEncoding.EncodeToString(frames),
		"plaintext":         string(f1) + string(f2),
		"files":             m.Files,
	}
	b, _ := json.MarshalIndent(vec, "", "  ")
	if err := os.WriteFile("testdata/vector.json", b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestInteropVectorRoundTrip decrypts the Go-produced vector (also consumed by
// the web side) — the forward direction.
func TestInteropVectorRoundTrip(t *testing.T) {
	decodeAndCheckVector(t, "testdata/vector.json")
}

// TestWebInteropVectorRoundTrip decrypts a vector produced by the WEB impl
// (web/src/lib/store-crypto.interop.test.ts writes it), proving the REVERSE
// direction: web-encrypted manifest + frames decrypt on the Go side, and a
// tampered frame is rejected. Skips cleanly if the web suite hasn't generated it.
func TestWebInteropVectorRoundTrip(t *testing.T) {
	if _, err := os.Stat("testdata/web-vector.json"); os.IsNotExist(err) {
		t.Skip("web-vector.json not generated (run the web interop test suite)")
	}
	decodeAndCheckVector(t, "testdata/web-vector.json")
}

// decodeAndCheckVector loads a cross-language vector, verifies the manifest and
// the full (possibly multi-file) plaintext decrypt, and asserts a single-byte
// tamper of the chunk frames is rejected by the AEAD.
func decodeAndCheckVector(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var vec interopVector
	if err := json.Unmarshal(raw, &vec); err != nil {
		t.Fatal(err)
	}
	key, err := DecodeKey(vec.KeyB64Url)
	if err != nil {
		t.Fatal(err)
	}
	mct, _ := base64.StdEncoding.DecodeString(vec.ManifestCtB64Std)
	m, err := DecryptManifest(key, mct)
	if err != nil {
		t.Fatalf("manifest decrypt: %v", err)
	}
	if len(vec.Files) > 0 {
		if len(m.Files) != len(vec.Files) {
			t.Fatalf("manifest files = %d, want %d", len(m.Files), len(vec.Files))
		}
		for i, f := range vec.Files {
			if m.Files[i].Name != f.Name || m.Files[i].Size != f.Size {
				t.Fatalf("file %d = %+v, want %+v", i, m.Files[i], f)
			}
		}
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

	// Tamper: flip a byte in the last frame's ciphertext; the GCM tag must reject
	// it (cross-language integrity, not just same-language).
	if len(frames) == 0 {
		t.Fatal("vector has no frames")
	}
	bad := append([]byte{}, frames...)
	bad[len(bad)-1] ^= 0x01
	tdec := NewDecryptor(key)
	perr := tdec.Push(bad, func([]byte) error { return nil })
	eerr := tdec.End(int64(len(vec.Plaintext)))
	if perr == nil && eerr == nil {
		t.Fatal("tampered frame was accepted; AEAD must reject it")
	}
}
