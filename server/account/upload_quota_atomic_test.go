package account

// A33 option 1: an upload's daily-quota debit is written by its object's own
// insert transaction (StoredFile.QuotaCharge). These tests pin that contract
// at the store, then every refusal and race around it through the real
// upload routes:
//
//   I1  each committed billable object has exactly one debit of
//       max(size, minBillableBytes); own-node objects have none;
//   I2  no debit exists without its object;
//   I3  the quota check is atomic under concurrency;
//   I4  429 still outranks 507/413; pair-room 410 and the reclaimed-session
//       500 are unchanged;
//   I5  traffic that moved stays metered exactly once;
//   I6  a legitimate debit is removed only by the 24h prune.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- the store contract ------------------------------------------------------

func quotaEventBytes(t *testing.T, st *SQLiteStore, id string) (int64, bool) {
	t.Helper()
	var n int
	var b int64
	if err := st.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM upload_events WHERE id = ?`, id).Scan(&n, &b); err != nil {
		t.Fatal(err)
	}
	return b, n == 1
}

func quotaObjectExists(t *testing.T, st *SQLiteStore, id string) bool {
	t.Helper()
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM stored_files WHERE id = ?`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}

func TestStoredFileQuotaChargeCommitsOrRollsBackWithItsObject(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "charge@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := st.UpsertUserByEmail(ctx, "other@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	const now, since, quota = int64(100_000), int64(100_000 - dayWindow), int64(200_000)
	file := func(id string, size int64, charge *UploadQuotaCharge) StoredFile {
		return StoredFile{ID: id, UserID: u.ID, BlobKey: "blob-" + id, EncManifest: []byte("m"),
			Size: size, CreatedAt: now, ExpiresAt: now + 3600, Purpose: "share", QuotaCharge: charge}
	}
	charge := func(id string, bytes int64) *UploadQuotaCharge {
		return &UploadQuotaCharge{Event: UploadEvent{ID: id, UserID: u.ID, Bytes: bytes, UploadedAt: now}, Since: since, Quota: quota}
	}
	nothingWritten := func(what, objectID, eventID string) {
		t.Helper()
		if quotaObjectExists(t, st, objectID) {
			t.Fatalf("%s: object %s was written", what, objectID)
		}
		if _, ok := quotaEventBytes(t, st, eventID); ok {
			t.Fatalf("%s: debit %s was written", what, eventID)
		}
	}

	// Outside the window: never counted.
	if err := st.RecordUpload(ctx, UploadEvent{ID: "ev-old", UserID: u.ID, Bytes: 1 << 40, UploadedAt: since - 1}); err != nil {
		t.Fatal(err)
	}
	// Admitted: object and debit, exactly as charged.
	if w, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f1", 900, charge("ev1", minBillableBytes)), now, 1<<30, 1<<40); err != nil || w.Reason != "" {
		t.Fatalf("admit: %+v %v", w, err)
	}
	if b, ok := quotaEventBytes(t, st, "ev1"); !ok || b != minBillableBytes || !quotaObjectExists(t, st, "f1") {
		t.Fatalf("admit wrote debit=%v/%d object=%v, want both", ok, b, quotaObjectExists(t, st, "f1"))
	}
	// Over quota: nothing, and the quota answers before either cap would.
	for _, c := range []struct {
		name               string
		userCap, globalCap int64
	}{{"no caps", 0, 0}, {"over the owner cap too", 1, 0}, {"over the disk cap too", 0, 1}} {
		w, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f2", 900, charge("ev2", quota-minBillableBytes+1)), now, c.userCap, c.globalCap)
		if err != nil || w.Reason != "quota" {
			t.Fatalf("over quota, %s: %+v %v, want Reason quota", c.name, w, err)
		}
		nothingWritten("over quota, "+c.name, "f2", "ev2")
	}
	// Exactly at the quota: admitted (the test is used+bytes > quota).
	if w, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f3", 900, charge("ev3", quota-minBillableBytes)), now, 0, 0); err != nil || w.Reason != "" {
		t.Fatalf("exactly at quota: %+v %v", w, err)
	}
	if err := st.RefundUpload(ctx, "ev3"); err != nil { // make room again for the cases below
		t.Fatal(err)
	}
	// A cap refusal under the quota: the debit rolls back with it.
	for _, c := range []struct {
		name, reason       string
		userCap, globalCap int64
	}{{"owner cap", "storage", 1, 0}, {"disk cap", "global", 0, 1}} {
		w, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f4", 900, charge("ev4", minBillableBytes)), now, c.userCap, c.globalCap)
		if err != nil || w.Reason != c.reason {
			t.Fatalf("%s: %+v %v, want Reason %s", c.name, w, err, c.reason)
		}
		nothingWritten(c.name, "f4", "ev4")
	}
	// A failure of the object's own INSERT, after the debit was written in
	// the same transaction: both roll back.
	if _, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f1", 900, charge("ev5", minBillableBytes)), now, 0, 0); err == nil {
		t.Fatal("a duplicate object id was inserted")
	}
	if _, ok := quotaEventBytes(t, st, "ev5"); ok {
		t.Fatal("a failed object insert kept its debit")
	}
	// A debit that cannot be written fails the object too.
	if _, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f6", 900, charge("ev1", minBillableBytes)), now, 0, 0); err == nil {
		t.Fatal("a duplicate debit id was accepted")
	}
	if quotaObjectExists(t, st, "f6") {
		t.Fatal("an object landed without its debit")
	}
	// A reclaimed session refuses the insert and the debit with it.
	f7 := file("f7", 900, charge("ev7", minBillableBytes))
	f7.UploadSessionID = "no-such-session"
	if _, err := st.CreateStoredFileWithinStorageCaps(ctx, f7, now, 0, 0); !errors.Is(err, ErrUploadSessionReclaimed) {
		t.Fatalf("reclaimed session: %v, want ErrUploadSessionReclaimed", err)
	}
	nothingWritten("reclaimed session", "f7", "ev7")
	// Malformed charges are refused before anything is written.
	for _, c := range []struct {
		name string
		q    *UploadQuotaCharge
	}{
		{"another user's debit", &UploadQuotaCharge{Event: UploadEvent{ID: "ev8", UserID: other.ID, Bytes: minBillableBytes, UploadedAt: now}, Since: since, Quota: quota}},
		{"no debit id", &UploadQuotaCharge{Event: UploadEvent{UserID: u.ID, Bytes: minBillableBytes, UploadedAt: now}, Since: since, Quota: quota}},
		{"zero bytes", &UploadQuotaCharge{Event: UploadEvent{ID: "ev8", UserID: u.ID, UploadedAt: now}, Since: since, Quota: quota}},
	} {
		if _, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f8", 900, c.q), now, 0, 0); err == nil {
			t.Fatalf("%s: accepted", c.name)
		}
		nothingWritten(c.name, "f8", "ev8")
	}
	// A non-positive quota admits nothing, as the rolling window always has.
	zero := charge("ev9", minBillableBytes)
	zero.Quota = 0
	if w, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f9", 900, zero), now, 0, 0); err != nil || w.Reason != "quota" {
		t.Fatalf("quota 0: %+v %v, want Reason quota", w, err)
	}
	nothingWritten("quota 0", "f9", "ev9")
	// No charge, no debit.
	if w, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f10", 900, nil), now, 0, 0); err != nil || w.Reason != "" {
		t.Fatalf("uncharged insert: %+v %v", w, err)
	}
	var events int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM upload_events WHERE user_id = ?`, u.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 2 { // ev-old and ev1
		t.Fatalf("%d debits in the ledger, want 2 (the out-of-window seed and ev1)", events)
	}
}

// T6 at the store: a pair-room object whose room closed is refused inside the
// insert's transaction, and the debit that transaction wrote first goes too.
func TestStoredFileQuotaChargeRollsBackWithAClosedPairRoom(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("575757", "")
	status, uploadID, _ := h.initPairUpload(t, "575757", 10, "")
	if status != http.StatusOK {
		t.Fatalf("init: %d", status)
	}
	sess := h.session(t, uploadID)
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)
	f := StoredFile{ID: "f-pair", UserID: h.userID, BlobKey: sess.BlobKey, EncManifest: []byte("m"),
		Size: 10, CreatedAt: h.now, ExpiresAt: h.now + 300, Purpose: StoredPurposePairRoom,
		PairRoomID: sess.PairRoomID, UploadSessionID: sess.ID,
		QuotaCharge: &UploadQuotaCharge{Event: UploadEvent{ID: "ev-pair", UserID: h.userID, Bytes: minBillableBytes, UploadedAt: h.now},
			Since: h.now - dayWindow, Quota: 64 << 20}}
	if _, err := h.store.CreateStoredFileWithinStorageCaps(ctx, f, h.now, 1<<30, 1<<40); !errors.Is(err, ErrPairRoomClosed) {
		t.Fatalf("closed room: %v, want ErrPairRoomClosed", err)
	}
	if n := dailyEvents(t, h); n != 0 {
		t.Fatalf("the refused pair-room insert kept %d debit(s)", n)
	}
}

// I3 at the store: concurrent charged inserts on a file-backed database, from
// independent goroutines, against a quota that fits exactly five.
func TestStoredFileQuotaChargeIsAtomicUnderConcurrency(t *testing.T) {
	st, err := OpenSQLite(filepath.Join(t.TempDir(), "relayium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "race@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	const n, fits = 32, 5
	now := time.Now().Unix()
	var wg sync.WaitGroup
	var mu sync.Mutex
	admitted, refused := 0, 0
	var errs []error
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			f := StoredFile{ID: fmt.Sprintf("f%d", i), UserID: u.ID, BlobKey: fmt.Sprintf("b%d", i), EncManifest: []byte("m"),
				Size: 10, CreatedAt: now, ExpiresAt: now + 3600, Purpose: "share",
				QuotaCharge: &UploadQuotaCharge{Event: UploadEvent{ID: fmt.Sprintf("e%d", i), UserID: u.ID, Bytes: minBillableBytes, UploadedAt: now},
					Since: now - dayWindow, Quota: fits * minBillableBytes}}
			w, err := st.CreateStoredFileWithinStorageCaps(ctx, f, now, 1<<30, 1<<40)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err != nil:
				errs = append(errs, err)
			case w.Reason == "quota":
				refused++
			case w.Reason == "":
				admitted++
			}
		}(i)
	}
	wg.Wait()
	l := quotaLedgerOf(t, st, u.ID, t.TempDir())
	t.Logf("admitted=%d refused=%d errs=%v ledger=%+v", admitted, refused, errs, l)
	if len(errs) != 0 || admitted != fits || refused != n-fits {
		t.Fatalf("admitted %d, refused %d, errors %v; want %d, %d, none", admitted, refused, errs, fits, n-fits)
	}
	if l.Events != fits || l.Files != fits || l.EventBytes != fits*minBillableBytes {
		t.Fatalf("ledger %+v, want %d debits for %d objects", l, fits, fits)
	}
}

// ---- through the upload routes ----------------------------------------------

// The debit is max(size, minBillableBytes): the floor below it, the size above.
func TestUploadQuotaDebitIsTheFlooredObjectSize(t *testing.T) {
	for _, route := range []string{"single", "finalize"} {
		for _, size := range []int{900, int(minBillableBytes) + 4000} {
			t.Run(fmt.Sprintf("%s/%d", route, size), func(t *testing.T) {
				h := newQuotaHarness(t, quotaOpts{})
				path, body := h.route(route, size)
				if code, m := h.do("POST", path, body); code != http.StatusOK {
					t.Fatalf("upload: %d %v", code, m)
				}
				l := h.assertOneDebitPerObject("one upload")
				want := int64(size)
				if want < minBillableBytes {
					want = minBillableBytes
				}
				if l.Files != 1 || l.EventBytes != want || l.Meter != int64(size) {
					t.Fatalf("ledger %+v, want one object, a %d-byte debit and %d bytes of traffic", l, want, size)
				}
				h.assertNoLegacyLedgerCalls()
			})
		}
	}
}

// T3. A legitimate cap refusal decided inside the insert (the cap was filled
// by another writer between the pre-check and the insert): 507/413, no debit,
// and nothing is refunded because nothing was charged.
func TestUploadQuotaCapRefusalAtTheInsertWritesNoDebit(t *testing.T) {
	for _, route := range []string{"single", "finalize"} {
		for _, gate := range []string{"storage", "global"} {
			t.Run(route+"/"+gate, func(t *testing.T) {
				h := newQuotaHarness(t, quotaOpts{})
				ctx := context.Background()
				const diskCap = 50 << 20
				if gate == "global" {
					if err := h.store.SetSetting(ctx, SettingStorageDiskCap, diskCap, time.Now().Unix()); err != nil {
						t.Fatal(err)
					}
				}
				filler := StoredFile{ID: "filler", BlobKey: "filler-blob", EncManifest: []byte("m"),
					CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 86400, Purpose: "share"}
				switch gate {
				case "storage": // the owner's own plan cap (Free: 100 MiB)
					filler.UserID, filler.Size = h.userID, freePlanFallback().StorageBytes
				case "global": // another account fills the disk cap
					o, err := h.store.UpsertUserByEmail(ctx, "filler@example.com", "")
					if err != nil {
						t.Fatal(err)
					}
					filler.UserID, filler.Size = o.ID, diskCap
				}
				path, body := h.route(route, 900)
				h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
					if p == qpPersistBefore {
						if err := h.store.CreateStoredFile(context.Background(), filler); err != nil {
							t.Errorf("filler: %v", err)
						}
					}
				})
				code, _ := h.do("POST", path, body)
				h.hook.setOnPoint(nil)
				want := map[string]int{"storage": http.StatusRequestEntityTooLarge, "global": http.StatusInsufficientStorage}[gate]
				if code != want {
					t.Fatalf("answered %d, want %d", code, want)
				}
				if r := h.hook.refusals(); len(r) != 1 || r[0] != gate {
					t.Fatalf("insert refusals %v, want [%s]", r, gate)
				}
				if _, err := h.store.db.Exec(`DELETE FROM stored_files WHERE id = 'filler'`); err != nil {
					t.Fatal(err)
				}
				l := h.assertOneDebitPerObject("after a cap refusal at the insert")
				if l.Events != 0 || l.CentralBlobs != 0 || l.Meter != 900 {
					t.Fatalf("ledger %+v, want no debit, no blob, 900 bytes of traffic", l)
				}
				if route == "finalize" && l.DoneSessions != 1 {
					t.Fatalf("the refused finalize left %d tombstone(s), want 1", l.DoneSessions)
				}
				h.assertNoLegacyLedgerCalls()
			})
		}
	}
}

// T5. The daily quota itself refuses inside the insert — another upload's
// debit landed between this one's pre-check and its insert. 429, the blob is
// dropped, a finalize keeps its tombstone, and the traffic stays metered.
func TestUploadQuotaRefusedAtTheInsertDropsTheBlobAndKeepsTheTombstone(t *testing.T) {
	for _, route := range []string{"single", "finalize"} {
		t.Run(route, func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{dailyQuota: oneUploadQuota})
			path, body := h.route(route, 900)
			h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
				if p == qpPersistBefore {
					if err := h.store.RecordUpload(context.Background(),
						UploadEvent{ID: "concurrent", UserID: h.userID, Bytes: minBillableBytes, UploadedAt: time.Now().Unix()}); err != nil {
						t.Errorf("concurrent debit: %v", err)
					}
				}
			})
			code, _ := h.do("POST", path, body)
			h.hook.setOnPoint(nil)
			if code != http.StatusTooManyRequests {
				t.Fatalf("answered %d, want 429", code)
			}
			if r := h.hook.refusals(); len(r) != 1 || r[0] != "quota" {
				t.Fatalf("insert refusals %v, want [quota]", r)
			}
			l := h.ledger()
			t.Logf("after the refusal: %+v", l)
			if l.Events != 1 || l.EventBytes != minBillableBytes || l.Files != 0 || l.CentralBlobs != 0 || l.Meter != 900 {
				t.Fatalf("ledger %+v, want only the concurrent debit, no object, no blob, 900 bytes of traffic", l)
			}
			if _, ok := quotaEventBytes(t, h.store, "concurrent"); !ok {
				t.Fatal("the concurrent upload's debit was touched")
			}
			if route == "finalize" {
				if l.DoneSessions != 1 {
					t.Fatalf("tombstones %d, want 1", l.DoneSessions)
				}
				if rc, _ := h.do("POST", path, nil); rc != http.StatusConflict {
					t.Fatalf("a retried finalize answered %d, want 409", rc)
				}
				if l2 := h.ledger(); l2 != l {
					t.Fatalf("the retried finalize changed the ledger: %+v -> %+v", l, l2)
				}
			}
			h.assertNoLegacyLedgerCalls()
		})
	}
}

// I4. Over the daily quota AND over a cap at the insert: the quota answers,
// as it did when it was a separate reservation decided first.
func TestUploadQuotaRefusalOutranksTheCapsAtTheInsert(t *testing.T) {
	for _, route := range []string{"single", "finalize"} {
		t.Run(route, func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{dailyQuota: oneUploadQuota})
			path, body := h.route(route, 900)
			h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
				if p != qpPersistBefore {
					return
				}
				now := time.Now().Unix()
				if err := h.store.RecordUpload(context.Background(),
					UploadEvent{ID: "concurrent", UserID: h.userID, Bytes: minBillableBytes, UploadedAt: now}); err != nil {
					t.Errorf("concurrent debit: %v", err)
				}
				if err := h.store.CreateStoredFile(context.Background(), StoredFile{ID: "filler", UserID: h.userID,
					BlobKey: "filler-blob", EncManifest: []byte("m"), Size: freePlanFallback().StorageBytes,
					CreatedAt: now, ExpiresAt: now + 86400, Purpose: "share"}); err != nil {
					t.Errorf("filler: %v", err)
				}
			})
			code, _ := h.do("POST", path, body)
			h.hook.setOnPoint(nil)
			if code != http.StatusTooManyRequests {
				t.Fatalf("over the quota and the storage cap: %d, want 429", code)
			}
			if r := h.hook.refusals(); len(r) != 1 || r[0] != "quota" {
				t.Fatalf("insert refusals %v, want [quota]", r)
			}
			h.assertNoLegacyLedgerCalls()
		})
	}
}

// T4 (adversarial: early grant / double charge / lost credit). Sixteen
// concurrent uploads, single-shot and finalize mixed, against a quota that
// fits exactly three. Exactly three objects and three debits; every refusal
// leaves nothing.
func TestUploadQuotaConcurrentMixAdmitsExactlyWhatFits(t *testing.T) {
	const fits, total, finalizes = 3, 16, 5 // 5 = maxSessionsPerUser
	h := newQuotaHarness(t, quotaOpts{dailyQuota: fits*minBillableBytes + 100})
	h.svc.uploadSem = newUploadSem(64)
	paths := make([]string, 0, total)
	bodies := make([][]byte, 0, total)
	for i := 0; i < finalizes; i++ {
		p, b := h.route("finalize", 900)
		paths, bodies = append(paths, p), append(bodies, b)
	}
	for len(paths) < total {
		p, b := h.route("single", 900)
		paths, bodies = append(paths, p), append(bodies, b)
	}
	before := h.ledger()
	// Hold every request at its insert until all sixteen are there, so the
	// pre-checks (which read no uncommitted debit) admit them all and the
	// decision is left entirely to the insert transactions racing each other.
	var arrivedMu sync.Mutex
	arrived := 0
	allThere := make(chan struct{})
	h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
		if p != qpPersistBefore {
			return
		}
		arrivedMu.Lock()
		arrived++
		if arrived == total {
			close(allThere)
		}
		arrivedMu.Unlock()
		select {
		case <-allThere:
		case <-time.After(10 * time.Second):
		}
	})
	var wg sync.WaitGroup
	start := make(chan struct{})
	codes := make(chan int, total)
	for i := range paths {
		conn, req := h.rawSend("POST", paths[i], bodies[i], nil)
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer conn.Close()
			<-start
			c, _, err := quotaReadResp(conn, req)
			if err != nil {
				c = -1
			}
			codes <- c
		}()
	}
	close(start)
	wg.Wait()
	close(codes)
	got := map[int]int{}
	for c := range codes {
		got[c]++
	}
	h.hook.setOnPoint(nil)
	arrivedMu.Lock()
	t.Logf("codes: %v; requests that reached the insert together: %d", got, arrived)
	if arrived != total {
		arrivedMu.Unlock()
		t.Fatalf("%d of %d requests reached the insert: the race was not staged", arrived, total)
	}
	arrivedMu.Unlock()
	if got[http.StatusOK] != fits || got[http.StatusTooManyRequests] != total-fits {
		t.Fatalf("codes %v, want %d×200 and %d×429", got, fits, total-fits)
	}
	// Wait for every handler to have finished its detached work.
	deadline := time.Now().Add(10 * time.Second)
	for h.ledger().Meter != before.Meter+int64(total-finalizes)*900 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	l := h.assertOneDebitPerObject("after 16 concurrent uploads")
	if l.Files != fits || l.CentralBlobs != fits {
		t.Fatalf("ledger %+v, want %d objects and %d blobs", l, fits, fits)
	}
	// Traffic: every single-shot's bytes moved and are metered once; the
	// sessions' were metered when they were appended.
	if l.Meter != int64(total)*900 {
		t.Fatalf("meter %d, want %d", l.Meter, total*900)
	}
	h.assertNoLegacyLedgerCalls()
}

// Two finalizes of one session at once: one object, one debit, and 409 for
// the loser.
func TestUploadQuotaRacingFinalizesChargeOnce(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	path, _ := h.route("finalize", 900)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		conn, req := h.rawSend("POST", path, nil, nil)
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer conn.Close()
			c, _, _ := quotaReadResp(conn, req)
			codes <- c
		}()
	}
	wg.Wait()
	close(codes)
	got := map[int]int{}
	for c := range codes {
		got[c]++
	}
	if got[http.StatusOK] != 1 || got[http.StatusConflict] != 1 {
		t.Fatalf("codes %v, want one 200 and one 409", got)
	}
	if l := h.assertOneDebitPerObject("after racing finalizes"); l.Files != 1 {
		t.Fatalf("ledger %+v, want one object", l)
	}
	h.assertNoLegacyLedgerCalls()
}

// The caller hangs up (a real socket close) right after the insert committed:
// the object is real, so it keeps its debit (I6).
func TestUploadQuotaHangupAfterTheInsertKeepsObjectAndDebit(t *testing.T) {
	for _, route := range []string{"single", "finalize"} {
		t.Run(route, func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{})
			path, body := h.route(route, 900)
			d, cancelled := h.closeAt(qpPersistAfter, "POST", path, body)
			t.Logf("handler finished %d; context cancelled at the point: %v", d.code, cancelled)
			if !cancelled {
				t.Fatal("net/http never cancelled the request: the hangup was not staged")
			}
			if l := h.assertOneDebitPerObject("after a hangup past the insert"); l.Files != 1 || l.Meter != 900 {
				t.Fatalf("ledger %+v, want the object, its debit and 900 bytes of traffic", l)
			}
			h.assertNoLegacyLedgerCalls()
		})
	}
}

// T7. The W-N36 orderings. Cleanup first: the reaper claims the finalizing
// session before the insert, the insert is refused as reclaimed (500), and
// no debit is left. Finalize first: the object and its debit survive every
// later cleanup pass.
func TestUploadQuotaCleanupOrderings(t *testing.T) {
	t.Run("cleanup first", func(t *testing.T) {
		h := newQuotaHarness(t, quotaOpts{})
		path, _ := h.route("finalize", 900)
		h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
			if p == qpPersistBefore {
				h.svc.ReapPendingUploads(time.Now().Unix() + pendingUploadTTL + 60)
			}
		})
		code, _ := h.do("POST", path, nil)
		h.hook.setOnPoint(nil)
		errs := h.hook.persistErrors()
		if code != http.StatusInternalServerError || len(errs) != 1 || !errors.Is(errs[0], ErrUploadSessionReclaimed) {
			t.Fatalf("answered %d with insert errors %v, want 500 and ErrUploadSessionReclaimed", code, errs)
		}
		if l := h.assertOneDebitPerObject("cleanup first"); l.Events != 0 || l.Meter != 900 {
			t.Fatalf("ledger %+v, want no debit and the 900 appended bytes metered", l)
		}
		h.assertNoLegacyLedgerCalls()
	})
	t.Run("finalize first", func(t *testing.T) {
		h := newQuotaHarness(t, quotaOpts{})
		path, _ := h.route("finalize", 900)
		if code, _ := h.do("POST", path, nil); code != http.StatusOK {
			t.Fatalf("finalize: %d", code)
		}
		start := time.Now().Unix()
		h.runGC(start + pendingUploadTTL + 60)
		h.runGC(start + pendingUploadTTL + 120)
		if l := h.assertOneDebitPerObject("finalize first, after cleanup passes"); l.Files != 1 || l.CentralBlobs != 1 {
			t.Fatalf("ledger %+v, want the object, its blob and its debit", l)
		}
		h.assertNoLegacyLedgerCalls()
	})
}

// T8. An account deletion racing a finalize. Purge first: the insert finds
// its session gone and is refused with no debit. Finalize first: the purge
// removes the object; its debit — a real upload's — stays like any deleted
// object's does, and the hard purge removes it with the account.
func TestUploadQuotaAccountPurgeRacingAFinalize(t *testing.T) {
	t.Run("purge first", func(t *testing.T) {
		h := newQuotaHarness(t, quotaOpts{})
		path, _ := h.route("finalize", 900)
		h.hook.setOnPoint(func(p quotaPoint, ctx context.Context) {
			if p == qpPersistBefore {
				if _, err := h.store.PurgeTransientUserData(context.Background(), h.userID); err != nil {
					t.Errorf("purge: %v", err)
				}
			}
		})
		code, _ := h.do("POST", path, nil)
		h.hook.setOnPoint(nil)
		if code != http.StatusInternalServerError {
			t.Fatalf("finalize after the purge: %d, want 500", code)
		}
		if l := h.assertOneDebitPerObject("purge first"); l.Events != 0 || l.Files != 0 {
			t.Fatalf("ledger %+v, want nothing left for the purged account", l)
		}
		h.assertNoLegacyLedgerCalls()
	})
	t.Run("finalize first", func(t *testing.T) {
		h := newQuotaHarness(t, quotaOpts{})
		path, _ := h.route("finalize", 900)
		h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
			if p == qpPersistAfter {
				if _, err := h.store.PurgeTransientUserData(context.Background(), h.userID); err != nil {
					t.Errorf("purge: %v", err)
				}
			}
		})
		code, _ := h.do("POST", path, nil)
		h.hook.setOnPoint(nil)
		l := h.ledger()
		t.Logf("finalize answered %d; after the purge: %+v", code, l)
		if l.Files != 0 || l.Events != 1 || l.EventBytes != minBillableBytes {
			t.Fatalf("ledger %+v, want the object purged and its one debit kept", l)
		}
		// The hard purge only runs for an account whose grace period is over.
		if _, err := h.store.db.Exec(`UPDATE users SET purge_after = 1 WHERE id = ?`, h.userID); err != nil {
			t.Fatal(err)
		}
		if err := h.store.ArchiveAndPurgeUser(context.Background(), h.userID, time.Now().Unix()); err != nil {
			t.Fatalf("hard purge: %v", err)
		}
		if l := h.ledger(); l.Events != 0 || l.Files != 0 {
			t.Fatalf("after the hard purge: %+v, want nothing", l)
		}
		h.assertNoLegacyLedgerCalls()
	})
}

// T9. Own-node uploads carry no charge: a finalize onto the user's own node
// writes no debit.
func TestUploadQuotaOwnNodeFinalizeWritesNoDebit(t *testing.T) {
	h := newPairHarness(t)
	node := newCleanupNode(t)
	h.registerOwnStorageNode(t, node.URL)
	uploadID, _ := cleanupUpload(t, h, 700)
	if h.session(t, uploadID).NodeID == "" {
		t.Fatal("the upload was not placed on the user's own node")
	}
	if code, id := h.finalize(t, uploadID); code != http.StatusOK || id == "" {
		t.Fatalf("finalize: %d %q", code, id)
	}
	if n := dailyEvents(t, h); n != 0 {
		t.Fatalf("an own-node finalize wrote %d debit(s)", n)
	}
}

// The uncapped door cannot carry a debit: persistStoredFile refuses a charge
// with enforceCaps=false rather than let CreateStoredFile drop it and admit a
// free object.
func TestPersistStoredFileRefusesAChargeOnTheUncappedDoor(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	now := time.Now().Unix()
	f := StoredFile{ID: "f-uncapped", UserID: h.userID, BlobKey: "b", EncManifest: []byte("m"), Size: 10,
		CreatedAt: now, ExpiresAt: now + 3600, Purpose: "share",
		QuotaCharge: &UploadQuotaCharge{Event: UploadEvent{ID: "e", UserID: h.userID, Bytes: minBillableBytes, UploadedAt: now},
			Since: now - dayWindow, Quota: 1 << 30}}
	if _, err := h.svc.persistStoredFile(context.Background(), f, false); err == nil || !strings.Contains(err.Error(), "capped insert") {
		t.Fatalf("uncapped persist with a charge: %v, want a refusal", err)
	}
	if l := h.ledger(); l.Files != 0 || l.Events != 0 {
		t.Fatalf("ledger %+v, want nothing written", l)
	}
	// And the capped door with the same charge lands both.
	if w, err := h.svc.persistStoredFile(context.Background(), f, true); err != nil || w.Reason != "" {
		t.Fatalf("capped persist: %+v %v", w, err)
	}
	h.assertOneDebitPerObject("capped persist")
}
