package xfer

import (
	"io/fs"
	"path/filepath"
)

// BuildManifest walks the given source roots and returns a manifest plus a
// parallel slice of absolute source paths (srcs[i] is the local file for
// m.Files[i]). Manifest paths are relative to each root's parent directory and
// use forward slashes, so `push ./dir` reproduces `dir/...` on the receiver.
// Only regular files are included; symlinks and special files are skipped.
func BuildManifest(roots []string) (Manifest, []string, error) {
	var m Manifest
	var srcs []string
	for _, root := range roots {
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return Manifest{}, nil, err
		}
		parent := filepath.Dir(absRoot)
		err = filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
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
			return Manifest{}, nil, err
		}
	}
	return m, srcs, nil
}
