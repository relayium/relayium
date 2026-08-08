//go:build unix

package inboxclient

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// The single-worker lock.
//
// Two workers on one config directory would each claim tasks, each plan
// destinations against the same directory, and each believe it owned the
// journals. Central's claim tokens keep them from corrupting a TASK, but nothing
// on the server can stop them from racing on this machine's filesystem, so the
// exclusion has to live here.
//
// flock is chosen over a pid file because it is released by the KERNEL when the
// holder dies. A pid file survives a crash and then either blocks a legitimate
// restart or has to be second-guessed with a "is that pid still alive, and is it
// really us?" heuristic that is wrong on a recycled pid.

// ErrWorkerRunning means another `relayium inbox run` holds this state directory.
var ErrWorkerRunning = errors.New("relayium inbox: another `relayium inbox run` is already using this configuration")

// ErrLockUnsupported means this platform cannot report the lock state.
var ErrLockUnsupported = errors.New("relayium inbox: this platform cannot report whether a worker is running")

// Lock is a held exclusive lock.
type Lock struct{ f *os.File }

// AcquireLock takes the exclusive worker lock, or returns ErrWorkerRunning.
func AcquireLock(path string) (*Lock, error) {
	if err := ensureSecretDir(dirOf(path)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, secretFileMode)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrWorkerRunning
		}
		return nil, fmt.Errorf("relayium inbox: lock %s: %w", path, err)
	}
	return &Lock{f: f}, nil
}

// Release drops the lock. The kernel would drop it on exit anyway; doing it
// explicitly means a long-lived process that stops the worker (a test, a future
// embedded use) frees it immediately.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	err := l.f.Close()
	l.f = nil
	return err
}

// WorkerRunning reports whether a worker currently holds the lock, by trying to
// take it and immediately releasing it. Read-only from the caller's point of
// view: a false answer means the lock was free at that instant, which is exactly
// what `status` should report.
func WorkerRunning(path string) (bool, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	f, err := os.OpenFile(path, os.O_RDWR, secretFileMode)
	if err != nil {
		return false, err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return true, nil
		}
		return false, err
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false, nil
}
