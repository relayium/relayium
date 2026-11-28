package xfer

import (
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
)

// WarnIfEmpty notes to w when the manifest has no files. A push of a symlink
// root (or an empty tree) yields zero files because symlinks and special files
// are skipped, and would otherwise be reported as a silent success.
func WarnIfEmpty(m Manifest, w io.Writer) {
	if len(m.Files) == 0 {
		fmt.Fprintln(w, "warning: no regular files to send (symlinks and special files are skipped)")
	}
}

// BuildManifest walks the given source roots and returns a manifest plus a
// parallel slice of absolute source paths (srcs[i] is the local file for
// m.Files[i]). Manifest paths are relative to each root's parent directory and
// use forward slashes, so `push ./dir` reproduces `dir/...` on the receiver.
// Only regular files are included; symlinks and special files are skipped.
func BuildManifest(roots []string) (Manifest, []string, error) {
	m, srcs, _, err := BuildFilteredManifest(roots, nil)
	return m, srcs, err
}

// BuildFilteredManifest applies the caller's excludes while walking the tree.
func BuildFilteredManifest(roots []string, excludes Excludes) (Manifest, []string, Excluded, error) {
	var m Manifest
	var srcs []string
	var excluded Excluded
	for _, root := range roots {
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return Manifest{}, nil, Excluded{}, err
		}
		parent := filepath.Dir(absRoot)
		err = filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if len(excludes) != 0 && (p != absRoot || !d.IsDir()) {
				relative, err := filepath.Rel(absRoot, p)
				if err != nil {
					return err
				}
				if relative == "." {
					relative = d.Name()
				}
				if excludes.matches(filepath.ToSlash(relative)) {
					if d.IsDir() {
						excluded.Directories++
						return fs.SkipDir
					}
					if d.Type().IsRegular() {
						excluded.Files++
					}
					return nil
				}
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(parent, p)
			if err != nil {
				return err
			}
			m.Files = append(m.Files, FileEntry{
				Path:    filepath.ToSlash(rel),
				Size:    info.Size(),
				Mode:    uint32(info.Mode().Perm()),
				ModTime: info.ModTime().Unix(),
			})
			srcs = append(srcs, p)
			return nil
		})
		if err != nil {
			return Manifest{}, nil, Excluded{}, err
		}
	}
	return m, srcs, excluded, nil
}
