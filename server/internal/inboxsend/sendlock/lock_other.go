//go:build !unix && !windows

package sendlock

import "os"

// Lock is never held on this platform.
type Lock struct{ f *os.File }

// Acquire refuses: without a kernel-held lock, a lock file would either fail
// to exclude a second process or outlive a crash and block every later retry.
func Acquire(string) (*Lock, error) { return nil, ErrUnsupported }

func (l *Lock) unlock() {}
