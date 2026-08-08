package inboxclient

import (
	"fmt"
	"os"
	"path/filepath"
)

// Local-state durability primitives.
//
// Everything this package persists is a local secret or a crash-recovery record:
// the device private-key history, the enrolment/receive configuration, and the
// per-task journals. All three share the same rules, so they share this code
// rather than each re-deriving them:
//
//   - the containing directory is 0700 and is CHMODded unconditionally, because
//     MkdirAll only applies a mode when it creates, so a directory restored from
//     a backup or created under a permissive umask would otherwise stay readable;
//   - the file is written to a fresh temp file (0600 from birth, so the bytes are
//     never on disk under looser permissions), fsynced, then renamed into place;
//   - the DIRECTORY is fsynced after the rename, because the rename itself is
//     only durable once its parent's entry is. Without it a crash can leave the
//     old contents and lose a key that was reported as persisted.

const (
	secretDirMode  os.FileMode = 0o700
	secretFileMode os.FileMode = 0o600
)

// dirOf is filepath.Dir, named so the lock files' intent reads clearly.
func dirOf(path string) string { return filepath.Dir(path) }

// ensureSecretDir creates dir (and its parents) and forces 0700 on the leaf.
func ensureSecretDir(dir string) error {
	if err := os.MkdirAll(dir, secretDirMode); err != nil {
		return err
	}
	return os.Chmod(dir, secretDirMode)
}

// writeSecretFile atomically replaces path with data at 0600, durably.
//
// Returns only after the data, the rename and the directory entry are all on
// stable storage, so a caller may treat a nil return as "this survives a crash"
// — which is exactly what invariant 2 (persist before publish) relies on.
func writeSecretFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := ensureSecretDir(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	// Harmless no-op once the rename succeeds; on every error path it is what
	// keeps a half-written secret from lingering in the directory.
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(secretFileMode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	return fsyncDir(dir)
}

// fsyncDir flushes a directory's own entries, making a create/rename/unlink
// inside it durable. A directory open for read is the portable way to do this on
// Unix; on platforms where opening a directory is not permitted the error is
// ignored deliberately (see fsyncDirUnsupported).
func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		if fsyncDirUnsupported {
			return nil
		}
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		if fsyncDirUnsupported {
			return nil
		}
		return fmt.Errorf("fsync %s: %w", dir, err)
	}
	return nil
}
