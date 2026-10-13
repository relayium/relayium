package cloud

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storecrypto"
)

// B3 (Root R2 probe): a record that saves must load. The largest manifest the
// format allows (MaxFiles entries, MaxFileNameBytes-long names that JSON would
// escape six-fold) still yields a small record, because a record keeps a
// summary rather than the file list; and an oversized record is refused before
// anything is written.
func TestUpOperationSaveLoadSymmetricAtTheLimits(t *testing.T) {
	key, err := storecrypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	files := make([]uploadFile, storecrypto.MaxFiles)
	for i := range files {
		files[i] = uploadFile{name: strings.Repeat("&", storecrypto.MaxFileNameBytes-8) + strings.Repeat("0", 8), size: 0}
	}
	p := &PreparedUpload{files: files, key: key, total: 0, BodyLength: 4 + 1<<20}
	op, err := NewUpOperation(p, "https://fixture.invalid", "fixture@example.invalid", 1)
	if err != nil {
		t.Fatal(err)
	}
	cfg := t.TempDir()
	if err := SaveUpOperation(cfg, op); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := LoadUpOperation(cfg, op.ID)
	if err != nil {
		t.Fatalf("a saved record must load: %v", err)
	}
	if got.FileCount != storecrypto.MaxFiles || got.ContentKey != op.ContentKey {
		t.Fatalf("round trip: %+v", got)
	}

	big := op
	big.ID = strings.Repeat("c", 32)
	big.Account = strings.Repeat("a", maxUpRecord)
	if err := SaveUpOperation(cfg, big); !errors.Is(err, ErrUpOperationTooLarge) {
		t.Fatalf("oversized save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(UpJournalDir(cfg), big.ID+".json")); !os.IsNotExist(err) {
		t.Fatal("an oversized record was written")
	}
	if left, _ := filepath.Glob(filepath.Join(UpJournalDir(cfg), ".tmp-*")); len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
	if _, err := LoadUpOperation(cfg, op.ID); err != nil {
		t.Fatalf("the existing record was disturbed: %v", err)
	}
}

// B4: a recorded upload (UploadPrepared) whose body was wholly sent is UNKNOWN
// even when the caller cancels while waiting for the answer -- the server may
// have stored it. Plain Upload keeps returning the caller's cancellation.
func TestPreparedUploadCancelAfterBodySentIsUnknown(t *testing.T) {
	gotBody := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		gotBody <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	src := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(src, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(recorded bool) error {
		c := NewClient(srv.URL)
		c.Token = "tok"
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() {
			<-gotBody // barrier: the server has the whole body
			time.Sleep(20 * time.Millisecond)
			cancel()
		}()
		if recorded {
			p, err := PrepareUpload([]string{src}, UploadOpts{})
			if err != nil {
				t.Fatal(err)
			}
			_, _, err = c.UploadPrepared(ctx, p, "relayium-up."+strings.Repeat("d", 32))
			return err
		}
		_, _, _, err := c.Upload(ctx, []string{src}, UploadOpts{})
		return err
	}
	var unk *UploadUnconfirmedError
	if err := run(true); !errors.As(err, &unk) {
		t.Fatalf("recorded upload cancelled after its body was sent: err = %v, want *UploadUnconfirmedError", err)
	}
	if err := run(false); errors.As(err, &unk) || !errors.Is(err, context.Canceled) {
		t.Fatalf("plain Upload cancelled after its body: err = %v, want the caller's context.Canceled", err)
	}
}

// B1 unit: a probe whose body is asked for before any answer (an early
// 100 Continue) still accepts a definitive answer that follows, and never
// yields a byte.
func TestRecoverAcceptsAnswerAfterEarlyContinue(t *testing.T) {
	var bodyBytes int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reading the body makes net/http send "100 Continue" at once; the
		// probe body then blocks, yielding nothing, until the answer below.
		done := make(chan int64, 1)
		go func() {
			n, _ := io.CopyN(io.Discard, r.Body, 1)
			done <- n
		}()
		select {
		case n := <-done:
			bodyBytes = n
		case <-time.After(300 * time.Millisecond):
		}
		w.Header().Set("Idempotent-Replay", "true")
		w.Header().Set("Connection", "close")
		_, _ = w.Write([]byte(`{"id":"abc123","expiresAt":42}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	c.Token = "tok"
	res, err := c.RecoverUpload(context.Background(), "relayium-up."+strings.Repeat("e", 32), UploadOpts{}, 1000)
	if err != nil || res.State != RecoveredCommitted || res.ID != "abc123" {
		t.Fatalf("res %+v err %v", res, err)
	}
	if bodyBytes != 0 {
		t.Fatalf("the probe yielded %d body byte(s)", bodyBytes)
	}
}
