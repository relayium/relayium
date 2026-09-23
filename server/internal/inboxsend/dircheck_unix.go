//go:build unix

package inboxsend

import (
	"errors"
	"os"
	"syscall"
)

// checkDirInfo proves, from an Lstat, that a directory the sender keeps its
// records in is a real directory (not a symbolic link) owned by this user
// that no other user can write into.
func checkDirInfo(fi os.FileInfo) error {
	if fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("is a symbolic link")
	}
	if !fi.IsDir() {
		return errors.New("is not a directory")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != os.Getuid() {
		return errors.New("is not owned by this user")
	}
	if fi.Mode().Perm()&0o022 != 0 {
		return errors.New("is writable by other users")
	}
	return nil
}

// closeDir makes the verified, open record directory 0700 through its own
// descriptor, so nothing but that directory can be changed.
func closeDir(d *os.File, fi os.FileInfo) error {
	if fi.Mode().Perm() == 0o700 {
		return nil
	}
	if err := d.Chmod(0o700); err != nil {
		return err
	}
	after, err := d.Stat()
	if err != nil {
		return err
	}
	if after.Mode().Perm()&0o077 != 0 {
		return errors.New("the send record directory stays accessible to other users")
	}
	return nil
}
