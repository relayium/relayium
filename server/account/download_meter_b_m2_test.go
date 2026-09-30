package account

// B-M2: download egress must not be silently lost when the meter write is
// refused, and the fix must not bill the same bytes twice.
//
// Faults are injected at the exact statement with SQLite triggers (the meter's
// usage_monthly UPSERT, the unbilled_meter INSERT), so the production code runs
// unmodified. The double-count case uses the driver's commit hook to cancel the
// caller's context after the increment has committed but before the statement
// returns — the real modernc.org/sqlite behaviour that makes a naive
// "RecordMeter(ctx) failed, so enqueue the bytes" fix bill twice.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"modernc.org/sqlite"

	"github.com/relayium/relayium/internal/inbox"
)

// failDownloadIncrement makes every usage_monthly write that would move
// download_bytes abort, on both halves of the meter's UPSERT. Upload metering
// is unaffected. The returned func removes the fault.
func failDownloadIncrement(t *testing.T, s *SQLiteStore) func() {
	t.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`CREATE TRIGGER b_m2_fail_dl_ins BEFORE INSERT ON usage_monthly
		   WHEN NEW.download_bytes <> 0 BEGIN SELECT RAISE(ABORT, 'b_m2 injected meter failure'); END`,
		`CREATE TRIGGER b_m2_fail_dl_upd BEFORE UPDATE ON usage_monthly
		   WHEN NEW.download_bytes <> OLD.download_bytes BEGIN SELECT RAISE(ABORT, 'b_m2 injected meter failure'); END`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			t.Fatalf("install meter fault: %v", err)
		}
	}
	return func() {
		for _, q := range []string{`DROP TRIGGER IF EXISTS b_m2_fail_dl_ins`, `DROP TRIGGER IF EXISTS b_m2_fail_dl_upd`} {
			if _, err := s.db.ExecContext(ctx, q); err != nil {
				t.Fatalf("remove meter fault: %v", err)
			}
		}
	}
}

func failOutbox(t *testing.T, s *SQLiteStore) {
	t.Helper()
	if _, err := s.db.ExecContext(context.Background(),
		`CREATE TRIGGER b_m2_fail_outbox BEFORE INSERT ON unbilled_meter
		   BEGIN SELECT RAISE(ABORT, 'b_m2 injected outbox failure'); END`); err != nil {
		t.Fatalf("install outbox fault: %v", err)
	}
}

type owedRow struct {
	userID string
	kind   UsageKind
	bytes  int64
	reason string
}

func owedRows(t *testing.T, s *SQLiteStore) []owedRow {
	t.Helper()
	rows, err := s.db.QueryContext(context.Background(),
		`SELECT user_id, kind, bytes, reason FROM unbilled_meter ORDER BY at, id`)
	if err != nil {
		t.Fatalf("read unbilled_meter: %v", err)
	}
	defer rows.Close()
	var out []owedRow
	for rows.Next() {
		var r owedRow
		var k int
		if err := rows.Scan(&r.userID, &k, &r.bytes, &r.reason); err != nil {
			t.Fatalf("scan unbilled_meter: %v", err)
		}
		r.kind = UsageKind(k)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func downloadMeter(t *testing.T, s *SQLiteStore, userID string, at int64) int64 {
	t.Helper()
	_, d, err := s.MonthlyUsage(context.Background(), userID, periodOf(at))
	if err != nil {
		t.Fatalf("MonthlyUsage: %v", err)
	}
	return d
}

// assertOwedOnceThenSettledOnce is the shared "exactly N, once" property: one
// owed row of N download bytes, nothing on the meter yet; one settle moves N
// onto the meter; a second settle moves nothing.
func assertOwedOnceThenSettledOnce(t *testing.T, s *SQLiteStore, userID string, before, n, at int64) {
	t.Helper()
	owed := owedRows(t, s)
	if len(owed) != 1 {
		t.Fatalf("owed rows = %+v, want exactly one row of %d download bytes (the bytes were lost or journaled twice)", owed, n)
	}
	if o := owed[0]; o.userID != userID || o.kind != MeterDownload || o.bytes != n || o.reason != downloadMeterFailedReason {
		t.Fatalf("owed row = %+v, want user=%s kind=download bytes=%d reason=%s", o, userID, n, downloadMeterFailedReason)
	}
	if d := downloadMeter(t, s, userID, at); d != before {
		t.Fatalf("meter moved to %d while its increment was refused, want %d", d, before)
	}
	ctx := context.Background()
	if settled, err := s.SettleUnbilledMeter(ctx, 100); err != nil || settled != 1 {
		t.Fatalf("settle = (%d, %v), want (1, nil)", settled, err)
	}
	if d := downloadMeter(t, s, userID, at); d != before+n {
		t.Fatalf("after settle download meter = %d, want %d (exactly N once)", d, before+n)
	}
	if settled, err := s.SettleUnbilledMeter(ctx, 100); err != nil || settled != 0 {
		t.Fatalf("second settle = (%d, %v), want (0, nil)", settled, err)
	}
	if d := downloadMeter(t, s, userID, at); d != before+n {
		t.Fatalf("second settle moved the meter to %d, want %d", d, before+n)
	}
	if left := owedRows(t, s); len(left) != 0 {
		t.Fatalf("owed rows after settle = %+v, want none", left)
	}
}

func TestB_M2_MeterDownloadMetersOnTheHappyPath(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "bm2-happy@example.test", "")
	at := time.Now().Unix()
	if err := s.MeterDownload(ctx, u.ID, 700, at); err != nil {
		t.Fatalf("MeterDownload: %v", err)
	}
	if d := downloadMeter(t, s, u.ID, at); d != 700 {
		t.Fatalf("download meter = %d, want 700", d)
	}
	if owed := owedRows(t, s); len(owed) != 0 {
		t.Fatalf("a successful meter left owed rows %+v", owed)
	}
}

func TestB_M2_RefusedDownloadIncrementIsOwedOnceAndSettledOnce(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "bm2-owed@example.test", "")
	at := time.Now().Unix()
	// A prior successful bill, so settle must ADD to an existing row.
	if err := s.MeterDownload(ctx, u.ID, 11, at); err != nil {
		t.Fatal(err)
	}
	heal := failDownloadIncrement(t, s)
	if err := s.MeterDownload(ctx, u.ID, 4096, at); err != nil {
		t.Fatalf("MeterDownload with a refused increment must journal the bytes and succeed, got %v", err)
	}
	heal()
	assertOwedOnceThenSettledOnce(t, s, u.ID, 11, 4096, at)
}

func TestB_M2_BothWritesRefusedReportsTheLoss(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "bm2-lost@example.test", "")
	at := time.Now().Unix()
	failDownloadIncrement(t, s)
	failOutbox(t, s)
	if err := s.MeterDownload(ctx, u.ID, 99, at); err == nil {
		t.Fatal("MeterDownload returned nil although the bytes are neither metered nor owed")
	}
	if d := downloadMeter(t, s, u.ID, at); d != 0 {
		t.Fatalf("download meter = %d, want 0", d)
	}
	if owed := owedRows(t, s); len(owed) != 0 {
		t.Fatalf("owed rows = %+v, want none", owed)
	}
}

func TestB_M2_UnacquiredConnectionWritesNothingAndReportsIt(t *testing.T) {
	s := newTestStore(t)
	u, _ := s.UpsertUserByEmail(context.Background(), "bm2-noconn@example.test", "")
	at := time.Now().Unix()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.MeterDownload(ctx, u.ID, 5, at); err == nil {
		t.Fatal("MeterDownload with a dead context must report that nothing was written")
	}
	if d := downloadMeter(t, s, u.ID, at); d != 0 {
		t.Fatalf("download meter = %d, want 0", d)
	}
	if owed := owedRows(t, s); len(owed) != 0 {
		t.Fatalf("owed rows = %+v, want none", owed)
	}
}

// armCancelOnCommit registers a commit hook on the store's single connection
// that, once armed, cancels `cancel` from INSIDE the committing statement and
// then gives the driver's interrupt watcher time to observe it. The commit
// itself proceeds (the hook returns 0), so the write is durable while the
// statement is still running — exactly a deadline landing at the end of a
// successful write.
func armCancelOnCommit(t *testing.T, s *SQLiteStore) (arm func(context.CancelFunc), fired func() bool) {
	t.Helper()
	var mu sync.Mutex
	var pending context.CancelFunc
	var count atomic.Int32
	conn, err := s.db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	register := func(fn sqlite.CommitHookFn) {
		if err := conn.Raw(func(dc any) error {
			hr, ok := dc.(sqlite.HookRegisterer)
			if !ok {
				return errors.New("driver connection does not register hooks")
			}
			hr.RegisterCommitHook(fn)
			return nil
		}); err != nil {
			t.Fatalf("register commit hook: %v", err)
		}
	}
	register(func() int32 {
		mu.Lock()
		c := pending
		pending = nil
		mu.Unlock()
		if c != nil {
			c()
			count.Add(1)
			time.Sleep(200 * time.Millisecond)
		}
		return 0
	})
	conn.Close() // back to the pool; MaxOpenConns(1) keeps it the only connection
	t.Cleanup(func() {
		c, err := s.db.Conn(context.Background())
		if err != nil {
			return
		}
		defer c.Close()
		_ = c.Raw(func(dc any) error {
			if hr, ok := dc.(sqlite.HookRegisterer); ok {
				hr.RegisterCommitHook(nil)
			}
			return nil
		})
	})
	return func(c context.CancelFunc) {
			mu.Lock()
			pending = c
			mu.Unlock()
		}, func() bool {
			return count.Load() > 0
		}
}

// The driver fact the design rests on: a statement whose context is cancelled
// after it committed reports the cancellation anyway. If this ever stops being
// true the guard below is still correct, but this pins why it exists.
func TestB_M2_DriverReportsCancellationForACommittedWrite(t *testing.T) {
	s := newTestStore(t)
	u, _ := s.UpsertUserByEmail(context.Background(), "bm2-driver@example.test", "")
	at := time.Now().Unix()
	arm, fired := armCancelOnCommit(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	arm(cancel)
	err := s.RecordMeter(ctx, u.ID, MeterDownload, 300, at)
	if !fired() {
		t.Fatal("commit hook did not fire; the harness is not exercising the case")
	}
	if d := downloadMeter(t, s, u.ID, at); d != 300 {
		t.Fatalf("download meter = %d, want the committed 300", d)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("RecordMeter err = %v; the driver no longer reports a cancellation for a committed write", err)
	}
}

// The double-count guard: the caller's context dies after the increment has
// committed. The bytes must be on the meter exactly once and must NOT also be
// journaled as owed (which GC would later settle into a second charge).
func TestB_M2_CommittedIncrementIsNotReJournaledWhenTheCallerContextFires(t *testing.T) {
	s := newTestStore(t)
	u, _ := s.UpsertUserByEmail(context.Background(), "bm2-double@example.test", "")
	at := time.Now().Unix()
	arm, fired := armCancelOnCommit(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	arm(cancel)
	err := s.MeterDownload(ctx, u.ID, 512, at)
	if !fired() {
		t.Fatal("commit hook did not fire; the harness is not exercising the case")
	}
	if err != nil {
		t.Fatalf("MeterDownload = %v, want nil: the increment committed", err)
	}
	if owed := owedRows(t, s); len(owed) != 0 {
		t.Fatalf("a committed increment was ALSO journaled as owed %+v — GC would bill these bytes twice", owed)
	}
	if _, err := s.SettleUnbilledMeter(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	if d := downloadMeter(t, s, u.ID, at); d != 512 {
		t.Fatalf("download meter = %d after settle, want exactly 512 once", d)
	}
}

// downloadAll reads the whole response. The test blobs are far below the
// server's response buffer, so the client sees the body only once the handler
// has returned — after its metering has run.
func downloadAll(t *testing.T, client *http.Client, url string) int64 {
	t.Helper()
	resp, err := client.Get(url)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer resp.Body.Close()
	n, _ := io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d", resp.StatusCode)
	}
	return n
}

// Through the real stored-link handler: a refused meter write leaves the
// served bytes owed exactly once, settled exactly once.
func TestB_M2_StoredLinkDownloadWithARefusedMeterIsOwedAndSettledOnce(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	ctx := context.Background()
	cookie := loginCookie(t, ts, mail, "bm2-link@example.test")
	blob := bytes.Repeat([]byte("q"), 321)
	resp := postUpload(t, ts, cookie, "?burnAfterRead=0&ttl=3600", uploadBody([]byte("m"), blob))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)
	owner, _ := store.UpsertUserByEmail(ctx, "bm2-link@example.test", "")
	at := svc.now().Unix()

	heal := failDownloadIncrement(t, store)
	if n := downloadAll(t, ts.Client(), ts.URL+"/api/files/"+up.ID+"/blob"); n != int64(len(blob)) {
		t.Fatalf("served %d bytes, want %d", n, len(blob))
	}
	heal()
	assertOwedOnceThenSettledOnce(t, store, owner.ID, 0, int64(len(blob)), at)
	// Statistics stay best-effort and independent of the bill.
	if st, err := store.GetUserStats(ctx, owner.ID); err != nil || st.DownloadBytes != int64(len(blob)) {
		t.Fatalf("download stat = (%+v, %v), want %d bytes", st, err, len(blob))
	}
}

// When neither the meter nor the outbox accepts the bill, the handler logs
// who and how much — and nothing that identifies the file.
func TestB_M2_StoredLinkDownloadLogsALostBillWithoutFileIdentity(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	ctx := context.Background()
	cookie := loginCookie(t, ts, mail, "bm2-loglost@example.test")
	blob := bytes.Repeat([]byte("w"), 77)
	resp := postUpload(t, ts, cookie, "?burnAfterRead=0&ttl=3600", uploadBody([]byte("m"), blob))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)
	owner, _ := store.UpsertUserByEmail(ctx, "bm2-loglost@example.test", "")
	sf, err := store.GetStoredFile(ctx, up.ID)
	if err != nil {
		t.Fatal(err)
	}

	failDownloadIncrement(t, store)
	failOutbox(t, store)
	logs := captureLog(t, func() {
		downloadAll(t, ts.Client(), ts.URL+"/api/files/"+up.ID+"/blob")
	})

	var line string
	for _, l := range strings.Split(logs, "\n") {
		if strings.Contains(l, "UNSETTLED BILL: download:") && strings.Contains(l, owner.ID) {
			line = l
		}
	}
	if line == "" {
		t.Fatalf("no UNSETTLED BILL line for user %s in log:\n%s", owner.ID, logs)
	}
	if !strings.Contains(line, "77 bytes") {
		t.Fatalf("loss line does not carry the byte count: %q", line)
	}
	if strings.Contains(line, up.ID) || strings.Contains(line, sf.BlobKey) {
		t.Fatalf("loss line leaks file identity: %q", line)
	}
}

// Through the real Device Inbox task blob handler: the same property.
func TestB_M2_InboxTaskDownloadWithARefusedMeterIsOwedAndSettledOnce(t *testing.T) {
	h := newTaskObjectHarness(t)
	uid := h.user(t, "bm2-inbox@example.test")
	tg := h.enrolTarget(t, uid, "server", inbox.AutoAcceptAuto, true)
	payload := bytes.Repeat([]byte("c"), 333)
	_, task := h.bindTask(t, tg, "bm2-send", payload)
	blobPath := "/api/devices/" + tg.deviceID + "/inbox/tasks/" + task["ID"].(string) + "/blob"
	_, claim := h.claimOne(t, tg)
	at := h.svc.now().Unix()
	before := downloadMeter(t, h.store, uid, at)

	heal := failDownloadIncrement(t, h.store)
	resp := h.do(t, "GET", blobPath, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+tg.token)
		r.Header.Set("X-Relayium-Inbox-Claim", claim)
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claim-holder blob read: got %d, want 200", resp.StatusCode)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !bytes.Equal(got, payload) {
		t.Fatalf("streamed %d bytes, want %d", len(got), len(payload))
	}
	heal()
	assertOwedOnceThenSettledOnce(t, h.store, uid, before, int64(len(payload)), at)
}

// slowStatsStore makes the statistics write spend its whole context — it
// blocks until that context is done — and records the context the bill then
// arrives with. The bill must not inherit the spent statistics budget.
type slowStatsStore struct {
	Store
	mu        sync.Mutex
	statsRuns int
	meterRuns int
	liveMeter int // MeterDownload calls whose ctx was still live on entry
	metered   int64
}

func (s *slowStatsStore) AddDownloadStat(ctx context.Context, userID string, bytes int64) error {
	<-ctx.Done()
	s.mu.Lock()
	s.statsRuns++
	s.mu.Unlock()
	return s.Store.AddDownloadStat(context.WithoutCancel(ctx), userID, bytes)
}

func (s *slowStatsStore) MeterDownload(ctx context.Context, userID string, bytes, at int64) error {
	s.mu.Lock()
	s.meterRuns++
	if ctx.Err() == nil {
		s.liveMeter++
	}
	s.metered += bytes
	s.mu.Unlock()
	return s.Store.MeterDownload(ctx, userID, bytes, at)
}

func (s *slowStatsStore) check(t *testing.T, raw *SQLiteStore, userID string, before, n, at int64) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.statsRuns != 1 {
		t.Fatalf("AddDownloadStat ran %d times, want 1 (the harness did not exhaust the stats budget)", s.statsRuns)
	}
	if s.meterRuns != 1 || s.metered != n {
		t.Fatalf("MeterDownload ran %d times for %d bytes, want once for %d", s.meterRuns, s.metered, n)
	}
	if s.liveMeter != 1 {
		t.Fatalf("MeterDownload was handed an already-expired context: the bill inherited the statistics budget")
	}
	if d := downloadMeter(t, raw, userID, at); d != before+n {
		t.Fatalf("download meter = %d, want %d (exactly N once)", d, before+n)
	}
	if owed := owedRows(t, raw); len(owed) != 0 {
		t.Fatalf("owed rows = %+v, want none", owed)
	}
}

// The bill gets its own live budget, on both download paths, even when the
// statistics write before it used up all of its own. Each case waits out the
// 5 s statistics budget once, so they run in parallel.
func TestB_M2_DownloadBillGetsItsOwnLiveBudget(t *testing.T) {
	t.Run("stored-link", func(t *testing.T) {
		t.Parallel()
		ts, svc, store, mail := newFileServer(t)
		ctx := context.Background()
		cookie := loginCookie(t, ts, mail, "bm2-budget-link@example.test")
		blob := bytes.Repeat([]byte("b"), 211)
		resp := postUpload(t, ts, cookie, "?burnAfterRead=0&ttl=3600", uploadBody([]byte("m"), blob))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("upload status = %d", resp.StatusCode)
		}
		var up struct {
			ID string `json:"id"`
		}
		decodeJSON(t, resp, &up)
		owner, _ := store.UpsertUserByEmail(ctx, "bm2-budget-link@example.test", "")
		at := svc.now().Unix()
		spy := &slowStatsStore{Store: svc.store}
		svc.store = spy
		downloadAll(t, ts.Client(), ts.URL+"/api/files/"+up.ID+"/blob")
		spy.check(t, store, owner.ID, 0, int64(len(blob)), at)
	})
	t.Run("inbox", func(t *testing.T) {
		t.Parallel()
		h := newTaskObjectHarness(t)
		uid := h.user(t, "bm2-budget-inbox@example.test")
		tg := h.enrolTarget(t, uid, "server", inbox.AutoAcceptAuto, true)
		payload := bytes.Repeat([]byte("i"), 222)
		_, task := h.bindTask(t, tg, "bm2-budget", payload)
		blobPath := "/api/devices/" + tg.deviceID + "/inbox/tasks/" + task["ID"].(string) + "/blob"
		_, claim := h.claimOne(t, tg)
		at := h.svc.now().Unix()
		before := downloadMeter(t, h.store, uid, at)
		spy := &slowStatsStore{Store: h.svc.store}
		h.svc.store = spy
		resp := h.do(t, "GET", blobPath, func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+tg.token)
			r.Header.Set("X-Relayium-Inbox-Claim", claim)
		})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("claim-holder blob read: got %d, want 200", resp.StatusCode)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		spy.check(t, h.store, uid, before, int64(len(payload)), at)
	})
}
