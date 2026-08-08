package inboxclient

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/inbox"
)

// Device key material. The wrapping algorithm is libsodium's crypto_box_seal
// (`x25519-sealedbox-v1`): X25519 + XSalsa20-Poly1305 under an EPHEMERAL sender
// key, so no sender long-term key has to exist — the queue's authorisation is
// the account, not a sender identity (protocol doc §2).
//
// This file is the only place a private key is handled. It produces raw bytes
// and consumes raw bytes; persistence is keystore.go's job, and neither the
// private key nor an unsealed content key is ever formatted into a log line, an
// error message or a request body.

// ErrUnseal is returned when a sealed box does not open under this device's key.
// It is deliberately opaque: distinguishing "wrong key" from "tampered box"
// would leak an oracle, and the caller's response is the same either way — the
// task cannot be decrypted here.
var ErrUnseal = errors.New("relayium inbox: sealed content key did not open with this device's private key")

// KeyPair is one X25519 identity. Private is the raw 32-byte scalar; Public is
// the raw 32-byte point, both in the spelling central validates.
type KeyPair struct {
	Private [32]byte
	Public  [32]byte
}

// GenerateKeyPair mints a fresh device key.
//
// It builds the key through crypto/ecdh — the SAME implementation central's
// ValidatePublicKey uses — and then re-validates its own public half through
// inbox.ValidatePublicKey before returning. That is not ceremony: a key central
// would reject (wrong length, non-canonical encoding, low-order point) must fail
// HERE, before it is persisted and long before a sender could wrap a content key
// to something the whole world can open.
func GenerateKeyPair() (KeyPair, error) {
	var kp KeyPair
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, fmt.Errorf("relayium inbox: generate device key: %w", err)
	}
	privBytes := priv.Bytes()
	pubBytes := priv.PublicKey().Bytes()
	if len(privBytes) != 32 || len(pubBytes) != inbox.X25519PublicKeyBytes {
		return KeyPair{}, errors.New("relayium inbox: generated key has the wrong length")
	}
	copy(kp.Private[:], privBytes)
	copy(kp.Public[:], pubBytes)
	if _, err := inbox.ValidatePublicKey(inbox.KeyAlgX25519SealedBoxV1, EncodeKeyBytes(kp.Public[:])); err != nil {
		return KeyPair{}, fmt.Errorf("relayium inbox: generated an unusable device key: %w", err)
	}
	return kp, nil
}

// EncodeKeyBytes is the one spelling rule for raw key bytes on the wire:
// base64url without padding, matching inbox.EncodePublicKey and the `#k=`
// content-key encoding, so a client implements one rule everywhere.
func EncodeKeyBytes(raw []byte) string { return base64.RawURLEncoding.EncodeToString(raw) }

// DecodeKeyBytes is the strict inverse. Strict() rejects padding, whitespace and
// non-canonical trailing bits, so one key has exactly one spelling — which is
// what lets "is this the key central named?" be a string comparison.
func DecodeKeyBytes(s string, want int) ([]byte, error) {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("relayium inbox: non-canonical base64url key material: %w", err)
	}
	if want > 0 && len(raw) != want {
		return nil, fmt.Errorf("relayium inbox: key material is %d bytes, want %d", len(raw), want)
	}
	return raw, nil
}

// UnsealContentKey opens a `x25519-sealedbox-v1` wrapped key with this device's
// private key and returns the 32-byte AES-256-GCM content key.
//
// The sealed box is length-checked against inbox.SealedBoxBytes first. What is
// wrapped is fixed by this protocol version, so any other length is a peer
// sealing something else — and a change to what is sealed has to be a new
// algorithm token, not a silently longer blob.
//
// The RESULT is length-checked too: the content key must be exactly 32 bytes,
// because everything downstream (manifest decryption, every frame) is keyed by
// it, and a short key must fail here rather than at an AEAD call whose error
// would read as "corrupt data".
func UnsealContentKey(algorithm, wrappedKey string, kp KeyPair) ([]byte, error) {
	if algorithm != inbox.KeyAlgX25519SealedBoxV1 {
		return nil, fmt.Errorf("relayium inbox: unsupported wrap algorithm %q", algorithm)
	}
	sealed, err := DecodeKeyBytes(wrappedKey, inbox.SealedBoxBytes)
	if err != nil {
		return nil, err
	}
	out, ok := box.OpenAnonymous(nil, sealed, &kp.Public, &kp.Private)
	if !ok {
		return nil, ErrUnseal
	}
	if len(out) != 32 {
		return nil, fmt.Errorf("relayium inbox: unwrapped content key is %d bytes, want 32", len(out))
	}
	return out, nil
}
