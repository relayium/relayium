package storecrypto

import (
	"math"
	"testing"
)

func TestValidateManifestRejectsUnsafeShapes(t *testing.T) {
	cases := []Manifest{
		{},
		{Files: []FileEntry{{Name: "", Size: 1}}},
		{Files: []FileEntry{{Name: "a", Size: -1}}},
		{Files: []FileEntry{{Name: "a", Size: math.MaxInt64}, {Name: "b", Size: 1}}},
		{Files: []FileEntry{{Name: "a", Size: MaxSafeInteger}, {Name: "b", Size: 1}}},
	}
	for i, m := range cases {
		if err := ValidateManifest(m); err == nil {
			t.Fatalf("case %d accepted: %#v", i, m)
		}
	}
}

func TestValidateManifestAcceptsBoundedFiles(t *testing.T) {
	if err := ValidateManifest(Manifest{Files: []FileEntry{{Name: "a", Size: 0}, {Name: "b", Size: 3}}}); err != nil {
		t.Fatal(err)
	}
}
