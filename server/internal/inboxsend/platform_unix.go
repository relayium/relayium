//go:build unix

package inboxsend

import (
	"os"
	"syscall"
)

// openRegular opens a planned source for reading without following a final
// symlink and without blocking: a path swapped for a FIFO between planning and
// reading must fail the SameFile check, not hang the send in open(2).
func openRegular(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}

const fsyncDirUnsupported = false
