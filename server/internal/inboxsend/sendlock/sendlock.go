// Package sendlock is the per-send exclusive lock of the Device Inbox sender:
// while one relayium command works on one local send record, no other process
// can. It is kernel-held — flock(2) on Unix, LockFileEx on Windows — so a
// crashed or killed holder releases it with its handles and no stale lock file
// can block a later retry. A platform with neither refuses to lock rather than
// pretending to exclude.
//
// It is its own package so its tests import nothing but the standard library
// and run unchanged on Windows (`go test ./internal/inboxsend/sendlock`).
package sendlock

import "errors"

// ErrLocked means another handle — normally another process — holds the lock.
var ErrLocked = errors.New("locked")

// ErrUnsupported means this platform has no kernel-held file lock.
var ErrUnsupported = errors.New("this platform cannot lock a local send record")

// Release unlocks and closes. Safe on nil and to call twice.
func (l *Lock) Release() {
	if l == nil || l.f == nil {
		return
	}
	l.unlock()
	_ = l.f.Close()
	l.f = nil
}
