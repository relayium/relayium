package inboxsend

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// F-A (revision 3): stale_target_key proves only that no task holds the
// idempotency key NOW. Once an earlier create may have landed, the task can
// have been cancelled, or saved and pruned, since; a stale answer then says
// nothing about the earlier create. These run against the real account.Service,
// SQLite and DiskStore behind the sendtest fault middleware.

// quietClient is a client with the given bearer that bypasses the faults and
// never touches testing.T, so a fault callback on a handler goroutine can use it.
func quietClient(w *world, token string) (*Client, error) {
	c, err := NewClient(w.env.TS.URL, token, nil)
	if err != nil {
		return nil, err
	}
	c.hc.Transport = bypassTransport{w.env}
	return c, nil
}

// cancelTheLandedTask deletes the one task the target holds, as another client
// of the account would.
func cancelTheLandedTask(w *world) error {
	c, err := quietClient(w, w.target.token)
	if err != nil {
		return err
	}
	ts, err := c.ListTasks(context.Background(), w.target.id, 500)
	if err != nil {
		return err
	}
	if len(ts) != 1 {
		return fmt.Errorf("want the one landed task, found %d", len(ts))
	}
	return c.DeleteTask(context.Background(), w.target.id, ts[0].ID)
}

// rotateQuietly is device.rotate without testing.T.
func (d *device) rotateQuietly() error {
	ctx := context.Background()
	keys, err := d.client.ListKeys(ctx)
	if err != nil {
		return err
	}
	prev := ""
	for _, k := range keys {
		if k.Active() {
			prev = k.ID
		}
	}
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	k, err := d.client.RegisterKey(ctx, inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(pub[:]), prev)
	if err != nil {
		return err
	}
	d.keys[k.ID], d.pub[k.ID] = priv, pub
	return nil
}

// drainFixture reports the first error a fault callback sent. It is called
// after the command returned, so every callback that will ever run has run;
// it never blocks on one that did not (a wrong sender makes fewer requests).
func drainFixture(t *testing.T, fixture chan error) {
	t.Helper()
	for {
		select {
		case err := <-fixture:
			if err != nil {
				t.Fatalf("fixture: %v", err)
			}
		default:
			return
		}
	}
}

func wrappedKeyOf(t *testing.T, body []byte) string {
	t.Helper()
	var b createBody
	if err := json.Unmarshal(body, &b); err != nil || b.WrappedKey == "" {
		t.Fatalf("create body: %v", err)
	}
	return b.WrappedKey
}

// assertNoFalseNegative fails when a message claims the delivery was never
// queued, or describes its ciphertext as an unattached orphan.
func assertNoFalseNegative(t *testing.T, msg string) {
	t.Helper()
	for _, claim := range []string{"not queued", "not attached to any delivery", "can no longer be completed",
		"keeps changing", "never got past"} {
		if strings.Contains(msg, claim) {
			t.Fatalf("message claims %q about a delivery that may have landed: %s", claim, msg)
		}
	}
}

// In process: the first create LANDS (answer lost); the task is then cancelled
// and the key rotated, so the byte-identical replay is answered stale. The
// first stale answer still licenses exactly one re-wrap (journalled before it
// is sent); the key rotates again, so the re-wrapped create is stale too. That
// second stale answer must not be read as "neither create landed".
func TestRepeatedStaleAfterAPossiblyLandedCreateStaysUnknown(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 4<<20)
	lost := atCreate
	lost.Action = sendtest.DropResponse
	w.env.Faults.Add(&lost)
	fixture := make(chan error, 2)
	replay := atCreate
	replay.Action = sendtest.Before
	replay.Fn = func(*http.Request) {
		err := cancelTheLandedTask(w)
		if err == nil {
			err = w.target.rotateQuietly()
		}
		fixture <- err
	}
	w.env.Faults.Add(&replay)
	var journalled string
	rewrapped := atCreate
	rewrapped.Action = sendtest.Before
	rewrapped.Fn = func(*http.Request) {
		ids, err := newJournalStore(w.cfgDir).ids()
		if err == nil && len(ids) == 1 {
			var j *Journal
			if j, err = newJournalStore(w.cfgDir).load(ids[0]); err == nil {
				journalled = j.WrappedKey
			}
		}
		if err == nil {
			err = w.target.rotateQuietly()
		}
		fixture <- err
	}
	w.env.Faults.Add(&rewrapped)
	sealsAtFinalize := -1
	w.env.Faults.SetObserve(func(kind string) {
		if kind == sendtest.KeyFinalize && sealsAtFinalize < 0 {
			sealsAtFinalize = reg.seals()
		}
	})

	root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	drainFixture(t, fixture)
	e := AsError(err)
	if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID == "" {
		t.Fatalf("send = %v; want unknown_outcome with the record kept", err)
	}
	assertNoFalseNegative(t, e.Msg)
	if !strings.Contains(e.Msg, "later attempt was refused (HTTP 409)") {
		t.Fatalf("the stale refusal is not reported as answering only that attempt: %s", e.Msg)
	}
	c := w.env.Faults.Creates()
	if len(c) != 3 || string(c[0]) != string(c[1]) || string(c[1]) == string(c[2]) {
		t.Fatalf("want [A, A, B]: one byte-identical replay, then exactly one re-wrap; got %d creates", len(c))
	}
	if journalled != wrappedKeyOf(t, c[2]) {
		t.Fatal("the re-wrapped key was sent before it was journalled")
	}
	j, lerr := newJournalStore(w.cfgDir).load(e.LocalSendID)
	if lerr != nil || j.Phase != PhaseFinalized || j.WrappedKey != wrappedKeyOf(t, c[2]) {
		t.Fatalf("record = %+v, %v; want kept, finalized, holding the last key sent", j, lerr)
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 {
		t.Fatalf("hits = %+v; a stale key started a second upload", h)
	}
	if reg.seals() != sealsAtFinalize {
		t.Fatalf("seals %d -> %d after the upload: a frame was sealed again", sealsAtFinalize, reg.seals())
	}
	if q := w.env.QuotaBytes(w.uid); q != 64<<10 {
		t.Fatalf("quota = %d; want exactly one (minimum) reservation", q)
	}
	if n := len(w.tasks()); n != 0 {
		t.Fatalf("tasks = %d; want none (no duplicate delivery)", n)
	}
	if !strings.Contains(w.notice.String(), "receiving key changed") {
		t.Fatal("the one re-wrap is not reported")
	}
}

// After a restart: the create LANDED (answer held, process interrupted), the
// real receiver claimed it and reported it saved, GC pruned the terminal row
// after its retention, and only then is `retry` run. Whether or not the key
// has rotated since, retry cannot know the delivery never happened.
func TestRetryAfterALandedCreateThatWasSavedAndPrunedStaysUnknown(t *testing.T) {
	for _, rotate := range []bool{false, true} {
		t.Run(map[bool]string{false: "key unchanged", true: "key rotated"}[rotate], func(t *testing.T) {
			fastBackoff(t)
			w := newWorld(t, 4<<20)
			root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
			hold := atCreate
			hold.Action, hold.Hit = sendtest.HoldResponse, make(chan struct{})
			w.env.Faults.Add(&hold)
			id := interruptAt(t, w, &hold, filepath.Join(root, "a.txt"))
			tasks := w.tasks()
			if len(tasks) != 1 {
				t.Fatalf("tasks = %d; the held create should have landed", len(tasks))
			}
			ctx := context.Background()
			ds, _, err := w.target.client.Claim(ctx, 8)
			if err != nil || len(ds) != 1 || ds[0].ID != tasks[0].ID {
				t.Fatalf("claim = %+v, %v", ds, err)
			}
			for _, st := range []string{inbox.TaskVerifying, inbox.TaskSaved} {
				if _, err := w.target.client.Report(ctx, ds[0].ID, ds[0].ClaimToken, st, inbox.TaskErrNone, st == inbox.TaskSaved); err != nil {
					t.Fatalf("report %s: %v", st, err)
				}
			}
			retention := int64(inbox.TerminalTaskRetention / time.Second)
			if _, _, pruned, err := w.env.Store.SweepInboxTasks(ctx, time.Now().Unix()+retention+60, retention); err != nil || pruned != 1 {
				t.Fatalf("sweep pruned %d, %v; want the saved task pruned", pruned, err)
			}
			if rotate {
				w.target.rotate(t, w.target.activeKeyID(t))
			}
			quota, creates := w.env.QuotaBytes(w.uid), len(w.env.Faults.Creates())

			_, err = w.session().Retry(ctx, id)
			e := AsError(err)
			if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID != id {
				t.Fatalf("retry = %v; want unknown_outcome with the record kept", err)
			}
			assertNoFalseNegative(t, e.Msg)
			if _, lerr := newJournalStore(w.cfgDir).load(id); lerr != nil {
				t.Fatalf("record discarded: %v", lerr)
			}
			if got := len(w.env.Faults.Creates()) - creates; got != 1 {
				t.Fatalf("retry sent %d creates; want exactly one replay", got)
			}
			if h := hitsOf(w); h.init != 1 || h.finalize != 1 || len(w.tasks()) != 0 || w.env.QuotaBytes(w.uid) != quota {
				t.Fatalf("hits=%+v tasks=%d quota %d->%d: retry uploaded or created", h, len(w.tasks()), quota, w.env.QuotaBytes(w.uid))
			}
		})
	}
}

// A record in phase finalized may have had its create sent, even when (as
// here) every earlier answer was a 502 and the create never reached central:
// the sender cannot tell. After a rotation the replay is stale; that is
// unknown with the record kept, never stale_after_restart.
func TestRetryOfAFinalizedRecordTreatsAStaleKeyAsUnknown(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("x")})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Times: 3, Action: sendtest.Status, Code: http.StatusBadGateway})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodGet, PathSuffix: "/inbox/tasks", Action: sendtest.Status, Code: http.StatusBadGateway})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	e := AsError(err)
	if e == nil || e.Class != ClassUnknown {
		t.Fatalf("err = %v; want unknown after three ambiguous creates and a failed lookup", err)
	}
	w.target.rotate(t, w.target.activeKeyID(t))
	_, err = w.session().Retry(context.Background(), e.LocalSendID)
	re := AsError(err)
	if re == nil || re.Class != ClassUnknown || re.Code != CodeUnknownOutcome || re.LocalSendID != e.LocalSendID {
		t.Fatalf("retry = %v; want unknown with the record kept", err)
	}
	assertNoFalseNegative(t, re.Msg)
	if _, lerr := newJournalStore(w.cfgDir).load(e.LocalSendID); lerr != nil {
		t.Fatalf("record discarded: %v", lerr)
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 1 {
		t.Fatal("retry uploaded")
	}
}

// In process, the re-wrap itself cannot happen (its journal write fails)
// after an earlier create may have landed. The record on disk is left as it
// was and the outcome stays unknown; nothing new is sent.
func TestRewrapFailureAfterAPossiblyLandedCreateKeepsTheRecord(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	lost := atCreate
	lost.Action = sendtest.DropResponse
	w.env.Faults.Add(&lost)
	fixture := make(chan error, 1)
	replay := atCreate
	replay.Action = sendtest.Before
	replay.Fn = func(*http.Request) {
		err := cancelTheLandedTask(w)
		if err == nil {
			err = w.target.rotateQuietly()
		}
		fixture <- err
	}
	w.env.Faults.Add(&replay)
	b := breakAt(w, sendtest.Rule{Method: http.MethodGet, PathSuffix: "/inbox/keys"})

	_, err := sendOne(t, w)
	drainFixture(t, fixture)
	if err == nil || err.Class != ClassUnknown || err.Code != CodeUnknownOutcome || err.LocalSendID == "" {
		t.Fatalf("send = %v; want unknown with the record kept", err)
	}
	assertNoFalseNegative(t, err.Msg)
	if !strings.Contains(err.Msg, "could not be re-sealed") {
		t.Fatalf("the failed re-wrap is not reported: %s", err.Msg)
	}
	c := w.env.Faults.Creates()
	if len(c) != 2 || string(c[0]) != string(c[1]) {
		t.Fatalf("want exactly the create and its byte-identical replay, got %d creates", len(c))
	}
	j := b.restore(w)
	if j.ID != err.LocalSendID || j.Phase != PhaseFinalized || j.WrappedKey != wrappedKeyOf(t, c[0]) {
		t.Fatalf("record = %+v; want the finalized record exactly as it was sent", j)
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || len(w.tasks()) != 0 {
		t.Fatalf("hits = %+v tasks = %d", h, len(w.tasks()))
	}
}

// Positive control for the one definitive case: the first create ever sent
// is refused stale. The same content key is re-wrapped exactly once, the new
// wrapped key is on disk before the second create is sent, nothing is sealed
// or uploaded again, quota is reserved once, and the delivery lands.
func TestFirstStaleRefusalRewrapsOnceJournalledBeforeTheCreate(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 4<<20)
	fixture := make(chan error, 2)
	first := atCreate
	first.Action = sendtest.Before
	first.Fn = func(*http.Request) { fixture <- w.target.rotateQuietly() }
	w.env.Faults.Add(&first)
	var journalled string
	second := atCreate
	second.Action = sendtest.Before
	second.Fn = func(*http.Request) {
		ids, err := newJournalStore(w.cfgDir).ids()
		if err == nil && len(ids) == 1 {
			var j *Journal
			if j, err = newJournalStore(w.cfgDir).load(ids[0]); err == nil {
				journalled = j.WrappedKey
			}
		}
		fixture <- err
	}
	w.env.Faults.Add(&second)

	res, e := sendOne(t, w)
	drainFixture(t, fixture)
	if e != nil || !res.Created {
		t.Fatalf("send = %+v, %v; want a newly created delivery", res, e)
	}
	c := w.env.Faults.Creates()
	if len(c) != 2 || string(c[0]) == string(c[1]) {
		t.Fatalf("want exactly two distinct creates, got %d", len(c))
	}
	if journalled == "" || journalled != wrappedKeyOf(t, c[1]) {
		t.Fatal("the re-wrapped key was not journalled before it was sent")
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 2 {
		t.Fatalf("hits = %+v", h)
	}
	if reg.seals() != 2 {
		t.Fatalf("seals = %d; want manifest + 1 frame (a re-wrap seals nothing)", reg.seals())
	}
	if q := w.env.QuotaBytes(w.uid); q != 64<<10 {
		t.Fatalf("quota = %d; want exactly one reservation", q)
	}
	if d := w.receive(res.TaskID); string(d.files["a.txt"]) != payload {
		t.Fatal("content differs")
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("record kept after completion: %v", ids)
	}
}

// The definitive restart case: the record is in phase uploading, so no create
// was ever sent (N8). Retry completes the upload; its first create is refused
// stale and the content key is gone, so the send fails and says so.
func TestRetryCannotRewrapAfterRestart(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
	hold := atPatch
	hold.Action, hold.Hit = sendtest.HoldResponse, make(chan struct{})
	w.env.Faults.Add(&hold)
	id := interruptAt(t, w, &hold, filepath.Join(root, "a.txt"))
	if j, err := newJournalStore(w.cfgDir).load(id); err != nil || j.Phase != PhaseUploading {
		t.Fatalf("record = %+v, %v; want phase uploading", j, err)
	}
	w.target.rotate(t, w.target.activeKeyID(t))
	seals := reg.seals()

	_, err := w.session().Retry(context.Background(), id)
	re := AsError(err)
	if re == nil || re.Class != ClassFailed || re.Code != CodeStaleAfterRestart || !strings.Contains(re.Msg, msgOrphanObject) {
		t.Fatalf("retry = %v; want a definite stale_after_restart", err)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("a definite failure kept a record: %v", ids)
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 {
		t.Fatalf("hits = %+v; want one upload, one finalize, one refused create", h)
	}
	if reg.seals() != seals {
		t.Fatal("retry sealed something")
	}
}

// O-1: a real daily-quota refusal at the FINALIZE gate. Central drops the blob
// and reserves nothing; the message must not assert the ciphertext is still on
// the server, and keeps transfer and daily quota apart.
func TestFinalizeGateRefusalCopyIsTruthful(t *testing.T) {
	fastBackoff(t)
	watchNonces(t)
	const maxFile = 1 << 20 // sendtest's daily quota is 16 * maxFile
	w := newWorld(t, maxFile)
	filler := make(chan error, 1)
	r := atFinalize
	r.Action = sendtest.Before
	r.Fn = func(*http.Request) {
		id, _ := newRandomHex()
		now := time.Now().Unix()
		ok, err := w.env.Store.ReserveUpload(context.Background(),
			account.UploadEvent{ID: "filler-" + id, UserID: w.uid, Bytes: 16*maxFile - 1, UploadedAt: now},
			now-86400, 16*maxFile)
		if err == nil && !ok {
			err = errors.New("filler reservation refused")
		}
		filler <- err
	}
	w.env.Faults.Add(&r)
	_, e := sendOne(t, w)
	drainFixture(t, filler)
	if e == nil || e.Class != ClassFailed || e.Code != CodeQuotaExceeded {
		t.Fatalf("send = %v; want a definite quota_exceeded", e)
	}
	if got := w.env.QuotaBytes(w.uid); got != 16*maxFile-1 {
		t.Fatalf("quota = %d; the refused finalize reserved something", got)
	}
	if !strings.Contains(e.Msg, msgFinalizeRefused) || strings.Contains(e.Msg, "The partial upload stays on the server") {
		t.Fatalf("finalize-gate refusal copy: %s", e.Msg)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 || len(w.tasks()) != 0 {
		t.Fatalf("records %v tasks %d", ids, len(w.tasks()))
	}
}

// O-1: a create refused because the object is gone or already bound must not
// call that object an unattached orphan waiting for cleanup.
func TestCreateRefusalDoesNotCallAGoneObjectAnOrphan(t *testing.T) {
	for _, code := range []string{CodeStoredObjectUnavailable, CodeStoredObjectBound} {
		e := createRefusal(&APIError{Status: http.StatusConflict, Code: code})
		if e.Code != code || strings.Contains(e.Msg, "not attached to any delivery") || !strings.Contains(e.Msg, msgCountedComplete) {
			t.Errorf("%s: %s", code, e.Msg)
		}
	}
	if e := createRefusal(&APIError{Status: http.StatusConflict, Code: CodeInboxQueueFull}); !strings.Contains(e.Msg, msgOrphanObject) {
		t.Errorf("an unbound, available object lost its orphan disclosure: %s", e.Msg)
	}
}
