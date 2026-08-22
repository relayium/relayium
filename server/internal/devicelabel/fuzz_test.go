package devicelabel

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// FuzzSanitize states the label contract as properties rather than as examples.
//
// The table tests next door pin what Sanitize does to the inputs somebody
// thought of. This pins what it may NEVER do to an input nobody thought of,
// which is the case that matters: the label is client-supplied (invariant 1),
// so every byte here is chosen by whoever is registering the device, and the
// result is rendered inside "Revoke <label>?" — the one sentence a person reads
// before a destructive action.
//
// The seeds are the current edge cases, kept deliberately: the bidi overrides
// and isolates, the zero-width and invisible marks, invalid UTF-8, the joiners
// two scripts spell ordinary words with, and the truncation boundary. A seed
// corpus that only held ASCII would leave the fuzzer to rediscover the Unicode
// classes this function exists for.
func FuzzSanitize(f *testing.F) {
	for _, seed := range []string{
		"",
		"prod-backup-1",
		"web-01.internal.example.com",
		"NAS (办公室)",
		"prod\u202Ebackup\u202D-1",         // RLO/LRO: reverses how the sentence reads
		"\u2066prod\u2069",                 // bidi isolates
		"pro\u200Bd\uFEFF",                 // zero-width space, ZWNBSP
		"pro\u00ADd",                       // soft hyphen
		"\u0645\u06CC\u200C\u062E",         // ZWNJ, which a real Persian label needs
		"\u0915\u200D\u0937",               // ZWJ, likewise
		"prod\x00\x07\x1b[31m",             // NUL, BEL, an ANSI escape
		"prod\xff\xfe",                     // invalid UTF-8
		"prod\xed\xa0\x80-1",               // lone surrogate bytes
		"  prod \n\t\u3000 1  ",            // every flavour of whitespace
		strings.Repeat("ab ", 64) + "tail", // past MaxRunes, cut mid-word
		strings.Repeat("\U0001F600", 200),  // past MaxRunes in a 4-byte rune
	} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, s string) {
		got := Sanitize(s)

		// A label central re-sanitizes must not change under it, or the name
		// the CLI printed before approval is not the name the account shows
		// afterwards (invariant 3).
		if again := Sanitize(got); again != got {
			t.Fatalf("Sanitize is not idempotent: Sanitize(%q) = %q, Sanitize(%q) = %q", s, got, got, again)
		}

		// Renderable at all. The input may be arbitrary bytes; the output is a
		// string this repository stores, logs and prints.
		if !utf8.ValidString(got) {
			t.Fatalf("Sanitize(%q) = %q, which is not valid UTF-8", s, got)
		}
		if n := utf8.RuneCountInString(got); n > MaxRunes {
			t.Fatalf("Sanitize(%q) kept %d runes, want at most %d", s, n, MaxRunes)
		}
		// Each input rune yields at most one output rune, and the collapsing
		// and trimming only remove. An output longer than its input would mean
		// something is being synthesized rather than filtered.
		if in, out := utf8.RuneCountInString(s), utf8.RuneCountInString(got); out > in {
			t.Fatalf("Sanitize(%q) grew from %d runes to %d", s, in, out)
		}

		// Invariant 2, restated per rune: nothing invisible, nothing that can
		// reorder the confirmation sentence, and no "this did not decode"
		// marker, survives into the stored label.
		for i, r := range got {
			if r == utf8.RuneError {
				t.Fatalf("Sanitize(%q) = %q kept U+FFFD at byte %d", s, got, i)
			}
			if dropped(r) {
				t.Fatalf("Sanitize(%q) = %q kept %U at byte %d, which dropped() refuses", s, got, r, i)
			}
			if unicode.IsSpace(r) && r != ' ' {
				t.Fatalf("Sanitize(%q) = %q kept the non-ASCII space %U at byte %d", s, got, r, i)
			}
		}

		// One line, single-spaced, no edges: the row it renders in is one line
		// wide, and a trailing space is what breaks idempotence after a cut.
		if strings.Contains(got, "  ") {
			t.Fatalf("Sanitize(%q) = %q contains a doubled space", s, got)
		}
		if got != strings.TrimSpace(got) {
			t.Fatalf("Sanitize(%q) = %q has edge whitespace", s, got)
		}

		// Valid is "storing this changes nothing", so it must agree with
		// Sanitize on Sanitize's own output — and must keep refusing the empty
		// label, which is the one an interactive rename has to reject.
		if got == "" {
			if Valid(got) {
				t.Fatalf("Valid(%q) = true; the empty label must never be storable", got)
			}
		} else if !Valid(got) {
			t.Fatalf("Sanitize(%q) = %q, which Valid rejects", s, got)
		}

		// An interactive rename may only differ from what it stores by
		// whitespace, so anything it accepts must survive as a valid label.
		if Acceptable(s) && !Valid(Sanitize(s)) {
			t.Fatalf("Acceptable(%q) = true but Sanitize gives %q, which Valid rejects", s, got)
		}
	})
}
