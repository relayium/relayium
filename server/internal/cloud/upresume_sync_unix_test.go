//go:build unix

package cloud

import (
	"bytes"
	"errors"
	"os"
	"testing"
)

func TestResumableUpCheckpointSyncFailureRetainsKeyAndSession(t *testing.T) {
	dir, op, raw, _ := preparedSpool(t, "https://relayium.test", []byte("payload"))
	op.Phase, op.UploadID, op.ChunkSize = "uploading", "session1", 1024
	original := journalSyncFile
	journalSyncFile = func(*os.File) error { return errors.New("injected directory sync failure") }
	err := SaveUpOperation(dir, op)
	journalSyncFile = original
	if err == nil {
		t.Fatal("failed sync reported success")
	}
	restored, err := LoadUpOperation(dir, op.ID)
	if err != nil || restored.ContentKey != op.ContentKey || restored.UploadID != op.UploadID || restored.Phase != "uploading" {
		t.Fatalf("checkpoint withdrew the only key/session: %#v %v", restored, err)
	}
	got, err := os.ReadFile(upSpoolPath(dir, op.ID))
	if err != nil || !bytes.Equal(got, raw) {
		t.Fatal("checkpoint failure changed encrypted copy")
	}
}
