package devicelabel

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSanitizeKeepsOrdinaryNames(t *testing.T) {
	// The names people actually use. None of them may be altered: a label that
	// changes on the way in is a label the terminal printed wrong.
	for _, s := range []string{
		"prod-backup-1",
		"web-01.internal.example.com",
		"Lily's MacBook Pro",
		"NAS (办公室)",
		"サーバー1",
		"خادم-الاحتياطي",
		"a",
	} {
		if got := Sanitize(s); got != s {
			t.Errorf("Sanitize(%q) = %q, want unchanged", s, got)
		}
		if !Valid(s) {
			t.Errorf("Valid(%q) = false, want true", s)
		}
	}
}

func TestSanitizeRemovesInvisibleAndReorderingCharacters(t *testing.T) {
	// Every one of these ends up inside "Revoke <label>?". A bidi override there
	// reverses how the sentence reads; a zero-width mark makes two different
	// machines render identically in a list whose entire job is telling them
	// apart.
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"RLO override", "prod\u202Ebackup", "prodbackup"},
		{"LRO override", "prod\u202Dbackup", "prodbackup"},
		{"bidi isolates", "\u2066prod\u2069-1", "prod-1"},
		{"ARABIC LETTER MARK", "srv\u061C-1", "srv-1"},
		{"LRM/RLM", "srv\u200E\u200F-1", "srv-1"},
		{"zero-width space", "pro\u200Bd", "prod"},
		{"zero-width no-break space", "\uFEFFprod", "prod"},
		{"soft hyphen", "pro\u00ADd", "prod"},
		{"NUL", "prod\x00-1", "prod-1"},
		{"BEL and ESC", "\x07prod\x1b[31m", "prod[31m"},
		{"DEL", "prod\x7f", "prod"},
		{"private use", "prod\uE000", "prod"},
		{"lone surrogate bytes", "prod\xed\xa0\x80-1", "prod-1"},
		{"invalid UTF-8", "prod\xff\xfe", "prod"},
		{"nothing but invisibles", "\u202E\u200B\x00", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Sanitize(c.in)
			if got != c.want {
				t.Errorf("Sanitize(%q) = %q, want %q", c.in, got, c.want)
			}
			if Valid(c.in) {
				t.Errorf("Valid(%q) = true; a label needing sanitization must be refused by an interactive rename", c.in)
			}
		})
	}
}

func TestSanitizeKeepsJoinersScriptsNeed(t *testing.T) {
	// ZWNJ and ZWJ are Cf like the bidi overrides, but they cannot reorder
	// anything — and Persian/Hindi spell ordinary words with them. Dropping them
	// would corrupt a legitimate name to buy nothing.
	for _, s := range []string{"می\u200Cخواهم", "क\u200Dष"} {
		if got := Sanitize(s); got != s {
			t.Errorf("Sanitize(%q) = %q, want unchanged — a script's own joiner was stripped", s, got)
		}
	}
}

func TestSanitizeFlattensWhitespace(t *testing.T) {
	// The row renders on one line. A label carrying its own newline would either
	// break the row or, worse, hide everything after the break from the person
	// reading the confirmation.
	cases := []struct{ in, want string }{
		{"  prod-1  ", "prod-1"},
		{"prod\n-1", "prod -1"},
		{"prod\r\n-1", "prod -1"},
		{"prod\t-1", "prod -1"},
		{"prod\u2028-1", "prod -1"},
		{"prod\u2029-1", "prod -1"},
		{"prod\u00A0-1", "prod -1"},
		{"prod\u2003-1", "prod -1"},
		{"prod\u3000-1", "prod -1"},
		{"prod    -    1", "prod - 1"},
		{"\n\t ", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := Sanitize(c.in); got != c.want {
			t.Errorf("Sanitize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeBoundsLength(t *testing.T) {
	// Runes, not bytes: a multi-byte name must get the same allowance as an
	// ASCII one instead of being cut to a third of it.
	for _, unit := range []string{"a", "字", "😀"} {
		long := strings.Repeat(unit, MaxRunes*3)
		got := Sanitize(long)
		if n := utf8.RuneCountInString(got); n != MaxRunes {
			t.Errorf("Sanitize(%d×%q) kept %d runes, want %d", MaxRunes*3, unit, n, MaxRunes)
		}
		if !utf8.ValidString(got) {
			t.Errorf("truncation split a rune for unit %q", unit)
		}
	}
	// Truncation must not leave a trailing space, or the stored label would
	// differ from the one Sanitize would produce from it — see idempotence.
	spaced := strings.Repeat("ab ", MaxRunes)
	got := Sanitize(spaced)
	if got != strings.TrimSpace(got) {
		t.Errorf("Sanitize(%q) = %q has edge whitespace", spaced, got)
	}
}

func TestSanitizeIsIdempotent(t *testing.T) {
	// Central re-sanitizes what the CLI already sanitized. If that were not a
	// no-op, the label printed in the terminal would not be the label the
	// account ends up showing — which is the entire requirement.
	inputs := []string{
		"prod-backup-1",
		"  pro\u202Ed \n -1 ",
		strings.Repeat("字 ", MaxRunes),
		strings.Repeat("a", MaxRunes*2),
		"\x00\x01\x02",
		"می\u200Cخواهم",
	}
	for _, in := range inputs {
		once := Sanitize(in)
		if twice := Sanitize(once); twice != once {
			t.Errorf("Sanitize not idempotent for %q: %q then %q", in, once, twice)
		}
		if once != "" && !Valid(once) {
			t.Errorf("Sanitize(%q) = %q, which Valid rejects", in, once)
		}
	}
}

func TestValidRejectsEmpty(t *testing.T) {
	// "" is what an interactive rename must refuse; the device-code flow
	// substitutes Fallback instead. Both callers need "" to be distinguishable
	// from a usable label rather than quietly stored.
	for _, s := range []string{"", " ", "\u200B", "\x00"} {
		if Valid(s) {
			t.Errorf("Valid(%q) = true, want false", s)
		}
	}
	if !Valid(Fallback) {
		t.Errorf("Valid(%q) = false; the fallback label must itself be storable", Fallback)
	}
}
