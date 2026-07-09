package storage

import "syscall"

// DiskUsage reports used and total bytes of the filesystem backing path, via
// statfs. used = total - available-to-unprivileged; total = all blocks. Used for
// the global blob-volume soft cap (account layer decides the threshold).
//
// syscall.Statfs / Statfs_t.Bsize are available on Unix (darwin + linux), which
// matches the deployment target; a //go:build unix guard plus a Windows
// fallback can be added if a Windows build is ever needed.
func DiskUsage(path string) (used, total uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bsize := uint64(st.Bsize)
	total = st.Blocks * bsize
	avail := st.Bavail * bsize
	if avail > total {
		avail = total
	}
	return total - avail, total, nil
}
