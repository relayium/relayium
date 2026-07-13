// Package storecrypto is the Go mirror of web/src/lib/store-crypto.ts. It MUST
// stay byte-for-byte compatible: a file uploaded from the browser must decrypt
// here and vice versa. AES-256-GCM, nonce = 4 zero bytes then a 64-bit BE
// counter, manifest at seq 0, file chunks at seq 1…, frames are uint32BE(len)||ct.
package storecrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

const ChunkSize = 192 * 1024

// MaxFrameCT caps a single ciphertext frame: a full plaintext chunk + 16-byte
// GCM tag + slack. The length prefix is attacker-controlled, so this bounds how
// much we buffer for one frame.
const MaxFrameCT = ChunkSize + 16 + 256

type FileEntry struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type Manifest struct {
	Files []FileEntry `json:"files"`
}

func GenerateKey() ([]byte, error) {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return k, nil
}

func EncodeKey(raw []byte) string { return base64.RawURLEncoding.EncodeToString(raw) }

func DecodeKey(s string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("storecrypto: bad key: %w", err)
	}
	if len(b) != 32 {
		return nil, errors.New("storecrypto: key must be 32 bytes")
	}
	return b, nil
}

func nonce(seq uint64) []byte {
	n := make([]byte, 12)
	binary.BigEndian.PutUint64(n[4:], seq)
	return n
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func EncryptManifest(key []byte, m Manifest) ([]byte, error) {
	pt, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	a, err := gcm(key)
	if err != nil {
		return nil, err
	}
	return a.Seal(nil, nonce(0), pt, nil), nil
}

func DecryptManifest(key, ct []byte) (Manifest, error) {
	a, err := gcm(key)
	if err != nil {
		return Manifest{}, err
	}
	pt, err := a.Open(nil, nonce(0), ct, nil)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(pt, &m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// FrameChunk encrypts one plaintext chunk at seq and returns uint32BE(len)||ct.
func FrameChunk(key []byte, seq uint64, plaintext []byte) ([]byte, error) {
	a, err := gcm(key)
	if err != nil {
		return nil, err
	}
	ct := a.Seal(nil, nonce(seq), plaintext, nil)
	out := make([]byte, 4+len(ct))
	binary.BigEndian.PutUint32(out, uint32(len(ct)))
	copy(out[4:], ct)
	return out, nil
}

// Decryptor reassembles length-prefixed frames across arbitrary chunk
// boundaries and emits decrypted plaintext in order. seq starts at 1.
type Decryptor struct {
	aead      cipher.AEAD
	seq       uint64
	buf       []byte
	n         int64
	cipherOff int64 // ciphertext bytes of fully-decoded frames (frame-aligned)
}

func NewDecryptor(key []byte) *Decryptor {
	a, _ := gcm(key) // key length already validated by DecodeKey callers
	return &Decryptor{aead: a, seq: 1}
}

func (d *Decryptor) DecryptedBytes() int64 { return d.n }

// ConsumedCipher returns the number of ciphertext bytes belonging to frames
// that have been fully decoded so far. It is always frame-aligned, so a resumed
// download can request `Range: bytes=<ConsumedCipher()>-` and this Decryptor
// will continue at the correct next frame/seq — provided ResetBuffer is called
// first to drop any partial frame left from the interrupted stream.
func (d *Decryptor) ConsumedCipher() int64 { return d.cipherOff }

// ResetBuffer discards the partial-frame buffer. Call it before feeding a
// Range-resumed body that begins exactly at ConsumedCipher (a frame boundary);
// the leftover partial bytes will be re-delivered by the new response.
func (d *Decryptor) ResetBuffer() { d.buf = nil }

func (d *Decryptor) Push(data []byte, emit func([]byte) error) error {
	d.buf = append(d.buf, data...)
	off := 0
	for off+4 <= len(d.buf) {
		l := binary.BigEndian.Uint32(d.buf[off:])
		if int(l) > MaxFrameCT {
			return fmt.Errorf("storecrypto: frame length %d exceeds %d", l, MaxFrameCT)
		}
		if off+4+int(l) > len(d.buf) {
			break // frame incomplete
		}
		ct := d.buf[off+4 : off+4+int(l)]
		pt, err := d.aead.Open(nil, nonce(d.seq), ct, nil)
		if err != nil {
			return fmt.Errorf("storecrypto: decrypt frame %d: %w", d.seq, err)
		}
		d.seq++
		off += 4 + int(l)
		d.cipherOff += int64(4 + int(l))
		d.n += int64(len(pt))
		if err := emit(pt); err != nil {
			return err
		}
	}
	d.buf = append([]byte(nil), d.buf[off:]...)
	return nil
}

func (d *Decryptor) End(expected int64) error {
	if len(d.buf) != 0 {
		return errors.New("storecrypto: trailing bytes — truncated stream")
	}
	if expected >= 0 && d.n != expected {
		return fmt.Errorf("storecrypto: length mismatch — got %d, expected %d", d.n, expected)
	}
	return nil
}
