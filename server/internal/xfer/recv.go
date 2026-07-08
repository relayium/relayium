package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
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

	// (Task 5 will insert --delete handling here, before the Result write.)

	rep.Failed = res.Failed
	return rep, WriteJSON(rw, MsgResult, res)
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
	clean := filepath.Clean("/" + filepath.FromSlash(rel))
	joined := filepath.Join(destDir, clean)
	if joined != destDir && !strings.HasPrefix(joined, destDir+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe path in manifest: %q", rel)
	}
	return joined, nil
}
