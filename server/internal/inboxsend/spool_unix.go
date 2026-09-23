//go:build darwin || linux

package inboxsend

import "golang.org/x/sys/unix"

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
