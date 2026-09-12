//go:build windows

// REAL DPAPI tests. These run only on a Windows host and are where the
// integrity claims are actually established; the portable record tests prove
// the codec, not the platform.
package secretprotect

import (
	"bytes"
	"errors"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/relayium/relayium/apps/windows/native/internal/secretframe"
)

// Markers for -v readback, matching the convention the file-IO helper uses.
//
// `unprovenPrefix` was removed with the last thing in this package that
// reported one: cross-user protection, now proven a layer up. A marker constant
// with no user is a package that looks like it still declares something
// unproven to anybody grepping for it.
const provenPrefix = "PROVEN-INVARIANT:"

func TestRoundTripThroughRealDPAPI(t *testing.T) {
	p := New()
	for _, size := range []int{0, 1, 32, 4096, secretframe.MaxPlaintextBytes} {
		plaintext := make([]byte, size)
		for i := range plaintext {
			plaintext[i] = byte(i * 31)
		}
		blob, err := p.Seal(plaintext)
		if err != nil {
			t.Fatalf("Seal(%d): %v", size, err)
		}
		if len(blob) > secretframe.MaxBlobBytes {
			t.Fatalf("a %d-byte plaintext sealed to %d bytes, past the %d bound",
				size, len(blob), secretframe.MaxBlobBytes)
		}
		// The blob must not contain the plaintext.
		if size > 16 && bytes.Contains(blob, plaintext) {
			t.Fatal("the sealed blob contains its own plaintext")
		}
		opened, err := p.Open(blob)
		if err != nil {
			t.Fatalf("Open(%d): %v", size, err)
		}
		if !bytes.Equal(opened, plaintext) {
			t.Fatalf("round trip lost a %d-byte secret", size)
		}
	}
	t.Logf("%s user-scope DPAPI seals and opens through the real API at every size up to the bound", provenPrefix)
}

// What a tampered blob must do, and the claim this test deliberately does NOT
// make.
//
// CryptUnprotectData's documented remarks say a corrupted blob may fail with
// varying error codes, and that some corruption may SUCCEED and return
// corrupted output:
// https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata
//
// A DPAPI blob is an opaque platform structure whose format this side does not
// interpret. That format may permit a mutation that does not change the
// protected payload, in which case the unprotect legitimately succeeds and
// returns the record that was sealed. An earlier version of this test demanded
// an error for EVERY mutated position, which is an assertion about blob
// byte-canonicality: the platform's business, not a property this helper
// implements, promises, or needs. It failed on a real Windows host at one
// position, where the ONLY thing observed was that 43 bytes came back —
// whether those bytes were the secret that was sealed was never measured, and
// nothing here attributes that outcome to any field of the blob. Measuring it
// is what this test is for.
//
// The property that must hold is that no mutation yields ALTERED plaintext.
// Every mutated blob has to land in exactly one of:
//
//	refused    an error AND no output at all, or
//	unchanged  no error AND a byte-for-byte identical secret.
//
// A different secret, a shorter one, a partial one, or any output alongside an
// error is a failure. Equal length is not equality, so the comparison is over
// the bytes and not over len(). No position is assumed to behave one way or the
// other: there is no offset table here and no knowledge of the blob's layout.
func TestTamperedBlobNeverReturnsAlteredPlaintext(t *testing.T) {
	p := New()
	original := []byte("the quick brown fox jumps over the lazy dog")
	plaintext := append([]byte(nil), original...)
	blob, err := p.Seal(plaintext)
	if err != nil {
		t.Fatal(err)
	}

	// Two mutations per position. A single low-bit flip can be absorbed by a
	// field only its other bits feed, and a full inversion cannot.
	masks := []byte{0x01, 0xFF}

	refused, unchanged := 0, 0
	for i := 0; i < len(blob); i++ {
		for _, mask := range masks {
			corrupted := append([]byte(nil), blob...)
			corrupted[i] ^= mask
			out, err := p.Open(corrupted)
			switch {
			case err != nil:
				if len(out) != 0 {
					t.Fatalf("byte %d ^ %#02x: a refusal returned %d bytes", i, mask, len(out))
				}
				if !errors.Is(err, ErrRefused) {
					t.Fatalf("byte %d ^ %#02x: %v is not the single refusal this package reports", i, mask, err)
				}
				refused++
			case bytes.Equal(out, original):
				// Measured, not inferred: the returned payload is exactly the
				// secret that was sealed, and the inner record verified before
				// it was returned. Nothing was altered, so nothing is wrong.
				// Why this position behaved this way is not this test's claim.
				unchanged++
			default:
				t.Fatalf("byte %d ^ %#02x: opened and returned %d bytes that are NOT the secret that was sealed",
					i, mask, len(out))
			}
		}
	}
	if refused == 0 {
		// Without at least one real refusal this test would pass on a build
		// where corruption never reaches the protected bytes at all, proving
		// nothing about the inner record.
		t.Fatalf("not one of %d mutations was refused", len(blob)*len(masks))
	}
	t.Logf("%s no single-byte mutation of a sealed blob yields altered plaintext: %d refused with no output, "+
		"%d opened byte-for-byte unchanged, 0 altered, over %d positions",
		provenPrefix, refused, unchanged, len(blob))
}

func TestTruncatedBlobIsRefused(t *testing.T) {
	p := New()
	blob, err := p.Seal([]byte("something worth protecting"))
	if err != nil {
		t.Fatal(err)
	}
	for _, cut := range []int{0, 1, len(blob) / 2, len(blob) - 1} {
		if out, err := p.Open(blob[:cut]); err == nil {
			t.Fatalf("a blob truncated to %d bytes opened, returning %d bytes", cut, len(out))
		}
	}
}

// A raw DPAPI blob written by something else — including Electron — is not our
// record and must not be interpreted as one.
func TestForeignDPAPIBlobIsRefused(t *testing.T) {
	foreign := []byte("a protected value this helper did not write")
	in := windows.DataBlob{Size: uint32(len(foreign)), Data: &foreign[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		t.Fatalf("CryptProtectData: %v", err)
	}
	blob, ok := takeBounded(&out, secretframe.MaxBlobBytes)
	if !ok {
		t.Fatal("a foreign blob exceeded the bound")
	}

	// DPAPI itself will happily unprotect this: it is a valid blob for this
	// user. The refusal has to come from the inner record.
	if opened, err := New().Open(blob); err == nil {
		t.Fatalf("a foreign DPAPI blob was accepted, returning %d bytes", len(opened))
	}
	t.Logf("%s a valid DPAPI blob without our inner record is refused rather than interpreted", provenPrefix)
}

// protectRaw protects arbitrary bytes with the real API, bypassing Seal, so a
// record this package would never build can still be handed a blob the OS
// considers entirely valid.
func protectRaw(t *testing.T, record []byte) []byte {
	t.Helper()
	if len(record) == 0 {
		t.Fatal("nothing to protect")
	}
	in := blobOf(record)
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		t.Fatalf("CryptProtectData: %v", err)
	}
	blob, ok := takeBounded(&out, secretframe.MaxBlobBytes)
	if !ok {
		t.Fatal("a raw blob exceeded the bound")
	}
	return blob
}

// unprotectRaw is the API call Open makes, without the record verification. A
// test uses it to establish that the OS itself accepts a blob BEFORE asserting
// that this package refuses it anyway.
func unprotectRaw(t *testing.T, blob []byte) ([]byte, bool) {
	t.Helper()
	in := blobOf(blob)
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		releaseBlob(&out)
		return nil, false
	}
	record, ok := takeBounded(&out, secretframe.MaxRecordBytes)
	if !ok {
		t.Fatal("the API returned a record past the bound")
	}
	return record, true
}

// The other direction, and the one that shows where the integrity claim
// actually lives: a blob the real API unprotects SUCCESSFULLY, carrying a
// record that does not verify. Each case is protected with a raw
// CryptProtectData, so DPAPI has no reason to object to any of them — and the
// unprotect is performed here to prove that rather than assume it. The refusal
// can only come from the inner record.
//
// The digest case is the central one: a payload changed without recomputing the
// hash over it is precisely what a decrypt-and-return implementation would hand
// back as plaintext. The portable tests in secretframe own the exhaustive field
// matrix; these are the few that are worth paying a real API call for.
func TestValidDpapiBlobWithABrokenInnerRecordIsRefused(t *testing.T) {
	plaintext := []byte("a secret that must never come back altered")

	cases := []struct {
		name    string
		corrupt func(record []byte) []byte
	}{
		{
			// The reason the digest is in the record at all.
			"a payload byte changed without recomputing the digest",
			func(record []byte) []byte {
				record[len(record)-1] ^= 0x01
				return record
			},
		},
		{
			// A record shortened inside the protected bytes still parses as
			// bytes; only the declared length disagrees.
			"a record truncated inside its payload",
			func(record []byte) []byte { return record[:len(record)-1] },
		},
		{
			// Trailing bytes inside the protected record are as much a
			// mismatch as missing ones.
			"a byte appended after the declared payload",
			func(record []byte) []byte { return append(record, 0x00) },
		},
		{
			// Not our record any more, which is the same refusal a foreign
			// producer's blob gets.
			"the domain name altered",
			func(record []byte) []byte {
				record[0] ^= 0x01
				return record
			},
		},
	}

	// A subtest failure does not stop the parent, so the marker below must not
	// be emitted on the strength of a loop that merely finished.
	allRefused := true
	for _, tc := range cases {
		allRefused = t.Run(tc.name, func(t *testing.T) {
			record, err := secretframe.SealRecord(plaintext)
			if err != nil {
				t.Fatal(err)
			}
			valid := append([]byte(nil), record...)
			broken := tc.corrupt(record)
			if bytes.Equal(broken, valid) {
				t.Fatal("the mutation left the record unchanged, so this case would prove nothing")
			}
			blob := protectRaw(t, broken)

			// The claim is about a blob the OS is happy with, so establish that
			// first. A refusal from DPAPI itself would make the assertion below
			// evidence about the API rather than about the inner record.
			returned, ok := unprotectRaw(t, blob)
			if !ok {
				t.Fatal("the real API refused a blob it had just produced")
			}
			if !bytes.Equal(returned, broken) {
				t.Fatal("the real API returned bytes other than the ones protected")
			}

			out, err := New().Open(blob)
			if err == nil {
				t.Fatalf("a blob the OS unprotected successfully was accepted, returning %d bytes", len(out))
			}
			if len(out) != 0 {
				t.Fatalf("a refusal returned %d bytes", len(out))
			}
			if !errors.Is(err, ErrRefused) {
				t.Fatalf("%v is not the single refusal this package reports", err)
			}
		}) && allRefused
	}
	if !allRefused {
		return
	}
	t.Logf("%s a real DPAPI blob that unprotects successfully is still refused when its inner record does not verify",
		provenPrefix)
}

func TestOversizeInputsAreRefused(t *testing.T) {
	p := New()
	if _, err := p.Seal(make([]byte, secretframe.MaxPlaintextBytes+1)); err == nil {
		t.Fatal("sealed a plaintext above the bound")
	}
	if _, err := p.Open(make([]byte, secretframe.MaxBlobBytes+1)); err == nil {
		t.Fatal("opened a blob above the bound")
	}
	if _, err := p.Open(nil); err == nil {
		t.Fatal("opened an empty blob")
	}
}

// Cross-user protection is a real property of user-scope DPAPI, and this layer
// still does not prove it — a test here calls the API in-process, so "another
// user" would mean launching a subprocess, which is exactly what the layer
// above already does.
//
// It is PROVEN there, against a real second account: see `TestCrossUser` in
// `internal/secrethelpertest`, which runs the SHIPPED executable as a second
// local account created by CI. That account must seal its own blob before
// anything is concluded from a refusal, because an account with no DPAPI master
// key would fail to open anything at all.
//
// This says so rather than repeating `UNPROVEN`. A reader grepping that marker
// for a security review would otherwise conclude the boundary is untested, which
// stopped being true on run 34674997632.
func TestCrossUserIsProvenByTheLayerThatShips(t *testing.T) {
	t.Logf("cross-user protection is proven in internal/secrethelpertest TestCrossUser, " +
		"against a real second account, not here: this layer calls the API in-process.")
}

// The bound is enforced BEFORE the copy, so an over-bound API result is never
// duplicated on its way to being rejected.
func TestOverBoundApiResultIsReleasedWithoutCopying(t *testing.T) {
	payload := []byte("some protected bytes")
	in := windows.DataBlob{Size: uint32(len(payload)), Data: &payload[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		t.Fatalf("CryptProtectData: %v", err)
	}
	size := int(out.Size)
	// A bound one byte below what the API actually returned.
	copied, ok := takeBounded(&out, size-1)
	if ok {
		t.Fatal("an over-bound result was accepted")
	}
	if copied != nil {
		t.Fatalf("an over-bound result was copied: %d bytes", len(copied))
	}
	// Released either way: the handle is cleared.
	if out.Data != nil || out.Size != 0 {
		t.Fatal("the API buffer was not released")
	}
}

func TestReleaseBlobIsSafeOnAnEmptyResult(t *testing.T) {
	var out windows.DataBlob
	releaseBlob(&out)
	if out.Data != nil || out.Size != 0 {
		t.Fatal("releasing an empty blob left state behind")
	}
}
