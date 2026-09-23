//go:build darwin || linux

package inboxsend

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// spoolSupported: `inbox send --resumable` needs a free-space query and an
// owner check this platform provides.
const spoolSupported = true

// freeDiskBytes is the space an unprivileged writer may still use on the
// filesystem holding dir. A variable so tests can simulate a full disk.
var freeDiskBytes = func(dir string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil //nolint:unconvert // field widths differ by OS
}

// checkOwnedDir proves path is a real directory (not a symlink) owned by this
// user that nobody else can write into. private additionally requires that
// nobody else can read or enter it (0700).
func checkOwnedDir(path string, private bool) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return errors.New("is not a plain directory")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != os.Getuid() {
		return errors.New("is not owned by this user")
	}
	perm := fi.Mode().Perm()
	if private && perm&0o077 != 0 {
		return errors.New("is accessible to other users")
	}
	if perm&0o022 != 0 {
		return errors.New("is writable by other users")
	}
	return nil
}
