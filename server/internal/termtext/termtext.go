// Package termtext makes text that came from the other end of a connection fit
// to print on a terminal.
//
// It lives below both the CLI and xfer because both need it: xfer builds error
// text out of a peer's manifest paths and out of a peer's refusal message, and
// that text ends up on a terminal the library never sees.
package termtext

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Safe returns s fit to print on a terminal line. The receiving terminal is also
// where the SAS was just printed: an escape sequence in a peer's file name or
// refusal message must not be able to move the cursor and repaint it, and a
// newline must not forge a line of output. Ordinary text comes back unchanged;
// control characters, the Unicode line separators and bytes that are not UTF-8
// come back as visible Go-style escapes. It is idempotent: a backslash is not
// escaped, so text that passed through once passes through again unchanged.
func Safe(s string) string {
	clean := utf8.ValidString(s)
	for _, r := range s {
		if unsafeRune(r) {
			clean = false
			break
		}
	}
	if clean {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		r, width := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && width == 1:
			fmt.Fprintf(&b, `\x%02x`, s[i])
		case unsafeRune(r):
			q := strconv.QuoteRuneToASCII(r)
			b.WriteString(q[1 : len(q)-1])
		default:
			b.WriteRune(r)
		}
		i += width
	}
	return b.String()
}

// SafeAll is Safe over a list, for the places that print one.
func SafeAll(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = Safe(s)
	}
	return out
}

func unsafeRune(r rune) bool {
	return unicode.IsControl(r) || r == '\u2028' || r == '\u2029'
}
