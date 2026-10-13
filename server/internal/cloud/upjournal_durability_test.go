//go:build unix

package cloud

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The checkpoint fails closed: when the journal directory cannot be synced --
// it cannot be opened (mode 0300: write+search, no read), or its fsync fails --
// SaveUpOperation returns an error, leaves no new record, and does not touch
// the records already there. (Root R2 probe: the generic best-effort syncDir
// reported success here.)
func TestUpOperationSaveFailsClosedWithoutDirectorySync(t *testing.T) {
	setup := func(t *testing.T) (cfg string, old UpOperation, oldBytes []byte, fresh UpOperation) {
		t.Helper()
		cfg, old = savedOp(t)
		oldBytes, _ = os.ReadFile(filepath.Join(UpJournalDir(cfg), old.ID+".json"))
		var err error
		fresh, err = NewUpOperation(preparedFixture(t), "https://relayium.example", "a@example.com", 2)
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	check := func(t *testing.T, cfg string, old UpOperation, oldBytes []byte, fresh UpOperation, err error) {
		t.Helper()
		if err == nil {
			t.Fatal("SaveUpOperation reported success although the directory could not be synced")
		}
		if _, serr := os.Stat(filepath.Join(UpJournalDir(cfg), fresh.ID+".json")); !os.IsNotExist(serr) {
			t.Fatalf("a record that could not be made durable was left behind: %v", serr)
		}
		if got, _ := os.ReadFile(filepath.Join(UpJournalDir(cfg), old.ID+".json")); !bytes.Equal(got, oldBytes) {
			t.Fatal("an existing record was changed")
		}
	}

	t.Run("directory not readable", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root ignores directory permissions")
		}
		cfg, old, oldBytes, fresh := setup(t)
		dir := UpJournalDir(cfg)
		if err := os.Chmod(dir, 0o300); err != nil {
			t.Fatal(err)
		}
		err := SaveUpOperation(cfg, fresh)
		_ = os.Chmod(dir, 0o700)
		if !errors.Is(err, ErrJournalNotDurable) {
			t.Fatalf("err = %v, want ErrJournalNotDurable", err)
		}
		check(t, cfg, old, oldBytes, fresh, err)
	})

	t.Run("directory fsync fails", func(t *testing.T) {
		cfg, old, oldBytes, fresh := setup(t)
		orig := journalSyncFile
		journalSyncFile = func(*os.File) error { return errors.New("injected fsync failure") }
		defer func() { journalSyncFile = orig }()
		err := SaveUpOperation(cfg, fresh)
		check(t, cfg, old, oldBytes, fresh, err)
	})
}
