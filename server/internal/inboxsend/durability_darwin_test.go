//go:build darwin

package inboxsend

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// N8's retention half, on a filesystem that refuses NEW files but still
// allows unlinking — the case where a removal attempt would succeed, so a kept
// record proves the code chose to keep it. A Darwin ACL on the test's own
// journal directory denies add_file; the fault checks both halves before it
// counts, and the ACL is removed in Cleanup.

func aclDenyAddFileAt(w *world, at sendtest.Rule) (lift func()) {
	t := w.t
	dir := filepath.Join(w.cfgDir, journalDirName)
	user, err := exec.Command("id", "-un").Output()
	if err != nil {
		t.Fatal(err)
	}
	entry := strings.TrimSpace(string(user)) + " deny add_file"
	lifted := false
	lift = func() {
		if !lifted {
			lifted = true
			if out, err := exec.Command("chmod", "-a", entry, dir).CombinedOutput(); err != nil {
				t.Errorf("lift ACL: %v %s", err, out)
			}
		}
	}
	t.Cleanup(func() { _ = exec.Command("chmod", "-N", dir).Run() })
	fault := make(chan error, 1)
	r := at
	r.Action = sendtest.Before
	r.Fn = func(*http.Request) {
		probe := filepath.Join(dir, "unlink-control")
		if err := os.WriteFile(probe, []byte("x"), 0o600); err != nil {
			fault <- err
			return
		}
		if out, err := exec.Command("chmod", "+a", entry, dir).CombinedOutput(); err != nil {
			fault <- &os.PathError{Op: "chmod +a " + string(out), Path: dir, Err: err}
			return
		}
		if err := os.WriteFile(filepath.Join(dir, "must-not-exist"), nil, 0o600); err == nil {
			fault <- os.ErrInvalid // the ACL did not refuse a new file
			return
		}
		fault <- os.Remove(probe) // …while unlinking still works
	}
	w.env.Faults.Add(&r)
	t.Cleanup(func() {
		select {
		case err := <-fault:
			if err != nil {
				t.Errorf("ACL fault did not take effect as designed: %v", err)
			}
		default:
			t.Error("ACL fault never fired")
		}
	})
	return lift
}

func onlyRecord(t *testing.T, w *world) *Journal {
	t.Helper()
	st := newJournalStore(w.cfgDir)
	ids, err := st.ids()
	if err != nil || len(ids) != 1 {
		t.Fatalf("records = %v, %v; want the one kept record", ids, err)
	}
	j, err := st.load(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestCheckpointFailureKeepsTheRecordEvenWhenUnlinkWorks(t *testing.T) {
	t.Run("stored object not recorded (send)", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		w.env.Faults.EmulatePreRecoveryServer() // a server that cannot confirm
		lift := aclDenyAddFileAt(w, atFinalize)
		_, e := sendOne(t, w)
		quota := w.env.QuotaBytes(w.uid)
		if h := hitsOf(w); h.finalize != 1 || h.create != 0 || quota == 0 {
			t.Fatalf("hits %+v quota %d; want a committed upload and no create", h, quota)
		}
		if e == nil || e.Code != CodeJournalWrite || !strings.Contains(e.Msg, "permission denied") {
			t.Fatalf("err = %v", e)
		}
		j := onlyRecord(t, w)
		if j.Phase != PhaseFinalizing || e.LocalSendID != j.ID {
			t.Fatalf("record %s %s, reported %q; want the finalizing record kept and named", j.ID, j.Phase, e.LocalSendID)
		}
		lift()
		_, err := w.session().Retry(context.Background(), j.ID)
		if re := AsError(err); re == nil || re.Class != ClassUnknown {
			t.Fatalf("retry = %v; want unknown", err)
		}
		if h := hitsOf(w); h.init != 1 || h.create != 0 || w.env.QuotaBytes(w.uid) != quota {
			t.Fatalf("hits %+v; retry must not upload", h)
		}
		onlyRecord(t, w)
	})
	t.Run("stored object not recorded (send), recovering server", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		lift := aclDenyAddFileAt(w, atFinalize)
		_, e := sendOne(t, w)
		quota := w.env.QuotaBytes(w.uid)
		if h := hitsOf(w); h.finalize != 1 || h.create != 0 || quota == 0 {
			t.Fatalf("hits %+v quota %d; want a committed upload and no create", h, quota)
		}
		if e == nil || e.Code != CodeJournalWrite {
			t.Fatalf("err = %v", e)
		}
		j := onlyRecord(t, w)
		if j.Phase != PhaseFinalizing || e.LocalSendID != j.ID {
			t.Fatalf("record %s %s, reported %q", j.ID, j.Phase, e.LocalSendID)
		}
		lift()
		assertRetryConverges(t, w, j.ID, quota)
	})
	t.Run("upload id not recorded (send)", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		lift := aclDenyAddFileAt(w, atInit)
		_, e := sendOne(t, w)
		if h := hitsOf(w); h != (hits{init: 1}) {
			t.Fatalf("hits %+v; want only the init", h)
		}
		j := onlyRecord(t, w)
		if e == nil || e.Code != CodeJournalWrite || j.Phase != PhasePlanned || e.LocalSendID != j.ID {
			t.Fatalf("err %v record %s %s", e, j.ID, j.Phase)
		}
		lift()
		_, err := w.session().Retry(context.Background(), j.ID)
		if re := AsError(err); re == nil || re.Code != CodeNotResumable {
			t.Fatalf("retry = %v; want not_resumable", err)
		}
	})
	t.Run("stored object not recorded (retry)", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		b := breakAt(w, atPatch)
		if _, e := sendOne(t, w); e == nil || e.Code != CodeJournalWrite {
			t.Fatalf("setup: %v", e)
		}
		id := b.restore(w).ID
		lift := aclDenyAddFileAt(w, atFinalize)
		_, err := w.session().Retry(context.Background(), id)
		if h := hitsOf(w); h.finalize != 1 || h.create != 0 {
			t.Fatalf("hits %+v; want no create", h)
		}
		if e := AsError(err); e == nil || e.Code != CodeJournalWrite || e.LocalSendID != id {
			t.Fatalf("retry = %v", err)
		}
		if j := onlyRecord(t, w); j.Phase != PhaseFinalizing {
			t.Fatalf("phase = %s", j.Phase)
		}
		lift()
	})
}
