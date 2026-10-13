//go:build unix

package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

// `up` sends nothing when its operation record cannot be made durable: the
// journal directory is write+search but not readable (0300), so it cannot be
// opened for a sync. No request reaches the server and an existing record is
// left exactly as it was.
func TestUpSendsNothingWhenRecordCannotBeMadeDurable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "unexpected", http.StatusTeapot)
	}))
	defer srv.Close()
	cfg := t.TempDir()
	if err := cloud.Save(cfg, cloud.Creds{Server: srv.URL, AccountEmail: "a@example.com", AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}
	// An existing record from an earlier unknown upload.
	src := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(src, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	prep, err := cloud.PrepareUpload([]string{src}, cloud.UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	old, err := cloud.NewUpOperation(prep, srv.URL, "a@example.com", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.SaveUpOperation(cfg, old); err != nil {
		t.Fatal(err)
	}
	dir := cloud.UpJournalDir(cfg)
	oldBytes, _ := os.ReadFile(filepath.Join(dir, old.ID+".json"))

	if err := os.Chmod(dir, 0o300); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := runUp([]string{"--json", "--config-dir", cfg, src}, &out, &errOut)
	_ = os.Chmod(dir, 0o700)
	if code != 1 {
		t.Fatalf("code %d, want 1\nstdout=%s\nstderr=%s", code, out.String(), errOut.String())
	}
	if d := decodeUpDoc(t, out.String()); d.Status != "failed" || d.Error != "record_failed" {
		t.Fatalf("doc %+v", d)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d request(s) sent although the record was not durable", n)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != old.ID+".json" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("journal now holds %v, want only the old record", names)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, old.ID+".json")); !bytes.Equal(got, oldBytes) {
		t.Fatal("the existing record changed")
	}
}
