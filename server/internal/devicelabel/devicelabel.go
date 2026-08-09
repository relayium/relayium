// Package devicelabel owns the one definition of an account-visible device
// label, shared by central and the CLI.
//
// It is shared rather than duplicated because `relayium login` prints the label
// it is about to register BEFORE the browser approves it (DECISION-LOG
// 2026-08-04). If the two sides sanitized differently, the terminal would show
// one identity and the account list would show another — and the whole point of
// the label is that a human can match the row in My Devices to the machine in
// front of them before pressing a destructive Revoke.
//
// INVARIANTS. Each is asserted in devicelabel_test.go.
//
//  1. NOT AN AUTHENTICATION SIGNAL. The label is client-supplied, descriptive
//     and spoofable. Nothing may authorize on it. Duplicate labels are legal —
//     the account list disambiguates with a short suffix of the opaque device
//     ID, not with the name.
//  2. NOTHING INVISIBLE SURVIVES. A label ends up inside a revoke confirmation
//     ("Revoke prod-backup-1?"). A bidi override or an embedded newline there
//     can make two different machines render identically, or make the sentence
//     read as something it does not say. Those characters are removed, not
//     escaped by the renderer downstream.
//  3. IDEMPOTENT AND BOUNDED. Sanitize(Sanitize(s)) == Sanitize(s), and the
//     result is at most MaxRunes runes, so central re-sanitizing what the CLI
//     already sanitized cannot change the printed label.
package devicelabel

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxRunes bounds a label in RUNES, not bytes: a 64-character Japanese hostname
// is as reasonable as a 64-character ASCII one, and a byte bound would silently
// cut one of them to a third of the other. Long enough for a fully-qualified
// hostname (255 bytes is the DNS limit, but a name that long is unreadable in a
// list row) and short enough that a row cannot be made to push the revoke
// button off screen.
const MaxRunes = 64

// Fallback is the label used when nothing usable was supplied. It is the name
// every CLI device carried before labels existed, so a legacy CLI, a hostile
// empty label and a machine whose hostname cannot be read all converge on the
// row users already know rather than on a blank one.
const Fallback = "CLI"

// Sanitize returns the label that may be persisted and displayed, or "" if the
// input contained nothing usable. Callers decide what "" means: the device-code
// flow substitutes Fallback, while an interactive rename refuses it (see
// Valid).
//
// The transformation, in order:
//
//   - invalid UTF-8 bytes are dropped (they cannot be rendered anywhere);
//   - every whitespace character — including tabs, newlines and the exotic
//     Unicode spaces — becomes one ASCII space, so a multi-line label cannot
//     break the single-line row it is rendered in;
//   - control, surrogate, private-use, and format characters are dropped;
//   - runs of spaces collapse and the ends are trimmed;
//   - the result is truncated to MaxRunes and trimmed again, so truncation
//     cannot leave a trailing space.
func Sanitize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == utf8.RuneError:
			// Range-over-string yields RuneError with size 1 for each invalid
			// byte. A literal U+FFFD the user typed is dropped too; it is a
			// "this did not decode" marker, never part of a real machine name.
			continue
		case unicode.IsSpace(r):
			b.WriteByte(' ')
		case dropped(r):
			continue
		default:
			b.WriteRune(r)
		}
	}
	return truncate(strings.Join(strings.Fields(b.String()), " "))
}

// dropped reports whether a rune must not appear in an account-visible label.
//
// Cc/Cs/Co are unrenderable or meaningless in text. Cf is the security-relevant
// one: it holds the bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069)
// that can reverse how a confirmation sentence reads, plus zero-width and
// invisible marks that make two distinct labels pixel-identical.
//
// ZWJ and ZWNJ are the deliberate exceptions. They are Cf, but they join and
// separate glyphs rather than reorder them, and Persian, Hindi and several
// other scripts need them to spell ordinary words. Dropping them would corrupt
// a legitimate label in those languages to buy nothing: they cannot forge a
// different reading order, only a different ligature.
// The two exceptions are spelled as escapes on purpose: written literally they
// are invisible in source, and an editor or a merge could delete one without
// leaving a trace in the diff.
func dropped(r rune) bool {
	if r == '\u200C' || r == '\u200D' { // ZWNJ, ZWJ
		return false
	}
	return unicode.In(r, unicode.Cc, unicode.Cf, unicode.Cs, unicode.Co)
}

// truncate cuts to MaxRunes runes on a rune boundary, then trims — cutting mid
// word can leave a trailing space that would otherwise survive as part of the
// stored label and break Sanitize's idempotence.
func truncate(s string) string {
	if utf8.RuneCountInString(s) <= MaxRunes {
		return s
	}
	n := 0
	for i := range s {
		if n == MaxRunes {
			return strings.TrimSpace(s[:i])
		}
		n++
	}
	return s
}

// Valid reports whether s is already exactly what Sanitize would produce and is
// non-empty — i.e. storing s changes nothing.
func Valid(s string) bool {
	return s != "" && Sanitize(s) == s
}

// Acceptable reports whether s may be stored by an INTERACTIVE rename, where
// the only difference Sanitize is allowed to make is whitespace normalization.
//
// The device-code flow sanitizes silently, because there is no one at the
// keyboard to tell and a login must not fail over a cosmetic label. A rename is
// the opposite: a person typed or pasted this and pressed save. Quietly storing
// something else — a pasted name whose invisible bidi mark was removed, a
// 300-character paste cut to 64 — hands them a row whose name they did not
// choose, in the list they are supposed to use to identify machines before
// revoking one. Trailing and doubled spaces are the exception: nobody decides
// those on purpose.
func Acceptable(s string) bool {
	clean := Sanitize(s)
	return clean != "" && clean == strings.Join(strings.Fields(s), " ")
}
