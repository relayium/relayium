// Windows destination-name safety, re-decided natively at the helper's trust
// boundary.
//
// ## Why this exists when src/main/io/winpath.ts already did it
//
// Not redundancy. The privileged Electron process validating a name says nothing
// about what THIS process was handed: the helper is a separate trust boundary
// and re-runs the whole decision on the bytes it actually received.
//
// The concrete danger is that the NT layer is MORE permissive than the Win32
// layer. Everything this helper creates goes through NtCreateFile with a
// directory handle and a single relative component, which bypasses Win32 path
// normalisation entirely. A component like `trailing.` or `COM1` or `a:b` would
// therefore be created successfully — and the result is an object that ordinary
// Win32 consumers, Explorer included, cannot open at all, or in the `a:b` case
// an alternate data stream that no directory listing shows. Win32 refuses these
// names on the way in; NT does not. This file is what keeps the two consistent.
//
// Rejection reasons are byte-identical to PathRejection in winpath.ts, so one
// vocabulary reaches the user no matter which boundary refused.
//
// Source: Microsoft, "Naming Files, Paths, and Namespaces"
// https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
package nameguard

import "strings"

// Rejection mirrors PathRejection in src/main/io/winpath.ts exactly.
type Rejection string

const (
	RejectEmpty               Rejection = "empty"
	RejectAbsolute            Rejection = "absolute"
	RejectDriveRelative       Rejection = "drive-relative"
	RejectUNCOrDevice         Rejection = "unc-or-device"
	RejectTraversal           Rejection = "traversal"
	RejectBackslashInSegment  Rejection = "backslash-in-segment"
	RejectSeparatorInSegment  Rejection = "separator-in-segment"
	RejectReservedDeviceName  Rejection = "reserved-device-name"
	RejectAlternateDataStream Rejection = "alternate-data-stream"
	RejectInvalidCharacter    Rejection = "invalid-character"
	RejectTrailingDotOrSpace  Rejection = "trailing-dot-or-space"
	// A name that DISPLAYS as something other than what it is. See the loop in
	// ValidateSegment for why this is its own reason rather than
	// invalid-character.
	RejectDeceptiveCharacter Rejection = "deceptive-character"
	RejectSegmentTooLong     Rejection = "segment-too-long"
	RejectTooDeep            Rejection = "too-deep"
	RejectPathTooLong        Rejection = "path-too-long"
)

// Bounds. Both segment limits apply and neither implies the other.
//
// MaxSegmentUTF16 is the filesystem's: NTFS counts a filename in UTF-16 code
// units and stops at 255. MaxSegmentBytes is the Device Inbox manifest's
// declared ceiling in UTF-8 bytes. 256 ASCII characters pass the byte limit and
// fail the unit limit; 400 CJK characters fail both. Checking one leaves real
// names unrefused.
const (
	MaxSegmentUTF16  = 255
	MaxSegmentBytes  = 1024
	MaxDepth         = 64
	MaxRelativeChars = 32000
)

// reserved DOS device names. The superscript forms are real: Win32 maps
// COM¹ COM² COM³ and LPT¹ LPT² LPT³ to the same devices as the ASCII digits,
// and they are what a hand-written blocklist misses.
var reserved = func() map[string]struct{} {
	m := map[string]struct{}{
		"CON": {}, "PRN": {}, "AUX": {}, "NUL": {}, "CONIN$": {}, "CONOUT$": {},
		"COM\u00B9": {}, "COM\u00B2": {}, "COM\u00B3": {},
		"LPT\u00B9": {}, "LPT\u00B2": {}, "LPT\u00B3": {},
	}
	for i := 0; i <= 9; i++ {
		d := string(rune('0' + i))
		m["COM"+d] = struct{}{}
		m["LPT"+d] = struct{}{}
	}
	return m
}()

// Verdict is the result of validating one relative path.
type Verdict struct {
	OK       bool
	Reason   Rejection
	Segments []string
}

func rejectWith(r Rejection) Verdict { return Verdict{Reason: r} }

// ValidateRelativePath judges one manifest-supplied relative path.
//
// `/` is the separator both wires use. A literal backslash is refused rather
// than treated as a separator: on Windows it IS one, so a sender that means a
// directory must say so in the wire's vocabulary, and one that did not mean a
// directory must not accidentally create one.
func ValidateRelativePath(raw string) Verdict {
	if raw == "" {
		return rejectWith(RejectEmpty)
	}
	// Counted in UTF-16 units to match the TypeScript boundary's String.length,
	// so the two cannot disagree about which paths are too long.
	if utf16Len(raw) > MaxRelativeChars {
		return rejectWith(RejectPathTooLong)
	}

	// Device and UNC namespaces first: `\\?\`, `\\.\`, `\\server\share`. They
	// bypass Win32 normalisation, so no per-segment check would ever see them.
	if len(raw) >= 2 && isSep(raw[0]) && isSep(raw[1]) {
		return rejectWith(RejectUNCOrDevice)
	}
	if isSep(raw[0]) {
		return rejectWith(RejectAbsolute)
	}
	if len(raw) >= 3 && isDriveLetter(raw[0]) && raw[1] == ':' && isSep(raw[2]) {
		return rejectWith(RejectAbsolute)
	}
	// `C:name` resolves against that drive's CURRENT directory — process state
	// the sender does not know and must not reach. A distinct reason because it
	// is not the same mistake as `C:\name`.
	if len(raw) >= 2 && isDriveLetter(raw[0]) && raw[1] == ':' {
		return rejectWith(RejectDriveRelative)
	}

	segments := strings.Split(raw, "/")
	if len(segments) > MaxDepth {
		return rejectWith(RejectTooDeep)
	}
	for _, seg := range segments {
		if v := ValidateSegment(seg); !v.OK {
			return v
		}
	}
	return Verdict{OK: true, Segments: segments}
}

// ValidateSegment judges a single path component.
func ValidateSegment(segment string) Verdict {
	if segment == "" {
		return rejectWith(RejectEmpty)
	}
	if segment == "." || segment == ".." {
		return rejectWith(RejectTraversal)
	}
	// ValidateRelativePath splits before calling here, so this only fires for a
	// direct caller. It is still checked: a validator that answers "fine" for
	// `a/b` would let a caller that skipped the splitter create an undeclared
	// directory.
	if strings.Contains(segment, "/") {
		return rejectWith(RejectSeparatorInSegment)
	}
	// A backslash inside a component is a separator Windows honours, so the
	// component is a directory the sender never declared — and `a\..\escape` is
	// a traversal that survives every `/`-based check.
	if strings.Contains(segment, "\\") {
		return rejectWith(RejectBackslashInSegment)
	}
	// Colon is both the drive marker and the alternate-data-stream marker.
	// Reported precisely: `name:stream` writes a hidden stream of `name`.
	if strings.Contains(segment, ":") {
		return rejectWith(RejectAlternateDataStream)
	}
	for _, r := range segment {
		if r < 0x20 || r == '<' || r == '>' || r == '"' || r == '|' || r == '?' || r == '*' {
			return rejectWith(RejectInvalidCharacter)
		}
		// DEL and the bidi controls, refused for a different reason than the
		// characters above: those cannot be written, these can — and they change
		// what the name LOOKS like without changing what it is.
		//
		// `photo\u202Egnp.exe` renders in Explorer as `photoexe.png`, because
		// U+202E reverses everything after it. The reader double-clicks an
		// executable believing it is an image, and on this platform the
		// extension is what decides that. macOS removes exactly these from a
		// received name; `web/src/lib/filename.ts` carries the same class with a
		// test that names the attack.
		//
		// REFUSED rather than stripped, which is this receiver's model
		// throughout: a name it cannot write faithfully is not quietly rewritten
		// into a different one.
		//
		// C1 (U+0080-U+009F) is deliberately NOT here. No other implementation
		// refuses it, and a name only some of a user's devices accept is the
		// failure the shared manifest rule exists to prevent.
		if r == 0x7f || isDeceptive(r) {
			return rejectWith(RejectDeceptiveCharacter)
		}
	}
	// Windows silently strips these at creation, so `report.txt ` and
	// `report.txt` become one file — a collision the manifest never declared.
	if last := segment[len(segment)-1]; last == '.' || last == ' ' {
		return rejectWith(RejectTrailingDotOrSpace)
	}
	if utf16Len(segment) > MaxSegmentUTF16 {
		return rejectWith(RejectSegmentTooLong)
	}
	if len(segment) > MaxSegmentBytes {
		return rejectWith(RejectSegmentTooLong)
	}
	// A name is reserved when the part BEFORE the first dot matches: `NUL.txt`
	// is the NUL device, not a text file.
	stem := segment
	if i := strings.IndexByte(segment, '.'); i >= 0 {
		stem = segment[:i]
	}
	if _, bad := reserved[strings.ToUpper(stem)]; bad {
		return rejectWith(RejectReservedDeviceName)
	}
	return Verdict{OK: true, Segments: []string{segment}}
}

// isDeceptive reports the characters that change how a name reads without
// changing what it is: the bidi overrides and isolates, and the marks that
// travel with them. Byte-identical to the class in `web/src/lib/filename.ts`
// and to `DECEPTIVE` in `src/main/io/winpath.ts`.
func isDeceptive(r rune) bool {
	switch r {
	case 0x061C, 0x200E, 0x200F,
		0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
		0x2066, 0x2067, 0x2068, 0x2069:
		return true
	}
	return false
}

// CollisionKey answers "would these two names be the same file on disk?".
//
// NTFS is case-insensitive by default, so `A.txt` and `a.txt` collide. Folding
// happens once, here, so the collision check and the write path cannot disagree
// about what a duplicate is. Matches collisionKey in winpath.ts.
func CollisionKey(segments []string) string {
	folded := make([]string, len(segments))
	for i, s := range segments {
		folded[i] = strings.ToUpper(s)
	}
	return strings.Join(folded, "/")
}

func isSep(b byte) bool { return b == '/' || b == '\\' }

func isDriveLetter(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

// utf16Len counts UTF-16 code units, which is what NTFS counts and what
// JavaScript's String.length reports. Counting runes or bytes here would let the
// native boundary and the TypeScript one disagree about a 255-unit name.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}
