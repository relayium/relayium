package inboxclient

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/relayium/relayium/internal/storecrypto"
)

// Destination planning: turning a decrypted, sender-controlled manifest into the
// exact set of local paths this task is allowed to create.
//
// AEAD proves the manifest was built by whoever holds the content key. It does
// NOT make the names inside it safe: the sender is another machine, possibly
// compromised, and a name is an instruction to this filesystem. Everything below
// treats a manifest name as hostile input.
//
// The plan is computed ONCE, before anything is downloaded, and is journalled
// before anything is committed. That ordering is what makes a crash resumable:
// the set of destinations a task may ever create is fixed and durable before the
// first one exists, so recovery never has to re-derive it from a directory that
// has since changed.

// Destination-planning bounds. The manifest's own count/size bounds are enforced
// by storecrypto.ValidateManifest; these are the filesystem-shaped ones.
const (
	// maxPathDepth bounds directory nesting created for one task. Deep trees are
	// legitimate but unbounded depth is a cheap way to exhaust path limits or
	// make cleanup expensive.
	maxPathDepth = 32
	// maxCollisionIndex bounds the deterministic "name (2)" search. Reaching it
	// means the directory genuinely has thousands of same-named files, which is a
	// human problem (name_conflict), not something to keep scanning for.
	maxCollisionIndex = 1000
	// stagingDirName is the per-task staging area, created INSIDE the receive
	// directory so the final commit is a same-filesystem link and can be atomic.
	// A staging area on another filesystem would silently degrade the commit to a
	// copy, reintroducing the partially-written-file window this design removes.
	stagingDirName = ".relayium-incoming"
)

// reservedTopLevelNames are the entries in the receive directory that belong to
// this package, and which a manifest may therefore never name.
//
// Both are real hazards, not tidiness. A delivery into stagingDirName would land
// ON its own staged source, so the commit would link the file to itself and then
// unlink it — the delivery would report saved and leave nothing. A delivery named
// probeName would be DELETED by the next readiness probe, which removes a stale
// probe file it assumes it left behind.
var reservedTopLevelNames = map[string]bool{
	stagingDirName: true,
	probeName:      true,
}

// ErrUnsafeName is a manifest entry this device refuses to materialise. It is
// terminal: the same bytes will be rejected the same way on every retry.
var ErrUnsafeName = errors.New("relayium inbox: manifest names a destination this device refuses to create")

// ErrNameConflict means every deterministic candidate name is taken. A human has
// to look, so it maps to attention_required rather than a retry.
var ErrNameConflict = errors.New("relayium inbox: no free destination name")

// PlanEntry binds one manifest entry to the one path it may ever create.
//
// Name and Dest are plaintext-derived and therefore LOCAL ONLY: they live in the
// 0600 journal so a crash can resume, and they are never logged, never printed
// by the worker, and never sent to central (invariant 6).
type PlanEntry struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Dest  string `json:"dest"`
}

// sanitizeName validates one manifest name and returns it as a cleaned,
// slash-separated relative path.
//
// The rules, and what each one is actually stopping:
//
//   - empty / oversized / invalid UTF-8: unrepresentable or unbounded input.
//   - control bytes (including NUL): a name that can truncate a C string or
//     rewrite a terminal line.
//   - a leading "/" or a Windows drive/UNC prefix: an ABSOLUTE destination,
//     which would leave the receive directory entirely.
//   - "\\" anywhere: the separator is "/" by protocol. A backslash is a legal
//     byte in a POSIX name but means "directory separator" on Windows, so the
//     same manifest would produce different trees on different receivers — the
//     definition of a confusable path.
//   - "." or ".." components: traversal, the classic Zip-Slip.
//   - empty components ("a//b"): two spellings of one path.
//   - a component ending in "." or " ": Windows silently strips both, so
//     "x " and "x" would collide there and not here.
//   - Windows reserved device names: opening "CON" on Windows talks to a device
//     rather than creating a file. Rejected on EVERY platform on purpose, so one
//     manifest is accepted or refused identically everywhere; a name that only
//     some of a user's devices can receive is worse than one none of them can.
func sanitizeName(name string) (string, error) {
	if name == "" || len(name) > storecrypto.MaxFileNameBytes {
		return "", fmt.Errorf("%w: bad length", ErrUnsafeName)
	}
	if !utf8.ValidString(name) {
		return "", fmt.Errorf("%w: not valid UTF-8", ErrUnsafeName)
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 0x20 || name[i] == 0x7f {
			return "", fmt.Errorf("%w: control byte", ErrUnsafeName)
		}
	}
	if strings.Contains(name, `\`) {
		return "", fmt.Errorf("%w: backslash", ErrUnsafeName)
	}
	if strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("%w: absolute path", ErrUnsafeName)
	}
	// "C:foo" and "C:/foo" are drive-relative and drive-absolute on Windows.
	if len(name) >= 2 && name[1] == ':' {
		return "", fmt.Errorf("%w: drive-qualified path", ErrUnsafeName)
	}
	parts := strings.Split(name, "/")
	if len(parts) > maxPathDepth {
		return "", fmt.Errorf("%w: too deeply nested", ErrUnsafeName)
	}
	for _, p := range parts {
		switch p {
		case "", ".", "..":
			return "", fmt.Errorf("%w: %q component", ErrUnsafeName, p)
		}
		if strings.HasSuffix(p, ".") || strings.HasSuffix(p, " ") {
			return "", fmt.Errorf("%w: component ends in a dot or space", ErrUnsafeName)
		}
		if isReservedDeviceName(p) {
			return "", fmt.Errorf("%w: reserved device name", ErrUnsafeName)
		}
	}
	clean := path.Clean(name)
	// path.Clean cannot introduce ".." here (every component was checked), so a
	// mismatch would mean the input had a redundant spelling we already rejected.
	// Asserted rather than assumed: this is the last line before a real path.
	if clean != name {
		return "", fmt.Errorf("%w: non-canonical spelling", ErrUnsafeName)
	}
	return clean, nil
}

// reservedDeviceNames are the Windows device names. A file cannot be created
// with any of them, with or without an extension, in any case.
var reservedDeviceNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

func isReservedDeviceName(component string) bool {
	base := component
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	return reservedDeviceNames[strings.ToLower(base)]
}

// splitBase splits a file name into the part a collision suffix is inserted
// after and the extension that must be preserved.
//
// Preserving the extension is a product requirement, not cosmetics: "report (2)"
// with the ".pdf" moved or dropped stops opening in the right application, and a
// user cannot tell what the file is. The three shapes that need care:
//
//   - "notes"            -> ("notes", "")            no extension to keep
//   - ".bashrc"          -> (".bashrc", "")          a dotfile is all stem
//   - "backup.tar.gz"    -> ("backup", ".tar.gz")    a compound archive suffix
func splitBase(base string) (stem, ext string) {
	for _, compound := range []string{".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4"} {
		if len(base) > len(compound) && strings.EqualFold(base[len(base)-len(compound):], compound) {
			return base[:len(base)-len(compound)], base[len(base)-len(compound):]
		}
	}
	// A leading dot is part of the name, not an extension marker: ".bashrc" is a
	// dotfile whose whole name is the stem, and filepath.Ext would call all of it
	// the extension and produce " (2).bashrc".
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 || dot == len(base)-1 {
		return base, ""
	}
	return base[:dot], base[dot:]
}

// collisionName is the deterministic safe rename (PRD §9): "name (2)", then
// "name (3)", with the extension preserved.
func collisionName(base string, n int) string {
	stem, ext := splitBase(base)
	return stem + " (" + strconv.Itoa(n) + ")" + ext
}

// PlanDestinations resolves every manifest entry to the exact path it may
// create, refusing the whole task rather than partially planning it.
//
// exists is injected so the plan can be computed against a snapshot of the
// filesystem (and so the tests can plant a destination between planning and
// commit). It must report whether ANY directory entry exists at that path —
// including a symlink, a socket or a device node — because all of those occupy
// the name and none of them may be written through.
//
// Ordering is manifest order and the collision search is lowest-index-first, so
// the same manifest against the same directory always produces the same plan.
// That determinism is what lets a resumed task compare its journalled plan
// against reality instead of guessing.
func PlanDestinations(root string, files []storecrypto.FileEntry, exists func(string) bool) ([]PlanEntry, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	plan := make([]PlanEntry, 0, len(files))
	// taken holds every path this plan will create, so two manifest entries
	// cannot be given the same destination even when the directory is empty.
	taken := make(map[string]bool, len(files))
	// lowered additionally catches names that differ only by case. A
	// case-insensitive filesystem (APFS, NTFS) would collapse those into one
	// file; detecting it here turns a silent overwrite into an honest refusal.
	// It is deliberately a REFUSAL and not a rename: two entries that differ only
	// by case are the sender describing two files, and quietly renaming one would
	// hide that this receiver cannot represent what was sent.
	lowered := make(map[string]bool, len(files))

	occupied := func(p string) bool { return taken[p] || exists(p) }

	for i, f := range files {
		rel, err := sanitizeName(f.Name)
		if err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
		// A manifest may not reach into this package's own working entries — see
		// reservedTopLevelNames for what each one would actually do.
		if top, _, _ := strings.Cut(rel, "/"); reservedTopLevelNames[top] {
			return nil, fmt.Errorf("entry %d: %w: names a reserved receive-directory entry", i, ErrUnsafeName)
		}
		dest := filepath.Join(absRoot, filepath.FromSlash(rel))
		// Belt and braces over the component checks: the joined path must still
		// be under the root. A lexical check is cheap and catches any future
		// sanitizeName regression before it reaches the filesystem.
		if dest != absRoot && !strings.HasPrefix(dest, absRoot+string(filepath.Separator)) {
			return nil, fmt.Errorf("entry %d: %w: escapes the receive directory", i, ErrUnsafeName)
		}
		lowerKey := strings.ToLower(dest)
		if lowered[lowerKey] {
			return nil, fmt.Errorf("entry %d: %w: two entries differ only by case", i, ErrUnsafeName)
		}

		final := dest
		if occupied(final) {
			found := false
			dir, base := filepath.Split(dest)
			for n := 2; n <= maxCollisionIndex; n++ {
				cand := filepath.Join(dir, collisionName(base, n))
				if !occupied(cand) && !lowered[strings.ToLower(cand)] {
					final, found = cand, true
					break
				}
			}
			if !found {
				return nil, fmt.Errorf("entry %d: %w", i, ErrNameConflict)
			}
		}
		taken[final] = true
		lowered[strings.ToLower(final)] = true
		plan = append(plan, PlanEntry{Index: i, Name: f.Name, Size: f.Size, Dest: final})
	}
	return plan, nil
}

// PathExists reports whether anything at all occupies p, without following a
// final symlink. Lstat rather than Stat is the point: a dangling symlink is not
// a free name, and a symlink pointing at somebody's ~/.ssh/authorized_keys is
// emphatically not a free name.
func PathExists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// StagingRoot is the per-task staging directory for taskID under root.
func StagingRoot(root, taskID string) string {
	return filepath.Join(root, stagingDirName, taskID)
}
