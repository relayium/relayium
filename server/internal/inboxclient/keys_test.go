package inboxclient

import (
	"bytes"
	"crypto/rand"
	"testing"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storecrypto"
)

// A FROZEN `x25519-sealedbox-v1` vector, and why it is built the way it is.
//
// The thing that must be true is not "our unseal is self-consistent" — it is
// "a content key sealed by libsodium, in the browser or in Swift, opens here".
// A round trip through box.SealAnonymous would prove neither: it would test one
// x/crypto function against its own inverse, and would stay green if x/crypto
// and libsodium ever disagreed.
//
// So the vector below is constructed from the libsodium crypto_box_seal
// SPECIFICATION instead, by a different code path from the one under test:
//
//	epk, esk := an ephemeral key pair          (FIXED here, so this is deterministic)
//	nonce    := blake2b-24(epk || recipient_pk)
//	box      := crypto_box_easy(content_key, nonce, recipient_pk, esk)
//	sealed   := epk || box
//
// That construction uses blake2b and the GENERIC box.Seal; the implementation
// under test uses box.OpenAnonymous, which derives its own nonce internally. The
// bytes are then frozen as literals, so a future change to either side that
// breaks the agreement fails here rather than in a user's inbox.
//
// TestSealedBoxSpecMatchesFrozenVector checks the construction still produces
// the literals; TestUnsealFrozenVector checks the product opens them. Both must
// pass for the vector to mean anything.
const (
	vectorRecipientPriv = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"
	vectorRecipientPub  = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw"
	vectorContentKey    = "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8"
	vectorSealed        = "ST6C_HRGSlkmiBdiPSBTxeuOLMSpiLT-4XnsawENUx1q8tdz56xOSU0-O_VGIK_yNzZsZoI6QA1K1SYWtACQgTQCLPNtFFjWMnchw1aDECg"
)

// mustDecode is a test helper for the frozen literals.
func mustDecode(t *testing.T, s string, want int) []byte {
	t.Helper()
	b, err := DecodeKeyBytes(s, want)
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return b
}

func vectorKeyPair(t *testing.T) KeyPair {
	t.Helper()
	var kp KeyPair
	copy(kp.Private[:], mustDecode(t, vectorRecipientPriv, 32))
	copy(kp.Public[:], mustDecode(t, vectorRecipientPub, 32))
	return kp
}

// TestSealedBoxSpecMatchesFrozenVector rebuilds the sealed box from the
// libsodium specification and asserts it is byte-identical to the frozen
// literal. This is what binds the literal to a real construction rather than to
// whatever the implementation happened to emit on the day it was written.
func TestSealedBoxSpecMatchesFrozenVector(t *testing.T) {
	var rsk, esk [32]byte
	for i := range rsk {
		rsk[i] = byte(i + 1)
	}
	for i := range esk {
		esk[i] = byte(0x80 ^ i)
	}
	var rpk, epk [32]byte
	curve25519.ScalarBaseMult(&rpk, &rsk)
	curve25519.ScalarBaseMult(&epk, &esk)

	if got := EncodeKeyBytes(rpk[:]); got != vectorRecipientPub {
		t.Fatalf("recipient public key = %q, frozen vector says %q", got, vectorRecipientPub)
	}

	h, err := blake2b.New(24, nil)
	if err != nil {
		t.Fatalf("blake2b: %v", err)
	}
	h.Write(epk[:])
	h.Write(rpk[:])
	var nonce [24]byte
	copy(nonce[:], h.Sum(nil))

	content := mustDecode(t, vectorContentKey, 32)
	sealed := append(append([]byte{}, epk[:]...), box.Seal(nil, content, &nonce, &rpk, &esk)...)

	if got := EncodeKeyBytes(sealed); got != vectorSealed {
		t.Fatalf("spec-built sealed box = %q, frozen vector says %q", got, vectorSealed)
	}
	if len(sealed) != inbox.SealedBoxBytes {
		t.Fatalf("sealed box is %d bytes, protocol fixes it at %d", len(sealed), inbox.SealedBoxBytes)
	}
}

// TestUnsealFrozenVector is the interoperability assertion: the product opens a
// sealed box it did not create, built to the libsodium specification.
func TestUnsealFrozenVector(t *testing.T) {
	got, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, vectorSealed, vectorKeyPair(t))
	if err != nil {
		t.Fatalf("unseal frozen vector: %v", err)
	}
	want := mustDecode(t, vectorContentKey, 32)
	if !bytes.Equal(got, want) {
		t.Fatalf("unsealed content key = %x, want %x", got, want)
	}
}

// TestUnsealWrongPrivateKeyFails is the other half of the vector's value. A
// sealed box that opens under ANY key would mean the wrapping proves nothing;
// this asserts the frozen box is refused by a key that is not its recipient, and
// that the refusal is the opaque ErrUnseal rather than a distinguishing error.
func TestUnsealWrongPrivateKeyFails(t *testing.T) {
	wrong, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if _, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, vectorSealed, wrong); err == nil {
		t.Fatal("a sealed box opened under a key that is not its recipient")
	} else if !isUnsealErr(err) {
		t.Fatalf("wrong-key failure = %v, want ErrUnseal", err)
	}

	// The subtler case: the right private key with somebody else's public key.
	// crypto_box_seal derives its nonce from the recipient PUBLIC key, so a
	// mismatched pair must fail too — otherwise a caller could be tricked into
	// unsealing against a public key it did not publish.
	mixed := vectorKeyPair(t)
	mixed.Public = wrong.Public
	if _, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, vectorSealed, mixed); err == nil {
		t.Fatal("a sealed box opened with a mismatched public/private pair")
	}
}

func isUnsealErr(err error) bool {
	return err != nil && err.Error() == ErrUnseal.Error()
}

// TestUnsealRejectsShapeViolations checks the length and algorithm gates. A
// wrapped key of any other length is a peer sealing something other than the
// 32-byte content key this protocol version fixes, and must be refused before
// it reaches the AEAD.
func TestUnsealRejectsShapeViolations(t *testing.T) {
	kp := vectorKeyPair(t)
	sealed := mustDecode(t, vectorSealed, inbox.SealedBoxBytes)

	if _, err := UnsealContentKey("x25519-sealedbox-v2", vectorSealed, kp); err == nil {
		t.Fatal("accepted an unknown wrap algorithm")
	}
	if _, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, EncodeKeyBytes(sealed[:len(sealed)-1]), kp); err == nil {
		t.Fatal("accepted a short sealed box")
	}
	if _, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, EncodeKeyBytes(append(sealed, 0)), kp); err == nil {
		t.Fatal("accepted an over-long sealed box")
	}
	// Standard base64 (with '+' and '/') and padded base64url are both
	// non-canonical spellings and must be refused, so one key has one spelling.
	if _, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, vectorSealed+"=", kp); err == nil {
		t.Fatal("accepted a padded base64url sealed box")
	}
}

// TestTamperedSealedBoxFails flips one bit of the frozen box and requires the
// AEAD to reject it. Poly1305 is what makes "the server could not have swapped
// the content key" true; if this ever passed, central could substitute a key it
// chose and read the file.
func TestTamperedSealedBoxFails(t *testing.T) {
	kp := vectorKeyPair(t)
	raw := mustDecode(t, vectorSealed, inbox.SealedBoxBytes)
	for _, idx := range []int{0, 31, 40, len(raw) - 1} {
		tampered := append([]byte{}, raw...)
		tampered[idx] ^= 0x01
		if _, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, EncodeKeyBytes(tampered), kp); err == nil {
			t.Fatalf("a sealed box tampered at byte %d still opened", idx)
		}
	}
}

// TestGenerateKeyPairRoundTripsThroughSealAnonymous proves a freshly generated
// device key is usable by the sender side as it actually exists: a sender calls
// SealAnonymous with the PUBLISHED public key, and the device must open it.
func TestGenerateKeyPairRoundTripsThroughSealAnonymous(t *testing.T) {
	kp, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	// Exactly what a sender does: the public key as it appears on the wire.
	published := EncodeKeyBytes(kp.Public[:])
	pubBytes, err := inbox.ValidatePublicKey(inbox.KeyAlgX25519SealedBoxV1, published)
	if err != nil {
		t.Fatalf("central would reject this generated key: %v", err)
	}
	var pub [32]byte
	copy(pub[:], pubBytes)

	content, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatalf("content key: %v", err)
	}
	sealed, err := box.SealAnonymous(nil, content, &pub, rand.Reader)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	got, err := UnsealContentKey(inbox.KeyAlgX25519SealedBoxV1, EncodeKeyBytes(sealed), kp)
	if err != nil {
		t.Fatalf("unseal: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("round-tripped content key = %x, want %x", got, content)
	}
}
