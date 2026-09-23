//go:build !unix

package inboxsend

import (
	"errors"
	"os"
)

// checkDirInfo: this platform's access control is not mode bits, so only the
// shape is checked — a real directory, never a symbolic link or junction.
func checkDirInfo(fi os.FileInfo) error {
	if fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return errors.New("is a symbolic link")
	}
	if !fi.IsDir() {
		return errors.New("is not a directory")
	}
	return nil
}

func closeDir(*os.File, os.FileInfo) error { return nil }
