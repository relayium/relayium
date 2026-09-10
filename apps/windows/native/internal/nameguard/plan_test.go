// Portable planner tests.
//
// SCOPE: the plan decision only. A manifest accepted here is still subject to
// the NT layer's own refusals at publication; see internal/winio.
package nameguard

import (
	"strconv"
	"strings"
	"testing"
)

func names(entries ...string) []Entry {
	out := make([]Entry, len(entries))
	for i, n := range entries {
		out[i] = Entry{Name: n, Size: 0}
	}
	return out
}

// A manifest with one bad entry must produce zero files, not N-1. The receiver
// is otherwise left partially delivered with no true answer to "did it save?".
func TestOneBadEntryRefusesTheWholeManifest(t *testing.T) {
	plan, failure := BuildPlan(names("good.txt", "also-good.txt", "../escape"))
	if failure == nil {
		t.Fatal("manifest with a traversal was accepted")
	}
	if plan != nil {
		t.Fatal("a refused manifest still produced a plan")
	}
	if failure.Kind != FailPath || failure.Index != 2 || failure.Reason != RejectTraversal {
		t.Fatalf("refusal not specific: %+v", failure)
	}
}

// Both directions, or the refusal would depend on manifest order.
func TestFileVersusParentBothDirections(t *testing.T) {
	if _, f := BuildPlan(names("file", "file/child")); f == nil || f.Kind != FailFileVsParent {
		t.Fatalf("file then file/child: %+v", f)
	}
	if _, f := BuildPlan(names("file/child", "file")); f == nil || f.Kind != FailFileVsParent {
		t.Fatalf("file/child then file: %+v", f)
	}
}

func TestCaseCollisionRefused(t *testing.T) {
	if _, f := BuildPlan(names("A.txt", "a.txt")); f == nil || f.Kind != FailDuplicate {
		t.Fatalf("case collision: %+v", f)
	}
	if _, f := BuildPlan(names("dir/x", "DIR/X")); f == nil || f.Kind != FailDuplicate {
		t.Fatalf("case collision through a directory: %+v", f)
	}
}

// Shared prefixes must open once, which is what keeps the pinned handle count at
// the distinct directory total instead of one chain per file.
func TestDirectoriesAreDeduplicatedAndOrderedParentFirst(t *testing.T) {
	plan, f := BuildPlan(names("a/b/one.txt", "a/b/two.txt", "a/c/three.txt"))
	if f != nil {
		t.Fatalf("valid manifest refused: %+v", f)
	}
	want := []string{"A", "A/B", "A/C"}
	if len(plan.Directories) != len(want) {
		t.Fatalf("directories %v, want %v", plan.Directories, want)
	}
	for i, key := range want {
		if plan.Directories[i] != key {
			t.Fatalf("directory %d is %q, want %q (parents must precede children)", i, plan.Directories[i], key)
		}
	}
	// Each file carries its own ancestor chain for the walk.
	if got := plan.Files[2].DirectoryKeys; len(got) != 2 || got[0] != "A" || got[1] != "A/C" {
		t.Fatalf("per-file directory chain wrong: %v", got)
	}
}

func TestFileCountCap(t *testing.T) {
	entries := make([]Entry, MaxFiles+1)
	for i := range entries {
		entries[i] = Entry{Name: "f" + strconv.Itoa(i), Size: 0}
	}
	if _, f := BuildPlan(entries); f == nil || f.Kind != FailCount {
		t.Fatalf("want count refusal, got %+v", f)
	}
}

// The aggregate name budget has no TypeScript equivalent and must refuse
// explicitly rather than truncate.
func TestAggregateManifestNameCap(t *testing.T) {
	// Long but individually LEGAL names: each segment stays under
	// MaxSegmentUTF16, so this exercises the aggregate budget rather than
	// tripping the per-segment limit first. The directory prefix is shared, so
	// the distinct-directory cap is not what fires either.
	seg := strings.Repeat("n", 250)
	prefix := strings.Repeat(seg+"/", 5)
	entries := make([]Entry, 0, MaxFiles)
	for i := 0; i < MaxFiles; i++ {
		entries = append(entries, Entry{Name: prefix + "f" + strconv.Itoa(i) + ".bin", Size: 0})
	}
	_, f := BuildPlan(entries)
	if f == nil || f.Kind != FailManifestTooBig {
		t.Fatalf("want manifest-too-large, got %+v", f)
	}
	if f.Index < 0 {
		t.Fatal("refusal must name the entry that crossed the budget")
	}
}

// The directory budget bounds a live resource: every distinct directory is a
// handle held for the whole of publication.
func TestDistinctDirectoryCap(t *testing.T) {
	entries := make([]Entry, 0, MaxFiles)
	// 20 directories per file across 300 files gives well over the cap while
	// staying inside the depth and count limits.
	for i := 0; i < 300; i++ {
		var b strings.Builder
		for d := 0; d < 20; d++ {
			b.WriteString("d")
			b.WriteString(strconv.Itoa(i))
			b.WriteString("_")
			b.WriteString(strconv.Itoa(d))
			b.WriteString("/")
		}
		b.WriteString("f.bin")
		entries = append(entries, Entry{Name: b.String(), Size: 0})
	}
	_, f := BuildPlan(entries)
	if f == nil || f.Kind != FailTooManyDirs {
		t.Fatalf("want too-many-directories, got %+v", f)
	}
}

func TestNegativeSizeRefused(t *testing.T) {
	if _, f := BuildPlan([]Entry{{Name: "a", Size: -1}}); f == nil || f.Kind != FailSize {
		t.Fatalf("want size refusal, got %+v", f)
	}
}

func TestTotalSizeOverflowRefused(t *testing.T) {
	half := MaxTotalBytes/2 + 2
	_, f := BuildPlan([]Entry{{Name: "a", Size: half}, {Name: "b", Size: half}})
	if f == nil || f.Kind != FailTotalSize {
		t.Fatalf("want total-size refusal, got %+v", f)
	}
}

// The plan must own its strings: segments alias a split of the caller's name.
func TestPlanOwnsItsSegments(t *testing.T) {
	plan, f := BuildPlan(names("a/b/c.txt"))
	if f != nil {
		t.Fatalf("refused: %+v", f)
	}
	if len(plan.Files[0].Segments) != 3 {
		t.Fatalf("segments %v", plan.Files[0].Segments)
	}
	if len(plan.DirectorySegments) != 2 || plan.DirectorySegments[1][1] != "b" {
		t.Fatalf("directory segments wrong: %v", plan.DirectorySegments)
	}
}

func TestZeroAndEmptyManifests(t *testing.T) {
	plan, f := BuildPlan(nil)
	if f != nil || len(plan.Files) != 0 {
		t.Fatalf("empty manifest: %+v %+v", plan, f)
	}
	plan, f = BuildPlan([]Entry{{Name: "empty.bin", Size: 0}})
	if f != nil || len(plan.Files) != 1 || plan.TotalBytes != 0 {
		t.Fatalf("zero-byte file: %+v %+v", plan, f)
	}
}
