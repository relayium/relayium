package account

import (
	"encoding/base64"
	"strings"
	"testing"
)

// A canonical identifier: 32 random bytes, RawURLEncoding, 43 characters.
const sampleInstallID = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

// The identifier is a lookup KEY. Two textual spellings that decode to the same
// bytes would be two identities for one installation (or, worse, one identity
// claimed by two spellings), so only the canonical spelling is accepted — the
// same rule the Device Inbox key encoding already follows.
func TestValidInstallIDAcceptsOnlyTheCanonicalSpelling(t *testing.T) {
	if _, err := base64.RawURLEncoding.Strict().DecodeString(sampleInstallID); err != nil {
		t.Fatalf("the fixture itself is not canonical: %v", err)
	}
	if !validInstallID(sampleInstallID) {
		t.Fatalf("canonical 43-char identifier rejected: %q", sampleInstallID)
	}

	// The last base64 character of a 32-byte value carries two unused bits. A
	// permissive decoder accepts a spelling that sets them; a strict one does
	// not, and accepting both would map two strings onto one installation.
	nonCanonical := sampleInstallID[:42] + "9" // '8' is the canonical last char
	if nonCanonical == sampleInstallID {
		t.Fatal("fixture mutation did not change the last character")
	}
	for _, bad := range []string{
		"",                      // absent
		"   ",                   // whitespace
		strings.Repeat("A", 42), // too short
		strings.Repeat("A", 44), // too long
		sampleInstallID + "=",   // padded
		"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh/", // standard-base64 '/'
		"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh+", // standard-base64 '+'
		" " + sampleInstallID[1:],                     // leading space
		sampleInstallID[:42] + ".",                    // non-alphabet
		nonCanonical,                                  // non-zero trailing bits
	} {
		if validInstallID(bad) {
			t.Fatalf("accepted a non-canonical identifier: %q", bad)
		}
	}
}
