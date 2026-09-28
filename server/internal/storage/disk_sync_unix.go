//go:build !windows

package storage

import "os"

// flushDir makes a directory's entries (a rename or a new file) durable by
// fsyncing the directory itself. See disk.go for why the seam exists.
func flushDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	serr := f.Sync()
	if cerr := f.Close(); serr == nil {
		serr = cerr
	}
	return serr
}
