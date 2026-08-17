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
	"math"
)

const ChunkSize = 192 * 1024
const MaxFiles = 1000
const MaxFileNameBytes = 1024
const MaxSafeInteger int64 = 9_007_199_254_740_991

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
	if err := ValidateManifest(m); err != nil {
		return nil, err
	}
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

// SealManifest seals arbitrary manifest plaintext into the seq-0 unit. The
// inverse of OpenManifest, and there for the same reason: the AEAD stays in one
// place while the document inside it is the caller's to choose.
func SealManifest(key, plaintext []byte) ([]byte, error) {
	a, err := gcm(key)
	if err != nil {
		return nil, err
	}
	return a.Seal(nil, nonce(0), plaintext, nil), nil
}

// OpenManifest opens the seq-0 manifest unit and returns its PLAINTEXT BYTES
// without interpreting them.
//
// The wire is unchanged — this is the same AEAD unit at the same sequence
// number that EncryptManifest seals. What it exists for is Device Inbox v2,
// which seals its own dedicated document (`internal/inboxmanifest`) there
// rather than the shared Stored-Wire manifest. Its receiver needs the bytes;
// parsing them here would reintroduce exactly the coupling to the shared
// manifest that a separate codec exists to avoid.
func OpenManifest(key, ct []byte) ([]byte, error) {
	a, err := gcm(key)
	if err != nil {
		return nil, err
	}
	return a.Open(nil, nonce(0), ct, nil)
}

func DecryptManifest(key, ct []byte) (Manifest, error) {
	pt, err := OpenManifest(key, ct)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(pt, &m); err != nil {
		return Manifest{}, err
	}
	if err := ValidateManifest(m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// ValidateManifest is the trust boundary for decrypted sender-controlled
// metadata. AEAD proves who constructed the bytes; it does not make negative,
// overflowing, empty, or resource-exhausting declarations safe to consume.
func ValidateManifest(m Manifest) error {
	if len(m.Files) == 0 || len(m.Files) > MaxFiles {
		return fmt.Errorf("storecrypto: invalid manifest file count %d", len(m.Files))
	}
	var total int64
	for i, f := range m.Files {
		if f.Name == "" || len([]byte(f.Name)) > MaxFileNameBytes {
			return fmt.Errorf("storecrypto: invalid file name at index %d", i)
		}
		if f.Size < 0 || f.Size > MaxSafeInteger || total > math.MaxInt64-f.Size || total+f.Size > MaxSafeInteger {
			return fmt.Errorf("storecrypto: invalid file size at index %d", i)
		}
		total += f.Size
	}
	return nil
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
