//go:build windows

package inboxclient

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// Windows has the same kernel-released advisory-lock property we use flock for
// on Unix. Lock one byte with LockFileEx so a crash releases ownership and a
// second worker (or disable) can distinguish busy from stale without a pid file.

var ErrWorkerRunning = errors.New("relayium inbox: another `relayium inbox run` is already using this configuration")
var ErrLockUnsupported = errors.New("relayium inbox: this platform cannot report whether a worker is running")

type Lock struct {
	f  *os.File
	ov windows.Overlapped
}

func AcquireLock(path string) (*Lock, error) {
	if err := ensureSecretDir(dirOf(path)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, secretFileMode)
	if err != nil {
		return nil, err
	}
	l := &Lock{f: f}
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err := windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &l.ov); err != nil {
		_ = f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return nil, ErrWorkerRunning
		}
		return nil, fmt.Errorf("relayium inbox: lock %s: %w", path, err)
	}
	return l, nil
}

func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = windows.UnlockFileEx(windows.Handle(l.f.Fd()), 0, 1, 0, &l.ov)
	err := l.f.Close()
	l.f = nil
	return err
}

func WorkerRunning(path string) (bool, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	l, err := AcquireLock(path)
	if errors.Is(err, ErrWorkerRunning) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return false, l.Release()
}
