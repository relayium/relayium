//go:build !windows

package xfer

import "syscall"

// oNoFollow makes the receive-side file open refuse a symlink at the final path
// component, so a pre-planted symlink in destDir can't redirect a write outside
// it. (A symlinked parent directory is a separate vector needing openat-style
// per-segment resolution; this guards the common leaf case.)
const oNoFollow = syscall.O_NOFOLLOW
