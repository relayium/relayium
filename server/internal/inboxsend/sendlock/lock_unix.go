//go:build unix

package sendlock

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// Lock is a held exclusive lock.
type Lock struct{ f *os.File }

// Acquire takes the exclusive lock on path, creating the file 0600. It never
// waits: a held lock is ErrLocked. The final path component is not followed if
// it is a symbolic link.
func Acquire(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	return AcquireFile(f)
}

// AcquireFile takes the exclusive lock on an already open file, which the
// Lock then owns; on failure f is closed. It never waits.
func AcquireFile(f *os.File) (*Lock, error) {
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("lock: %w", err)
	}
	return &Lock{f: f}, nil
}

func (l *Lock) unlock() { _ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN) }
