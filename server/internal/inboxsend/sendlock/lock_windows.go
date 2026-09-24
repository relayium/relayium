//go:build windows

package sendlock

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// Lock is a held exclusive lock: one byte locked with LockFileEx, the same
// kernel-released lock the inbox receiver's worker lock uses on Windows. The
// system releases it when the holding process's handle is closed, including
// when the process is killed.
type Lock struct {
	f  *os.File
	ov windows.Overlapped
}

// Acquire takes the exclusive lock on path, creating the file. It never waits:
// a held lock is ErrLocked. A reparse point (symbolic link or junction) at
// path is refused rather than followed.
func Acquire(path string) (*Lock, error) {
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return nil, errors.New("refusing to follow a symbolic link")
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	return AcquireFile(f)
}

// AcquireFile takes the exclusive lock on an already open file, which the
// Lock then owns; on failure f is closed. It never waits.
func AcquireFile(f *os.File) (*Lock, error) {
	l := &Lock{f: f}
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err := windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &l.ov); err != nil {
		_ = f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("lock: %w", err)
	}
	return l, nil
}

func (l *Lock) unlock() { _ = windows.UnlockFileEx(windows.Handle(l.f.Fd()), 0, 1, 0, &l.ov) }
