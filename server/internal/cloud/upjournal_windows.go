//go:build windows

package cloud

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// ownedPrivately on Windows checks only that the entry is not a symbolic link.
// It does NOT verify an owner SID or the ACL: Go's mode bits do not describe
// Windows permissions. The record therefore relies on the same trust boundary
// as the credential file beside it -- a configuration directory inside the
// user's private profile, protected by its inherited ACL -- and this code makes
// no claim beyond that (and changes no ACL).
func ownedPrivately(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink == 0 }

func openNoFollow(p string) (*os.File, error) { return os.Open(p) }

// UpLock is a held per-operation lock (LockFileEx, released by the kernel when
// the holder dies).
type UpLock struct {
	f  *os.File
	ov windows.Overlapped
}

func lockFile(p string) (*UpLock, error) {
	f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	l := &UpLock{f: f}
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err := windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &l.ov); err != nil {
		_ = f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return nil, ErrUpOperationBusy
		}
		return nil, fmt.Errorf("lock %s: %w", p, err)
	}
	return l, nil
}

// Release drops the lock.
func (l *UpLock) Release() {
	if l == nil || l.f == nil {
		return
	}
	_ = windows.UnlockFileEx(windows.Handle(l.f.Fd()), 0, 1, 0, &l.ov)
	_ = l.f.Close()
	l.f = nil
}
