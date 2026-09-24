package inboxsend

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// Hold the retry lock through copy expiry, then change the durable record
// before the seven-day collector obtains it. No sleeps or deletion barriers:
// the unchanged planned control must actually be removed by that collector.
func TestLocalSendsRereadsAfterBusyCopyExpiry(t *testing.T) {
	for _, change := range []string{"planned", "uploading", "removed", "unreadable"} {
		t.Run(change, func(t *testing.T) {
			w := newWorld(t, 4<<20)
			root := writeTree(t, map[string][]byte{"a.txt": []byte("planned")})
			rule := atInit
			rule.Action, rule.Code = sendtest.Status, http.StatusTooManyRequests
			w.env.Faults.Add(&rule)
			if _, e := sendResumable(t, w, context.Background(), filepath.Join(root, "a.txt")); e == nil {
				t.Fatal("expected init refusal")
			}
			j := theRecord(t, w)
			st := newJournalStore(w.cfgDir)
			copyBefore, err := os.ReadFile(st.spoolPath(j.ID))
			if err != nil {
				t.Fatal(err)
			}
			lk, err := st.lock(j.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if lk != nil {
					lk.release()
				}
			}()
			s := w.session()
			calls := 0
			s.now = func() time.Time {
				calls++
				if calls == 2 {
					switch change {
					case "uploading":
						j.Phase, j.UploadID, j.ChunkSize = PhaseUploading, "test-upload", 8<<20
						if err := st.save(j); err != nil {
							t.Fatal(err)
						}
					case "removed":
						if err := os.Remove(st.path(j.ID)); err != nil {
							t.Fatal(err)
						}
					case "unreadable":
						if err := os.WriteFile(st.path(j.ID), []byte("invalid record"), 0o600); err != nil {
							t.Fatal(err)
						}
					}
					lk.release()
					lk = nil
				}
				return time.Unix(j.CreatedAt, 0).Add(staleJournalAge + time.Hour)
			}
			before := hitsOf(w)
			w.notice.Reset()
			got := s.LocalSends()
			if calls != 2 {
				t.Fatalf("clock calls = %d; seven-day collector not reached", calls)
			}
			if hitsOf(w) != before || w.env.QuotaBytes(w.uid) != 0 {
				t.Fatal("local collection contacted server or changed quota")
			}
			switch change {
			case "uploading":
				if len(got) != 1 || got[0].LocalSendID != j.ID || got[0].Phase != PhaseUploading || !got[0].Resumable {
					t.Fatalf("advanced record not listed: %+v", got)
				}
				cur, err := st.load(j.ID)
				if err != nil || *cur != *j {
					t.Fatalf("advanced record changed: %+v %v", cur, err)
				}
				copyAfter, err := os.ReadFile(st.spoolPath(j.ID))
				if err != nil || !bytes.Equal(copyBefore, copyAfter) {
					t.Fatalf("copy changed: %v", err)
				}
				sp, err := st.openSpool(cur)
				if err != nil {
					t.Fatalf("retained copy no longer validates: %v", err)
				}
				sp.close()
				if w.notice.Len() != 0 {
					t.Fatalf("false notice: %s", w.notice.String())
				}
			case "unreadable":
				if len(got) != 0 || !strings.Contains(w.notice.String(), "unreadable and was left untouched") {
					t.Fatalf("rows=%+v notice=%s", got, w.notice.String())
				}
				b, err := os.ReadFile(st.path(j.ID))
				if err != nil || string(b) != "invalid record" {
					t.Fatalf("unreadable record changed: %q %v", b, err)
				}
				b, err = os.ReadFile(st.spoolPath(j.ID))
				if err != nil || !bytes.Equal(copyBefore, b) {
					t.Fatalf("unreadable record's copy changed: %v", err)
				}
			default:
				if len(got) != 0 {
					t.Fatalf("obsolete record listed: %+v", got)
				}
				assertNoSendState(t, w)
				want := "removed the local record of an unfinished send"
				if change == "removed" {
					want = "removed a local encrypted copy no send record owns"
				}
				if !strings.Contains(w.notice.String(), want) {
					t.Fatalf("missing removal notice: %s", w.notice.String())
				}
			}
		})
	}
}

// A directory sync can fail AFTER unlink. The diagnostic must not promise
// either successful durable removal or that the journal still exists.
func TestLocalSendsReportsUnconfirmedRemoval(t *testing.T) {
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("unfinished")})
	ctx, cancel := cancelAt(w, atFinalize, 0)
	defer cancel()
	if _, err := w.session().Send(ctx, SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}}); err == nil {
		t.Fatal("expected interrupted send")
	}
	j := theRecord(t, w)
	s := w.session()
	s.now = func() time.Time { return time.Unix(j.CreatedAt, 0).Add(staleJournalAge + time.Hour) }
	old := syncRootDir
	syncs := 0
	syncRootDir = func(*os.Root) error { syncs++; return fmt.Errorf("injected sync failure\x1b[31m") }
	defer func() { syncRootDir = old }()
	w.notice.Reset()
	before := hitsOf(w)
	got := s.LocalSends()
	if syncs != 1 {
		t.Fatalf("sync failures = %d; removal path not reached", syncs)
	}
	if len(got) != 1 || got[0].LocalSendID != j.ID {
		t.Fatalf("diagnostic row lost: %+v", got)
	}
	if _, err := s.store.load(j.ID); !errors.Is(err, errNoJournal) {
		t.Fatalf("expected unlink before failed sync: %v", err)
	}
	notice := w.notice.String()
	for _, want := range []string{"warning:", "cannot confirm removal", j.ID, "injected sync failure"} {
		if !strings.Contains(notice, want) {
			t.Errorf("missing %q in %q", want, notice)
		}
	}
	if strings.Contains(notice, "\x1b") || strings.Contains(notice, "removed the local record") || strings.Contains(notice, "left untouched") {
		t.Fatalf("unsafe or false notice: %q", notice)
	}
	if hitsOf(w) != before {
		t.Fatal("local collection contacted server")
	}
	syncRootDir = old
	w.notice.Reset()
	if got := s.LocalSends(); len(got) != 0 || w.notice.Len() != 0 {
		t.Fatalf("second listing rows=%+v notice=%s", got, w.notice.String())
	}
}
