package inboxmanifest

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// maxSeedBytes bounds one seed document. The frozen vectors are all far below
// it; the bound exists so a vector added later — the fixture is shared with
// Swift and TypeScript and is not this test's to control — cannot quietly turn
// a seed corpus into a set of megabyte inputs the fuzzer then mutates forever.
//
// A vector past the bound FAILS this test rather than being skipped. Skipping
// was the first spelling and it is the worse one: the fixture is the shared
// record of what every implementation must accept and refuse, so the vector
// most likely to exceed a size bound is a large-manifest or deep-path case
// somebody added precisely because it was hard. Dropping it leaves the seed
// corpus short of the fixture with nothing red anywhere — this test passes, the
// campaign runs, and the one document the fuzzer most needed to start from is
// the one it never sees. Failing forces the choice to be made on purpose:
// shrink the vector, or raise this bound knowing what it now admits.
const maxSeedBytes = 4096

// seedFromVectors adds every frozen cross-language document as a seed.
//
// The bytes are READ from the fixture rather than transcribed into this file.
// Transcribing them would create a second copy that drifts: the fixture is the
// one the Swift and TypeScript suites read, and a seed corpus quoting a stale
// version of it would seed the fuzzer with documents no other implementation
// still agrees about.
//
// Both halves are seeded on purpose. The accept vectors put the fuzzer next to
// the canonical spellings, where a one-byte mutation is exactly the near-miss
// this codec has to refuse; the refuse vectors put it next to the documents
// that are already refused, where a mutation may find the neighbouring one that
// is not.
func seedFromVectors(f *testing.F) {
	f.Helper()
	data, err := os.ReadFile(filepath.FromSlash(vectorPath))
	if err != nil {
		f.Fatalf("the frozen vectors must be readable from this package: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(data, &v); err != nil {
		f.Fatalf("vectors: %v", err)
	}
	if len(v.Accept) == 0 || len(v.Refuse) == 0 {
		f.Fatalf("the fixture contributed no seeds: %d accept, %d refuse", len(v.Accept), len(v.Refuse))
	}
	// Every document reaches f.Add, or this test fails naming the one that did
	// not. There is deliberately no branch here that adds nothing and returns.
	for _, tc := range v.Accept {
		if len(tc.Canonical) > maxSeedBytes {
			f.Fatalf("accept vector %q is %d bytes, past the %d-byte seed bound, so it cannot be "+
				"seeded as written. Shrink the vector or raise maxSeedBytes deliberately; this "+
				"test will not quietly fuzz a corpus that is missing one of the frozen documents.",
				tc.Name, len(tc.Canonical), maxSeedBytes)
		}
		f.Add([]byte(tc.Canonical))
	}
	for _, tc := range v.Refuse {
		if len(tc.JSON) > maxSeedBytes {
			f.Fatalf("refuse vector %q is %d bytes, past the %d-byte seed bound, so it cannot be "+
				"seeded as written. Shrink the vector or raise maxSeedBytes deliberately; this "+
				"test will not quietly fuzz a corpus that is missing one of the frozen documents.",
				tc.Name, len(tc.JSON), maxSeedBytes)
		}
		f.Add([]byte(tc.JSON))
	}
}

// FuzzDecode is invariant 3 — CANONICAL OR REFUSED — as a property.
//
// Decode is the first thing a receiver runs on sender-controlled bytes after
// the AEAD opens, and invariant 4 says the seal proves authorship and nothing
// about safety. So the contract under arbitrary input is: never panic, and
// either refuse or hand back a manifest that is both valid and the ONE spelling
// of itself.
func FuzzDecode(f *testing.F) {
	seedFromVectors(f)
	// Shapes the fixture has no reason to carry: not JSON at all, empty, and
	// the truncations a fuzzer would otherwise have to find its own way to.
	for _, seed := range []string{
		"",
		"\x00",
		"[]",
		"{",
		`{"v":3,"items":[`,
	} {
		f.Add([]byte(seed))
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		m, err := Decode(data)
		if err != nil {
			return
		}
		// Everything below only holds for a document Decode ACCEPTED, and each
		// line is something a caller is entitled to assume from that point on.
		if err := Validate(m); err != nil {
			t.Fatalf("Decode accepted %q but Validate refuses it: %v", data, err)
		}
		if k := m.Kind(); k != KindFile && k != KindText {
			t.Fatalf("Decode accepted %q with kind %q, which is outside the closed set", data, k)
		}
		// Safe only on a validated manifest, which is exactly what we have.
		if total := m.TotalSize(); total < 0 || total > MaxSafeInteger {
			t.Fatalf("Decode accepted %q whose total size is %d", data, total)
		}
		encoded, err := Encode(m)
		if err != nil {
			t.Fatalf("Decode accepted %q but Encode refuses to re-emit it: %v", data, err)
		}
		if !bytes.Equal(encoded, data) {
			t.Fatalf("Decode accepted a non-canonical document\n  in  %q\n  out %q", data, encoded)
		}
		// And the round trip closes: re-decoding the bytes this codec produced
		// yields the same manifest, so nothing about the document depends on
		// which side of the wire it was last on.
		back, err := Decode(encoded)
		if err != nil {
			t.Fatalf("Encode produced %q, which Decode refuses: %v", encoded, err)
		}
		if back.V != m.V || len(back.Items) != len(m.Items) {
			t.Fatalf("round trip changed the manifest shape: %+v vs %+v", back, m)
		}
		for i := range m.Items {
			if back.Items[i] != m.Items[i] {
				t.Fatalf("round trip changed item %d: %+v vs %+v", i, back.Items[i], m.Items[i])
			}
		}
	})
}

// FuzzEncodeRoundTrip drives the other direction: manifests assembled directly,
// bypassing the constructors exactly as a hostile or broken sender would.
//
// Decode can only ever reach Encode with documents that already parsed, so on
// its own it leaves the encoder's own refusals — a negative size, a name past
// the byte bound, a total that overflows, a mixed-kind delivery — reachable
// only through whatever JSON the fuzzer happens to synthesize. Building the
// struct instead puts every bound one step from the input.
func FuzzEncodeRoundTrip(f *testing.F) {
	f.Add("a.txt", []byte{1}, false, int64(1), byte(0))
	f.Add("dir/a.txt\x00dir/b.txt", []byte{0, 255}, false, int64(1), byte(0))
	f.Add("", []byte{}, true, int64(MaxTextBytes), byte(0))
	f.Add("../escape", []byte{7}, false, int64(0), byte(0))
	f.Add("a\"b\\c", []byte{200}, false, int64(0), byte(1))

	f.Fuzz(func(t *testing.T, names string, sizes []byte, text bool, textSize int64, mix byte) {
		m := manifestFromFuzz(names, sizes, text, textSize, mix)

		validateErr := Validate(m)
		encoded, encodeErr := Encode(m)
		// Encode validates first and must never emit bytes for a manifest
		// Validate refuses; that is what stops a sender from producing a
		// document every receiver will then reject halfway through a delivery.
		if validateErr != nil {
			if encodeErr == nil {
				t.Fatalf("Validate refuses %+v (%v) but Encode emitted %q", m, validateErr, encoded)
			}
			return
		}
		if encodeErr != nil {
			t.Fatalf("Validate accepts %+v but Encode refuses it: %v", m, encodeErr)
		}

		back, err := Decode(encoded)
		if err != nil {
			t.Fatalf("Encode produced %q from %+v, which Decode refuses: %v", encoded, m, err)
		}
		if back.V != m.V || len(back.Items) != len(m.Items) {
			t.Fatalf("round trip changed the manifest shape: %+v vs %+v", back, m)
		}
		for i := range m.Items {
			if back.Items[i] != m.Items[i] {
				t.Fatalf("round trip changed item %d: %+v vs %+v", i, back.Items[i], m.Items[i])
			}
		}
		// Canonical means fixed-point: encoding what was decoded from these
		// bytes reproduces them.
		again, err := Encode(back)
		if err != nil {
			t.Fatalf("re-encoding a decoded manifest failed: %v", err)
		}
		if !bytes.Equal(again, encoded) {
			t.Fatalf("encoding is not a fixed point\n  first  %q\n  second %q", encoded, again)
		}
	})
}

// manifestFromFuzz builds one manifest from fuzz input, deterministically.
//
// It deliberately produces manifests this codec must REFUSE as well as ones it
// must accept — the sizes are scaled so the MaxSafeInteger ceiling, negative
// sizes and total overflow are all a few input bytes away, and `mix` retypes
// one item so invariant 2 has something to reject.
func manifestFromFuzz(names string, sizes []byte, text bool, textSize int64, mix byte) Manifest {
	if text {
		return Manifest{V: Version, Items: []Item{{Kind: KindText, Size: textSize}}}
	}
	// NUL separates names because it is the one byte validateName always
	// refuses, so it can never be part of a name the fuzzer is trying to build.
	parts := strings.Split(names, "\x00")
	// One past MaxItems is all this needs: the count bound is a comparison, and
	// a thousand-item manifest per input would spend the whole fuzz budget on
	// allocation rather than on the bounds.
	if len(parts) > MaxItems+1 {
		parts = parts[:MaxItems+1]
	}
	items := make([]Item, len(parts))
	for i, name := range parts {
		var size int64
		if len(sizes) > 0 {
			b := sizes[i%len(sizes)]
			// Shifting reaches the MaxSafeInteger ceiling, int64 overflow and
			// negative values from a single byte; a raw 0..255 never would.
			size = int64(b) << (uint(b) % 63)
		}
		items[i] = Item{Kind: KindFile, Name: name, Size: size}
	}
	if mix > 0 && len(items) > 0 {
		items[int(mix)%len(items)].Kind = KindText
	}
	return Manifest{V: Version, Items: items}
}
