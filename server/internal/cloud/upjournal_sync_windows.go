//go:build windows

package cloud

// Windows cannot open a directory for a sync the way POSIX systems can, so the
// journal's rename is not followed by a directory fsync there. The record file
// itself is still flushed (File.Sync) before the atomic rename, but no
// power-loss durability of the rename is claimed on Windows.

func journalDirSyncable(string) error { return nil }

func journalDirSync(string) error { return nil }
