//go:build !unix && !windows

package cloud

import (
	"errors"
	"os"
)

func ownedPrivately(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink == 0 }

func openNoFollow(p string) (*os.File, error) { return os.Open(p) }

// UpLock is unavailable on this platform: without a kernel-released lock,
// recovery refuses rather than risk two processes acting on one operation.
type UpLock struct{}

func lockFile(string) (*UpLock, error) {
	return nil, errors.New("upload operation locks are not supported on this platform")
}

// Release is a no-op.
func (l *UpLock) Release() {}
