package selfupdate

import "testing"

// CompareVersions is exported because the admin panel decides whether a release
// is newer than what the fleet targets, and it lives in another package. The
// (result, ok) shape is load-bearing: an unparseable version must stay
// distinguishable from "equal", or a typo would read as "nothing new".
func TestCompareVersionsIsExported(t *testing.T) {
	if n, ok := CompareVersions("v1.3.0", "v1.2.9"); !ok || n <= 0 {
		t.Fatalf("CompareVersions(v1.3.0, v1.2.9) = %d, %v; want a positive comparison", n, ok)
	}
	if n, ok := CompareVersions("v1.2.0", "v1.2.0"); !ok || n != 0 {
		t.Fatalf("equal versions compared as %d, %v", n, ok)
	}
	if _, ok := CompareVersions("not-a-version", "v1.2.0"); ok {
		t.Fatal("an unparseable version reported ok; it must be distinguishable from equal")
	}
}
