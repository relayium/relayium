package linkwire

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"unicode/utf8"
)

// Untrusted JSON is never decoded into a struct: encoding/json matches struct
// field names case-insensitively, so {"LINK":true} would satisfy a `link` field
// and a smuggled case variant would slip past an exact-key allow-list. Objects
// are decoded into map[string]json.RawMessage instead, whose keys are exact and
// where a duplicate key keeps the LAST value, as JSON.parse does.

// validJSON checks that b is exactly one JSON value, valid UTF-8, and free of
// unpaired UTF-16 surrogate escapes. encoding/json would silently replace both
// invalid UTF-8 and a lone surrogate with U+FFFD; accepting that as the peer's
// bytes would claim a parity this package does not have.
func validJSON(b []byte) error {
	if !utf8.Valid(b) {
		return ErrInvalidUTF8
	}
	if !json.Valid(b) {
		return ErrInvalidJSON
	}
	if hasLoneSurrogateEscape(b) {
		return ErrInvalidJSON
	}
	return nil
}

// hasLoneSurrogateEscape scans already-valid JSON for a \uD800–\uDBFF escape
// that is not immediately followed by a \uDC00–\uDFFF escape, or a low
// surrogate escape that does not follow a high one.
func hasLoneSurrogateEscape(b []byte) bool {
	inString := false
	for i := 0; i < len(b); i++ {
		c := b[i]
		if !inString {
			if c == '"' {
				inString = true
			}
			continue
		}
		switch c {
		case '"':
			inString = false
		case '\\':
			if b[i+1] != 'u' {
				i++ // a one-character escape; valid JSON guarantees it exists
				continue
			}
			u := hex4(b[i+2 : i+6])
			i += 5
			switch {
			case u >= 0xDC00 && u <= 0xDFFF:
				return true
			case u >= 0xD800 && u <= 0xDBFF:
				if i+6 >= len(b) || b[i+1] != '\\' || b[i+2] != 'u' {
					return true
				}
				lo := hex4(b[i+3 : i+7])
				if lo < 0xDC00 || lo > 0xDFFF {
					return true
				}
				i += 6
			}
		}
	}
	return false
}

func hex4(h []byte) uint32 {
	v, _ := strconv.ParseUint(string(h), 16, 32)
	return uint32(v)
}

// jsonObject decodes b as a JSON object. ok is false, with no error, when b is
// valid JSON that is not an object (an array, a string, a number, true, false
// or null); err is set when b is not acceptable JSON at all.
func jsonObject(b []byte) (fields map[string]json.RawMessage, ok bool, err error) {
	if err := validJSON(b); err != nil {
		return nil, false, err
	}
	t := bytes.TrimLeft(b, " \t\r\n")
	if len(t) == 0 || t[0] != '{' {
		return nil, false, nil
	}
	if err := json.Unmarshal(t, &fields); err != nil {
		return nil, false, ErrInvalidJSON
	}
	return fields, true, nil
}

// The helpers below take a value already inside validated JSON.

func jsonIsTrue(v json.RawMessage) bool { return string(v) == "true" }

func jsonIsNull(v json.RawMessage) bool { return string(v) == "null" }

// jsonString decodes a JSON string value. ok is false for any other type.
func jsonString(v json.RawMessage) (string, bool) {
	if len(v) == 0 || v[0] != '"' {
		return "", false
	}
	var s string
	if json.Unmarshal(v, &s) != nil {
		return "", false
	}
	return s, true
}

// jsonArray decodes a JSON array into its raw elements. ok is false for any
// other type.
func jsonArray(v json.RawMessage) ([]json.RawMessage, bool) {
	if len(v) == 0 || v[0] != '[' {
		return nil, false
	}
	var out []json.RawMessage
	if json.Unmarshal(v, &out) != nil {
		return nil, false
	}
	return out, true
}

// jsonNumber reads a JSON number exactly as JavaScript does — the nearest
// float64 — and reports whether it is finite. Every valid JSON number literal
// parses; one too large for a float64 is reported as not finite.
func jsonNumber(v json.RawMessage) (float64, bool) {
	if len(v) == 0 || (v[0] != '-' && (v[0] < '0' || v[0] > '9')) {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(v), 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	return f, true
}

// safeUint is JavaScript's `Number.isSafeInteger(n) && n >= 0` on a float64.
// -0 is 0. A fraction, an unsafe magnitude or a negative value is refused; the
// value is never truncated. Spellings such as 1e3 and 1.0 denote safe integers
// and are accepted, exactly as on the Web.
func safeUint(f float64) (uint64, bool) {
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f > MaxSafeInteger {
		return 0, false
	}
	return uint64(f), true
}

// jsonSafeUint reads a JSON number that must be a non-negative safe integer.
func jsonSafeUint(v json.RawMessage) (uint64, bool) {
	f, ok := jsonNumber(v)
	if !ok {
		return 0, false
	}
	return safeUint(f)
}

// appendJSString appends s as a JSON string literal escaped exactly as
// JavaScript's JSON.stringify does: `"` and `\`, the five short escapes, any
// other code point below U+0020 as \u00xx in lower-case hex, and EVERYTHING
// else raw — DEL, the C1 range, U+2028, U+2029, `<`, `>`, `&` and astral
// characters as their UTF-8 bytes. encoding/json's default escaping differs
// (it escapes <, >, & and U+2028/U+2029) and would change the bytes a tag or a
// sealed manifest covers. s must be valid UTF-8; callers check that first.
func appendJSString(dst []byte, s string) []byte {
	const hexdigits = "0123456789abcdef"
	dst = append(dst, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\t':
			dst = append(dst, '\\', 't')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\r':
			dst = append(dst, '\\', 'r')
		default:
			if c < 0x20 {
				dst = append(dst, '\\', 'u', '0', '0', hexdigits[c>>4], hexdigits[c&0xf])
			} else {
				// Bytes >= 0x80 belong to a valid multi-byte sequence and are
				// copied as they are.
				dst = append(dst, c)
			}
		}
	}
	return append(dst, '"')
}

// utf16Len is JavaScript's String.prototype.length for valid UTF-8 s.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}
