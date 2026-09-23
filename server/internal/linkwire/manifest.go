package linkwire

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// FileMeta is one manifest entry. HasPath distinguishes an absent `path` (a
// flat file) from a present one, which may be the empty string.
//
// From DecodeManifest, Name and Path are DISPLAY values: bidi controls and
// C0/DEL/C1 are stripped, but nothing else is. A decoded name may be empty and a
// decoded path may contain "..", absolute components or anything else a peer
// chose. Neither is a safe filesystem path, and a later layer that writes files
// must apply its own path policy.
type FileMeta struct {
	Name    string
	Size    uint64
	Path    string
	HasPath bool
}

// EncodeManifest renders the manifest plaintext exactly as the Web's
// JSON.stringify({files}) does: {"files":[{"name":…,"size":…[,"path":…]}]},
// keys in that order, no whitespace, JavaScript string escaping. It refuses a
// manifest a receiver would refuse (count, name/path length, sizes and total)
// and any name or path that is not valid UTF-8.
func EncodeManifest(files []FileMeta) ([]byte, error) {
	if len(files) == 0 || len(files) > MaxFiles {
		return nil, ErrInvalidManifest
	}
	var total uint64
	b := []byte(`{"files":[`)
	for i, f := range files {
		if !validName(f.Name) || f.Size > MaxSafeInteger {
			return nil, ErrInvalidManifest
		}
		if f.HasPath && (!utf8.ValidString(f.Path) || len(f.Path) > MaxNameBytes) {
			return nil, ErrInvalidManifest
		}
		total += f.Size
		if total > MaxSafeInteger {
			return nil, ErrInvalidManifest
		}
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"name":`...)
		b = appendJSString(b, f.Name)
		b = append(b, `,"size":`...)
		b = strconv.AppendUint(b, f.Size, 10)
		if f.HasPath {
			b = append(b, `,"path":`...)
			b = appendJSString(b, f.Path)
		}
		b = append(b, '}')
	}
	return append(b, "]}"...), nil
}

func validName(s string) bool {
	return len(s) > 0 && len(s) <= MaxNameBytes && utf8.ValidString(s)
}

// DecodeManifest parses and validates a manifest plaintext, then sanitises the
// display values. Validation runs on the RAW strings first, as on the Web and
// Android: 1..MaxFiles entries; each name a non-empty string of at most
// MaxNameBytes UTF-8 bytes; each size a non-negative safe integer; each path,
// when the key is present, a string (null is refused) of at most MaxNameBytes;
// and the running total a safe integer. Only then are bidi controls and
// C0/DEL/C1 stripped from the name and from each "/"-separated path segment.
//
// Keys are matched exactly (a "NAME" key is not "name"); a duplicated key keeps
// its last value, as JSON.parse does; other keys are ignored. Invalid UTF-8 and
// unpaired surrogate escapes are refused rather than replaced.
func DecodeManifest(plain []byte) ([]FileMeta, error) {
	if len(plain) > ManifestMaxBytes {
		return nil, ErrManifestTooLarge
	}
	top, ok, err := jsonObject(plain)
	if err != nil || !ok {
		return nil, ErrInvalidManifest
	}
	entries, ok := jsonArray(top["files"])
	if !ok || len(entries) == 0 || len(entries) > MaxFiles {
		return nil, ErrInvalidManifest
	}
	out := make([]FileMeta, 0, len(entries))
	var total uint64
	for _, raw := range entries {
		entry, ok, err := jsonObject(raw)
		if err != nil || !ok {
			return nil, ErrInvalidManifest
		}
		name, ok := jsonString(entry["name"])
		if !ok || !validName(name) {
			return nil, ErrInvalidManifest
		}
		size, ok := jsonSafeUint(entry["size"])
		if !ok {
			return nil, ErrInvalidManifest
		}
		var f FileMeta
		if rawPath, present := entry["path"]; present {
			path, ok := jsonString(rawPath)
			if !ok || len(path) > MaxNameBytes {
				return nil, ErrInvalidManifest
			}
			f.Path, f.HasPath = path, true
		}
		total += size
		if total > MaxSafeInteger {
			return nil, ErrInvalidManifest
		}
		f.Name, f.Size = name, size
		out = append(out, f)
	}
	for i := range out {
		out[i].Name = SanitizeDisplayName(out[i].Name)
		if out[i].HasPath {
			out[i].Path = sanitizePath(out[i].Path)
		}
	}
	return out, nil
}

// SanitizeDisplayName removes every Unicode Bidi_Control code point (U+061C,
// U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) and every C0, DEL and C1 code
// point (U+0000–U+001F, U+007F–U+009F), exactly as the Web's safeDisplayName.
// It is a display cleaner, not a filesystem sanitiser.
func SanitizeDisplayName(s string) string {
	return strings.Map(func(r rune) rune {
		if isStrippedRune(r) {
			return -1
		}
		return r
	}, s)
}

func isStrippedRune(r rune) bool {
	switch {
	case r <= 0x1f, r >= 0x7f && r <= 0x9f:
		return true
	case r == 0x061c, r == 0x200e, r == 0x200f:
		return true
	case r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

// sanitizePath cleans each "/"-separated segment, so the separators survive and
// the directory structure is not flattened.
func sanitizePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = SanitizeDisplayName(s)
	}
	return strings.Join(segs, "/")
}
