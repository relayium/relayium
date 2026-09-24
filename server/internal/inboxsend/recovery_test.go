package inboxsend

// The sender's side of finalize recovery (A02 / W-C1 Stage 0): every finalize
// carries `{"recoverFinalized":true}`, a lost finalize answer is recovered from
// the server instead of ending as unknown, and each recovery outcome maps to an
// honest, definitive result. All against a real central on a FILE-backed
// SQLite database, with faults injected in front of the real handlers.

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

func uploadIDOf(r *http.Request) string {
	return strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/uploads/"), "/finalize")
}

// S0-CLI (E5 against a server with recovery): the first finalize commits and
// its answer is lost. The in-process retry recovers the SAME object, the
// delivery is queued once, nothing is uploaded or counted again, and the target
// opens exactly what was sent.
func TestLostFinalizeIsRecoveredWithoutUploadingAgain(t *testing.T) {
	fastBackoff(t)
	watchNonces(t)
	w := newFileWorld(t, 4<<20)
	data := randomBytes(t, 300_000)
	root := writeTree(t, map[string][]byte{"a.bin": data})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.DropResponse})
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.bin")}})
	if err != nil {
		t.Fatalf("send with a lost finalize answer: %v", err)
	}
	if res.TaskID == "" || !res.Created {
		t.Fatalf("result %+v; want a queued delivery", res)
	}
	if got := w.env.Faults.Hits(sendtest.KeyInit); got != 1 {
		t.Fatalf("inits = %d; recovery must never upload again", got)
	}
	if got := w.env.Faults.Hits(sendtest.KeyFinalize); got != 2 {
		t.Fatalf("finalizes = %d, want the lost one and its recovery", got)
	}
	for i, b := range w.env.Faults.FinalizeBodies() {
		if string(b) != `{"recoverFinalized":true}` {
			t.Fatalf("finalize #%d body %q; every finalize must carry the opt-in", i, b)
		}
	}
	if tasks := w.tasks(); len(tasks) != 1 || tasks[0].ID != res.TaskID {
		t.Fatalf("tasks %+v; want exactly the one delivery", tasks)
	}
	// One daily-quota debit: the first finalize's. The 300 000-byte plaintext is
	// over the 64 KiB floor, so the debit is the ciphertext size.
	quota := w.env.QuotaBytes(w.uid)
	if quota < int64(len(data)) || quota > int64(len(data))+4096 {
		t.Fatalf("daily quota %d for one %d-byte upload", quota, len(data))
	}
	if !strings.Contains(w.notice.String(), "already completed this upload") {
		t.Fatalf("notice: %s", w.notice.String())
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("record kept after completion: %v", ids)
	}
	if got := w.receive(res.TaskID).files["a.bin"]; !bytes.Equal(got, data) {
		t.Fatal("the recovered delivery does not open to the bytes that were sent")
	}
}

// Every answer lost, then a restart: `inbox retry` from the finalizing record
// recovers the same object — also on a file-backed database across the
// separate read pool the recovery read uses.
func TestRetryRecoversAFinalizeWhoseAnswersWereAllLost(t *testing.T) {
	fastBackoff(t)
	w := newFileWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("lost three times")})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.DropResponse, Times: finalizeAttempts})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	e := AsError(err)
	if e == nil || e.Class != ClassUnknown || e.LocalSendID == "" {
		t.Fatalf("send = %v; want unknown with the record kept", err)
	}
	quota := w.env.QuotaBytes(w.uid)
	if quota == 0 {
		t.Fatal("the first finalize should have committed")
	}
	res := assertRetryConverges(t, w, e.LocalSendID, quota)
	if string(w.receive(res.TaskID).files["a.txt"]) != "lost three times" {
		t.Fatal("content differs")
	}
}

// D7 at the CLI: the finalize is refused (the daily quota is spent) and its
// answer is lost. The retry hears "failed": a definitive failure, the record
// dropped, nothing queued, no debit and no second upload.
func TestRecoveredRefusalIsADefinitiveFailure(t *testing.T) {
	fastBackoff(t)
	w := newFileWorld(t, 4<<20)
	// The window is spent between the upload and its finalize (an init over
	// quota is refused before anything is uploaded).
	var spent sync.Once
	w.env.Faults.SetObserve(func(kind string) {
		if kind != sendtest.KeyFinalize {
			return
		}
		spent.Do(func() {
			now := time.Now().Unix()
			if ok, err := w.env.Store.ReserveUpload(context.Background(),
				account.UploadEvent{ID: "spent", UserID: w.uid, Bytes: 64 << 20, UploadedAt: now}, now-86400, 1<<40); err != nil || !ok {
				t.Errorf("spend the daily quota: %v %v", ok, err)
			}
		})
	})
	root := writeTree(t, map[string][]byte{"a.txt": []byte("refused")})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.DropResponse})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	e := AsError(err)
	if e == nil || e.Class != ClassFailed || e.Code != CodeFinalizeRefused {
		t.Fatalf("send = %v; want finalize_refused", err)
	}
	if !strings.Contains(e.Msg, msgFinalizeRefused) || !strings.Contains(e.Msg, msgSendAgain) {
		t.Fatalf("message: %s", e.Msg)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("a definitive failure kept a record: %v", ids)
	}
	if n := len(w.tasks()); n != 0 {
		t.Fatalf("tasks = %d", n)
	}
	if got := w.env.QuotaBytes(w.uid); got != 64<<20 {
		t.Fatalf("daily quota %d; want only the spent window, no debit for a refused upload", got)
	}
	if got := w.env.Faults.Hits(sendtest.KeyInit); got != 1 {
		t.Fatalf("inits = %d", got)
	}
}

// D6 at the CLI: the finalize commits, its answer is lost, and the object is
// removed before the retry asks. "removed" is definitive: nothing is queued,
// nothing is re-created, and the command says a new send is a new upload.
func TestRecoveredRemovedObjectIsADefinitiveFailure(t *testing.T) {
	fastBackoff(t)
	w := newFileWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("removed")})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.DropResponse})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.Before,
		Fn: func(r *http.Request) {
			ctx := context.Background()
			rec, ok, err := w.env.Store.GetUploadFinalizeRecord(ctx, uploadIDOf(r), w.uid)
			if err != nil || !ok || rec.FileID == "" {
				t.Errorf("no committed object to remove: %+v %v %v", rec, ok, err)
				return
			}
			if err := w.env.Store.DeleteStoredFile(ctx, rec.FileID, time.Now().Unix()); err != nil {
				t.Errorf("remove: %v", err)
			}
		}})
	quotaBefore := w.env.QuotaBytes(w.uid)
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	e := AsError(err)
	if e == nil || e.Class != ClassFailed || e.Code != CodeStoredObjectUnavailable || !strings.Contains(e.Msg, "since been removed") {
		t.Fatalf("send = %v; want stored_object_unavailable (removed)", err)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("a definitive failure kept a record: %v", ids)
	}
	if n := len(w.tasks()); n != 0 || w.env.Faults.Hits(sendtest.KeyInit) != 1 || w.env.Faults.Hits(sendtest.KeyCreate) != 0 {
		t.Fatalf("tasks %d inits %d creates %d", n, w.env.Faults.Hits(sendtest.KeyInit), w.env.Faults.Hits(sendtest.KeyCreate))
	}
	if got := w.env.QuotaBytes(w.uid); got == quotaBefore {
		t.Fatal("setup: the first finalize should have committed and been counted")
	}
}

// D8 at the CLI: another finalize of this upload has claimed it and never
// ends. The sender keeps asking — bounded — and then reports unknown with the
// record kept; it never uploads again.
func TestRunningFinalizeIsPolledThenUnknown(t *testing.T) {
	fastBackoff(t)
	oldBudget, oldPoll := finalizeRunningBudget, finalizeRunningPoll
	finalizeRunningBudget = 200 * time.Millisecond
	var waits []time.Duration
	finalizeRunningPoll = func(ra time.Duration) time.Duration { waits = append(waits, ra); return 20 * time.Millisecond }
	t.Cleanup(func() { finalizeRunningBudget, finalizeRunningPoll = oldBudget, oldPoll })

	w := newFileWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("in flight")})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.Before,
		Fn: func(r *http.Request) {
			if _, _, ok, err := w.env.Store.ClaimUploadDone(context.Background(), uploadIDOf(r), time.Now().Unix()); err != nil || !ok {
				t.Errorf("claim: %v %v", ok, err)
			}
		}})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	e := AsError(err)
	if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID == "" {
		t.Fatalf("send = %v; want unknown with the record kept", err)
	}
	if len(waits) < 2 {
		t.Fatalf("polled %d times; want several", len(waits))
	}
	for _, ra := range waits {
		if ra != 5*time.Second {
			t.Fatalf("Retry-After read as %v, want 5s", ra)
		}
	}
	if _, lerr := newJournalStore(w.cfgDir).load(e.LocalSendID); lerr != nil {
		t.Fatalf("record not kept: %v", lerr)
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 1 || len(w.tasks()) != 0 {
		t.Fatal("a running finalize must never cause another upload or a task")
	}
}

// The poll interval honours Retry-After within bounds.
func TestFinalizeRunningPollIsBounded(t *testing.T) {
	for in, want := range map[time.Duration]time.Duration{
		0: 5 * time.Second, time.Millisecond: time.Second, 5 * time.Second: 5 * time.Second, time.Hour: 10 * time.Second,
	} {
		if got := finalizeRunningPoll(in); got != want {
			t.Errorf("poll(%v) = %v, want %v", in, got, want)
		}
	}
}

// The recovery outcomes a server may send are the closed set; anything else is
// not an outcome (and a plain-text 409 stays "cannot confirm").
func TestFinalizeOutcomeParsingIsClosed(t *testing.T) {
	for body, want := range map[string]string{
		`{"error":"already_finalized","outcome":"running"}`: outcomeRunning,
		`{"error":"already_finalized","outcome":"failed"}`:  outcomeFailed,
		`{"error":"already_finalized","outcome":"expired"}`: outcomeExpired,
		`{"error":"already_finalized","outcome":"removed"}`: outcomeRemoved,
		`{"error":"already_finalized","outcome":"pwned"}`:   "",
		`{"outcome":"failed"}`:                              "",
		"already finalized\n":                               "",
	} {
		e := asAPIError("complete upload", &response{status: 409, header: http.Header{"Retry-After": {"5"}}, body: []byte(body)})
		if e.Outcome != want || e.RetryAfter != 5*time.Second {
			t.Errorf("%q -> outcome %q retry %v; want %q", body, e.Outcome, e.RetryAfter, want)
		}
	}
	for _, o := range []string{outcomeFailed, outcomeExpired, outcomeRemoved} {
		e := finalizeOutcomeFailure(o, nil)
		if e.Class != ClassFailed || !strings.Contains(e.Msg, msgSendAgain) || !strings.Contains(e.Msg, "nothing was queued") {
			t.Errorf("%s -> %+v", o, e)
		}
	}
}

// A "running" answer means some finalize of this upload claimed it and may
// commit an object (and its debit) at any moment, so the outcome is uncertain
// from then on. When the next answer is a 404 (that finalize committed and the
// tombstone was purged since) or a refusal of the request itself (a revoked
// login), the send must end unknown with the record kept — never "the upload
// ended before it was completed", which invites a second, counted upload.
func TestRunningThenDefinitiveLookingAnswerStaysUnknown(t *testing.T) {
	for _, tc := range []struct {
		name string
		next func(w *world) *sendtest.Rule
	}{
		{"committed_then_purged_404", func(w *world) *sendtest.Rule {
			return &sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.Before,
				Fn: func(r *http.Request) {
					// The concurrent finalize commits its object and the
					// tombstone is then purged: the real handler answers 404.
					ctx := context.Background()
					sess, ok, err := w.env.Store.GetUploadSession(ctx, uploadIDOf(r), w.uid)
					if err != nil || !ok {
						t.Errorf("session: %v %v", ok, err)
						return
					}
					now := time.Now().Unix()
					if err := w.env.Store.CreateStoredFile(ctx, account.StoredFile{ID: "f-concurrent", UserID: w.uid,
						BlobKey: sess.BlobKey, EncManifest: sess.EncManifest, Size: sess.Received, CreatedAt: now,
						ExpiresAt: now + 3600, Purpose: account.StoredPurposeDeviceTask}); err != nil {
						t.Errorf("object: %v", err)
					}
					if err := w.env.Store.DeleteUploadSession(ctx, sess.ID); err != nil {
						t.Errorf("purge: %v", err)
					}
				}}
		}},
		{"auth_refusal_401", func(*world) *sendtest.Rule {
			return &sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.Status, Code: http.StatusUnauthorized}
		}},
		{"auth_refusal_403", func(*world) *sendtest.Rule {
			return &sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.Status, Code: http.StatusForbidden}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fastBackoff(t)
			oldPoll := finalizeRunningPoll
			finalizeRunningPoll = func(time.Duration) time.Duration { return 10 * time.Millisecond }
			t.Cleanup(func() { finalizeRunningPoll = oldPoll })

			w := newFileWorld(t, 4<<20)
			root := writeTree(t, map[string][]byte{"a.txt": []byte("maybe committed")})
			// First finalize: another finalize has claimed the upload → running.
			w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.Before,
				Fn: func(r *http.Request) {
					if _, _, ok, err := w.env.Store.ClaimUploadDone(context.Background(), uploadIDOf(r), time.Now().Unix()); err != nil || !ok {
						t.Errorf("claim: %v %v", ok, err)
					}
				}})
			w.env.Faults.Add(tc.next(w))
			quotaBefore := w.env.QuotaBytes(w.uid)
			_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
			e := AsError(err)
			if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID == "" {
				t.Fatalf("send = %v; want unknown with the record kept", err)
			}
			if strings.Contains(e.Msg, "ended before it was completed") {
				t.Fatalf("message claims the upload never completed: %s", e.Msg)
			}
			if _, lerr := newJournalStore(w.cfgDir).load(e.LocalSendID); lerr != nil {
				t.Fatalf("record not kept: %v", lerr)
			}
			if got := w.env.Faults.Hits(sendtest.KeyFinalize); got != 2 {
				t.Fatalf("finalizes = %d, want the running one and the next", got)
			}
			if w.env.Faults.Hits(sendtest.KeyInit) != 1 || len(w.tasks()) != 0 || w.env.QuotaBytes(w.uid) != quotaBefore {
				t.Fatalf("inits %d tasks %d quota %d->%d; nothing may be uploaded or counted again",
					w.env.Faults.Hits(sendtest.KeyInit), len(w.tasks()), quotaBefore, w.env.QuotaBytes(w.uid))
			}
		})
	}
}

// G34-N6: the empty-blob probe fails after the finalize claim. Stage 0
// records a terminal failure, including across an interrupted CLI restart.
func TestEmptyMaterializeFailureResolvesAfterClaim(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(fmt.Sprint(restart), func(t *testing.T) {
			fastBackoff(t)
			w, node := newWorldOnNode(t, 4<<20)
			w.env.Faults.SetObserve(func(kind string) {
				if kind == sendtest.KeyFinalize {
					node.SetDown(true)
				}
			})
			ctx := context.Background()
			if restart {
				var cancel context.CancelFunc
				ctx, cancel = cancelAt(w, atFinalize, 0)
				defer cancel()
			}
			root := writeTree(t, map[string][]byte{"empty": {}})
			_, err := w.session().Send(ctx, SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "empty")}})
			if restart {
				j := theRecord(t, w)
				if j.Phase != PhaseFinalizing {
					t.Fatal(j.Phase)
				}
				node.SetDown(false)
				_, err = w.session().Retry(context.Background(), j.ID)
			}
			e := AsError(err)
			if e == nil || e.Class != ClassFailed || e.Code != CodeFinalizeRefused {
				t.Fatalf("want definitive refusal: %v", err)
			}
			if w.env.QuotaBytes(w.uid) != 0 || len(w.tasks()) != 0 {
				t.Fatal("failed materialization counted or queued")
			}
			if w.env.Faults.Hits(sendtest.KeyInit) != 1 {
				t.Fatal("another upload initialized")
			}
			if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
				t.Fatal("unresolvable record retained")
			}
		})
	}
}
