//go:build !unix && !windows

package inboxclient

import (
	"errors"
	"os"
)

// Non-Unix worker lock. Without flock there is no way to hold a lock that the
// kernel releases on a crash, so this platform gets an honest "unknown" rather
// than a pid file that would either block a legitimate restart after a crash or
// be second-guessed with a heuristic that is wrong on a recycled pid.

// ErrWorkerRunning means another `relayium inbox run` holds this state directory.
var ErrWorkerRunning = errors.New("relayium inbox: another `relayium inbox run` is already using this configuration")

// ErrLockUnsupported means this platform cannot report the lock state.
var ErrLockUnsupported = errors.New("relayium inbox: this platform cannot report whether a worker is running")

// Lock is a held (best-effort) worker lock.
type Lock struct{ f *os.File }

// AcquireLock opens the lock file. It does not exclude a second worker on this
// platform; `relayium inbox status` says so rather than implying a guarantee
// that is not there.
func AcquireLock(path string) (*Lock, error) {
	if err := ensureSecretDir(dirOf(path)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, secretFileMode)
	if err != nil {
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release closes the lock file.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// WorkerRunning cannot be answered here.
func WorkerRunning(path string) (bool, error) { return false, ErrLockUnsupported }
