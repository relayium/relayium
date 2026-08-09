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
// Driven by `apps/RelayiumKit/Tests/RelayiumKitTests/InboxSealedBoxInteropTests.swift`.
package inboxclient

import (
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
