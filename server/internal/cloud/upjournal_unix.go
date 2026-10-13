//go:build unix

package cloud

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// ownedPrivately reports whether info is owned by this user with no group or
// other permission bits.
func ownedPrivately(info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return int(st.Uid) == os.Getuid() && info.Mode().Perm()&0o077 == 0
}

func openNoFollow(p string) (*os.File, error) {
	return os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// UpLock is a held per-operation lock.
type UpLock struct{ f *os.File }

func lockFile(p string) (*UpLock, error) {
	f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrUpOperationBusy
		}
		return nil, fmt.Errorf("lock %s: %w", p, err)
	}
	return &UpLock{f: f}, nil
}

// Release drops the lock.
func (l *UpLock) Release() {
	if l == nil || l.f == nil {
		return
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	_ = l.f.Close()
	l.f = nil
}
