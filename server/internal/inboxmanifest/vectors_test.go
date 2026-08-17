package inboxmanifest

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The frozen cross-language vectors. One file, three ecosystems: this test, the
// Swift `InboxManifestTests`, and the TypeScript `inbox-manifest.test.ts` all
// read the SAME bytes, so an implementation that drifts fails here rather than
// on a user's device halfway through a delivery.
//
// It lives under the Swift package because SwiftPM can only load test resources
// from inside its own package directory. Go and TypeScript have no such
// restriction and reach it by relative path, which is why there is one copy and
// not three.
const vectorPath = "../../../apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json"

type vectorFile struct {
	Version int `json:"version"`
	Bounds  struct {
		MaxItems       int   `json:"maxItems"`
		MinItems       int   `json:"minItems"`
		MaxNameBytes   int   `json:"maxNameBytes"`
		MaxPathDepth   int   `json:"maxPathDepth"`
		MaxSafeInteger int64 `json:"maxSafeInteger"`
		MinTextBytes   int64 `json:"minTextBytes"`
		MaxTextBytes   int64 `json:"maxTextBytes"`
	} `json:"bounds"`
	Accept []struct {
		Name      string `json:"name"`
		Canonical string `json:"canonical"`
		Kind      string `json:"kind"`
		Total     int64  `json:"total"`
		Items     []Item `json:"items"`
	} `json:"accept"`
	Refuse []struct {
		Name       string `json:"name"`
		Reason     string `json:"reason"`
		AnyRefusal bool   `json:"anyRefusal"`
		JSON       string `json:"json"`
	} `json:"refuse"`
	Generated []struct {
		Name      string `json:"name"`
		Reason    string `json:"reason"`
		Kind      string `json:"kind"`
		Count     int    `json:"count"`
		NameBytes int    `json:"nameBytes"`
		Depth     int    `json:"depth"`
	} `json:"generated"`
}

// reasons maps each fixture token to the error this implementation must return.
// Written out rather than derived, so adding a vector with a new token fails
// loudly instead of silently matching nothing.
var reasons = map[string]error{
	"version":       ErrVersion,
	"itemCount":     ErrItemCount,
	"unknownKind":   ErrUnknownKind,
	"mixedKinds":    ErrMixedKinds,
	"name":          ErrName,
	"textName":      ErrTextName,
	"textItemCount": ErrTextItemCount,
	"size":          ErrSize,
	"totalOverflow": ErrTotalOverflow,
	"malformed":     ErrMalformed,
	"notCanonical":  ErrNotCanonical,
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile(filepath.FromSlash(vectorPath))
	if err != nil {
		t.Fatalf("the frozen vectors must be readable from this package: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("vectors: %v", err)
	}
	return v
}

// TestVectorBoundsMatchThisImplementation checks the constants before the
// documents. A bound that drifted here would make every vector below pass
// against the wrong rule.
func TestVectorBoundsMatchThisImplementation(t *testing.T) {
	v := loadVectors(t)
	for _, c := range []struct {
		name       string
		got, fixed int64
	}{
		{"version", Version, int64(v.Version)},
		{"maxItems", MaxItems, int64(v.Bounds.MaxItems)},
		{"minItems", MinItems, int64(v.Bounds.MinItems)},
		{"maxNameBytes", MaxNameBytes, int64(v.Bounds.MaxNameBytes)},
		{"maxPathDepth", MaxPathDepth, int64(v.Bounds.MaxPathDepth)},
		{"maxSafeInteger", MaxSafeInteger, v.Bounds.MaxSafeInteger},
		{"minTextBytes", MinTextBytes, v.Bounds.MinTextBytes},
		{"maxTextBytes", MaxTextBytes, v.Bounds.MaxTextBytes},
	} {
		if c.got != c.fixed {
			t.Errorf("%s = %d, fixture says %d", c.name, c.got, c.fixed)
		}
	}
}

func TestVectorsAccept(t *testing.T) {
	v := loadVectors(t)
	if len(v.Accept) == 0 {
		t.Fatal("no accept vectors were loaded")
	}
	for _, tc := range v.Accept {
		t.Run(tc.Name, func(t *testing.T) {
			// DECODE: the frozen bytes must parse to exactly the stated shape.
			m, err := Decode([]byte(tc.Canonical))
			if err != nil {
				t.Fatalf("must decode: %v", err)
			}
			if string(m.Kind()) != tc.Kind {
				t.Fatalf("kind = %q, want %q", m.Kind(), tc.Kind)
			}
			if m.TotalSize() != tc.Total {
				t.Fatalf("total = %d, want %d", m.TotalSize(), tc.Total)
			}
			if len(m.Items) != len(tc.Items) {
				t.Fatalf("%d items, want %d", len(m.Items), len(tc.Items))
			}
			for i, want := range tc.Items {
				if m.Items[i] != want {
					t.Fatalf("item %d = %+v, want %+v", i, m.Items[i], want)
				}
			}
			// ENCODE: and this implementation must produce those exact bytes
			// from that shape. Decoding alone would let a lenient encoder pass.
			out, err := Encode(Manifest{V: Version, Items: tc.Items})
			if err != nil {
				t.Fatalf("must encode: %v", err)
			}
			if string(out) != tc.Canonical {
				t.Fatalf("encoded\n got %s\nwant %s", out, tc.Canonical)
			}
		})
	}
}

func TestVectorsRefuse(t *testing.T) {
	v := loadVectors(t)
	if len(v.Refuse) == 0 {
		t.Fatal("no refuse vectors were loaded")
	}
	for _, tc := range v.Refuse {
		t.Run(tc.Name, func(t *testing.T) {
			want, known := reasons[tc.Reason]
			if !known {
				t.Fatalf("vector uses reason %q, which this test does not map", tc.Reason)
			}
			_, err := Decode([]byte(tc.JSON))
			if err == nil {
				t.Fatalf("accepted a document the vectors refuse: %s", tc.JSON)
			}
			// `anyRefusal` vectors are ones the three JSON parsers cannot all
			// observe identically (JavaScript cannot tell 1.0 from 1 after
			// parsing; Go cannot tell an absent key from a zero value). They
			// must still be refused — only the clause is allowed to differ.
			if tc.AnyRefusal {
				return
			}
			if !errors.Is(err, want) {
				t.Fatalf("err = %v, want %v", err, want)
			}
		})
	}
}

// TestVectorsGenerated covers the bounds that would make the fixture enormous
// if spelled out — a thousand items, a kilobyte name, a sixty-four-deep path —
// by constructing them from the same frozen numbers.
func TestVectorsGenerated(t *testing.T) {
	v := loadVectors(t)
	if len(v.Generated) == 0 {
		t.Fatal("no generated vectors were loaded")
	}
	for _, tc := range v.Generated {
		t.Run(tc.Name, func(t *testing.T) {
			var m Manifest
			switch {
			case tc.Count > 0:
				items := make([]Item, tc.Count)
				for i := range items {
					items[i] = Item{Kind: KindFile, Name: "f", Size: 1}
				}
				m = Manifest{V: Version, Items: items}
			case tc.NameBytes > 0:
				m = Manifest{V: Version, Items: []Item{
					{Kind: KindFile, Name: strings.Repeat("a", tc.NameBytes), Size: 1},
				}}
			case tc.Depth > 0:
				m = Manifest{V: Version, Items: []Item{
					{Kind: KindFile, Name: strings.Repeat("a/", tc.Depth-1) + "b", Size: 1},
				}}
			default:
				t.Fatalf("generated vector %q describes nothing to build", tc.Name)
			}
			err := Validate(m)
			if tc.Reason == "accept" {
				if err != nil {
					t.Fatalf("must be accepted: %v", err)
				}
				// Round-trips too: a bound that only Validate honours would
				// still break a real delivery at encode or decode time.
				encoded, err := Encode(m)
				if err != nil {
					t.Fatalf("encode: %v", err)
				}
				if _, err := Decode(encoded); err != nil {
					t.Fatalf("decode: %v", err)
				}
				return
			}
			want, known := reasons[tc.Reason]
			if !known {
				t.Fatalf("unmapped reason %q", tc.Reason)
			}
			if !errors.Is(err, want) {
				t.Fatalf("err = %v, want %v", err, want)
			}
		})
	}
}
