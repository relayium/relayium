//go:build unix

package account

import (
	"fmt"
	"os"
	"syscall"
)

// checkAdminDBOwner refuses to open the database as a different user than the
// one that owns it. SQLite creates -wal/-shm files owned by whoever opens the
// database first; a root-run admin command against a stopped service would
// leave root-owned files the service user can no longer write, and the next
// boot would fail. Run the command as the service user instead
// (sudo -u relayium ...).
func checkAdminDBOwner(path string, fi os.FileInfo) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	if euid := os.Geteuid(); uint32(euid) != st.Uid {
		return fmt.Errorf("admin: %s is owned by uid %d but this command runs as uid %d; run it as the database owner (for example: sudo -u relayium ...)", path, st.Uid, euid)
	}
	return nil
}
