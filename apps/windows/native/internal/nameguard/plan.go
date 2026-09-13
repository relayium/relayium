// Turning a manifest into a write plan — or refusing it, before touching disk.
//
// Ports src/main/io/plan.ts, and adds the aggregate bounds the TypeScript
// planner does not have (see MaxManifestNameBytes and MaxDistinctDirectories).
//
// ## Why the whole manifest is judged before the first byte
//
// A per-file check that runs as each file arrives has already created files by
// the time it meets the one it must refuse. The receiver is then in the state
// this product refuses to report anywhere else: partially delivered, with no
// single true answer to "did it save?". So the plan is total, and a manifest
// with one bad entry produces zero files rather than N-1.
//
// ## The two conflicts a per-name validator cannot see
//
//   - Case collision. `A.txt` and `a.txt` are both valid names and the same NTFS
//     file. Writing both means the second replaces the first while the receiver
//     is told two files arrived.
//   - File versus parent. `file` and `file/child` are both valid and no ordering
//     satisfies them. The honest answer is to say so before creating either.
package nameguard

// PlannedFile is one validated destination.
type PlannedFile struct {
	// Segments are validated components relative to the chosen root.
	Segments []string
	// Size is the exact byte count the sink will require. Never re-derived.
	Size int64
	// DirectoryKeys are the collision keys of every ancestor directory this file
	// needs, outermost first. Precomputed so publication opens each distinct
	// directory once instead of once per file.
	DirectoryKeys []string
}

// Aggregate bounds.
//
// MaxFiles matches the realtime wire's MAX_FILES and plan.ts.
//
// MaxManifestNameBytes and MaxDistinctDirectories have NO equivalent in
// plan.ts, and that divergence is deliberate rather than accidental. Each one
// bounds a resource this process must actually hold:
//
//   - Names are the bulk of the `open` frame, and MaxOpenRequestBytes has to be
//     a number. Without an aggregate name budget, a legal 1000-entry manifest of
//     32000-character names is roughly 96 MB and no frame ceiling could admit it.
//   - Directory handles are pinned for the whole of publication, so their count
//     is a live resource. Per-file limits bound it only at 1000 x 64.
//
// Both are refused explicitly at `open`, before a byte is written, and never by
// truncating the manifest. The integrator should pre-check them in main so the
// user sees a better message than a boundary refusal; see native/README.md.
const (
	MaxFiles               = 1000
	MaxManifestNameBytes   = 1 << 20
	MaxDistinctDirectories = 4096
	MaxTotalBytes          = int64(1)<<53 - 1 // Number.MAX_SAFE_INTEGER
)

// FailureKind classifies a plan refusal.
type FailureKind string

const (
	FailPath           FailureKind = "path"
	FailDuplicate      FailureKind = "duplicate"
	FailFileVsParent   FailureKind = "file-vs-parent"
	FailSize           FailureKind = "size"
	FailCount          FailureKind = "count"
	FailTotalSize      FailureKind = "total-size"
	FailManifestTooBig FailureKind = "manifest-too-large"
	FailTooManyDirs    FailureKind = "too-many-directories"
)

// Failure is the first refusal, deterministic in manifest order so a refusal is
// reproducible from a bug report.
type Failure struct {
	Kind FailureKind
	// Index of the offending entry, or -1 for a whole-manifest refusal. The
	// offending NAME is deliberately absent: this value is logged, and a
	// filename is user content.
	Index  int
	Reason Rejection
}

// Entry is one manifest row.
type Entry struct {
	Name string
	Size int64
}

// Plan is an accepted manifest.
type Plan struct {
	Files []PlannedFile
	// Directories are distinct ancestor directory keys in creation order,
	// outermost before innermost, deduplicated across the whole manifest.
	Directories []string
	// DirectorySegments parallels Directories, giving the raw components.
	DirectorySegments [][]string
	TotalBytes        int64
}

// BuildPlan validates an entire manifest and produces the write plan, or the
// first failure.
func BuildPlan(entries []Entry) (*Plan, *Failure) {
	if len(entries) > MaxFiles {
		return nil, &Failure{Kind: FailCount, Index: -1}
	}

	plan := &Plan{Files: make([]PlannedFile, 0, len(entries))}
	// collision key -> index of the entry that claimed it as a FILE.
	claimed := make(map[string]int, len(entries))
	// collision key -> already recorded as a needed DIRECTORY.
	directories := make(map[string]struct{})
	var nameBytes int

	for i, entry := range entries {
		nameBytes += len(entry.Name)
		if nameBytes > MaxManifestNameBytes {
			return nil, &Failure{Kind: FailManifestTooBig, Index: i}
		}

		verdict := ValidateRelativePath(entry.Name)
		if !verdict.OK {
			return nil, &Failure{Kind: FailPath, Index: i, Reason: verdict.Reason}
		}
		// A size that is not a non-negative safe integer cannot be compared
		// against a byte counter, so a sink built on it could never detect a
		// short write.
		if entry.Size < 0 || entry.Size > MaxTotalBytes {
			return nil, &Failure{Kind: FailSize, Index: i}
		}
		if plan.TotalBytes > MaxTotalBytes-entry.Size {
			return nil, &Failure{Kind: FailTotalSize, Index: -1}
		}
		plan.TotalBytes += entry.Size

		segments := verdict.Segments
		key := CollisionKey(segments)
		if _, dup := claimed[key]; dup {
			return nil, &Failure{Kind: FailDuplicate, Index: i}
		}

		// This file's path may not pass THROUGH a name another entry claimed as
		// a file: `file/child` after `file`.
		dirKeys := make([]string, 0, len(segments)-1)
		for d := 1; d < len(segments); d++ {
			prefix := CollisionKey(segments[:d])
			if _, isFile := claimed[prefix]; isFile {
				return nil, &Failure{Kind: FailFileVsParent, Index: i}
			}
			dirKeys = append(dirKeys, prefix)
			if _, seen := directories[prefix]; !seen {
				directories[prefix] = struct{}{}
				if len(plan.Directories) >= MaxDistinctDirectories {
					return nil, &Failure{Kind: FailTooManyDirs, Index: i}
				}
				plan.Directories = append(plan.Directories, prefix)
				// Copied: segments aliases the split of entry.Name, and the plan
				// outlives this loop iteration's ownership of it.
				owned := make([]string, d)
				copy(owned, segments[:d])
				plan.DirectorySegments = append(plan.DirectorySegments, owned)
			}
		}
		// ...and this file may not claim a name an earlier entry already needs
		// as a directory: `file` after `file/child`. Both directions, or the
		// refusal would depend on manifest order.
		if _, isDir := directories[key]; isDir {
			return nil, &Failure{Kind: FailFileVsParent, Index: i}
		}

		claimed[key] = i
		owned := make([]string, len(segments))
		copy(owned, segments)
		plan.Files = append(plan.Files, PlannedFile{
			Segments:      owned,
			Size:          entry.Size,
			DirectoryKeys: dirKeys,
		})
	}
	return plan, nil
}
