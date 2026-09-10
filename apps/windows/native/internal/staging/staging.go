// The staging directory naming rule, in one portable place.
//
// ## Why this is not just a string constant in the Windows sink
//
// The Windows tests assert "no staging residue" by scanning the destination root
// for directories this process owns. That assertion is only as good as the
// scanner: if the predicate never matches a real name, every no-residue check
// passes vacuously and reports success for bytes still on disk. Those tests run
// only on Windows, so the oracle would go unverified exactly where it matters.
//
// So the rule lives here, portably, is used by both the sink that CREATES the
// name and the tests that RECOGNISE it, and is proven by a test that runs on any
// host. One definition, and the oracle cannot silently disagree with the thing
// it is checking.
package staging

import (
	"crypto/rand"
	"encoding/hex"
)

// Prefix marks a directory as belonging to a receive lease.
const Prefix = ".relayium-incoming-"

// SuffixLen is the hex length of the random component: 16 bytes, 32 characters.
const SuffixLen = 32

// NameLen is the exact total length of a well-formed staging directory name.
const NameLen = len(Prefix) + SuffixLen

// NewName mints a staging directory name.
//
// The random component is not a secret and does not need to be: any process
// running as this user can enumerate the folder. What it provides is that
// FILE_CREATE will not collide with a concurrent lease, so each helper provably
// creates its own directory rather than adopting one.
func NewName() (string, error) {
	var raw [SuffixLen / 2]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return Prefix + hex.EncodeToString(raw[:]), nil
}

// IsOwnedName reports whether a directory entry is a staging directory of the
// shape NewName produces.
//
// Deliberately strict — prefix, exact length AND lowercase hex. A loose prefix
// match would claim a user's own similarly-named folder, and a cleanup or
// residue check built on that would be reasoning about something it does not own.
func IsOwnedName(name string) bool {
	if len(name) != NameLen {
		return false
	}
	if name[:len(Prefix)] != Prefix {
		return false
	}
	for i := len(Prefix); i < len(name); i++ {
		c := name[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
