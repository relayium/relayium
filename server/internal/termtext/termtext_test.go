package termtext

import "testing"

func TestSafe(t *testing.T) {
	// Built from code points: a control character typed into a source file is
	// exactly the kind of thing this package exists to keep off a terminal.
	esc, del, ls := string(rune(0x1b)), string(rune(0x7f)), string(rune(0x2028))
	for _, tc := range []struct{ name, in, want string }{
		{"ordinary", "docs/报告 final.pdf", "docs/报告 final.pdf"},
		{"escape sequence", "a" + esc + "[2Jb", `a\x1b[2Jb`},
		{"newline forges a line", "ok\nverification code (SAS): 000000", `ok\nverification code (SAS): 000000`},
		{"carriage return repaints", "x\rSAS", `x\rSAS`},
		{"delete", "a" + del, `a\x7f`},
		{"unicode line separator", "a" + ls + "b", `a` + "\\" + `u2028b`},
		{"invalid utf-8", "a\xffb", `a\xffb`},
		{"backslash is left alone", `a\nb`, `a\nb`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Safe(tc.in)
			if got != tc.want {
				t.Fatalf("Safe = %q, want %q", got, tc.want)
			}
			if again := Safe(got); again != got {
				t.Fatalf("not idempotent: %q then %q", got, again)
			}
		})
	}
	if got := SafeAll([]string{"a", "b" + esc}); len(got) != 2 || got[0] != "a" || got[1] != `b\x1b` {
		t.Fatalf("SafeAll = %q", got)
	}
}
