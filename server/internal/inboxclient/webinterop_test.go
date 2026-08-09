//go:build webinterop

// Cross-implementation proof for `x25519-sealedbox-v1`: a sealed box produced by
// the REAL browser implementation, opened by the REAL device implementation.
//
// Why this is a separate build tag rather than an ordinary test. The vector is
// not a frozen file: `crypto_box_seal` uses a fresh ephemeral key every call, so
// a committed box would either be stale (and prove nothing about today's browser
// code) or churn on every run. Instead the two halves are executed in one CI job
// and hand each other real material through a temporary directory:
//
//	go test -tags webinterop -run TestWebSealedBoxEmitDeviceKey   ← Go mints the device key AND the expected content key
//	npx vitest run src/lib/device-seal.interop.test.ts            ← the browser code seals that exact key
//	go test -tags webinterop -run TestWebSealedBoxOpen            ← Go opens it with the private half alone
//
// The direction of trust matters and is deliberate. The device keypair comes
// from `GenerateKeyPair` — the same function the CLI receiver uses — and the
// EXPECTED content key is written by this file before the browser has seen
// anything, so the assertion is never derived from the implementation under
// test. Nothing here is a self round trip: the sealing code and the opening code
// are different languages, different libraries (`libsodium-wrappers` vs.
// `golang.org/x/crypto/nacl/box`) and different processes.
//
// Driven by `web/src/lib/device-seal.interop.test.ts`; wired into CI as the
// `sealed-box-interop` job in `.github/workflows/web.yml`.
package inboxclient

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/relayium/relayium/internal/inbox"
)

// deviceKeyFile is what Go hands the browser: a real device public key to wrap
// to, and the exact bytes it must wrap. The private key travels through it too —
// this is a scratch directory created per CI run, and the whole point of the
// second phase is that ONLY this key opens the box.
type deviceKeyFile struct {
	Algorithm  string `json:"algorithm"`
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
	ContentKey string `json:"contentKey"`
}

// webBoxFile is what the browser hands back.
type webBoxFile struct {
	Algorithm  string `json:"algorithm"`
	WrappedKey string `json:"wrappedKey"`
	// SealedBy names the implementation that produced WrappedKey, so a file left
	// behind by something else cannot silently satisfy this gate.
	SealedBy string `json:"sealedBy"`
}

func interopDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("RELAYIUM_INTEROP_DIR")
	if dir == "" {
		// Never skipped: a gate that quietly passes when its environment is
		// missing is indistinguishable from a gate that ran.
		t.Fatal("RELAYIUM_INTEROP_DIR is not set; run this through web/src/lib/device-seal.interop.test.ts")
	}
	return dir
}

// TestWebSealedBoxEmitDeviceKey mints the device identity and the expected
// content key, using the same code path the CLI receiver uses.
func TestWebSealedBoxEmitDeviceKey(t *testing.T) {
	dir := interopDir(t)
	kp, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("generate device key: %v", err)
	}
	content := make([]byte, 32)
	if _, err := rand.Read(content); err != nil {
		t.Fatalf("random content key: %v", err)
	}
	out := deviceKeyFile{
		Algorithm:  inbox.KeyAlgX25519SealedBoxV1,
		PublicKey:  EncodeKeyBytes(kp.Public[:]),
		PrivateKey: EncodeKeyBytes(kp.Private[:]),
		ContentKey: EncodeKeyBytes(content),
	}
	// Central would refuse a key it considers unusable, so prove this one is
	// registrable before asking the browser to wrap to it. Otherwise a failure
	// in the next phase could mean "the browser is wrong" when it actually means
	// "we handed it a key no server would have published".
	if _, err := inbox.ValidatePublicKey(out.Algorithm, out.PublicKey); err != nil {
		t.Fatalf("generated a public key central would reject: %v", err)
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatalf("encode device key file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "device-key.json"), b, 0o600); err != nil {
		t.Fatalf("write device key file: %v", err)
	}
}

// TestWebSealedBoxOpen is the assertion the whole gate exists for.
func TestWebSealedBoxOpen(t *testing.T) {
	dir := interopDir(t)

	var key deviceKeyFile
	readJSON(t, filepath.Join(dir, "device-key.json"), &key)
	var box webBoxFile
	readJSON(t, filepath.Join(dir, "web-box.json"), &box)

	if box.SealedBy != "relayium-web" {
		t.Fatalf("web-box.json was not produced by the browser implementation (sealedBy=%q)", box.SealedBy)
	}
	if box.Algorithm != inbox.KeyAlgX25519SealedBoxV1 {
		t.Fatalf("browser named algorithm %q, want %q", box.Algorithm, inbox.KeyAlgX25519SealedBoxV1)
	}
	// Exactly what central validates before it will store the box, applied to
	// the browser's output rather than to our own.
	raw, err := DecodeKeyBytes(box.WrappedKey, inbox.SealedBoxBytes)
	if err != nil {
		t.Fatalf("browser produced a wrapped key central would reject: %v", err)
	}
	if len(raw) != inbox.SealedBoxBytes {
		t.Fatalf("wrapped key is %d bytes, want %d", len(raw), inbox.SealedBoxBytes)
	}

	kp := keyPairFrom(t, key.PublicKey, key.PrivateKey)
	got, err := UnsealContentKey(box.Algorithm, box.WrappedKey, kp)
	if err != nil {
		t.Fatalf("the device could not open a box the browser sealed to it: %v", err)
	}
	want := decodeOrFail(t, key.ContentKey, 32)
	if string(got) != string(want) {
		t.Fatal("the unsealed content key is not the one this test asked the browser to wrap")
	}

	t.Run("a different device cannot open it", func(t *testing.T) {
		other, err := GenerateKeyPair()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if _, err := UnsealContentKey(box.Algorithm, box.WrappedKey, other); err == nil {
			t.Fatal("a box sealed to one device opened with another device's key")
		}
	})

	t.Run("the private half alone decides", func(t *testing.T) {
		// The real public half with somebody else's private half: a sealed box
		// derives its shared secret from the private key, so this must fail even
		// though the public key matches the recipient central published.
		other, err := GenerateKeyPair()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		mixed := KeyPair{Public: kp.Public, Private: other.Private}
		if _, err := UnsealContentKey(box.Algorithm, box.WrappedKey, mixed); err == nil {
			t.Fatal("a mismatched public/private pair opened the box")
		}
	})

	t.Run("tampering is refused at every offset", func(t *testing.T) {
		// The ephemeral public key, the ciphertext and the Poly1305 tag, one
		// byte each: all three are covered by the AEAD.
		for _, at := range []int{0, 31, 40, len(raw) - 1} {
			bad := append([]byte(nil), raw...)
			bad[at] ^= 0x01
			if _, err := UnsealContentKey(box.Algorithm, EncodeKeyBytes(bad), kp); err == nil {
				t.Fatalf("a box tampered at byte %d still opened", at)
			}
		}
	})

	t.Run("a truncated or over-long box is refused before any crypto runs", func(t *testing.T) {
		for _, bad := range [][]byte{raw[:len(raw)-1], append(append([]byte(nil), raw...), 0)} {
			if _, err := UnsealContentKey(box.Algorithm, EncodeKeyBytes(bad), kp); err == nil {
				t.Fatalf("a %d-byte box was accepted", len(bad))
			}
		}
	})

	t.Run("a non-canonical spelling of the same bytes is refused", func(t *testing.T) {
		// Padded base64url decodes to identical bytes but is a second spelling,
		// and identity comparisons in this protocol are string comparisons.
		if _, err := UnsealContentKey(box.Algorithm, box.WrappedKey+"=", kp); err == nil {
			t.Fatal("a padded spelling was accepted")
		}
	})

	t.Run("another algorithm token is refused", func(t *testing.T) {
		if _, err := UnsealContentKey("x25519-sealedbox-v2", box.WrappedKey, kp); err == nil {
			t.Fatal("an unknown wrap algorithm was accepted")
		}
	})
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Base(path), err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("decode %s: %v", filepath.Base(path), err)
	}
}

func decodeOrFail(t *testing.T, encoded string, want int) []byte {
	t.Helper()
	raw, err := DecodeKeyBytes(encoded, want)
	if err != nil {
		t.Fatalf("decode key material: %v", err)
	}
	return raw
}

func keyPairFrom(t *testing.T, pub, priv string) KeyPair {
	t.Helper()
	var kp KeyPair
	copy(kp.Public[:], decodeOrFail(t, pub, 32))
	copy(kp.Private[:], decodeOrFail(t, priv, 32))
	return kp
}
