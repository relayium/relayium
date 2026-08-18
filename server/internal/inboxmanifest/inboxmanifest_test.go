package inboxmanifest

import (
	"errors"
	"strings"
	"testing"
)

// ── the canonical form ─────────────────────────────────────────────────────

func TestEncodeIsTheOneCanonicalSpelling(t *testing.T) {
	m, err := NewFiles([]Item{
		{Kind: KindFile, Name: "b.txt", Size: 2},
		{Kind: KindFile, Name: "a.txt", Size: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Encode(m)
	if err != nil {
		t.Fatal(err)
	}
	// Key order is fixed, item order is the SENDER's (not sorted), and there is
	// no whitespace anywhere.
	want := `{"v":3,"items":[{"kind":"file","name":"b.txt","size":2},{"kind":"file","name":"a.txt","size":1}]}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestTextEncodesWithNoNameKeyAtAll(t *testing.T) {
	m, err := NewText(11)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := Encode(m)
	want := `{"v":3,"items":[{"kind":"text","size":11}]}`
	if string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	// Absent, not empty. An empty string is something a receiver could be
	// tempted to treat as a destination; an absent key cannot be.
	if strings.Contains(string(got), "name") {
		t.Fatal("a text manifest carries a name key")
	}
}

func TestEncodeThenDecodeRoundTrips(t *testing.T) {
	for _, m := range []Manifest{
		mustFiles(t, []Item{{Kind: KindFile, Name: "a/b/c.txt", Size: 0}}),
		mustFiles(t, []Item{{Kind: KindFile, Name: "发票 2026.pdf", Size: MaxSafeInteger}}),
		mustText(t, MaxTextBytes),
	} {
		encoded, err := Encode(m)
		if err != nil {
			t.Fatalf("encode %v: %v", m, err)
		}
		back, err := Decode(encoded)
		if err != nil {
			t.Fatalf("decode %s: %v", encoded, err)
		}
		again, err := Encode(back)
		if err != nil || string(again) != string(encoded) {
			t.Fatalf("re-encode drifted: %s vs %s (err %v)", again, encoded, err)
		}
	}
}

// TestEscapingMatchesJSONStringify pins the escape rules the three
// implementations share. Getting any of these wrong produces bytes that decrypt
// fine and then fail a canonical-form check on another platform.
func TestEscapingMatchesJSONStringify(t *testing.T) {
	for name, want := range map[string]string{
		`say "hi"`: `say \"hi\"`,
		"a\tb":     `a\tb`,
		"a\x01b":   `a\u0001b`,
		// NOT escaped, unlike Go's own encoding/json: these are the four that
		// would silently diverge from JavaScript.
		"a<b>&c":      `a<b>&c`,
		"a\u2028b":    "a\u2028b",
		"a/b":         `a/b`,
		"发票 2026.pdf": `发票 2026.pdf`,
	} {
		if got := escapeJSONString(name); got != want {
			t.Errorf("escape(%q) = %q, want %q", name, got, want)
		}
	}
}

// ── fail-closed clauses ────────────────────────────────────────────────────

func TestVersionFailsClosed(t *testing.T) {
	// The version is decided BEFORE anything else, so a v1 document — which has
	// no `v` and an unknown `files` key — is diagnosed as a version problem
	// rather than as a stray field.
	for name, doc := range map[string]string{
		"v1 shape":  `{"files":[{"name":"a.txt","size":1}]}`,
		"explicit":  `{"v":1,"items":[{"kind":"file","name":"a.txt","size":1}]}`,
		"future":    `{"v":4,"items":[{"kind":"file","name":"a.txt","size":1}]}`,
		"absent":    `{"items":[{"kind":"file","name":"a.txt","size":1}]}`,
		"zero":      `{"v":0,"items":[{"kind":"file","name":"a.txt","size":1}]}`,
		"negative":  `{"v":-2,"items":[{"kind":"file","name":"a.txt","size":1}]}`,
		"very high": `{"v":3147483647,"items":[{"kind":"file","name":"a.txt","size":1}]}`,
	} {
		if _, err := Decode([]byte(doc)); !errors.Is(err, ErrVersion) {
			t.Errorf("%s: err = %v, want ErrVersion", name, err)
		}
	}
}

func TestSingleKindPerDelivery(t *testing.T) {
	mixed := `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1},{"kind":"text","size":5}]}`
	if _, err := Decode([]byte(mixed)); !errors.Is(err, ErrMixedKinds) {
		t.Fatalf("file+text: err = %v, want ErrMixedKinds", err)
	}
	// The reverse order too. Checking every item against item 0 (rather than
	// against a permitted set) is what makes both directions one rule.
	reversed := `{"v":3,"items":[{"kind":"text","size":5},{"kind":"file","name":"a.txt","size":1}]}`
	if _, err := Decode([]byte(reversed)); !errors.Is(err, ErrMixedKinds) {
		t.Fatalf("text+file: err = %v, want ErrMixedKinds", err)
	}
	// A single stray item in a long run of files is caught too — a loop that
	// only compared neighbours, or only looked at the first two, would pass the
	// two cases above and let this one through.
	items := make([]Item, 0, 40)
	for i := 0; i < 39; i++ {
		items = append(items, Item{Kind: KindFile, Name: "f", Size: 1})
	}
	items = append(items, Item{Kind: KindText, Size: 1})
	if err := Validate(Manifest{V: Version, Items: items}); !errors.Is(err, ErrMixedKinds) {
		t.Fatalf("one stray text at the end: err = %v, want ErrMixedKinds", err)
	}
}

func TestTextIsExactlyOneUnnamedBoundedItem(t *testing.T) {
	two := `{"v":3,"items":[{"kind":"text","size":5},{"kind":"text","size":6}]}`
	if _, err := Decode([]byte(two)); !errors.Is(err, ErrTextItemCount) {
		t.Fatalf("two messages: err = %v, want ErrTextItemCount", err)
	}
	named := `{"v":3,"items":[{"kind":"text","name":"note.txt","size":5}]}`
	if _, err := Decode([]byte(named)); !errors.Is(err, ErrTextName) {
		t.Fatalf("named message: err = %v, want ErrTextName", err)
	}
	for _, size := range []int64{0, -1, MaxTextBytes + 1, MaxSafeInteger} {
		if err := Validate(Manifest{V: Version, Items: []Item{{Kind: KindText, Size: size}}}); !errors.Is(err, ErrSize) {
			t.Errorf("text size %d: err = %v, want ErrSize", size, err)
		}
	}
	for _, size := range []int64{MinTextBytes, 1024, MaxTextBytes} {
		if err := Validate(Manifest{V: Version, Items: []Item{{Kind: KindText, Size: size}}}); err != nil {
			t.Errorf("text size %d must be accepted: %v", size, err)
		}
	}
}

func TestNameRejectsTraversalAndControlCharacters(t *testing.T) {
	for name, bad := range map[string]string{
		"empty":                "",
		"parent":               "../etc/passwd",
		"parent mid-path":      "a/../../b.txt",
		"bare dot":             "./a.txt",
		"trailing dot dot":     "a/..",
		"absolute":             "/etc/passwd",
		"drive absolute":       "C:/Windows/a.dll",
		"drive relative":       "C:a.dll",
		"backslash":            `a\b.txt`,
		"backslash traversal":  `..\a.txt`,
		"empty component":      "a//b.txt",
		"trailing separator":   "a/b/",
		"leading separator":    "/a",
		"NUL":                  "a\x00b.txt",
		"newline":              "a\nb.txt",
		"carriage return":      "a\rb.txt",
		"escape":               "a\x1bb.txt",
		"DEL":                  "a\x7fb.txt",
		"invalid UTF-8":        "a\xffb.txt",
		"over the byte bound":  strings.Repeat("a", MaxNameBytes+1),
		"multibyte over bound": strings.Repeat("é", MaxNameBytes/2+1),
		"too deep":             strings.Repeat("a/", MaxPathDepth) + "b",
	} {
		err := Validate(Manifest{V: Version, Items: []Item{{Kind: KindFile, Name: bad, Size: 1}}})
		if !errors.Is(err, ErrName) {
			t.Errorf("%s (%q): err = %v, want ErrName", name, bad, err)
		}
	}
	// And the boundary cases that must pass, so the rule is a rule and not a
	// ban on ordinary names.
	for name, ok := range map[string]string{
		"plain":                 "a.txt",
		"a relative folder":     "trip/day 1/IMG_0001.jpg",
		"dots inside a segment": "a..b.txt",
		"a leading dot":         ".hidden",
		"non-ASCII":             "发票 2026.pdf",
		"exactly the bound":     strings.Repeat("a", MaxNameBytes),
		"exactly the depth":     strings.Repeat("a/", MaxPathDepth-1) + "b",
	} {
		if err := Validate(Manifest{V: Version, Items: []Item{{Kind: KindFile, Name: ok, Size: 1}}}); err != nil {
			t.Errorf("%s (%q) must be accepted: %v", name, ok, err)
		}
	}
}

func TestSizesAndTotalsAreBounded(t *testing.T) {
	neg := Manifest{V: Version, Items: []Item{{Kind: KindFile, Name: "a", Size: -1}}}
	if err := Validate(neg); !errors.Is(err, ErrSize) {
		t.Fatalf("negative: err = %v", err)
	}
	over := Manifest{V: Version, Items: []Item{{Kind: KindFile, Name: "a", Size: MaxSafeInteger + 1}}}
	if err := Validate(over); !errors.Is(err, ErrSize) {
		t.Fatalf("past MaxSafeInteger: err = %v", err)
	}
	// Each item fits; the SUM does not. This is the one an item-at-a-time
	// bound misses, and it is what a receiver would use to preallocate.
	pair := Manifest{V: Version, Items: []Item{
		{Kind: KindFile, Name: "a", Size: MaxSafeInteger},
		{Kind: KindFile, Name: "b", Size: 1},
	}}
	if err := Validate(pair); !errors.Is(err, ErrTotalOverflow) {
		t.Fatalf("sum overflow: err = %v", err)
	}
	// int64 wraparound specifically: two values whose sum is negative in
	// two's complement would look "small" to a naive `total+size > max` check.
	wrap := Manifest{V: Version, Items: []Item{
		{Kind: KindFile, Name: "a", Size: MaxSafeInteger},
		{Kind: KindFile, Name: "b", Size: MaxSafeInteger},
	}}
	if err := Validate(wrap); !errors.Is(err, ErrTotalOverflow) {
		t.Fatalf("wraparound: err = %v", err)
	}
	// Zero is legal: an empty file is a real file.
	if err := Validate(Manifest{V: Version, Items: []Item{{Kind: KindFile, Name: "a", Size: 0}}}); err != nil {
		t.Fatalf("an empty file must be accepted: %v", err)
	}
}

func TestItemCountIsBounded(t *testing.T) {
	if err := Validate(Manifest{V: Version, Items: nil}); !errors.Is(err, ErrItemCount) {
		t.Fatalf("no items: err = %v", err)
	}
	at := make([]Item, MaxItems)
	for i := range at {
		at[i] = Item{Kind: KindFile, Name: "f", Size: 1}
	}
	if err := Validate(Manifest{V: Version, Items: at}); err != nil {
		t.Fatalf("exactly MaxItems must be accepted: %v", err)
	}
	if err := Validate(Manifest{V: Version, Items: append(at, at[0])}); !errors.Is(err, ErrItemCount) {
		t.Fatalf("MaxItems+1: err = %v", err)
	}
}

func TestUnknownFieldsAreRefusedNotIgnored(t *testing.T) {
	for name, doc := range map[string]string{
		"on the manifest": `{"v":3,"note":"hi","items":[{"kind":"file","name":"a.txt","size":1}]}`,
		"on an item":      `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1,"path":"/tmp"}]}`,
		// The one that matters: a sender must not be able to smuggle the
		// message body into the structure every receiver parses first.
		"the message body": `{"v":3,"items":[{"kind":"text","size":5,"text":"hello"}]}`,
		"a content key":    `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}],"key":"AAAA"}`,
	} {
		if _, err := Decode([]byte(doc)); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: err = %v, want ErrMalformed", name, err)
		}
	}
}

func TestNonCanonicalDocumentsAreRefused(t *testing.T) {
	for name, doc := range map[string]string{
		"manifest keys reordered": `{"items":[{"kind":"file","name":"a.txt","size":1}],"v":3}`,
		"item keys reordered":     `{"v":3,"items":[{"size":1,"kind":"file","name":"a.txt"}]}`,
		"pretty printed":          `{"v": 3, "items": [{"kind": "file", "name": "a.txt", "size": 1}]}`,
		"leading whitespace":      ` {"v":3,"items":[{"kind":"file","name":"a.txt","size":1}]}`,
		"trailing newline":        "{\"v\":3,\"items\":[{\"kind\":\"file\",\"name\":\"a.txt\",\"size\":1}]}\n",
		"duplicate key":           `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1,"size":2}]}`,
		"escaped solidus":         `{"v":3,"items":[{"kind":"file","name":"a\/b.txt","size":1}]}`,
		"needlessly escaped":      `{"v":3,"items":[{"kind":"file","name":"a\u003cb.txt","size":1}]}`,
		"omitted size":            `{"v":3,"items":[{"kind":"file","name":"a.txt"}]}`,
		"empty name on text":      `{"v":3,"items":[{"kind":"text","name":"","size":5}]}`,
	} {
		if _, err := Decode([]byte(doc)); !errors.Is(err, ErrNotCanonical) {
			t.Errorf("%s: err = %v, want ErrNotCanonical", name, err)
		}
	}
}

func TestMalformedDocumentsAreRefused(t *testing.T) {
	for name, doc := range map[string]string{
		"empty":              "",
		"not json":           "not json",
		"an array document":  `[{"kind":"file","name":"a.txt","size":1}]`,
		"items not an array": `{"v":3,"items":{"kind":"file","name":"a.txt","size":1}}`,
		"item not an object": `{"v":3,"items":["a.txt"]}`,
		"stringly size":      `{"v":3,"items":[{"kind":"file","name":"a.txt","size":"1"}]}`,
		"float size":         `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1.0}]}`,
		"exponent size":      `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1e3}]}`,
		"fractional size":    `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1.5}]}`,
		// A second document appended to the first. Without the trailing-token
		// check this would decode as its first value and the rest would vanish.
		"two documents": `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}]}{"v":3,"items":[{"kind":"text","size":1}]}`,
		"truncated":     `{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}`,
	} {
		if _, err := Decode([]byte(doc)); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: err = %v, want ErrMalformed", name, err)
		}
	}
}

func TestUnknownKindIsNeverGuessedAt(t *testing.T) {
	for name, doc := range map[string]string{
		"a third kind":  `{"v":3,"items":[{"kind":"folder","name":"a","size":1}]}`,
		"absent":        `{"v":3,"items":[{"name":"a.txt","size":1}]}`,
		"wrong case":    `{"v":3,"items":[{"kind":"File","name":"a.txt","size":1}]}`,
		"empty string":  `{"v":3,"items":[{"kind":"","name":"a.txt","size":1}]}`,
		"looks like v1": `{"v":3,"items":[{"kind":"files","name":"a.txt","size":1}]}`,
	} {
		if _, err := Decode([]byte(doc)); !errors.Is(err, ErrUnknownKind) {
			t.Errorf("%s: err = %v, want ErrUnknownKind", name, err)
		}
	}
}

// TestEncodeRefusesToProduceAnInvalidManifest is the sender-side half. A codec
// that only checked on the way IN would happily seal a traversal name and leave
// the refusal to the receiver — after the upload, and only if the receiver is
// this careful. Both directions cross the same boundary.
func TestEncodeRefusesToProduceAnInvalidManifest(t *testing.T) {
	for name, m := range map[string]Manifest{
		"traversal":  {V: Version, Items: []Item{{Kind: KindFile, Name: "../a", Size: 1}}},
		"mixed":      {V: Version, Items: []Item{{Kind: KindFile, Name: "a", Size: 1}, {Kind: KindText, Size: 1}}},
		"empty":      {V: Version},
		"wrong v":    {V: 1, Items: []Item{{Kind: KindFile, Name: "a", Size: 1}}},
		"named text": {V: Version, Items: []Item{{Kind: KindText, Name: "n", Size: 1}}},
	} {
		if _, err := Encode(m); err == nil {
			t.Errorf("%s: Encode accepted an invalid manifest", name)
		}
	}
	// The constructors refuse the same things, so no caller reaches Encode with
	// one in the first place.
	if _, err := NewText(0); !errors.Is(err, ErrSize) {
		t.Fatalf("NewText(0): err = %v, want ErrSize", err)
	}
	if _, err := NewFiles(nil); !errors.Is(err, ErrItemCount) {
		t.Fatalf("NewFiles(nil): err = %v, want ErrItemCount", err)
	}
}

func TestKindAndTotalReadBackWhatWasSealed(t *testing.T) {
	m := mustFiles(t, []Item{
		{Kind: KindFile, Name: "a", Size: 1},
		{Kind: KindFile, Name: "b", Size: 41},
	})
	if m.Kind() != KindFile || m.TotalSize() != 42 {
		t.Fatalf("kind=%q total=%d", m.Kind(), m.TotalSize())
	}
	tm := mustText(t, 11)
	if tm.Kind() != KindText || tm.TotalSize() != 11 {
		t.Fatalf("kind=%q total=%d", tm.Kind(), tm.TotalSize())
	}
}

func mustFiles(t *testing.T, items []Item) Manifest {
	t.Helper()
	m, err := NewFiles(items)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func mustText(t *testing.T, size int64) Manifest {
	t.Helper()
	m, err := NewText(size)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
