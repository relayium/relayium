// Portable proof of the staging-name oracle.
//
// SCOPE: this proves the recogniser agrees with the generator. It proves nothing
// about Windows filesystem behaviour — but it is what stops every Windows
// no-residue assertion from being vacuous, and unlike those assertions it
// actually runs here.
package staging

import (
	"strings"
	"testing"
)

// The bug class this exists to prevent: a hand-written prefix comparison whose
// length is off by one never matches a real name, and every scan built on it
// silently returns nothing.
func TestPrefixLengthConstantsAgree(t *testing.T) {
	if len(Prefix) != 19 {
		t.Fatalf("Prefix is %d characters (%q); the constants below and every scanner derived from them assume 19", len(Prefix), Prefix)
	}
	if NameLen != 51 {
		t.Fatalf("NameLen is %d, want 51", NameLen)
	}
}

func TestGeneratedNamesAreRecognised(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 256; i++ {
		name, err := NewName()
		if err != nil {
			t.Fatalf("NewName: %v", err)
		}
		if !IsOwnedName(name) {
			t.Fatalf("the generator produced %q and the recogniser rejected it", name)
		}
		if len(name) != NameLen {
			t.Fatalf("generated name is %d characters, want %d", len(name), NameLen)
		}
		if seen[name] {
			t.Fatalf("NewName repeated %q", name)
		}
		seen[name] = true
	}
}

// The negative half. A scanner that matched these would claim directories this
// process does not own, and a cleanup built on it would delete a user's folder.
func TestDecoysAreRejected(t *testing.T) {
	valid, err := NewName()
	if err != nil {
		t.Fatal(err)
	}
	decoys := map[string]string{
		"prefix alone":            Prefix,
		"prefix with short hex":   Prefix + "abc",
		"prefix with long hex":    valid + "0",
		"non-hex suffix":          Prefix + strings.Repeat("z", SuffixLen),
		"uppercase hex":           Prefix + strings.ToUpper(valid[len(Prefix):]),
		"missing leading dot":     valid[1:],
		"similar user folder":     ".relayium-incoming",
		"plausible user folder":   "relayium-incoming-files",
		"unrelated hidden folder": ".git",
		"empty":                   "",
	}
	for name, candidate := range decoys {
		if IsOwnedName(candidate) {
			t.Errorf("%s: %q was claimed as an owned staging directory", name, candidate)
		}
	}
}
