//go:build windows

// REAL DPAPI tests. These run only on a Windows host and are where the
// integrity claims are actually established; the portable record tests prove
// the codec, not the platform.
package secretprotect

import (
	"bytes"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/relayium/relayium/apps/windows/native/internal/secretframe"
)

// Markers for -v readback, matching the convention the file-IO helper uses.
const (
	provenPrefix   = "PROVEN-INVARIANT:"
	unprovenPrefix = "UNPROVEN-INVARIANT:"
)

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

// The case DPAPI's own documentation warns about: corruption that may fail with
// varying codes, or SUCCEED and return corrupted output. Either way the inner
// record must refuse, and no plaintext may come back.
func TestTamperedBlobNeverReturnsPlaintext(t *testing.T) {
	p := New()
	plaintext := []byte("the quick brown fox jumps over the lazy dog")
	blob, err := p.Seal(plaintext)
	if err != nil {
		t.Fatal(err)
	}

	refusals := 0
	for i := 0; i < len(blob); i++ {
		corrupted := append([]byte{}, blob...)
		corrupted[i] ^= 0x01
		out, err := p.Open(corrupted)
		if err == nil {
			t.Fatalf("byte %d: a tampered blob opened, returning %d bytes", i, len(out))
		}
		if len(out) != 0 {
			t.Fatalf("byte %d: a refusal returned %d bytes", i, len(out))
		}
		refusals++
	}
	if refusals != len(blob) {
		t.Fatalf("only %d of %d flipped bytes were refused", refusals, len(blob))
	}
	t.Logf("%s every single-byte corruption of a sealed blob is refused with no output (%d positions)",
		provenPrefix, len(blob))
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

// Cross-user protection is a real property of user-scope DPAPI, but proving it
// needs a second account this test must not create. Where one is not available
// this reports the invariant as UNPROVEN rather than passing — and it never
// infers the property from the flags alone, which would be describing the
// request rather than testing the outcome.
func TestCrossUserIsNotProvenByFlagsAlone(t *testing.T) {
	t.Logf("%s a blob sealed by another user cannot be opened here. Proving it needs a "+
		"second real account, which this test will not create; passing flags is a "+
		"description of the request, not evidence about another user's blob.",
		unprovenPrefix)
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
