//go:build swiftinterop

// Cross-implementation proof for `x25519-sealedbox-v1` in the OTHER direction
// from webinterop_test.go: a sealed box produced by the REAL Go implementation,
// opened by the REAL native (Swift/libsodium) receiver.
//
// Why a separate build tag rather than an ordinary test. The vector is not a
// frozen file: `crypto_box_seal` uses a fresh ephemeral key every call, so a
// committed box would either be stale (and prove nothing about today's code) or
// churn on every run. Instead the two halves execute in one job and hand each
// other real material through a temporary directory:
//
//	swift test --filter InboxSealedBoxInteropTests                 ← Swift mints the device key AND the expected content key
//	go test -tags swiftinterop -run TestSwiftSealedBoxSeal          ← Go seals that exact key to it
//	(back in Swift)                                                 ← Swift opens it with the private half alone
//
// The direction of trust matters and is deliberate. The device keypair comes
// from `InboxKeyMaterial.generateKeyPair` — the same function the macOS receiver
// uses — and the EXPECTED content key is written by Swift before Go has seen
// anything, so the assertion is never derived from the implementation under
// test. Nothing here is a self round trip: the sealing code and the opening code
// are different languages, different libraries
// (`golang.org/x/crypto/nacl/box` vs. libsodium) and different processes.
//
// P3A added the OPPOSITE direction, for the native SENDER:
//
//	go test -tags swiftinterop -run TestSwiftSealedBoxMintRecipient ← Go mints the recipient key AND the expected content key
//	(in Swift) InboxKeyMaterial.sealContentKey                      ← the real native sender seals it
//	go test -tags swiftinterop -run TestSwiftSealedBoxOpen          ← Go opens it with the private half Swift never saw
//
// Same trust rule, mirrored: the expected content key is chosen by GO, before
// the Swift sender has computed anything, so a Swift bug cannot make the
// expectation agree with the result. The negative control for that direction
// lives in Swift and asserts that the Go OPEN phase exits non-zero on a
// tampered box and on a box sealed to the wrong target.
//
// Driven by `apps/RelayiumKit/Tests/RelayiumKitTests/InboxSealedBoxInteropTests.swift`.
package inboxclient

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/inbox"
)

// swiftDeviceKeyFile is what Swift hands Go: a real device public key to wrap
// to, and the exact bytes it must wrap. No private key travels this way — the
// whole point of the second phase is that Swift's own private half, which never
// leaves that process, is the only thing that opens the result.
type swiftDeviceKeyFile struct {
	Algorithm  string `json:"algorithm"`
	PublicKey  string `json:"publicKey"`
	ContentKey string `json:"contentKey"`
	// MintedBy names the implementation that produced PublicKey, so a file left
	// behind by something else cannot silently satisfy this gate.
	MintedBy string `json:"mintedBy"`
}

// goBoxFile is what Go hands back.
type goBoxFile struct {
	Algorithm  string `json:"algorithm"`
	WrappedKey string `json:"wrappedKey"`
	SealedBy   string `json:"sealedBy"`
}

func swiftInteropDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("RELAYIUM_INTEROP_DIR")
	if dir == "" {
		// Never skipped: a gate that quietly passes when its environment is
		// missing is indistinguishable from a gate that ran.
		t.Fatal("RELAYIUM_INTEROP_DIR is not set; run this through InboxSealedBoxInteropTests")
	}
	return dir
}

// TestSwiftSealedBoxSeal seals the content key Swift chose to the device key
// Swift minted, using the sender-side primitive as it actually exists.
//
// It refuses the key through `inbox.ValidatePublicKey` FIRST — central's own
// gate. Otherwise a failure in the Swift phase could mean "Go sealed it wrongly"
// when it actually means "Swift minted a key no server would have published",
// and the two are different defects with different fixes.
func TestSwiftSealedBoxSeal(t *testing.T) {
	dir := swiftInteropDir(t)

	var key swiftDeviceKeyFile
	readSwiftJSON(t, filepath.Join(dir, "device-key.json"), &key)
	if key.MintedBy != "relayium-swift" {
		t.Fatalf("device-key.json was not produced by the native implementation (mintedBy=%q)", key.MintedBy)
	}
	if key.Algorithm != inbox.KeyAlgX25519SealedBoxV1 {
		t.Fatalf("native named algorithm %q, want %q", key.Algorithm, inbox.KeyAlgX25519SealedBoxV1)
	}
	pubBytes, err := inbox.ValidatePublicKey(key.Algorithm, key.PublicKey)
	if err != nil {
		t.Fatalf("the native client minted a public key central would reject: %v", err)
	}
	var pub [32]byte
	copy(pub[:], pubBytes)

	content, err := DecodeKeyBytes(key.ContentKey, 32)
	if err != nil {
		t.Fatalf("native content key is not canonical 32-byte base64url: %v", err)
	}
	sealed, err := box.SealAnonymous(nil, content, &pub, rand.Reader)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(sealed) != inbox.SealedBoxBytes {
		t.Fatalf("sealed box is %d bytes, protocol fixes it at %d", len(sealed), inbox.SealedBoxBytes)
	}

	out, err := json.MarshalIndent(goBoxFile{
		Algorithm:  inbox.KeyAlgX25519SealedBoxV1,
		WrappedKey: EncodeKeyBytes(sealed),
		SealedBy:   "relayium-go",
	}, "", "  ")
	if err != nil {
		t.Fatalf("encode go box file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go-box.json"), out, 0o600); err != nil {
		t.Fatalf("write go box file: %v", err)
	}
}

// goRecipientFile is what Go hands Swift for the SENDER direction: a recipient
// public key to seal to, and the exact content key it must seal.
//
// The private half is written here too. This directory is a per-run temporary
// the Swift driver creates and removes; the production Swift sealing primitive
// receives only `publicKey` and `contentKey`, while Go opens with the private
// half in the third phase.
type goRecipientFile struct {
	Algorithm  string `json:"algorithm"`
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
	ContentKey string `json:"contentKey"`
	// MintedBy names the implementation that produced PublicKey, so a file left
	// behind by something else cannot silently satisfy this gate.
	MintedBy string `json:"mintedBy"`
}

// swiftBoxFile is what the native sender hands back.
type swiftBoxFile struct {
	Algorithm  string `json:"algorithm"`
	WrappedKey string `json:"wrappedKey"`
	SealedBy   string `json:"sealedBy"`
}

// TestSwiftSealedBoxMintRecipient mints the target of a native send: a real
// X25519 recipient key and the exact content key the Swift sender must wrap.
//
// The recipient key goes through `inbox.ValidatePublicKey` before it is
// published, exactly as central would before a device row could carry it.
// Otherwise a later failure could mean "Swift sealed wrongly" when it actually
// means "Go offered a key no server would have stored".
func TestSwiftSealedBoxMintRecipient(t *testing.T) {
	dir := swiftInteropDir(t)

	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate recipient key: %v", err)
	}
	encodedPub := EncodeKeyBytes(pub[:])
	if _, err := inbox.ValidatePublicKey(inbox.KeyAlgX25519SealedBoxV1, encodedPub); err != nil {
		t.Fatalf("minted a recipient key central would reject: %v", err)
	}

	content := make([]byte, 32)
	if _, err := rand.Read(content); err != nil {
		t.Fatalf("mint content key: %v", err)
	}

	out, err := json.MarshalIndent(goRecipientFile{
		Algorithm:  inbox.KeyAlgX25519SealedBoxV1,
		PublicKey:  encodedPub,
		PrivateKey: EncodeKeyBytes(priv[:]),
		ContentKey: EncodeKeyBytes(content),
		MintedBy:   "relayium-go",
	}, "", "  ")
	if err != nil {
		t.Fatalf("encode go recipient file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go-recipient.json"), out, 0o600); err != nil {
		t.Fatalf("write go recipient file: %v", err)
	}
}

// TestSwiftSealedBoxOpen opens the box the REAL native sender produced, with
// the private half that never left this process, and asserts it is byte for
// byte the content key Go chose before Swift ran.
//
// Every failure here is fatal rather than skipped, and that is what makes the
// Swift-side negative control meaningful: a tampered box or a box sealed to
// somebody else's key must make this process EXIT NON-ZERO.
func TestSwiftSealedBoxOpen(t *testing.T) {
	dir := swiftInteropDir(t)

	var recipient goRecipientFile
	readSwiftJSON(t, filepath.Join(dir, "go-recipient.json"), &recipient)
	if recipient.MintedBy != "relayium-go" {
		t.Fatalf("go-recipient.json was not produced here (mintedBy=%q)", recipient.MintedBy)
	}

	var sealedFile swiftBoxFile
	readSwiftJSON(t, filepath.Join(dir, "swift-box.json"), &sealedFile)
	if sealedFile.SealedBy != "relayium-swift" {
		t.Fatalf("swift-box.json was not produced by the native sender (sealedBy=%q)", sealedFile.SealedBy)
	}
	if sealedFile.Algorithm != inbox.KeyAlgX25519SealedBoxV1 {
		t.Fatalf("native named algorithm %q, want %q", sealedFile.Algorithm, inbox.KeyAlgX25519SealedBoxV1)
	}

	sealed, err := DecodeKeyBytes(sealedFile.WrappedKey, inbox.SealedBoxBytes)
	if err != nil {
		t.Fatalf("the native sender produced a box that is not canonical %d-byte base64url: %v",
			inbox.SealedBoxBytes, err)
	}

	pubBytes, err := DecodeKeyBytes(recipient.PublicKey, 32)
	if err != nil {
		t.Fatalf("recipient public key: %v", err)
	}
	privBytes, err := DecodeKeyBytes(recipient.PrivateKey, 32)
	if err != nil {
		t.Fatalf("recipient private key: %v", err)
	}
	var pub, priv [32]byte
	copy(pub[:], pubBytes)
	copy(priv[:], privBytes)

	opened, ok := box.OpenAnonymous(nil, sealed, &pub, &priv)
	if !ok {
		t.Fatal("the box the native sender produced did not open under the recipient key")
	}
	want, err := DecodeKeyBytes(recipient.ContentKey, 32)
	if err != nil {
		t.Fatalf("expected content key: %v", err)
	}
	if !bytes.Equal(opened, want) {
		t.Fatal("the opened content key is not the one Go asked the native sender to wrap")
	}
	if len(opened) != 32 {
		t.Fatalf("opened %d bytes, the protocol wraps exactly 32", len(opened))
	}
}

// readSwiftJSON is this file's own reader rather than webinterop_test.go's:
// the two live under different build tags, so neither can see the other's
// helpers, and a shared one would have to move into the non-tagged package.
func readSwiftJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Base(path), err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("decode %s: %v", filepath.Base(path), err)
	}
}
