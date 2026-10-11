//go:build unix

package coturnbridge

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// lockDir takes an exclusive, non-blocking flock on <dir>/.lock. The lock
// lives as long as the returned file is open; the kernel drops it when the
// process dies, so a crashed bridge never leaves a stale lock.
func lockDir(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("%w: %s (%v)", ErrSpoolLocked, dir, err)
	}
	return f, nil
}
