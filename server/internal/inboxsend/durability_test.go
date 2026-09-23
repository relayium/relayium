package inboxsend

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// N8 against a REAL filesystem failure. The fault replaces the journal
// directory with an ordinary file at a chosen request, so every later journal
// write fails with the operating system's own error, while the record as it
// stood is kept aside. restore() puts it back — the state a new process finds
// after the disk recovers — and a fresh Session retries it against the actual
// account.Service, SQLite and DiskStore. No product code is hooked.

type journalBreaker struct {
	t          *testing.T
	live, held string
	mu         sync.Mutex
	broken     bool
	err        error
}

func newJournalBreaker(w *world) *journalBreaker {
	live := filepath.Join(w.cfgDir, journalDirName)
	return &journalBreaker{t: w.t, live: live, held: live + "-held"}
}

// breakNow runs on the server's handler goroutine, before the real handler.
func (b *journalBreaker) breakNow(*http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := os.Rename(b.live, b.held); err != nil {
		b.err = err
		return
	}
	b.err = os.WriteFile(b.live, []byte("not a directory"), 0o600)
	b.broken = b.err == nil
}

// restore undoes the fault and returns the one record that was kept.
func (b *journalBreaker) restore(w *world) *Journal {
	b.t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil || !b.broken {
		b.t.Fatalf("the fault never took effect: %v", b.err)
	}
	if err := os.Remove(b.live); err != nil {
		b.t.Fatal(err)
	}
	if err := os.Rename(b.held, b.live); err != nil {
		b.t.Fatal(err)
	}
	b.broken = false
	st := newJournalStore(w.cfgDir)
	ids, err := st.ids()
	if err != nil || len(ids) != 1 {
		b.t.Fatalf("records after restore = %v, %v; want exactly one", ids, err)
	}
	j, err := st.load(ids[0])
	if err != nil {
		b.t.Fatal(err)
	}
	return j
}

type hits struct{ init, patch, finalize, create int }

func hitsOf(w *world) hits {
	f := w.env.Faults
	return hits{f.Hits(sendtest.KeyInit), f.Hits(sendtest.KeyPatch), f.Hits(sendtest.KeyFinalize), f.Hits(sendtest.KeyCreate)}
}

var (
	atInit     = sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/uploads", PathSuffix: "/api/uploads"}
	atPatch    = sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/"}
	atStatus   = sendtest.Rule{Method: http.MethodGet, PathPrefix: "/api/uploads/"}
	atFinalize = sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize"}
	atCreate   = sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks"}
)

// breakAt installs the fault just before the matched request reaches central.
func breakAt(w *world, at sendtest.Rule) *journalBreaker {
	b := newJournalBreaker(w)
	r := at
	r.Action, r.Fn = sendtest.Before, b.breakNow
	w.env.Faults.Add(&r)
	return b
}

const payload = "exactly these bytes"

func sendOne(t *testing.T, w *world) (Result, *Error) {
	t.Helper()
	root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	if err != nil {
		e := AsError(err)
		if e == nil {
			t.Fatalf("send: %v", err)
		}
		return res, e
	}
	return res, nil
}

func assertJournalWriteFailure(t *testing.T, e *Error) {
	t.Helper()
	if e == nil || e.Class != ClassFailed || e.Code != CodeJournalWrite {
		t.Fatalf("err = %v; want ClassFailed %s", e, CodeJournalWrite)
	}
	if !strings.Contains(e.Msg, "not a directory") {
		t.Fatalf("the operating system's error is not reported: %s", e.Msg)
	}
}

// Every Send checkpoint, with a healthy control. The fault fires just before
// the request whose answer the next checkpoint records.
func TestSendCheckpointFailureStopsBeforeTheNextIrreversibleRequest(t *testing.T) {
	t.Run("healthy control", func(t *testing.T) {
		fastBackoff(t)
		watchNonces(t)
		w := newWorld(t, 4<<20)
		r := atInit
		r.Action, r.Fn = sendtest.Before, func(*http.Request) {}
		w.env.Faults.Add(&r)
		res, e := sendOne(t, w)
		if e != nil {
			t.Fatalf("send: %v", e)
		}
		if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 || len(w.tasks()) != 1 {
			t.Fatalf("hits %+v tasks %d", h, len(w.tasks()))
		}
		if string(w.receive(res.TaskID).files["a.txt"]) != payload {
			t.Fatal("content differs")
		}
	})

	t.Run("first record is not written: nothing is requested", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		if err := newJournalStore(w.cfgDir).ensure(); err != nil {
			t.Fatal(err)
		}
		b := newJournalBreaker(w)
		b.breakNow(nil)
		if b.err != nil {
			t.Fatal(b.err)
		}
		_, e := sendOne(t, w)
		if e == nil || e.Code != CodeLocalState || !strings.Contains(e.Msg, "not a directory") {
			t.Fatalf("err = %v; want local_state naming the OS error", e)
		}
		if h := hitsOf(w); h != (hits{}) {
			t.Fatalf("hits = %+v; want no write request", h)
		}
	})

	t.Run("upload id is not recorded: no byte is appended", func(t *testing.T) {
		fastBackoff(t)
		watchNonces(t)
		w := newWorld(t, 4<<20)
		b := breakAt(w, atInit)
		_, e := sendOne(t, w)
		if h := hitsOf(w); h != (hits{init: 1}) {
			t.Fatalf("hits = %+v; want only the init — no byte may be appended to an unrecorded session", h)
		}
		assertJournalWriteFailure(t, e)
		if !strings.Contains(e.Msg, "before any file data was uploaded") || !strings.Contains(e.Msg, "Nothing was queued") {
			t.Fatalf("message: %s", e.Msg)
		}
		// Restart: the record a new process finds says planned, which is now
		// true — no finalize was ever sent — so its advice is honest.
		j := b.restore(w)
		if j.Phase != PhasePlanned {
			t.Fatalf("phase = %s", j.Phase)
		}
		_, err := w.session().Retry(context.Background(), j.ID)
		if re := AsError(err); re == nil || re.Code != CodeNotResumable {
			t.Fatalf("retry = %v; want not_resumable", err)
		}
		if h := hitsOf(w); h != (hits{init: 1}) || len(w.tasks()) != 0 || w.env.QuotaBytes(w.uid) != 0 {
			t.Fatalf("hits %+v tasks %d quota %d; want nothing committed", h, len(w.tasks()), w.env.QuotaBytes(w.uid))
		}
	})

	t.Run("finalizing is not recorded: finalize is not sent; retry completes it", func(t *testing.T) {
		fastBackoff(t)
		watchNonces(t)
		w := newWorld(t, 4<<20)
		b := breakAt(w, atPatch)
		_, e := sendOne(t, w)
		if h := hitsOf(w); h.finalize != 0 || h.create != 0 || w.env.QuotaBytes(w.uid) != 0 {
			t.Fatalf("hits %+v quota %d; finalize must not be sent", h, w.env.QuotaBytes(w.uid))
		}
		assertJournalWriteFailure(t, e)
		if e.LocalSendID == "" || !strings.Contains(e.Msg, "relayium inbox retry "+e.LocalSendID) {
			t.Fatalf("no way to finish it: %+v", e)
		}
		j := b.restore(w)
		if j.Phase != PhaseUploading || j.ID != e.LocalSendID {
			t.Fatalf("record = %s %s", j.ID, j.Phase)
		}
		res, err := w.session().Retry(context.Background(), j.ID)
		if err != nil {
			t.Fatalf("retry: %v", err)
		}
		if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 || len(w.tasks()) != 1 {
			t.Fatalf("hits %+v tasks %d; want one upload, one finalize, one task", h, len(w.tasks()))
		}
		if string(w.receive(res.TaskID).files["a.txt"]) != payload {
			t.Fatal("content differs")
		}
		if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
			t.Fatal("record kept after completion")
		}
	})

	t.Run("stored object is not recorded: create is not sent; retry never says nothing happened", func(t *testing.T) {
		fastBackoff(t)
		watchNonces(t)
		w := newWorld(t, 4<<20)
		b := breakAt(w, atFinalize)
		_, e := sendOne(t, w)
		quota := w.env.QuotaBytes(w.uid)
		if h := hitsOf(w); h.finalize != 1 || h.create != 0 || len(w.tasks()) != 0 || quota == 0 {
			t.Fatalf("hits %+v tasks %d quota %d; want a committed upload and no create", h, len(w.tasks()), quota)
		}
		assertJournalWriteFailure(t, e)
		if !strings.Contains(e.Msg, "NOT queued") || !strings.Contains(e.Msg, "upload itself was completed") ||
			!strings.Contains(e.Msg, "record was kept") || strings.Contains(e.Msg, "never got past") {
			t.Fatalf("message: %s", e.Msg)
		}
		j := b.restore(w)
		if j.Phase != PhaseFinalizing || e.LocalSendID != j.ID {
			t.Fatalf("record %s %s, reported %q", j.ID, j.Phase, e.LocalSendID)
		}
		_, err := w.session().Retry(context.Background(), j.ID)
		re := AsError(err)
		if re == nil || re.Class != ClassUnknown || re.Code == CodeNotResumable ||
			strings.Contains(re.Msg, "never got past") || re.LocalSendID != j.ID {
			t.Fatalf("retry = %+v; want unknown with the record kept", re)
		}
		if h := hitsOf(w); h.init != 1 || h.create != 0 || len(w.tasks()) != 0 || w.env.QuotaBytes(w.uid) != quota {
			t.Fatalf("hits %+v tasks %d quota %d; retry must not upload or invent a task", h, len(w.tasks()), w.env.QuotaBytes(w.uid))
		}
		if _, err := newJournalStore(w.cfgDir).load(j.ID); err != nil {
			t.Fatalf("record not kept: %v", err)
		}
	})

	t.Run("record cannot be removed after the create: retry converges on the one task", func(t *testing.T) {
		fastBackoff(t)
		watchNonces(t)
		w := newWorld(t, 4<<20)
		b := breakAt(w, atCreate)
		res, e := sendOne(t, w)
		if e != nil {
			t.Fatalf("send: %v", e)
		}
		if !strings.Contains(w.notice.String(), "cannot remove the local send record") {
			t.Fatalf("notice: %s", w.notice.String())
		}
		quota := w.env.QuotaBytes(w.uid)
		j := b.restore(w)
		if j.Phase != PhaseFinalized {
			t.Fatalf("phase = %s", j.Phase)
		}
		again, err := w.session().Retry(context.Background(), j.ID)
		if err != nil || again.Created || again.TaskID != res.TaskID {
			t.Fatalf("retry = %+v, %v; want the same task, not created", again, err)
		}
		if h := hitsOf(w); h.init != 1 || len(w.tasks()) != 1 || w.env.QuotaBytes(w.uid) != quota {
			t.Fatalf("hits %+v tasks %d", h, len(w.tasks()))
		}
	})
}

// Retry's own checkpoints, from a record left in phase uploading with every
// byte acknowledged.
func TestRetryCheckpointFailureStopsBeforeTheNextIrreversibleRequest(t *testing.T) {
	uploaded := func(t *testing.T) (*world, string) {
		w := newWorld(t, 4<<20)
		b := breakAt(w, atPatch)
		if _, e := sendOne(t, w); e == nil || e.Code != CodeJournalWrite {
			t.Fatalf("setup: %v", e)
		}
		return w, b.restore(w).ID
	}

	t.Run("finalizing is not recorded: finalize is not sent", func(t *testing.T) {
		fastBackoff(t)
		w, id := uploaded(t)
		b := breakAt(w, atStatus)
		_, err := w.session().Retry(context.Background(), id)
		if h := hitsOf(w); h.finalize != 0 || h.create != 0 {
			t.Fatalf("hits = %+v; finalize must not be sent", h)
		}
		e := AsError(err)
		assertJournalWriteFailure(t, e)
		if e.LocalSendID != id {
			t.Fatalf("record not named: %+v", e)
		}
		if j := b.restore(w); j.Phase != PhaseUploading {
			t.Fatalf("phase = %s", j.Phase)
		}
		if _, err := w.session().Retry(context.Background(), id); err != nil {
			t.Fatalf("second retry: %v", err)
		}
		if h := hitsOf(w); h.init != 1 || h.finalize != 1 || len(w.tasks()) != 1 {
			t.Fatalf("hits %+v tasks %d", h, len(w.tasks()))
		}
	})

	t.Run("stored object is not recorded: create is not sent", func(t *testing.T) {
		fastBackoff(t)
		w, id := uploaded(t)
		b := breakAt(w, atFinalize)
		_, err := w.session().Retry(context.Background(), id)
		quota := w.env.QuotaBytes(w.uid)
		if h := hitsOf(w); h.finalize != 1 || h.create != 0 || len(w.tasks()) != 0 || quota == 0 {
			t.Fatalf("hits %+v tasks %d quota %d; want a committed upload and no create", h, len(w.tasks()), quota)
		}
		assertJournalWriteFailure(t, AsError(err))
		if j := b.restore(w); j.Phase != PhaseFinalizing {
			t.Fatalf("phase = %s", j.Phase)
		}
		_, err = w.session().Retry(context.Background(), id)
		if re := AsError(err); re == nil || re.Class != ClassUnknown {
			t.Fatalf("retry = %v; want unknown", err)
		}
		if h := hitsOf(w); h.init != 1 || h.create != 0 || w.env.QuotaBytes(w.uid) != quota {
			t.Fatalf("hits %+v quota %d", h, w.env.QuotaBytes(w.uid))
		}
	})
}

// ---------------------------------------------------------------- F5

// A definitive refusal of a create REPLAY answers only that request. After an
// ambiguous attempt that actually landed, a revoked login must not turn "may
// have been queued" into "not queued", nor discard the record.
func TestLaterRefusalAfterAPossiblyLandedCreateIsUnknown(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	first := atCreate
	first.Action = sendtest.DropResponse
	w.env.Faults.Add(&first)
	second := atCreate
	second.Action = sendtest.Before
	revoked := make(chan error, 1)
	second.Fn = func(r *http.Request) {
		revoked <- w.env.Store.DeleteCLIToken(context.Background(),
			authx.HashToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
	}
	w.env.Faults.Add(&second)
	_, e := sendOne(t, w)
	if err := <-revoked; err != nil {
		t.Fatal(err)
	}
	quota := w.env.QuotaBytes(w.uid)
	if n := len(w.tasks()); n != 1 || quota == 0 {
		t.Fatalf("tasks %d quota %d; the first create should have landed", n, quota)
	}
	if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID == "" {
		t.Fatalf("err = %v; want unknown with the record kept", e)
	}
	if strings.Contains(e.Msg, "not queued") || !strings.Contains(e.Msg, "may have been queued") ||
		!strings.Contains(e.Msg, "later attempt was refused (HTTP 401)") {
		t.Fatalf("message: %s", e.Msg)
	}
	j, err := newJournalStore(w.cfgDir).load(e.LocalSendID)
	if err != nil || j.Phase != PhaseFinalized {
		t.Fatalf("record = %+v, %v; want kept in phase finalized", j, err)
	}
	// The same (revoked) login cannot finish it; the record survives that too.
	_, err = w.session().Retry(context.Background(), j.ID)
	if re := AsError(err); re == nil || re.Code != CodeSignedOut {
		t.Fatalf("retry = %v; want signed_out", err)
	}
	if _, err := newJournalStore(w.cfgDir).load(j.ID); err != nil {
		t.Fatalf("record discarded: %v", err)
	}
	if h := hitsOf(w); h.init != 1 || len(w.tasks()) != 1 || w.env.QuotaBytes(w.uid) != quota {
		t.Fatalf("hits %+v tasks %d quota %d", h, len(w.tasks()), w.env.QuotaBytes(w.uid))
	}
}

// Control: with no earlier ambiguous attempt, a definitive refusal of the
// first create is definite — not queued, record removed.
func TestFirstCreateRefusalIsDefinite(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	r := atCreate
	r.Action, r.Code = sendtest.Status, http.StatusForbidden
	w.env.Faults.Add(&r)
	_, e := sendOne(t, w)
	if e == nil || e.Class != ClassFailed || e.Code != CodeSignedOut || !strings.Contains(e.Msg, "not queued") {
		t.Fatalf("err = %v; want a definite signed_out refusal", e)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 || len(w.tasks()) != 0 {
		t.Fatalf("records %v tasks %d", ids, len(w.tasks()))
	}
}

// After a restart from phase finalized, the earlier process may have sent the
// create. A refusal of the replay is reconciled by looking the task up, and
// is unknown — record kept — when even that is refused.
func TestRetryOfAFinalizedRecordReconcilesARefusedReplay(t *testing.T) {
	for _, listRefused := range []bool{false, true} {
		t.Run(map[bool]string{false: "lookup finds the landed task", true: "lookup refused too"}[listRefused], func(t *testing.T) {
			fastBackoff(t)
			w := newWorld(t, 4<<20)
			root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
			hold := w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
			id := interruptAt(t, w, hold, filepath.Join(root, "a.txt"))
			refuse := atCreate
			refuse.Action, refuse.Code = sendtest.Status, http.StatusForbidden
			w.env.Faults.Add(&refuse)
			if listRefused {
				w.env.Faults.Add(&sendtest.Rule{Method: http.MethodGet, PathSuffix: "/inbox/tasks", Action: sendtest.Status, Code: http.StatusForbidden})
			}
			res, err := w.session().Retry(context.Background(), id)
			if len(w.tasks()) != 1 || w.env.Faults.Hits(sendtest.KeyInit) != 1 {
				t.Fatal("want exactly one task and one upload")
			}
			_, lerr := newJournalStore(w.cfgDir).load(id)
			if !listRefused {
				if err != nil || res.TaskID == "" || res.Created {
					t.Fatalf("retry = %+v, %v; want the landed task", res, err)
				}
				if lerr == nil {
					t.Fatal("record kept after reconciling")
				}
				return
			}
			if e := AsError(err); e == nil || e.Class != ClassUnknown || e.LocalSendID != id {
				t.Fatalf("retry = %v; want unknown", err)
			}
			if lerr != nil {
				t.Fatalf("record discarded: %v", lerr)
			}
		})
	}
}

// ---------------------------------------------------------------- F6

// The finalize counterpart of F5. The first finalize commits against the real
// service and its answer is lost; the login is revoked before the replay, which
// central refuses 401. That refusal answers only the replay: the upload stays
// "may have completed", the record is kept, nothing is uploaded again, and no
// partial-upload cleanup is claimed.
func TestLaterRefusalAfterAPossiblyCommittedFinalizeIsUnknown(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	first := atFinalize
	first.Action = sendtest.DropResponse
	w.env.Faults.Add(&first)
	second := atFinalize
	second.Action = sendtest.Before
	revoked := make(chan error, 1)
	second.Fn = func(r *http.Request) {
		revoked <- w.env.Store.DeleteCLIToken(context.Background(),
			authx.HashToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
	}
	w.env.Faults.Add(&second)
	_, e := sendOne(t, w)
	if err := <-revoked; err != nil {
		t.Fatal(err)
	}
	quota := w.env.QuotaBytes(w.uid)
	if h := hitsOf(w); h.init != 1 || h.finalize != 2 || h.create != 0 || len(w.tasks()) != 0 || quota == 0 {
		t.Fatalf("hits %+v tasks %d quota %d; the first finalize should have committed", h, len(w.tasks()), quota)
	}
	if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID == "" {
		t.Fatalf("err = %v; want unknown with the record kept", e)
	}
	if strings.Contains(e.Msg, "partial upload") || !strings.Contains(e.Msg, "may have received the complete upload") ||
		!strings.Contains(e.Msg, "later attempt was refused (HTTP 401)") || !strings.Contains(e.Msg, "logging in again creates a new device") {
		t.Fatalf("message: %s", e.Msg)
	}
	j, err := newJournalStore(w.cfgDir).load(e.LocalSendID)
	if err != nil || j.Phase != PhaseFinalizing {
		t.Fatalf("record = %+v, %v; want kept in phase finalizing", j, err)
	}
	// The same (revoked) login cannot finish it; the record survives that too.
	_, err = w.session().Retry(context.Background(), j.ID)
	if re := AsError(err); re == nil || re.Code != CodeSignedOut {
		t.Fatalf("retry = %v; want signed_out", err)
	}
	if _, err := newJournalStore(w.cfgDir).load(j.ID); err != nil {
		t.Fatalf("record discarded: %v", err)
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 2 || len(w.tasks()) != 0 || w.env.QuotaBytes(w.uid) != quota {
		t.Fatalf("hits %+v tasks %d quota %d", h, len(w.tasks()), w.env.QuotaBytes(w.uid))
	}
}

// After a restart from phase finalizing, the earlier process may have sent the
// finalize (here it did: the held answer never arrived). Any definitive refusal
// of the retry's finalize is unknown with the record kept, never a re-upload.
func TestRetryOfAFinalizingRecordKeepsItOnARefusedReplay(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusRequestEntityTooLarge, http.StatusTooManyRequests, http.StatusBadRequest} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			fastBackoff(t)
			w := newWorld(t, 4<<20)
			root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
			hold := w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
			id := interruptAt(t, w, hold, filepath.Join(root, "a.txt"))
			quota := w.env.QuotaBytes(w.uid)
			refuse := atFinalize
			refuse.Action, refuse.Code = sendtest.Status, code
			w.env.Faults.Add(&refuse)
			_, err := w.session().Retry(context.Background(), id)
			e := AsError(err)
			if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID != id {
				t.Fatalf("retry = %v; want unknown", err)
			}
			if strings.Contains(e.Msg, "partial upload") || !strings.Contains(e.Msg, "later attempt was refused") {
				t.Fatalf("message: %s", e.Msg)
			}
			if j, lerr := newJournalStore(w.cfgDir).load(id); lerr != nil || j.Phase != PhaseFinalizing {
				t.Fatalf("record = %+v, %v; want kept in phase finalizing", j, lerr)
			}
			if h := hitsOf(w); h.init != 1 || h.finalize != 2 || h.create != 0 || len(w.tasks()) != 0 || quota == 0 || w.env.QuotaBytes(w.uid) != quota {
				t.Fatalf("hits %+v tasks %d quota %d->%d", h, len(w.tasks()), quota, w.env.QuotaBytes(w.uid))
			}
		})
	}
}

// Control: with no earlier ambiguous attempt, a definitive refusal of the
// first finalize is definite — failed, what it may have left reported, record
// removed. A refusal before the handler (as here) leaves the session to
// cleanup, so the copy must not say the ciphertext is gone either.
func TestFirstFinalizeRefusalIsDefinite(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	r := atFinalize
	r.Action, r.Code = sendtest.Status, http.StatusForbidden
	w.env.Faults.Add(&r)
	_, e := sendOne(t, w)
	if e == nil || e.Class != ClassFailed || e.Code != CodeSignedOut || !strings.Contains(e.Msg, msgFinalizeRefused) ||
		strings.Contains(e.Msg, "later attempt") {
		t.Fatalf("err = %v; want a definite signed_out refusal", e)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 || len(w.tasks()) != 0 {
		t.Fatalf("records %v tasks %d", ids, len(w.tasks()))
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 0 {
		t.Fatalf("hits %+v", h)
	}
}
