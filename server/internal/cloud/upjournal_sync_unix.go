//go:build !windows

package cloud

import (
	"fmt"
	"os"
)

// journalSyncFile is (*os.File).Sync, indirected so a test can make the
// directory fsync fail.
var journalSyncFile = (*os.File).Sync

// journalDirSyncable reports whether dir can be opened for a sync at all.
func journalDirSyncable(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("%w (%v)", ErrJournalNotDurable, err)
	}
	return d.Close()
}

// journalDirSync fsyncs dir, so a rename into it survives a crash. Unlike the
// credential's best-effort syncDir, every failure is returned.
func journalDirSync(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	if err := journalSyncFile(d); err != nil {
		d.Close()
		return err
	}
	return d.Close()
}
