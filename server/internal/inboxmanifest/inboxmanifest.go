// Package inboxmanifest is the Device Inbox v2 encrypted manifest: the small
// authenticated JSON document a sender seals at frame 0 of a delivery's
// ciphertext, describing what the frames after it contain.
//
// It is a DEDICATED codec, deliberately separate from `storecrypto`'s shared
// Stored-Wire manifest, and the separation is the point. The shared manifest
// describes public share objects whose bytes are already frozen and interop-
// tested across the web, the CLI and Swift; teaching it a content kind would
// change bytes that other, unrelated products depend on. This one is free to be
// stricter, and is: it is the ONLY place that says whether a delivery is a set
// of files or a message.
//
// INVARIANTS. Each is asserted by a test in inboxmanifest_test.go and by a
// vector in the frozen cross-language fixture. Changing one is a protocol
// change, not a refactor.
//
//  1. KIND IS SEALED. Content kind exists here and nowhere else. Central never
//     sees this document — it holds ciphertext — so a message and a file
//     delivery are indistinguishable to the server, its logs and its operators.
//  2. ONE KIND PER DELIVERY. Every item declares its kind and all of them must
//     agree. A mixed manifest is refused rather than partly honoured, because a
//     receiver that split one would have to write half a delivery into the
//     user's receive folder and half into the message store.
//  3. CANONICAL OR REFUSED. There is exactly ONE byte sequence for any given
//     manifest. Decode re-encodes what it parsed and requires the result to
//     equal its input, so unknown fields, dropped fields, reordered keys,
//     duplicate keys, whitespace and non-canonical numbers are all refusals and
//     not merely tolerated variations.
//  4. AEAD IS NOT VALIDATION. Decryption proves who wrote these bytes; it says
//     nothing about whether the numbers and names inside them are safe to act
//     on. Every bound below is applied AFTER the seal opens, on the assumption
//     that a sender may be hostile or simply broken.
//  5. TEXT IS NOT IN HERE. A message's bytes travel in the encrypted frames
//     like any other payload; the manifest carries only its length. Putting the
//     message in the manifest would make its size a function of its content and
//     would put plaintext into the one structure every receiver parses before
//     it has decided the delivery is safe to accept.
package inboxmanifest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Version is the only manifest version this codec reads or writes.
//
// v1 had no version field at all — it was `{"files":[…]}`, the shared
// Stored-Wire shape. That is why `v` is checked first and why its absence
// (which decodes to 0) is a refusal: a v1 document must fail as an unsupported
// version, not as a manifest with no items.
const Version = 2

// Kind is the closed content-kind set. A delivery is files or it is a message;
// there is no third value and no "unknown" that a receiver could guess at.
type Kind string

const (
	// KindFile: the frames carry file bytes, concatenated in item order.
	KindFile Kind = "file"
	// KindText: the frames carry one UTF-8 message.
	KindText Kind = "text"
)

// Bounds. Every one of these is applied to sender-controlled input after the
// AEAD opens (invariant 4).
const (
	// MaxItems bounds a delivery's item count. Matches the shared manifest's
	// own limit so a folder that can be shared can also be sent to a device.
	MaxItems = 1000
	// MinItems: an empty manifest describes nothing and would leave a receiver
	// committing a delivery with no content.
	MinItems = 1

	// MaxNameBytes bounds one file name, measured in UTF-8 BYTES rather than
	// characters: the filesystem limit this eventually meets is a byte limit.
	MaxNameBytes = 1024

	// MaxPathDepth bounds "/"-separated components in one name. A name may be a
	// relative path so a folder send keeps its shape; this stops a manifest
	// from demanding a thousand-deep directory tree.
	MaxPathDepth = 64

	// MaxSafeInteger is JavaScript's exact-integer ceiling. Sizes are bounded
	// by it, not by int64, because one of the three implementations of this
	// codec runs in a browser: a size that only Go and Swift can represent
	// exactly would decode to a different number there.
	MaxSafeInteger int64 = 9_007_199_254_740_991

	// Text length bounds, in UTF-8 bytes of the message itself.
	//
	// MinTextBytes is 1: an empty message is not a message, and a receiver
	// asked to commit one would have to invent something to show. MaxTextBytes
	// is 64 KiB — far more than any message a person types, and small enough
	// that a receiver can hold one in memory to display it without a streaming
	// path of its own.
	MinTextBytes = 1
	MaxTextBytes = 65536
)

// Refusals. Distinct errors rather than one, because each names a different
// thing a sender did and the vector fixture pins the mapping: a test that only
// checked "some error" would pass while the codec rejected the right documents
// for the wrong reasons.
var (
	ErrVersion       = errors.New("inboxmanifest: unsupported manifest version")
	ErrItemCount     = errors.New("inboxmanifest: invalid item count")
	ErrUnknownKind   = errors.New("inboxmanifest: unknown content kind")
	ErrMixedKinds    = errors.New("inboxmanifest: a delivery carries exactly one content kind")
	ErrName          = errors.New("inboxmanifest: invalid file name")
	ErrTextName      = errors.New("inboxmanifest: a text item has no name")
	ErrTextItemCount = errors.New("inboxmanifest: a text delivery is exactly one item")
	ErrSize          = errors.New("inboxmanifest: invalid item size")
	ErrTotalOverflow = errors.New("inboxmanifest: total size out of range")
	ErrMalformed     = errors.New("inboxmanifest: malformed manifest document")
	// ErrNotCanonical is the catch-all that makes the others unnecessary to
	// enumerate: the document parsed and validated, but is not the ONE spelling
	// this codec would have produced. Unknown keys that a lenient parser
	// dropped, an omitted `size` that defaulted to zero, reordered keys,
	// duplicated keys, whitespace and `2.0` in place of `2` all land here.
	ErrNotCanonical = errors.New("inboxmanifest: manifest is not in canonical form")
)

// Item is one entry. `name` is present for a file and ABSENT for text — not
// empty, absent — because text has no name and a receiver must never be handed
// a string it could be tempted to treat as a destination.
type Item struct {
	Kind Kind   `json:"kind"`
	Name string `json:"name,omitempty"`
	Size int64  `json:"size"`
}

// Manifest is the whole document.
type Manifest struct {
	V     int    `json:"v"`
	Items []Item `json:"items"`
}

// Kind returns the single kind of a VALID manifest. Callers that have not
// validated must not use it; it reports the first item's kind and says nothing
// about whether the rest agree.
func (m Manifest) Kind() Kind {
	if len(m.Items) == 0 {
		return ""
	}
	return m.Items[0].Kind
}

// TotalSize sums item sizes. Safe to call only on a validated manifest, where
// the sum is already known not to overflow.
func (m Manifest) TotalSize() int64 {
	var total int64
	for _, it := range m.Items {
		total += it.Size
	}
	return total
}

// NewFiles builds a file manifest, validated. The constructors exist so no
// caller assembles a Manifest literal and skips the bounds.
func NewFiles(items []Item) (Manifest, error) {
	m := Manifest{V: Version, Items: items}
	return m, Validate(m)
}

// NewText builds the one-item text manifest for a message of size bytes.
func NewText(size int64) (Manifest, error) {
	m := Manifest{V: Version, Items: []Item{{Kind: KindText, Size: size}}}
	return m, Validate(m)
}

// Validate applies every bound, in a fixed order, and returns the FIRST
// violation. The order is part of the contract: version, then shape, then
// per-item rules, then the aggregate — so a v1 document is reported as a
// version problem rather than as whatever its items happen to look like.
func Validate(m Manifest) error {
	if m.V != Version {
		return fmt.Errorf("%w: %d", ErrVersion, m.V)
	}
	if len(m.Items) < MinItems || len(m.Items) > MaxItems {
		return fmt.Errorf("%w: %d", ErrItemCount, len(m.Items))
	}
	kind := m.Items[0].Kind
	switch kind {
	case KindFile, KindText:
	default:
		return fmt.Errorf("%w: %q", ErrUnknownKind, kind)
	}
	// Invariant 2. Checked against the FIRST item rather than against a
	// permitted set, so "every item is `text` except one `file`" and "every
	// item is `file` except one `text`" are both refused by the same rule.
	for i, it := range m.Items {
		if it.Kind != kind {
			return fmt.Errorf("%w: item %d is %q, item 0 is %q", ErrMixedKinds, i, it.Kind, kind)
		}
	}
	if kind == KindText {
		// One message per delivery. A second text item would have no way to be
		// told apart from the first in the frame stream, since text carries no
		// name — the receiver would have to guess at the boundary.
		if len(m.Items) != 1 {
			return fmt.Errorf("%w: %d", ErrTextItemCount, len(m.Items))
		}
		it := m.Items[0]
		if it.Name != "" {
			return fmt.Errorf("%w: %q", ErrTextName, it.Name)
		}
		if it.Size < MinTextBytes || it.Size > MaxTextBytes {
			return fmt.Errorf("%w: text of %d bytes", ErrSize, it.Size)
		}
		return nil
	}
	var total int64
	for i, it := range m.Items {
		if err := validateName(it.Name); err != nil {
			return fmt.Errorf("%w at index %d: %v", ErrName, i, err)
		}
		// Zero is legal — an empty file is a real file — but negative is not,
		// and neither is a value the browser could not hold exactly.
		if it.Size < 0 || it.Size > MaxSafeInteger {
			return fmt.Errorf("%w at index %d: %d", ErrSize, i, it.Size)
		}
		if total > math.MaxInt64-it.Size || total+it.Size > MaxSafeInteger {
			return fmt.Errorf("%w at index %d", ErrTotalOverflow, i)
		}
		total += it.Size
	}
	return nil
}

// validateName is the traversal-and-control rule, and it is deliberately
// PLATFORM-NEUTRAL: exactly these bytes are accepted on every receiver, so one
// manifest is accepted or refused identically everywhere. A name that only some
// of a user's devices would take is worse than one none of them would.
//
// Platform-specific hardening — Windows reserved device names, components
// ending in a dot or a space, case-insensitive collisions — belongs to the
// receiver's destination planner, which knows which filesystem it is about to
// write to. Those checks are not weakened by living there; they are applied
// after this one, never instead of it.
//
// What is refused here, and why:
//
//   - empty or over MaxNameBytes: unrepresentable or unbounded.
//   - invalid UTF-8: a name no receiver could agree on the meaning of.
//   - any C0 control byte or DEL: can truncate a C string or rewrite a
//     terminal line as it is logged or displayed.
//   - a backslash anywhere: "/" is the separator by protocol, and a backslash
//     means "separator" on Windows — the same manifest would otherwise produce
//     different trees on different receivers.
//   - a leading "/" or a drive prefix: an ABSOLUTE destination, which leaves
//     the receive folder entirely.
//   - a "." or ".." component: traversal, the classic Zip-Slip.
//   - an empty component ("a//b"): two spellings of one path.
func validateName(name string) error {
	if name == "" {
		return errors.New("empty")
	}
	if len(name) > MaxNameBytes {
		return fmt.Errorf("%d bytes exceeds %d", len(name), MaxNameBytes)
	}
	if !utf8.ValidString(name) {
		return errors.New("not valid UTF-8")
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 0x20 || name[i] == 0x7f {
			return fmt.Errorf("control byte at offset %d", i)
		}
	}
	if strings.Contains(name, `\`) {
		return errors.New("backslash")
	}
	if strings.HasPrefix(name, "/") {
		return errors.New("absolute path")
	}
	// "C:foo" is drive-relative and "C:/foo" drive-absolute on Windows; both
	// escape a receive folder there while looking like ordinary names here.
	if len(name) >= 2 && name[1] == ':' {
		return errors.New("drive-qualified path")
	}
	parts := strings.Split(name, "/")
	if len(parts) > MaxPathDepth {
		return fmt.Errorf("%d components exceeds %d", len(parts), MaxPathDepth)
	}
	for _, p := range parts {
		switch p {
		case "":
			return errors.New("empty path component")
		case ".", "..":
			return fmt.Errorf("%q path component", p)
		}
	}
	return nil
}

// Encode returns the ONE canonical byte sequence for m, after validating it.
//
// Hand-written rather than `json.Marshal`, for the same reason the Swift side
// hand-writes its Stored-Wire manifest: this document's bytes are compared
// across three languages, and every standard-library encoder differs somewhere.
// Go's escapes `<`, `>`, `&` and U+2028/U+2029 by default; JavaScript's
// `JSON.stringify` escapes none of them; Swift's `JSONEncoder` does not
// guarantee key order at all. A canonical form that depends on any of them is
// not canonical.
//
// The rules, matching `JSON.stringify` exactly: no whitespace, fixed key order
// (`v`, `items`; then `kind`, `name`, `size`), `name` omitted entirely for
// text, `"`, `\` and the C0 controls escaped (`\b \t \n \f \r` by name, the
// rest as lowercase `\u00xx`), everything else — including DEL, C1 controls,
// bidi overrides and all non-ASCII — emitted raw as UTF-8, and `/` never
// escaped.
func Encode(m Manifest) ([]byte, error) {
	if err := Validate(m); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.WriteString(`{"v":`)
	b.WriteString(strconv.Itoa(m.V))
	b.WriteString(`,"items":[`)
	for i, it := range m.Items {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"kind":"`)
		b.WriteString(string(it.Kind)) // a closed set; no escapable byte can occur
		b.WriteString(`"`)
		if it.Kind == KindFile {
			b.WriteString(`,"name":"`)
			b.WriteString(escapeJSONString(it.Name))
			b.WriteString(`"`)
		}
		b.WriteString(`,"size":`)
		b.WriteString(strconv.FormatInt(it.Size, 10))
		b.WriteString(`}`)
	}
	b.WriteString(`]}`)
	return b.Bytes(), nil
}

// escapeJSONString applies JavaScript's `JSON.stringify` escaping rules.
func escapeJSONString(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if c < 0x20 {
				b.WriteString(`\u00`)
				const hex = "0123456789abcdef"
				b.WriteByte(hex[c>>4])
				b.WriteByte(hex[c&0xf])
			} else {
				b.WriteByte(c)
			}
		}
	}
	return b.String()
}

// Decode parses and validates one manifest, and refuses anything that is not
// the canonical spelling of what it parsed (invariant 3).
//
// The canonical-form check is what makes this strict without a hand-written
// parser. `DisallowUnknownFields` below catches an added key with a precise
// error; the re-encode catches everything a lenient parser would otherwise have
// absorbed silently — a duplicate `"size"` key where the last wins, an omitted
// `"size"` that defaults to 0, `{"items":…,"v":2}` in the wrong order, `2.0`
// for `2`, a trailing newline, or a v1 `{"files":[…]}` document whose fields
// simply do not appear here.
func Decode(data []byte) (Manifest, error) {
	// The version is read FIRST, by a lenient probe, and that ordering is part
	// of the contract rather than an accident of how this decoder is written.
	//
	// A v1 document is `{"files":[…]}` — no `v` at all. Left to the strict pass
	// below it would be refused as "unknown field: files", which is true and
	// useless. Refused here it is "unsupported manifest version", which is the
	// thing a person can act on. The three implementations of this codec agree
	// on this order so one document produces one diagnosis everywhere.
	var probe struct {
		V *int `json:"v"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return Manifest{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if probe.V == nil {
		return Manifest{}, fmt.Errorf("%w: absent", ErrVersion)
	}
	if *probe.V != Version {
		return Manifest{}, fmt.Errorf("%w: %d", ErrVersion, *probe.V)
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	// The integer fields decode into `int`/`int64`, so a non-integer number
	// (1.5, 2.0, 1e400) is a decode error rather than a silent truncation; a
	// value past MaxSafeInteger that still fits int64 is caught by Validate.
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return Manifest{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	// A second value after the first is not part of this manifest. Without
	// this, `{"v":2,…}{"v":2,…}` would decode as its first document.
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Manifest{}, fmt.Errorf("%w: trailing content", ErrMalformed)
	}
	if err := Validate(m); err != nil {
		return Manifest{}, err
	}
	canonical, err := Encode(m)
	if err != nil {
		return Manifest{}, err
	}
	if !bytes.Equal(canonical, data) {
		return Manifest{}, ErrNotCanonical
	}
	return m, nil
}
