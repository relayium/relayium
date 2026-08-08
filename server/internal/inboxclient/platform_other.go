//go:build !unix

package inboxclient

import (
	"errors"
	"io/fs"
	"os"
)

// Non-Unix fallbacks. The Device Inbox worker's supported deployment targets are
// Linux and macOS (systemd, launchd and container foreground), but the CLI is
// built for every published OS/CPU pair, so this file keeps the package
// compiling and behaving conservatively elsewhere rather than silently dropping
// the command from a platform's binary.

// fsyncDirUnsupported is true where a directory cannot be opened for fsync.
// Directory-entry durability then falls back to the platform's own semantics;
// the commit protocol still never overwrites, it only loses the strict ordering
// guarantee that a crash resumes without re-linking.
const fsyncDirUnsupported = true

// oNoFollow has no portable equivalent here. Symlink creation on Windows is
// privileged and this package never creates one, so the flag is simply absent —
// matching internal/cloud/nofollow_windows.go.
const oNoFollow = 0

func isNoSpace(err error) bool {
	// Best effort: without the errno constants, only an explicitly wrapped
	// ErrNoSpace can be recognised. A misclassification here degrades to
	// failed_retryable rather than attention_required, which is safe.
	return false
}

func isPermission(err error) bool { return errors.Is(err, fs.ErrPermission) }

// freeBytes reports "unknown" so the caller skips the free-space preflight
// rather than inventing a number. The commit path still fails closed on a real
// write error.
func freeBytes(path string) (uint64, bool) { return 0, false }

func sameFile(a, b os.FileInfo) bool { return os.SameFile(a, b) }
