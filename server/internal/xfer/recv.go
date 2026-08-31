package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// refuse reports a structural refusal to an already-authorized sender as a
// MsgError frame, and returns the same error for the receiver's own console.
// The frame is best-effort: the local error stands even if the peer is gone.
//
// Only call this AFTER the transport has authorized the peer. An unauthorized
// connection is closed without a word — it learns nothing about this host.
func refuse(w io.Writer, code string, err error) error {
	_ = WriteJSON(w, MsgError, WireError{Code: code, Msg: err.Error()})
	return err
}

type RecvOpts struct {
	NoResume    bool
	AllowDelete bool // sync mode: honor a Hello.Delete mirror request
}

// Receive accepts a pushed batch into destDir. It reads the manifest, reports
// resume state for any partial files already on disk, then writes each file,
// verifying SHA-256.
func Receive(rw io.ReadWriter, destDir string, opts RecvOpts) (Report, error) {
	var hello Hello
	if _, err := ReadJSON(rw, &hello); err != nil {
		return Report{}, err
	}
	if hello.Version != WireVersion {
		return Report{}, fmt.Errorf("unsupported wire version %d", hello.Version)
	}
	var m Manifest
	if _, err := ReadJSON(rw, &m); err != nil {
		return Report{}, err
	}
	if err := validateManifest(destDir, m); err != nil {
		// The manifest cap is a structural refusal the sender can act on (split
		// the batch), and by this point the peer is already authorized by the
		// transport, so telling it why is safe. Every other validation failure
		// stays silent: those messages quote manifest content and only a
		// malformed or hostile manifest reaches them.
		if errors.Is(err, errManifestTooLarge) {
			return Report{}, refuse(rw, ErrCodeManifestTooLarge, err)
		}
		return Report{}, err
	}
	// A one-shot receive must never silently replace files already owned by the
	// user. `sync` is the explicit overwrite/mirror operation; ordinary push
	// refuses collisions before telling the sender to stream any bytes.
	if !hello.Sync {
		for _, f := range m.Files {
			dest, err := safeJoin(destDir, f.Path)
			if err != nil {
				return Report{}, err
			}
			if _, err := os.Lstat(dest); err == nil {
				// The relative manifest path is the sender's own name for the
				// file, so it is safe to echo; the absolute receive path is not.
				return Report{}, refuse(rw, ErrCodeDestinationExists,
					fmt.Errorf("destination already exists: %s (use `sync` to replace, or remove it on the receiver)", f.Path))
			} else if !os.IsNotExist(err) {
				return Report{}, err
			}
		}
	}

	rs := ResumeState{}
	if hello.Sync && !opts.NoResume {
		rs = syncStateFor(destDir, m)
	} else if !opts.NoResume {
		rs = resumeStateFor(destDir, m)
	}
	if err := WriteJSON(rw, MsgResume, rs); err != nil {
		return Report{}, err
	}
	resumeOffsets := make(map[int]int64, len(rs.Entries))
	for _, entry := range rs.Entries {
		resumeOffsets[entry.Index] = entry.Have
	}
	skipped := make(map[int]struct{}, len(rs.Skip))
	for _, index := range rs.Skip {
		skipped[index] = struct{}{}
	}
	expectedIndices := make([]int, 0, len(m.Files)-len(rs.Skip))
	for index := range m.Files {
		if _, ok := skipped[index]; !ok {
			expectedIndices = append(expectedIndices, index)
		}
	}

	var rep Report
	var res Result
	res.OK = true
	for k, expectedIndex := range expectedIndices {
		var fs FileStart
		if _, err := ReadJSON(rw, &fs); err != nil {
			return rep, err
		}
		// fs.Index is peer-controlled; reject out-of-range values before indexing
		// so a malicious/buggy sender can't panic the receiver (and, under serve,
		// take down the whole daemon).
		if fs.Index < 0 || fs.Index >= len(m.Files) {
			return rep, fmt.Errorf("file index %d out of range [0,%d)", fs.Index, len(m.Files))
		}
		if fs.Index != expectedIndex {
			return rep, fmt.Errorf("file %d arrived out of manifest order at position %d (want %d)", fs.Index, k, expectedIndex)
		}
		f := m.Files[fs.Index]
		expectedOffset := resumeOffsets[fs.Index]
		if fs.Offset != expectedOffset {
			return rep, fmt.Errorf("file offset %d does not match negotiated offset %d for %q", fs.Offset, expectedOffset, f.Path)
		}
		dest, err := safeJoin(destDir, f.Path)
		if err != nil {
			return rep, err
		}
		sum, staged, werr := writeFileBody(rw, destDir, dest, f, fs.Offset)

		var fh FileHash
		if _, err := ReadJSON(rw, &fh); err != nil {
			return rep, err
		}
		if werr != nil || fh.SHA256 != sum {
			if staged != "" {
				_ = os.Remove(staged)
			}
			res.OK = false
			res.Failed = append(res.Failed, f.Path)
		} else {
			if err := installStaged(staged, dest, hello.Sync); err != nil {
				_ = os.Remove(staged)
				res.OK = false
				res.Failed = append(res.Failed, f.Path)
				continue
			}
			if hello.Sync {
				// Preserve the source mtime so a later sync can skip this file.
				tm := time.Unix(f.ModTime, 0)
				_ = os.Chtimes(dest, tm, tm)
			}
			rep.Files++
			rep.Bytes += f.Size
		}
	}

	if hello.Delete && opts.AllowDelete && len(m.Files) == 0 {
		// Refuse a mirror-delete driven by an EMPTY manifest — it would wipe the
		// entire destination. The sync client already refuses --delete with an
		// empty source, but a malicious/buggy peer can send Delete=true with a
		// zero-file manifest straight to an --allow-delete listener, so enforce the
		// same guard on the receiver.
		rep.DeleteDenied = true
		rep.DeleteRefusedReason = "the manifest contains no files"
	} else if hello.Delete && opts.AllowDelete {
		// Best-effort mirror delete; a failure here doesn't undo the files that
		// already landed, so it does not fail the transfer. It is scoped to the
		// manifest's own top-level roots (see deleteExtras) and refuses outright
		// when no such scope can be derived.
		//
		// Refused and half-done are different outcomes and must not be reported
		// as the same thing: an operator who reads "nothing was deleted" after
		// files were in fact removed would be misled about their own data.
		if n, err := deleteExtras(destDir, m); err != nil {
			if n == 0 {
				rep.DeleteDenied = true
				rep.DeleteRefusedReason = err.Error()
			} else {
				rep.DeletePartial = fmt.Sprintf("removed %d stale file(s), then stopped: %v", n, err)
			}
		}
	} else if hello.Delete {
		rep.DeleteDenied = true
	}
	// Surface a denied delete to the sender too (spec §8 "both ends"), not
	// just the receiver's local Report.
	res.DeleteDenied = hello.Delete && !opts.AllowDelete

	rep.Failed = res.Failed
	return rep, WriteJSON(rw, MsgResult, res)
}

// installStaged atomically installs a verified file. Sync is an explicit
// replacement operation. Ordinary receive uses a hard link so a destination
// created after preflight wins the race and is never overwritten.
func installStaged(staged, dest string, allowReplace bool) error {
	if allowReplace {
		return os.Rename(staged, dest)
	}
	if err := os.Link(staged, dest); err != nil {
		return err
	}
	// The no-clobber install is complete once the hard link exists. Cleanup of
	// the private staging name is best-effort: reporting a failed transfer here
	// would be false (and could prompt a resend) even though the verified
	// destination is already durable and visible.
	_ = os.Remove(staged)
	return nil
}

const maxManifestFiles = 1000
const maxManifestPathBytes = 4096

// errManifestTooLarge marks the one validation failure the receiver reports back
// to an authorized sender: it is structural, actionable (split the batch) and
// says nothing about the manifest's contents or the receiver's filesystem.
var errManifestTooLarge = errors.New("manifest contains too many files")

func validateManifest(destDir string, m Manifest) error {
	if len(m.Files) > maxManifestFiles {
		return fmt.Errorf("%w: %d (this receiver accepts at most %d per transfer)", errManifestTooLarge, len(m.Files), maxManifestFiles)
	}
	seen := make(map[string]struct{}, len(m.Files))
	var total int64
	for i, f := range m.Files {
		if f.Path == "" || len([]byte(f.Path)) > maxManifestPathBytes {
			return fmt.Errorf("invalid manifest path at index %d", i)
		}
		if f.Size < 0 || total > math.MaxInt64-f.Size {
			return fmt.Errorf("invalid manifest size at index %d", i)
		}
		total += f.Size
		p, err := safeJoin(destDir, f.Path)
		if err != nil {
			return err
		}
		key := destKey(p)
		if _, ok := seen[key]; ok {
			return fmt.Errorf("duplicate destination in manifest: %q", f.Path)
		}
		seen[key] = struct{}{}
	}
	return nil
}

// manifestRel maps a manifest path onto the destDir-relative path safeJoin would
// actually write it to, so the delete scope and the write path can never
// disagree. It mirrors safeJoin's normalisation ("../x" clamps to "x"), and
// reports false for anything that names no file under destDir at all.
func manifestRel(p string) (string, bool) {
	clean := filepath.Clean(string(filepath.Separator) + filepath.FromSlash(p))
	rel := strings.TrimPrefix(clean, string(filepath.Separator))
	if rel == "" || rel == "." {
		return "", false
	}
	return rel, true
}

// foldDestPaths reports whether this platform's filesystem treats "Site" and
// "site" as the same name. runtime.GOOS is a compile-time constant, so this is
// too — it is the single place the fold decision is made.
const foldDestPaths = runtime.GOOS == "darwin" || runtime.GOOS == "windows"

// destKey canonicalises a destination path into the key every comparison in the
// mirror uses: the manifest's duplicate check, the set of files to keep, and the
// paths WalkDir reports off disk.
//
// They MUST agree. The manifest says "Site/index.html" and the directory on a
// case-insensitive filesystem is "site/", so a raw string compare finds the
// wanted file missing from the want set and deletes the very file the transfer
// just wrote. Case-folding on one side only is worse than not folding at all.
func destKey(path string) string { return destKeyFold(path, foldDestPaths) }

// destKeyFold is destKey with the platform decision passed in, so both branches
// are executable in a test on any OS — the case-insensitive branch is the one
// that can lose data, and it must not be reachable only on a Mac.
func destKeyFold(path string, fold bool) string {
	key := filepath.Clean(path)
	if fold {
		key = strings.ToLower(key)
	}
	return key
}

// deleteScope is the bounded region of destDir a mirror-delete may touch: the
// top-level roots the accepted manifest actually represents, never the whole
// receive directory.
//
// `sync ./a ./b host` sends "a/..." and "b/...", so it may prune stale files
// inside a/ and b/ — and must leave every unrelated sibling under --dir alone,
// including another source's tree. A single-file root ("notes.txt") scopes only
// that one file, which the manifest keeps by definition, so it deletes nothing.
type deleteScope struct {
	dirRoots []string        // destDir-relative top-level directories in scope
	want     map[string]bool // destDir-relative paths the manifest keeps
}

// deleteScopeFor derives the scope from validated manifest paths, fail-closed:
// an unusable path, an empty scope, or a root claimed as both a file and a
// directory returns an error and no deletion happens at all.
//
// The root maps are keyed by destKey for the same reason want is: on a
// case-insensitive filesystem "Site/a" and "site/b" name ONE directory, so
// keying them raw would walk it twice (the second pass removing files the first
// already did, turning a clean mirror into a reported partial delete) and would
// miss a "Notes" file colliding with a "notes/" directory. The value keeps the
// first-seen spelling, because that is what gets joined onto a real path.
func deleteScopeFor(m Manifest) (deleteScope, error) {
	sc := deleteScope{want: make(map[string]bool, len(m.Files))}
	fileRoots := make(map[string]bool)
	dirRoots := make(map[string]string) // canonical key -> on-disk spelling
	for _, f := range m.Files {
		rel, ok := manifestRel(f.Path)
		if !ok {
			return deleteScope{}, fmt.Errorf("the manifest contains a path that names no destination file (%q)", f.Path)
		}
		sc.want[destKey(rel)] = true
		root, rest, nested := strings.Cut(rel, string(filepath.Separator))
		if root == "" {
			return deleteScope{}, fmt.Errorf("the manifest contains a path with no top-level name (%q)", f.Path)
		}
		if nested && rest != "" {
			if _, dup := dirRoots[destKey(root)]; !dup {
				dirRoots[destKey(root)] = root
			}
		} else {
			fileRoots[destKey(root)] = true
		}
	}
	for key, root := range dirRoots {
		if fileRoots[key] {
			// The same name cannot be both a file and a directory on disk, so
			// the scope is ambiguous. Refuse rather than guess.
			return deleteScope{}, fmt.Errorf("the manifest claims %q as both a file and a directory", root)
		}
		sc.dirRoots = append(sc.dirRoots, root)
	}
	if len(fileRoots) == 0 && len(dirRoots) == 0 {
		return deleteScope{}, errors.New("the manifest yields no top-level root to mirror")
	}
	sort.Strings(sc.dirRoots) // deterministic order for tests and logs
	return sc, nil
}

// deleteExtras removes regular files that are inside one of the manifest's
// top-level directory roots but absent from the manifest, then prunes
// directories left empty inside those same roots. Everything else under destDir
// — an unrelated sibling tree, a root the manifest does not name, destDir itself
// — is out of scope and untouched. Returns files removed.
func deleteExtras(destDir string, m Manifest) (int, error) {
	sc, err := deleteScopeFor(m)
	if err != nil {
		return 0, err
	}
	var files []string
	for _, root := range sc.dirRoots {
		rootDir, err := safeJoin(destDir, filepath.ToSlash(root))
		if err != nil {
			return 0, err
		}
		if fi, err := os.Lstat(rootDir); err != nil || !fi.IsDir() {
			// Absent (nothing to prune) or not a directory (not ours to mirror).
			continue
		}
		err = filepath.WalkDir(rootDir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(destDir, p)
			if err != nil {
				return err
			}
			if !sc.want[destKey(rel)] {
				files = append(files, p)
			}
			return nil
		})
		if err != nil {
			return 0, err
		}
	}
	n := 0
	for _, p := range files {
		if err := os.Remove(p); err != nil {
			return n, err
		}
		n++
	}
	for _, root := range sc.dirRoots {
		rootDir, err := safeJoin(destDir, filepath.ToSlash(root))
		if err != nil {
			return n, err
		}
		pruneEmptyDirs(rootDir)
	}
	return n, nil
}

// pruneEmptyDirs removes empty subdirectories under root (root itself is kept,
// so a mirrored root survives even when the transfer emptied it).
func pruneEmptyDirs(root string) {
	var dirs []string
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	})
	// Deepest first so a parent can empty after its children go.
	for i := len(dirs) - 1; i >= 0; i-- {
		if dirs[i] == root {
			continue
		}
		os.Remove(dirs[i]) // fails harmlessly if not empty
	}
}

// resumeStateFor inspects destDir and returns, for each manifest file that has
// a partial (non-empty, shorter-than-declared) copy on disk, the number of
// bytes already present, so the sender can resume from that offset. The
// end-to-end SHA-256 check still validates the merged result.
func resumeStateFor(destDir string, m Manifest) ResumeState {
	var rs ResumeState
	for i, f := range m.Files {
		dest, err := safeJoin(destDir, f.Path)
		if err != nil {
			continue
		}
		info, err := os.Stat(dest)
		if err != nil {
			continue // absent → full send
		}
		if info.Size() > 0 && info.Size() < f.Size {
			rs.Entries = append(rs.Entries, ResumeEntry{Index: i, Have: info.Size()})
		}
	}
	return rs
}

// syncStateFor is resumeStateFor plus skip detection: a manifest file whose
// on-disk copy matches by size and modification time is skipped (not sent).
func syncStateFor(destDir string, m Manifest) ResumeState {
	var rs ResumeState
	for i, f := range m.Files {
		dest, err := safeJoin(destDir, f.Path)
		if err != nil {
			continue
		}
		info, err := os.Stat(dest)
		if err != nil {
			continue // absent → full send
		}
		if info.Size() == f.Size && info.ModTime().Unix() == f.ModTime {
			rs.Skip = append(rs.Skip, i)
			continue
		}
		if info.Size() > 0 && info.Size() < f.Size {
			rs.Entries = append(rs.Entries, ResumeEntry{Index: i, Have: info.Size()})
		}
	}
	return rs
}

// writeFileBody reads exactly f.Size-offset bytes from rw, writes them at the
// given offset in dest, and returns the SHA-256 (hex) of the full file.
func writeFileBody(rw io.Reader, base, dest string, f FileEntry, offset int64) (string, string, error) {
	dir := filepath.Dir(dest)
	if info, err := os.Lstat(dest); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", "", fmt.Errorf("refusing symlink destination %q", dest)
	} else if err != nil && !os.IsNotExist(err) {
		return "", "", err
	}
	// Defense in depth beyond safeJoin's lexical check and the leaf O_NOFOLLOW: a
	// pre-planted symlinked *directory* under destDir could still redirect the
	// write outside it. mkdirAllWithin verifies the deepest existing ancestor
	// stays within destDir BEFORE MkdirAll can follow it (a symlink must already
	// exist to be followed); the post-create ensureWithin is the backstop.
	if err := mkdirAllWithin(base, dir); err != nil {
		return "", "", err
	}
	if err := ensureWithin(base, dir); err != nil {
		return "", "", err
	}
	out, err := os.CreateTemp(dir, ".relayium-recv-*")
	if err != nil {
		return "", "", err
	}
	staged := out.Name()
	keep := false
	defer func() {
		_ = out.Close()
		if !keep {
			_ = os.Remove(staged)
		}
	}()
	// Mode is peer-controlled. Preserve only ordinary rwx permission bits;
	// never install setuid/setgid/sticky or other special mode flags.
	if err := out.Chmod(os.FileMode(f.Mode) & os.ModePerm); err != nil {
		return "", "", err
	}

	h := sha256.New()
	if offset > 0 {
		existing, err := os.Open(dest)
		if err != nil {
			return "", "", err
		}
		prefix := io.MultiWriter(out, h)
		if _, err := io.CopyN(prefix, existing, offset); err != nil {
			existing.Close()
			return "", "", err
		}
		existing.Close()
	}
	mw := io.MultiWriter(out, h)
	if _, err := io.CopyN(mw, rw, f.Size-offset); err != nil {
		return "", "", err
	}
	if err := out.Sync(); err != nil {
		return "", "", err
	}
	if err := out.Close(); err != nil {
		return "", "", err
	}
	keep = true
	return hex.EncodeToString(h.Sum(nil)), staged, nil
}

// safeJoin joins a relative manifest path onto destDir, rejecting any path that
// escapes destDir (defends against a malicious/buggy manifest with "..").
func safeJoin(destDir, rel string) (string, error) {
	// Resolve destDir to an absolute, cleaned path first. Without this a destDir
	// like "." or "out/" (serve's default --dir and receive's default destdir
	// are both ".") never prefix-matches the joined result, rejecting every file.
	base, err := filepath.Abs(destDir)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean("/" + filepath.FromSlash(rel))
	joined := filepath.Join(base, clean)
	if joined != base && !strings.HasPrefix(joined, base+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe path in manifest: %q", rel)
	}
	return joined, nil
}

// mkdirAllWithin creates dir like os.MkdirAll, but first verifies the deepest
// already-existing ancestor of dir resolves (symlinks and all) within destDir,
// so MkdirAll can't follow a pre-planted symlinked parent to create directories
// outside destDir. A symlink must already exist to be followed, and
// EvalSymlinks resolves the whole chain; components created below the ancestor
// are fresh real dirs.
func mkdirAllWithin(destDir, dir string) error {
	anc := dir
	for {
		if _, err := os.Lstat(anc); err == nil {
			break // deepest existing ancestor
		}
		parent := filepath.Dir(anc)
		if parent == anc {
			break // reached the filesystem root
		}
		anc = parent
	}
	if err := ensureWithin(destDir, anc); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}

// ensureWithin verifies that dir, after resolving any symlinks, is still inside
// destDir (also symlink-resolved). Both must exist. This catches a symlinked
// directory pre-planted under destDir that a purely lexical check would miss.
func ensureWithin(destDir, dir string) error {
	absBase, err := filepath.Abs(destDir)
	if err != nil {
		return err
	}
	realBase, err := filepath.EvalSymlinks(absBase)
	if err != nil {
		return err
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	if realDir != realBase && !strings.HasPrefix(realDir, realBase+string(filepath.Separator)) {
		return fmt.Errorf("refusing write outside destDir via symlinked directory: %q", dir)
	}
	return nil
}
