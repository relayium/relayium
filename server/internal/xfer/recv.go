package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

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

	rs := ResumeState{}
	if hello.Sync {
		rs = syncStateFor(destDir, m)
	} else if !opts.NoResume {
		rs = resumeStateFor(destDir, m)
	}
	if err := WriteJSON(rw, MsgResume, rs); err != nil {
		return Report{}, err
	}

	var rep Report
	var res Result
	res.OK = true
	expected := len(m.Files) - len(rs.Skip)
	for k := 0; k < expected; k++ {
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
		f := m.Files[fs.Index]
		dest, err := safeJoin(destDir, f.Path)
		if err != nil {
			return rep, err
		}
		sum, werr := writeFileBody(rw, dest, f, fs.Offset)

		var fh FileHash
		if _, err := ReadJSON(rw, &fh); err != nil {
			return rep, err
		}
		if werr != nil || fh.SHA256 != sum {
			res.OK = false
			res.Failed = append(res.Failed, f.Path)
		} else {
			if hello.Sync {
				// Preserve the source mtime so a later sync can skip this file.
				tm := time.Unix(f.ModTime, 0)
				_ = os.Chtimes(dest, tm, tm)
			}
			rep.Files++
			rep.Bytes += f.Size
		}
	}

	if hello.Delete && opts.AllowDelete {
		// Best-effort mirror delete; a failure here doesn't undo the files that
		// already landed, so it does not fail the transfer.
		_, _ = deleteExtras(destDir, m)
	} else if hello.Delete {
		rep.DeleteDenied = true
	}
	// Surface a denied delete to the sender too (spec §8 "both ends"), not
	// just the receiver's local Report.
	res.DeleteDenied = hello.Delete && !opts.AllowDelete

	rep.Failed = res.Failed
	return rep, WriteJSON(rw, MsgResult, res)
}

// deleteExtras removes regular files under destDir whose relative path is not in
// the manifest, then prunes directories left empty. It stays within destDir
// (the same guarantee safeJoin gives the write path). Returns files removed.
func deleteExtras(destDir string, m Manifest) (int, error) {
	want := make(map[string]bool, len(m.Files))
	for _, f := range m.Files {
		want[filepath.Clean(filepath.FromSlash(f.Path))] = true
	}
	var files []string
	err := filepath.WalkDir(destDir, func(p string, d fs.DirEntry, err error) error {
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
		if !want[rel] {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	n := 0
	for _, p := range files {
		if err := os.Remove(p); err != nil {
			return n, err
		}
		n++
	}
	pruneEmptyDirs(destDir)
	return n, nil
}

// pruneEmptyDirs removes empty subdirectories under root (root itself is kept).
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
func writeFileBody(rw io.Reader, dest string, f FileEntry, offset int64) (string, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	flag := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flag |= os.O_TRUNC
	}
	out, err := os.OpenFile(dest, flag, os.FileMode(f.Mode))
	if err != nil {
		return "", err
	}
	defer out.Close()

	h := sha256.New()
	if offset > 0 {
		existing, err := os.Open(dest)
		if err != nil {
			return "", err
		}
		if _, err := io.CopyN(h, existing, offset); err != nil {
			existing.Close()
			return "", err
		}
		existing.Close()
		if _, err := out.Seek(offset, io.SeekStart); err != nil {
			return "", err
		}
	}
	mw := io.MultiWriter(out, h)
	if _, err := io.CopyN(mw, rw, f.Size-offset); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
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
