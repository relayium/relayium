package account

// A14 part 2: the optional per-account Idempotency-Key on single-shot uploads
// (POST /api/files). Real Routes behind a real TCP listener, file-backed
// SQLite opened as production opens it, a real DiskStore, raw TCP clients —
// the A33 harness in upload_quota_harness_test.go.
//
// What must hold (per account, per key):
//   - one committed key ⇔ one object ⇔ one daily-quota debit;
//   - a replay is answered before the body is read: no body bytes moved, no
//     debit, no meter;
//   - a key whose object is gone answers 410 and never re-creates it;
//   - a key reused for a different request answers 422;
//   - a refused or failed keyed attempt leaves the key unused (no lost retry);
//   - no header: exactly the behaviour before this change.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const idemBodyBytes = 900

// idemResp is one answered request.
type idemResp struct {
	code   int
	body   map[string]any
	replay string // the Idempotent-Replay header
	text   string
}

func (r idemResp) id() string {
	s, _ := r.body["id"].(string)
	return s
}

// idemSend writes one complete request as `cookie` on a fresh TCP connection.
func (h *quotaHarness) idemSend(cookie *http.Cookie, method, path string, body []byte, hdr map[string]string) (net.Conn, *http.Request) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.ts.URL+path, strings.NewReader(string(body)))
	if err != nil {
		h.t.Fatal(err)
	}
	req.AddCookie(cookie)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	conn, err := net.Dial("tcp", h.ts.Listener.Addr().String())
	if err != nil {
		h.t.Fatal(err)
	}
	if err := req.Write(conn); err != nil {
		h.t.Fatal(err)
	}
	return conn, req
}

// idemRead reads one response. No t.Fatal: it also runs off the test goroutine.
func idemRead(conn net.Conn, req *http.Request) (idemResp, error) {
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		return idemResp{}, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	out := idemResp{code: resp.StatusCode, replay: resp.Header.Get("Idempotent-Replay"), text: string(b)}
	_ = json.Unmarshal(b, &out.body)
	return out, nil
}

// idemDo performs one fully answered request and waits for its handler.
func (h *quotaHarness) idemDo(cookie *http.Cookie, method, path string, body []byte, hdr map[string]string) idemResp {
	h.t.Helper()
	conn, req := h.idemSend(cookie, method, path, body, hdr)
	defer conn.Close()
	r, err := idemRead(conn, req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	h.waitDone(method, strings.SplitN(path, "?", 2)[0])
	return r
}

func (h *quotaHarness) upload(key string, query string, n int) idemResp {
	h.t.Helper()
	var hdr map[string]string
	if key != "" {
		hdr = map[string]string{"Idempotency-Key": key}
	}
	return h.idemDo(h.cookie, "POST", "/api/files"+query, quotaSingleBody(n), hdr)
}

// idemLoseAnswer sends a keyed upload, lets it commit, and closes the caller's
// connection at persist.after — the 200 is lost. It returns the id that
// committed, read from the database the caller never heard from.
func (h *quotaHarness) idemLoseAnswer(key string) string {
	h.t.Helper()
	h.hook.arm(qpPersistAfter)
	conn, _ := h.idemSend(h.cookie, "POST", "/api/files?ttl=7200", quotaSingleBody(idemBodyBytes),
		map[string]string{"Idempotency-Key": key})
	select {
	case <-h.hook.entered:
	case d := <-h.done:
		h.t.Fatalf("handler returned %d before committing", d.code)
	case <-time.After(20 * time.Second):
		h.t.Fatal("never committed")
	}
	_ = conn.Close()
	h.hook.open()
	h.waitDone("POST", "/api/files")
	var id string
	if err := h.store.db.QueryRow(`SELECT id FROM stored_files WHERE user_id=?`, h.userID).Scan(&id); err != nil {
		h.t.Fatalf("the lost answer's object: %v", err)
	}
	return id
}

// idemReplayWithoutBody sends only the request head with
// "Expect: 100-continue" and a Content-Length, and never the body. A handler
// that answers from the key without reading the body produces a final status
// straight away; one that reads the body first makes net/http send
// "100 Continue" and then wait for bytes that never come.
func (h *quotaHarness) idemReplayWithoutBody(key, query string, n int) idemResp {
	h.t.Helper()
	conn, err := net.Dial("tcp", h.ts.Listener.Addr().String())
	if err != nil {
		h.t.Fatal(err)
	}
	defer conn.Close()
	bodyLen := len(quotaSingleBody(n))
	head := fmt.Sprintf("POST /api/files%s HTTP/1.1\r\nHost: example.test\r\nCookie: %s=%s\r\n"+
		"Content-Length: %d\r\nExpect: 100-continue\r\nIdempotency-Key: %s\r\n\r\n",
		query, h.cookie.Name, h.cookie.Value, bodyLen, key)
	if _, err := io.WriteString(conn, head); err != nil {
		h.t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/files"+query, nil)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	r, err := idemRead(conn, req)
	if err != nil {
		h.t.Fatalf("replay without body: %v", err)
	}
	if r.code == http.StatusContinue {
		h.t.Fatalf("the server asked for the body (100 Continue) before answering a replay: the key was looked up after the body was read")
	}
	h.waitDone("POST", "/api/files")
	return r
}

func (h *quotaHarness) opRows() int64 {
	h.t.Helper()
	var n int64
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM upload_operations`).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func (h *quotaHarness) secondUser(email string) (*http.Cookie, string) {
	h.t.Helper()
	c := loginCookie(h.t, h.ts, h.svc.mailer.(*capturingMailer), email)
	u, err := h.store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		h.t.Fatal(err)
	}
	h.drainDone()
	return c, u.ID
}

const idemKey = "idem-key-0123456789abcdef"

// ---- the lost answer ---------------------------------------------------------

// S4 with a key: the retry is the same upload — same id, one object, one debit,
// and the traffic of the one body that moved. The replay moves no body bytes.
func TestUploadIdempotencyLostAnswerReplaysSameObject(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	id := h.idemLoseAnswer(idemKey)
	h.assertOneDebitPerObject("lost answer")

	r := h.idemReplayWithoutBody(idemKey, "?ttl=7200", idemBodyBytes)
	if r.code != http.StatusOK || r.id() != id || r.replay != "true" {
		t.Fatalf("replay: %d %q replay=%q, want 200 id=%s replay=true", r.code, r.text, r.replay, id)
	}
	// A client that sends the body anyway (no Expect) gets the same answer, and
	// the server does not read or bill it.
	r2 := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if r2.code != http.StatusOK || r2.id() != id || r2.replay != "true" {
		t.Fatalf("replay with body: %d %q replay=%q", r2.code, r2.text, r2.replay)
	}
	if exp, _ := r2.body["expiresAt"].(float64); exp <= 0 {
		t.Fatalf("replay without expiresAt: %v", r2.body)
	}
	l := h.assertOneDebitPerObject("after two replays")
	if l.Files != 1 || l.Events != 1 || l.EventBytes != minBillableBytes || l.Meter != idemBodyBytes || l.CentralBlobs != 1 {
		t.Fatalf("ledger after replays: %+v, want 1 object, 1 debit of %d, %d bytes of traffic, 1 blob", l, minBillableBytes, idemBodyBytes)
	}
	h.assertNoLegacyLedgerCalls()
}

// S5 with a key: the first attempt's own debit fills the daily quota, and the
// retry must still hear its object, not 429. Without a key the retry is the
// old second upload, refused.
func TestUploadIdempotencyReplayIsNotRefusedByItsOwnDebit(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{dailyQuota: 100000})
	id := h.idemLoseAnswer(idemKey)
	r := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if r.code != http.StatusOK || r.id() != id || r.replay != "true" {
		t.Fatalf("keyed retry at a full quota: %d %q, want the 200 replay of %s", r.code, r.text, id)
	}
	before := h.ledger()
	if r := h.upload("", "?ttl=7200", idemBodyBytes); r.code != http.StatusTooManyRequests {
		t.Fatalf("unkeyed retry at a full quota: %d, want 429 (unchanged behaviour)", r.code)
	}
	// The refused unkeyed retry is still billed for the body it streamed —
	// today's behaviour (fin-repro S5 / residual 3), deliberately unchanged here.
	// The keyed retry above added nothing.
	l := h.assertOneDebitPerObject("tight quota")
	if l.Files != 1 || before.Meter != idemBodyBytes || l.Meter != before.Meter+idemBodyBytes {
		t.Fatalf("ledger: %+v (before the unkeyed retry: %+v)", l, before)
	}
}

// ---- scope, mismatch, gone ---------------------------------------------------

func TestUploadIdempotencyKeyIsPerAccount(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	a := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	cookieB, userB := h.secondUser("other@example.com")
	b := h.idemDo(cookieB, "POST", "/api/files?ttl=7200", quotaSingleBody(idemBodyBytes),
		map[string]string{"Idempotency-Key": idemKey})
	if a.code != 200 || b.code != 200 || a.id() == b.id() || a.replay != "" || b.replay != "" {
		t.Fatalf("same key, two accounts: A=%d %s %q B=%d %s %q — want two independent uploads", a.code, a.id(), a.replay, b.code, b.id(), b.replay)
	}
	h.assertOneDebitPerObject("account A")
	lb := quotaLedgerOf(t, h.store, userB, h.blobDir)
	if lb.Files != 1 || lb.Events != 1 {
		t.Fatalf("account B ledger: %+v", lb)
	}
	// Each account's replay resolves to its own object.
	if r := h.upload(idemKey, "?ttl=7200", idemBodyBytes); r.id() != a.id() || r.replay != "true" {
		t.Fatalf("A's replay: %s %q", r.id(), r.replay)
	}
}

func TestUploadIdempotencyKeyReusedForADifferentRequestIs422(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	if r := h.upload(idemKey, "?ttl=7200", idemBodyBytes); r.code != 200 {
		t.Fatalf("first: %d", r.code)
	}
	for _, tc := range []struct {
		name, query string
		n           int
	}{
		{"different ttl", "?ttl=3600", idemBodyBytes},
		{"burn flag", "?ttl=7200&burnAfterRead=1", idemBodyBytes},
		{"download limit", "?ttl=7200&maxDownloads=3", idemBodyBytes},
		{"different length", "?ttl=7200", idemBodyBytes + 1},
	} {
		if r := h.upload(idemKey, tc.query, tc.n); r.code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: %d %q, want 422", tc.name, r.code, r.text)
		}
	}
	l := h.assertOneDebitPerObject("after mismatches")
	if l.Files != 1 || l.Meter != idemBodyBytes {
		t.Fatalf("a mismatch created or billed something: %+v", l)
	}
}

func TestUploadIdempotencyDeletedObjectIs410NeverRecreated(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	first := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if first.code != 200 {
		t.Fatalf("upload: %d", first.code)
	}
	if r := h.idemDo(h.cookie, "DELETE", "/api/files/"+first.id(), nil, nil); r.code/100 != 2 {
		t.Fatalf("delete: %d %q", r.code, r.text)
	}
	r := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if r.code != http.StatusGone {
		t.Fatalf("retry after delete: %d %q, want 410", r.code, r.text)
	}
	l := h.ledger()
	// Delete never returns daily quota (unchanged policy): one debit, no object.
	if l.Files != 0 || l.Events != 1 || l.Meter != idemBodyBytes {
		t.Fatalf("after 410: %+v", l)
	}
}

// Expiry, then the GC: the key answers 410 while the row lingers, after the
// sweep deletes the row, and for 24h after the sweep first finds it gone; only
// then is the key row pruned.
func TestUploadIdempotencyExpiredObjectIs410UntilRetentionEnds(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	first := h.upload(idemKey, "?ttl=3600", idemBodyBytes)
	if first.code != 200 {
		t.Fatalf("upload: %d", first.code)
	}
	exp := int64(first.body["expiresAt"].(float64))
	at := exp + 1
	h.svc.now = func() time.Time { return time.Unix(at, 0) }
	if r := h.upload(idemKey, "?ttl=3600", idemBodyBytes); r.code != http.StatusGone {
		t.Fatalf("expired, row still present: %d, want 410", r.code)
	}
	h.runGC(at) // deletes the expired row; the key row is stamped, not deleted
	if n := h.ledger().Files; n != 0 {
		t.Fatalf("GC left %d expired objects", n)
	}
	if h.opRows() != 1 {
		t.Fatal("the key row was pruned on the sweep that found its object gone")
	}
	h.svc.now = func() time.Time { return time.Unix(at, 0) }
	if r := h.upload(idemKey, "?ttl=3600", idemBodyBytes); r.code != http.StatusGone {
		t.Fatalf("expired and swept: %d, want 410", r.code)
	}
	h.runGC(at + uploadOperationGoneRetention - 1)
	if h.opRows() != 1 {
		t.Fatal("the key row was pruned before 24h had passed since its object went")
	}
	h.runGC(at + uploadOperationGoneRetention + 1)
	if h.opRows() != 0 {
		t.Fatal("the key row outlived its retention")
	}
}

// A live object keeps its key row through any number of sweeps.
func TestUploadIdempotencyLiveObjectKeepsItsKey(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	first := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	now := time.Now().Unix()
	h.runGC(now + 7000)
	h.runGC(now + 7100)
	var stamp int64
	if err := h.store.db.QueryRow(`SELECT gone_seen FROM upload_operations`).Scan(&stamp); err != nil || stamp != 0 {
		t.Fatalf("a live object's key row was stamped gone: %d %v", stamp, err)
	}
	if r := h.upload(idemKey, "?ttl=7200", idemBodyBytes); r.id() != first.id() || r.replay != "true" {
		t.Fatalf("replay: %d %s", r.code, r.id())
	}
}

// ---- concurrency: one key, many requests -------------------------------------

// idemBarrier holds every request at persist.before until n have arrived, so
// all of them have missed the pre-body lookup and moved their bodies before
// any of them commits — the case only the transaction's key claim can decide.
func (h *quotaHarness) idemBarrier(n int) {
	var arrived int32
	all := make(chan struct{})
	h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
		if p != qpPersistBefore {
			return
		}
		if atomic.AddInt32(&arrived, 1) == int32(n) {
			close(all)
		}
		select {
		case <-all:
		case <-time.After(30 * time.Second):
		}
	})
	h.t.Cleanup(func() { h.hook.setOnPoint(nil) })
}

func (h *quotaHarness) idemConcurrent(n int, query func(i int) string) []idemResp {
	h.t.Helper()
	out := make([]idemResp, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		conn, req := h.idemSend(h.cookie, "POST", "/api/files"+query(i), quotaSingleBody(idemBodyBytes),
			map[string]string{"Idempotency-Key": idemKey})
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer conn.Close()
			out[i], errs[i] = idemRead(conn, req)
		}(i)
	}
	wg.Wait()
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			h.t.Fatalf("request %d: %v", i, errs[i])
		}
		h.waitDone("POST", "/api/files")
	}
	return out
}

func (h *quotaHarness) opExistsErrors() int {
	n := 0
	for _, err := range h.hook.persistErrors() {
		if errors.Is(err, ErrUploadOperationExists) {
			n++
		}
	}
	return n
}

// 16 concurrent requests with one key, all past the lookup before any commits:
// one object, one debit, one blob; every request hears the same id; each body
// that moved is billed. Run at a quota that fits exactly ONE upload too — the
// losers must hear the winner's object, never a 429 caused by its debit.
func TestUploadIdempotencyConcurrentSameKeyOneObjectOneDebit(t *testing.T) {
	const n = 16
	for _, quota := range []int64{8 << 20, 100000} {
		t.Run(fmt.Sprintf("quota=%d", quota), func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{dailyQuota: quota})
			h.svc.uploadSem = newUploadSem(2 * n) // let all 16 in at once
			h.idemBarrier(n)
			rs := h.idemConcurrent(n, func(int) string { return "?ttl=7200" })
			id, fresh := "", 0
			for i, r := range rs {
				if r.code != http.StatusOK {
					t.Fatalf("request %d: %d %q", i, r.code, r.text)
				}
				if id == "" {
					id = r.id()
				}
				if r.id() != id {
					t.Fatalf("request %d heard %s, another heard %s", i, r.id(), id)
				}
				if r.replay == "" {
					fresh++
				}
			}
			if fresh != 1 {
				t.Fatalf("%d requests were answered as the original, want exactly 1", fresh)
			}
			if got := h.opExistsErrors(); got != n-1 {
				t.Fatalf("%d key-claim conflicts in the insert, want %d (the barrier did not overlap them)", got, n-1)
			}
			l := h.assertOneDebitPerObject("16 same-key requests")
			if l.Files != 1 || l.Events != 1 || l.CentralBlobs != 1 || l.Meter != n*idemBodyBytes {
				t.Fatalf("ledger: %+v, want 1 object/1 debit/1 blob and %d bytes of moved traffic", l, n*idemBodyBytes)
			}
			if h.opRows() != 1 {
				t.Fatalf("%d key rows", h.opRows())
			}
		})
	}
}

// The same key racing with two different requests: the committed one decides,
// its twins hear it, the others hear 422 — and still only one object.
func TestUploadIdempotencyConcurrentMismatchedRequests(t *testing.T) {
	const n = 8
	h := newQuotaHarness(t, quotaOpts{})
	h.svc.uploadSem = newUploadSem(2 * n)
	h.idemBarrier(n)
	q := func(i int) string {
		if i%2 == 0 {
			return "?ttl=7200"
		}
		return "?ttl=3600"
	}
	rs := h.idemConcurrent(n, q)
	var ok, mismatch int
	winnerQuery := ""
	for i, r := range rs {
		switch r.code {
		case http.StatusOK:
			ok++
			if winnerQuery == "" {
				winnerQuery = q(i)
			} else if q(i) != winnerQuery {
				t.Fatalf("both request shapes got 200")
			}
		case http.StatusUnprocessableEntity:
			mismatch++
		default:
			t.Fatalf("request %d: %d %q", i, r.code, r.text)
		}
	}
	if ok != n/2 || mismatch != n/2 {
		t.Fatalf("ok=%d mismatch=%d, want %d each", ok, mismatch, n/2)
	}
	if l := h.assertOneDebitPerObject("mismatched race"); l.Files != 1 {
		t.Fatalf("%d objects", l.Files)
	}
}

// ---- lost credit: a failed keyed attempt must not burn its key ---------------

// The daily quota refuses the keyed upload INSIDE the insert (a debit landed
// between the pre-check and the insert). Nothing may remain of the attempt —
// no object, no debit, and no key claim — so that once quota is available the
// retry uploads, instead of hearing 410 for an object that never existed.
func TestUploadIdempotencyRefusedAttemptLeavesKeyUnused(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	seed := UploadEvent{ID: "seeded-debit", UserID: h.userID, Bytes: 8 << 20, UploadedAt: time.Now().Unix()}
	var once sync.Once
	h.hook.setOnPoint(func(p quotaPoint, ctx context.Context) {
		if p == qpPersistBefore {
			once.Do(func() {
				if ok, err := h.store.ReserveUpload(context.Background(), seed, 0, 1<<40); !ok || err != nil {
					t.Errorf("seed: %v %v", ok, err)
				}
			})
		}
	})
	if r := h.upload(idemKey, "?ttl=7200", idemBodyBytes); r.code != http.StatusTooManyRequests {
		t.Fatalf("in-transaction quota refusal: %d %q", r.code, r.text)
	}
	if got := h.hook.refusals(); len(got) != 1 || got[0] != "quota" {
		t.Fatalf("refusals: %v, want [quota]", got)
	}
	if h.opRows() != 0 {
		t.Fatal("a refused keyed upload left its key claimed")
	}
	h.hook.setOnPoint(nil)
	if err := h.store.RefundUpload(context.Background(), seed.ID); err != nil {
		t.Fatal(err)
	}
	r := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if r.code != http.StatusOK || r.replay != "" {
		t.Fatalf("retry once quota is free: %d %q replay=%q, want a fresh 200", r.code, r.text, r.replay)
	}
	if l := h.assertOneDebitPerObject("after the retry"); l.Files != 1 {
		t.Fatalf("%d objects", l.Files)
	}
}

// A real database failure at the insert (another process holds SQLite's write
// lock past busy_timeout): 500, nothing written, key unused; the retry uploads.
func TestUploadIdempotencyDatabaseFailureLeavesKeyUnused(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	var release func()
	var once sync.Once
	h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
		if p == qpPersistBefore {
			once.Do(func() { release = holdWriteLock(t, h.dbPath) })
		}
	})
	r := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	release()
	if r.code != http.StatusInternalServerError {
		t.Fatalf("insert under a held write lock: %d %q, want 500", r.code, r.text)
	}
	if h.opRows() != 0 {
		t.Fatal("a failed keyed insert left its key claimed")
	}
	h.hook.setOnPoint(nil)
	r = h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if r.code != http.StatusOK || r.replay != "" {
		t.Fatalf("retry: %d %q replay=%q, want a fresh 200", r.code, r.text, r.replay)
	}
	if l := h.assertOneDebitPerObject("after the retry"); l.Files != 1 || l.Events != 1 {
		t.Fatalf("ledger: %+v", l)
	}
}

// ---- no header, bad header ---------------------------------------------------

func TestUploadIdempotencyAbsentHeaderIsUnchanged(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	a := h.upload("", "?ttl=7200", idemBodyBytes)
	b := h.upload("", "?ttl=7200", idemBodyBytes)
	if a.code != 200 || b.code != 200 || a.id() == b.id() || a.replay != "" || b.replay != "" {
		t.Fatalf("unkeyed uploads: %d %s %q / %d %s %q", a.code, a.id(), a.replay, b.code, b.id(), b.replay)
	}
	if l := h.assertOneDebitPerObject("two unkeyed uploads"); l.Files != 2 || l.Meter != 2*idemBodyBytes {
		t.Fatalf("ledger: %+v", l)
	}
	if h.opRows() != 0 {
		t.Fatal("an unkeyed upload wrote a key row")
	}
}

func TestUploadIdempotencyMalformedKeyIs400BeforeTheBody(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	for _, key := range []string{
		"short",
		strings.Repeat("k", uploadOperationKeyMax+1),
		"has space in it 0123456789",
		"slash/is/not/allowed/0123456789",
		"unicode-é-0123456789abcdef",
		"",
	} {
		// A hand-written head, so an empty value reaches the server as a header
		// that is present and empty.
		c, err := net.Dial("tcp", h.ts.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		body := quotaSingleBody(idemBodyBytes)
		head := fmt.Sprintf("POST /api/files?ttl=7200 HTTP/1.1\r\nHost: example.test\r\nCookie: %s=%s\r\n"+
			"Content-Length: %d\r\nIdempotency-Key: %s\r\n\r\n", h.cookie.Name, h.cookie.Value, len(body), key)
		_, _ = io.WriteString(c, head+string(body))
		r2, _ := http.NewRequest("POST", h.ts.URL+"/api/files", nil)
		r, err := idemRead(c, r2)
		c.Close()
		if err != nil {
			t.Fatalf("key %q: %v", key, err)
		}
		if r.code != http.StatusBadRequest {
			t.Fatalf("key %q: %d %q, want 400", key, r.code, r.text)
		}
		h.waitDone("POST", "/api/files")
	}
	// Two Idempotency-Key headers.
	c, err := net.Dial("tcp", h.ts.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	body := quotaSingleBody(idemBodyBytes)
	head := fmt.Sprintf("POST /api/files?ttl=7200 HTTP/1.1\r\nHost: example.test\r\nCookie: %s=%s\r\n"+
		"Content-Length: %d\r\nIdempotency-Key: %s\r\nIdempotency-Key: %s\r\n\r\n", h.cookie.Name, h.cookie.Value, len(body), idemKey, idemKey+"x")
	_, _ = io.WriteString(c, head+string(body))
	r2, _ := http.NewRequest("POST", h.ts.URL+"/api/files", nil)
	r, err := idemRead(c, r2)
	c.Close()
	if err != nil || r.code != http.StatusBadRequest {
		t.Fatalf("two keys: %d %v, want 400", r.code, err)
	}
	h.waitDone("POST", "/api/files")
	if l := h.ledger(); l.Files != 0 || l.Events != 0 || l.Meter != 0 {
		t.Fatalf("a malformed key created or billed something: %+v", l)
	}
	// Key-length bounds are inclusive.
	for _, key := range []string{strings.Repeat("a", uploadOperationKeyMin), strings.Repeat("b", uploadOperationKeyMax), "A.b_c:d-0123456789"} {
		if r := h.upload(key, "?ttl=7200", idemBodyBytes); r.code != 200 {
			t.Fatalf("valid key %q: %d %q", key, r.code, r.text)
		}
	}
}

// ---- store level -------------------------------------------------------------

func idemStoreUser(t *testing.T, s *SQLiteStore, email string) string {
	t.Helper()
	u, err := s.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func idemStoreFile(userID, id, key string, now int64) StoredFile {
	return StoredFile{
		ID: id, UserID: userID, BlobKey: "blob-" + id, EncManifest: []byte("m"), Size: 10,
		CreatedAt: now, ExpiresAt: now + 3600, Purpose: StoredPurposeShare,
		Operation: &UploadOperation{UserID: userID, Key: key, FileID: id, RequestDigest: []byte{1}, CreatedAt: now},
	}
}

func idemCount(t *testing.T, s *SQLiteStore, table string) int64 {
	t.Helper()
	var n int64
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// The claim, the debit and the object commit together; a second claim of the
// same key writes none of them, on the capped door and on the uncapped
// (own-node) door alike.
func TestUploadOperationStoreClaimIsAtomicWithObjectAndDebit(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	uid := idemStoreUser(t, s, "store-idem@example.com")
	now := time.Now().Unix()
	charge := func(id string) *UploadQuotaCharge {
		return &UploadQuotaCharge{Event: UploadEvent{ID: "ev-" + id, UserID: uid, Bytes: minBillableBytes, UploadedAt: now}, Since: now - dayWindow, Quota: 1 << 30}
	}
	f1 := idemStoreFile(uid, "f1", "store-key-0123456789", now)
	f1.QuotaCharge = charge("f1")
	if w, err := s.CreateStoredFileWithinStorageCaps(ctx, f1, now, 0, 0); err != nil || w.Reason != "" {
		t.Fatalf("first: %+v %v", w, err)
	}
	f2 := idemStoreFile(uid, "f2", "store-key-0123456789", now)
	f2.QuotaCharge = charge("f2")
	if _, err := s.CreateStoredFileWithinStorageCaps(ctx, f2, now, 0, 0); !errors.Is(err, ErrUploadOperationExists) {
		t.Fatalf("second claim: %v, want ErrUploadOperationExists", err)
	}
	// Uncapped door (own-node uploads reach the store through it).
	f3 := idemStoreFile(uid, "f3", "store-key-0123456789", now)
	if err := s.CreateStoredFile(ctx, f3); !errors.Is(err, ErrUploadOperationExists) {
		t.Fatalf("uncapped second claim: %v", err)
	}
	f4 := idemStoreFile(uid, "f4", "store-key-own-node-01", now)
	if err := s.CreateStoredFile(ctx, f4); err != nil {
		t.Fatalf("uncapped first claim: %v", err)
	}
	if f, e, o := idemCount(t, s, "stored_files"), idemCount(t, s, "upload_events"), idemCount(t, s, "upload_operations"); f != 2 || e != 1 || o != 2 {
		t.Fatalf("files=%d events=%d ops=%d, want 2/1/2", f, e, o)
	}
	op, err := s.GetUploadOperation(ctx, uid, "store-key-0123456789")
	if err != nil || op.FileID != "f1" {
		t.Fatalf("GetUploadOperation: %+v %v", op, err)
	}
	if _, err := s.GetUploadOperation(ctx, "someone-else", "store-key-0123456789"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another user's key: %v, want ErrNotFound", err)
	}
	// A cap refusal takes the claim with it.
	f5 := idemStoreFile(uid, "f5", "store-key-capped-0001", now)
	f5.QuotaCharge = charge("f5")
	if w, err := s.CreateStoredFileWithinStorageCaps(ctx, f5, now, 1, 0); err != nil || w.Reason != "storage" {
		t.Fatalf("capped: %+v %v", w, err)
	}
	if _, err := s.GetUploadOperation(ctx, uid, "store-key-capped-0001"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a refused insert kept its claim: %v", err)
	}
	// A claim that does not describe this object is refused before writing.
	bad := idemStoreFile(uid, "f6", "store-key-bad-000001", now)
	bad.Operation.FileID = "f1"
	if _, err := s.CreateStoredFileWithinStorageCaps(ctx, bad, now, 0, 0); err == nil || errors.Is(err, ErrUploadOperationExists) {
		t.Fatalf("mismatched claim: %v, want a caller-bug error", err)
	}
	if f := idemCount(t, s, "stored_files"); f != 2 {
		t.Fatalf("files=%d after refusals", f)
	}
}

// Account deletion removes the key rows (both purges), and the table has no
// foreign key: an older binary that does not know the table can still purge a
// user who has rows in it.
func TestUploadOperationRowsFollowTheAccount(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now().Unix()
	a := idemStoreUser(t, s, "purge-a@example.com")
	b := idemStoreUser(t, s, "purge-b@example.com")
	for i, uid := range []string{a, b} {
		if err := s.CreateStoredFile(ctx, idemStoreFile(uid, fmt.Sprintf("p%d", i), "purge-key-0123456789", now)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.PurgeTransientUserData(ctx, a); err != nil {
		t.Fatal(err)
	}
	var n int64
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM upload_operations WHERE user_id=?`, a).Scan(&n)
	if n != 0 {
		t.Fatalf("PurgeTransientUserData left %d key rows", n)
	}
	if err := s.SetAccountDeletion(ctx, b, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := s.ArchiveAndPurgeUser(ctx, b, 200); err != nil {
		t.Fatalf("purge: %v", err)
	}
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM upload_operations WHERE user_id=?`, b).Scan(&n)
	if n != 0 {
		t.Fatalf("ArchiveAndPurgeUser left %d key rows", n)
	}
	rows, err := s.db.Query(`PRAGMA foreign_key_list(upload_operations)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("upload_operations has a foreign key: an older binary's purge would fail on it")
	}
	// Rollback shape: a users row with key rows left behind (an older binary
	// never deletes them) is still deletable with foreign keys on.
	c := idemStoreUser(t, s, "purge-c@example.com")
	if _, err := s.db.Exec(`INSERT INTO upload_operations (user_id, op_key, file_id, request_digest, created_at) VALUES (?, 'k-0123456789abcdef', 'gone', x'01', 1)`, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DELETE FROM users WHERE id=?`, c); err != nil {
		t.Fatalf("deleting a user with leftover key rows: %v", err)
	}
}
