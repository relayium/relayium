//go:build unix

package inboxclient

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

// fsyncDirUnsupported is false on Unix: opening a directory and fsyncing it is
// the standard way to make a rename/create durable, and a failure there is a
// real durability failure worth surfacing.
const fsyncDirUnsupported = false

// oNoFollow refuses a symlink at the final path component, so a pre-planted
// name inside the staging area cannot redirect a write. Mirrors the download
// path's guard (internal/cloud/nofollow_other.go).
const oNoFollow = syscall.O_NOFOLLOW

// isNoSpace reports whether err is "the filesystem is full", which is an
// attention_required condition (a human must free space) rather than something
// a retry can fix on its own.
func isNoSpace(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT)
}

// isPermission reports whether err is a permission/ownership failure. os.ErrPermission
// covers EACCES and EPERM; the explicit EROFS check catches a read-only remount,
// which is the same product situation (the directory is no longer writable) and
// is likewise not fixable by retrying.
func isPermission(err error) bool {
	return errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS)
}

// freeBytes reports the space available to this (unprivileged) process on the
// filesystem backing path.
func freeBytes(path string) (uint64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, false
	}
	if st.Bsize <= 0 {
		return 0, false
	}
	return st.Bavail * uint64(st.Bsize), true
}

// sameFile reports whether two stat results name the same on-disk object. It is
// what lets a crashed commit tell "the destination is the hard link I already
// made" from "somebody else's file is in the way" — see commit.go.
func sameFile(a, b os.FileInfo) bool { return os.SameFile(a, b) }
