package xfer

import (
	"math"
	"testing"
)

func TestValidateManifestRejectsDuplicateAndInvalidEntries(t *testing.T) {
	dir := t.TempDir()
	for _, m := range []Manifest{
		{Files: []FileEntry{{Path: "a", Size: -1}}},
		{Files: []FileEntry{{Path: "a", Size: math.MaxInt64}, {Path: "b", Size: 1}}},
		{Files: []FileEntry{{Path: "a/../same", Size: 1}, {Path: "same", Size: 1}}},
		{Files: []FileEntry{{Path: "", Size: 1}}},
	} {
		if err := validateManifest(dir, m); err == nil {
			t.Fatalf("accepted %#v", m)
		}
	}
}
