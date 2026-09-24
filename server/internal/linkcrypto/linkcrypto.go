// Package linkcrypto is the Go implementation of the realtime link's crypto
// layer, byte-pinned to docs/protocol/relayium-crypto-v1.md and to the shared
// golden vectors in apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json that
// the Web, Swift and Android clients are pinned to as well.
//
// It is a pure library: no I/O beyond the system random source, no logging, no
// wire framing, no handshake state. Nothing in the CLI or server imports it yet,
// and passing its vectors says nothing about whether any Go program interoperates
// with another client over a network — that is the job of whatever layer adopts
// it.
//
// No primitive is invented here. X25519 is crypto/ecdh, AES-256-GCM, HMAC-SHA-256
// and the random source are the standard library, and BLAKE2b is
// golang.org/x/crypto/blake2b (already a module dependency). The one composition
// reproduced by hand is libsodium's crypto_kx session-key derivation, which is
// exactly X25519 followed by one BLAKE2b-512 call; it is pinned by the vectors in
// both directions.
//
// Secrets never appear in an error message. Every byte slice this package
// returns is a fresh copy the caller owns, and no function retains or mutates a
// slice it was given.
package linkcrypto

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strconv"

	"golang.org/x/crypto/blake2b"
)

const (
	PublicKeySize   = 32
	SecretKeySize   = 32
	SessionKeySize  = 32
	CommitSize      = 32
	CommitNonceSize = 32
	AEADNonceSize   = 12
	AEADTagSize     = 16
	// ResumeTagSize is the raw HMAC-SHA-256 length; ResumeTagEncodedLen is its
	// standard padded base64 spelling, the only spelling VerifyResume accepts.
	ResumeTagSize       = sha256.Size
	ResumeTagEncodedLen = 44
)

// The two domain-separation prefixes, each ending in a NUL that is part of the
// hashed input. Their lengths (24 and 17) are protocol constants; init checks
// them rather than trusting the literals.
const (
	resumeAuthDomain = "relayium-resume-auth-v1\x00"
	textKeyDomain    = "relayium-text-v1\x00"
)

func init() {
	if len(resumeAuthDomain) != 24 || len(textKeyDomain) != 17 {
		panic("linkcrypto: domain-separation constant has the wrong length")
	}
}

var (
	// ErrInvalidKey reports key material of the wrong length or an unusable
	// value. It never carries the bytes.
	ErrInvalidKey = errors.New("linkcrypto: invalid key material")
	// ErrInvalidRole reports a role that is neither Initiator nor Responder.
	ErrInvalidRole = errors.New("linkcrypto: role must be initiator or responder")
	// ErrLowOrderPeer reports a peer public key for which X25519 produced the
	// all-zero shared secret. Agreeing on it would give both ends a secret an
	// attacker also knows; libsodium's crypto_kx refuses it the same way.
	ErrLowOrderPeer = errors.New("linkcrypto: peer public key is a low-order point")
	// ErrOpen is the only error Open returns for an authentication failure. It
	// deliberately does not distinguish wrong key, wrong sequence and tampered
	// ciphertext.
	ErrOpen = errors.New("linkcrypto: ciphertext did not authenticate")
)

// randReader is the entropy source. A variable only so tests can prove that a
// failing source is reported rather than papered over.
var randReader io.Reader = rand.Reader

// Role is the side of a connection. Initiator sends the SDP offer and takes
// crypto_kx's client role; Responder answers and takes the server role. The two
// ends MUST take opposite roles. The zero value is invalid on purpose, so an
// unset Role cannot silently pick a side.
type Role int

const (
	Initiator Role = iota + 1
	Responder
)

func (r Role) String() string {
	switch r {
	case Initiator:
		return "initiator"
	case Responder:
		return "responder"
	}
	return "Role(" + strconv.Itoa(int(r)) + ")"
}

// KeyPair is one crypto_kx (X25519) identity. The public half is always derived
// from the secret, so a mismatched pair cannot be constructed.
//
// Generate a fresh pair per link establishment, never per process: one link
// owns one set of session keys, and a second link must not share its nonce
// space.
type KeyPair struct {
	secret *ecdh.PrivateKey
	public [PublicKeySize]byte
}

// GenerateKeyPair returns a fresh pair from the system random source. It is
// byte-compatible with crypto_kx_keypair: libsodium stores 32 random bytes and
// clamps during the multiplication, and crypto/ecdh does the same.
func GenerateKeyPair() (*KeyPair, error) {
	var seed [SecretKeySize]byte
	defer clear(seed[:])
	if _, err := io.ReadFull(randReader, seed[:]); err != nil {
		return nil, fmt.Errorf("linkcrypto: read random key: %w", err)
	}
	return KeyPairFromSecret(seed[:])
}

// KeyPairFromSecret rebuilds a pair from a 32-byte crypto_kx secret, deriving
// the public key from it. The input is copied, not retained. An all-zero secret
// is refused: a random source never produces it, so seeing one means the caller
// passed an unset buffer.
func KeyPairFromSecret(secret []byte) (*KeyPair, error) {
	if len(secret) != SecretKeySize || isZero(secret) {
		return nil, ErrInvalidKey
	}
	priv, err := ecdh.X25519().NewPrivateKey(bytes.Clone(secret))
	if err != nil {
		return nil, ErrInvalidKey
	}
	kp := &KeyPair{secret: priv}
	copy(kp.public[:], priv.PublicKey().Bytes())
	return kp, nil
}

// PublicKey returns a copy of the 32-byte public key, or nil for a KeyPair that
// was not built by this package.
func (k *KeyPair) PublicKey() []byte {
	if k == nil || k.secret == nil {
		return nil
	}
	return bytes.Clone(k.public[:])
}

// Format prints the public key only, for every verb, so no formatting of a
// KeyPair — in a log line, an error or a %#v dump — can reach the secret.
func (k KeyPair) Format(f fmt.State, _ rune) {
	fmt.Fprintf(f, "linkcrypto.KeyPair{public:%x}", k.public)
}

// SessionKeys is everything one authenticated link is keyed with. Every accessor
// returns a fresh copy.
//
// Send/Recv key the file stream and TextSend/TextRecv the message stream, each
// with AES-256-GCM through Seal and Open. The caller owns the sequence counter
// of each direction: it must be strictly monotonic under one key and never
// rewound or reused, including across a resume. Any narrower counter a wire
// format carries (for example a 32-bit field) is that layer's limit to enforce,
// not this one's.
type SessionKeys struct {
	send, recv, resumeAuth, textSend, textRecv [SessionKeySize]byte
}

// Format redacts every key, for every verb: the fields are plain byte arrays,
// so without it a %v or %x of a SessionKeys would print all five keys.
func (SessionKeys) Format(f fmt.State, _ rune) {
	io.WriteString(f, "linkcrypto.SessionKeys{redacted}")
}

func (s *SessionKeys) Send() []byte       { return bytes.Clone(s.send[:]) }
func (s *SessionKeys) Recv() []byte       { return bytes.Clone(s.recv[:]) }
func (s *SessionKeys) ResumeAuth() []byte { return bytes.Clone(s.resumeAuth[:]) }
func (s *SessionKeys) TextSend() []byte   { return bytes.Clone(s.textSend[:]) }
func (s *SessionKeys) TextRecv() []byte   { return bytes.Clone(s.textRecv[:]) }

// DeriveSession is libsodium's crypto_kx_client_session_keys (Initiator) or
// crypto_kx_server_session_keys (Responder), plus the resume-auth and text
// subkeys derived from the result:
//
//	q = X25519(selfSecret, peerPublic)                    // refuse all-zero
//	h = BLAKE2b-512(q || clientPublic || serverPublic)    // always client first
//	client: rx = h[0:32], tx = h[32:64]
//	server: rx = h[32:64], tx = h[0:32]
//
// The hash input order is fixed by role, not "self then peer", and the halves
// are swapped by role; that mirroring is what makes one side's send the other's
// recv.
func DeriveSession(role Role, self *KeyPair, peerPublic []byte) (*SessionKeys, error) {
	if role != Initiator && role != Responder {
		return nil, ErrInvalidRole
	}
	if self == nil || self.secret == nil || len(peerPublic) != PublicKeySize {
		return nil, ErrInvalidKey
	}
	peer, err := ecdh.X25519().NewPublicKey(bytes.Clone(peerPublic))
	if err != nil {
		return nil, ErrInvalidKey
	}
	q, err := self.secret.ECDH(peer)
	if err != nil || isZero(q) {
		// crypto/ecdh already refuses the all-zero output; the second check
		// keeps that refusal from depending on it.
		clear(q)
		return nil, ErrLowOrderPeer
	}
	defer clear(q)

	clientPub, serverPub := self.public[:], peerPublic
	if role == Responder {
		clientPub, serverPub = peerPublic, self.public[:]
	}
	h, err := blake2b.New512(nil)
	if err != nil {
		return nil, err
	}
	h.Write(q)
	h.Write(clientPub)
	h.Write(serverPub)
	both := h.Sum(nil)
	defer clear(both)

	s := &SessionKeys{}
	if role == Initiator {
		copy(s.recv[:], both[:SessionKeySize])
		copy(s.send[:], both[SessionKeySize:])
	} else {
		copy(s.send[:], both[:SessionKeySize])
		copy(s.recv[:], both[SessionKeySize:])
	}
	s.resumeAuth = deriveResumeAuth(s.send[:], s.recv[:])
	// Per direction and NOT sorted: crypto_kx already mirrors tx/rx, so hashing
	// each locally lines the peers up. Sorting would collapse both directions
	// onto one key and put two producers on one nonce counter.
	s.textSend = deriveSubkey(textKeyDomain, s.send[:])
	s.textRecv = deriveSubkey(textKeyDomain, s.recv[:])
	return s, nil
}

// deriveResumeAuth is BLAKE2b-256(domain || a || b) with (a, b) the session keys
// sorted bytewise ascending. Sorted, unlike the text subkeys, because this key is
// shared and must be the same on both sides.
func deriveResumeAuth(tx, rx []byte) [SessionKeySize]byte {
	a, b := tx, rx
	if bytes.Compare(tx, rx) > 0 {
		a, b = rx, tx
	}
	h := newBlake2b(SessionKeySize)
	h.Write([]byte(resumeAuthDomain))
	h.Write(a)
	h.Write(b)
	var out [SessionKeySize]byte
	copy(out[:], h.Sum(nil))
	return out
}

// deriveSubkey is BLAKE2b-256(domain || sessionKey).
func deriveSubkey(domain string, sessionKey []byte) [SessionKeySize]byte {
	h := newBlake2b(SessionKeySize)
	h.Write([]byte(domain))
	h.Write(sessionKey)
	var out [SessionKeySize]byte
	copy(out[:], h.Sum(nil))
	return out
}

// newBlake2b is unkeyed BLAKE2b with the given OUTPUT LENGTH, libsodium's
// crypto_generichash(size, …). The length is part of BLAKE2b's parameter block,
// so an 8-byte digest is NOT the first 8 bytes of a longer one.
func newBlake2b(size int) interface {
	Write([]byte) (int, error)
	Sum([]byte) []byte
} {
	h, err := blake2b.New(size, nil)
	if err != nil {
		// Only reachable with a size outside 1..64, which no caller passes.
		panic("linkcrypto: blake2b size " + strconv.Itoa(size))
	}
	return h
}

// NonceFromSeq is the 12-byte AEAD nonce: four zero bytes, then seq as a 64-bit
// big-endian integer.
func NonceFromSeq(seq uint64) [AEADNonceSize]byte {
	var n [AEADNonceSize]byte
	binary.BigEndian.PutUint64(n[4:], seq)
	return n
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != SessionKeySize {
		return nil, ErrInvalidKey
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrInvalidKey
	}
	return cipher.NewGCM(block)
}

// Seal is AES-256-GCM in combined mode (16-byte tag appended), no associated
// data, nonce NonceFromSeq(seq). The result is a new slice. A (key, seq) pair
// must never be sealed twice; see SessionKeys.
func Seal(key []byte, seq uint64, plaintext []byte) ([]byte, error) {
	aead, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := NonceFromSeq(seq)
	return aead.Seal(nil, nonce[:], plaintext, nil), nil
}

// Open is the inverse of Seal. On any failure it returns a nil plaintext and an
// error — never partial or unauthenticated bytes.
func Open(key []byte, seq uint64, ciphertext []byte) ([]byte, error) {
	aead, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < AEADTagSize {
		return nil, ErrOpen
	}
	nonce := NonceFromSeq(seq)
	pt, err := aead.Open(nil, nonce[:], ciphertext, nil)
	if err != nil {
		return nil, ErrOpen
	}
	return pt, nil
}

// RandomCommitNonce returns 32 fresh random bytes for a commitment.
func RandomCommitNonce() ([]byte, error) {
	n := make([]byte, CommitNonceSize)
	if _, err := io.ReadFull(randReader, n); err != nil {
		return nil, fmt.Errorf("linkcrypto: read commitment nonce: %w", err)
	}
	return n, nil
}

// CommitKey is BLAKE2b-256(pub || nonce), the commitment each side sends before
// revealing its public key.
func CommitKey(pub, nonce []byte) ([]byte, error) {
	if len(pub) != PublicKeySize || len(nonce) != CommitNonceSize {
		return nil, ErrInvalidKey
	}
	h := newBlake2b(CommitSize)
	h.Write(pub)
	h.Write(nonce)
	return h.Sum(nil), nil
}

// VerifyCommit reports, in constant time over the commitment, whether commit
// opens to (pub, nonce). Any wrong length is false.
func VerifyCommit(commit, pub, nonce []byte) bool {
	if len(commit) != CommitSize {
		return false
	}
	want, err := CommitKey(pub, nonce)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(commit, want) == 1
}

// SAS is the six-digit short authentication string. It is order-independent:
// sort the two public keys bytewise, take the 8-byte-output BLAKE2b of a||b,
// XOR its two big-endian uint32 halves, reduce modulo 1 000 000 and zero-pad.
// It is unrelated to the six-digit pairing code and must never be shown as one.
func SAS(selfPublic, peerPublic []byte) (string, error) {
	if len(selfPublic) != PublicKeySize || len(peerPublic) != PublicKeySize {
		return "", ErrInvalidKey
	}
	a, b := selfPublic, peerPublic
	if bytes.Compare(a, b) > 0 {
		a, b = b, a
	}
	h := newBlake2b(8)
	h.Write(a)
	h.Write(b)
	d := h.Sum(nil)
	num := binary.BigEndian.Uint32(d[0:4]) ^ binary.BigEndian.Uint32(d[4:8])
	return fmt.Sprintf("%06d", num%1_000_000), nil
}

// SignResume is base64(HMAC-SHA-256(key, utf8(payload))), standard alphabet with
// padding. key is the session's ResumeAuth key.
func SignResume(key []byte, payload string) (string, error) {
	if len(key) != SessionKeySize {
		return "", ErrInvalidKey
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(payload))
	return base64.StdEncoding.EncodeToString(m.Sum(nil)), nil
}

// VerifyResume reports whether tag authenticates payload under key. An absent,
// malformed, non-canonical or wrong-length tag, or a bad key, is false — never an
// error the caller could mistake for "unauthenticated is acceptable". The MAC
// comparison is constant time.
func VerifyResume(key []byte, payload, tag string) bool {
	if len(key) != SessionKeySize || len(tag) != ResumeTagEncodedLen {
		return false
	}
	got, err := base64.StdEncoding.Strict().DecodeString(tag)
	if err != nil || len(got) != ResumeTagSize {
		return false
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(payload))
	return hmac.Equal(got, m.Sum(nil))
}

func isZero(b []byte) bool {
	var acc byte
	for _, x := range b {
		acc |= x
	}
	return acc == 0
}
