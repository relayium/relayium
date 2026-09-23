//go:build !unix

package inboxsend

import (
	"errors"
	"os"
)

func openRegular(path string) (*os.File, error) { return os.Open(path) }

func openNoFollow(path string) (*os.File, error) {
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("refusing to follow a symbolic link")
	}
	return os.Open(path)
}

// Windows cannot open a directory for fsync; the rename is still atomic.
const fsyncDirUnsupported = true
