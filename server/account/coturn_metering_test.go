package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// F02 central ingest: binding, receipt and ledger contract. Money-moving: every
// test here pins a double-charge, wrong-owner, lost-credit or retroactive-bill
// path. See ApplyCoturnSnapshot.

var cmSep30 = time.Date(2026, 9, 30, 23, 59, 50, 0, time.UTC).Unix()

type cmEnv struct {
	t     *testing.T
	st    *SQLiteStore
	h     *CoturnMeteringIngest
	clock int64
	mu    sync.Mutex
	logs  []string
	cfg   CoturnMeteringConfig
	deny  map[string]string // tag → refusal
}

const cmRelayA, cmTokenA = "coturn-central", "token-a-secret"
const cmRelayB, cmTokenB = "coturn-second", "token-b-secret"

func cmHash(tok string) [32]byte { return sha256.Sum256([]byte(tok)) }

func newCMEnv(t *testing.T, mode string, billableSince int64) *cmEnv {
	t.Helper()
	e := &cmEnv{t: t, st: newTestStore(t), clock: cmSep30, deny: map[string]string{}}
	e.cfg = CoturnMeteringConfig{
		Relays:        map[string][32]byte{cmRelayA: cmHash(cmTokenA), cmRelayB: cmHash(cmTokenB)},
		Mode:          mode,
		BillableSince: billableSince,
	}
	e.rebuild()
	return e
}

func (e *cmEnv) rebuild() {
	e.t.Helper()
	cfg := e.cfg
	cfg.Now = func() int64 { e.mu.Lock(); defer e.mu.Unlock(); return e.clock }
	cfg.Logf = func(f string, a ...any) { e.mu.Lock(); e.logs = append(e.logs, fmt.Sprintf(f, a...)); e.mu.Unlock() }
	h, err := NewCoturnMeteringIngest(e.st, func(tag, user string) string { return e.deny[tag] }, cfg)
	if err != nil {
		e.t.Fatal(err)
	}
	e.h = h
}

func (e *cmEnv) set(at int64) { e.mu.Lock(); e.clock = at; e.mu.Unlock() }

func (e *cmEnv) logged(sub string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, l := range e.logs {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func (e *cmEnv) user(email string) string {
	e.t.Helper()
	u, err := e.st.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

type cmSnap struct {
	relay, boot, sess, user, tag, state string
	pid                                 int
	ticks, seq, stream, live, final     uint64
	finalSeen                           bool
	firstObs                            int64
}

func (c cmSnap) build() wire.Snapshot {
	s := wire.Snapshot{
		Version: wire.Version, RelayID: c.relay, BootID: c.boot, PID: c.pid, StartTicks: c.ticks,
		SessionID: c.sess, Username: "1790000000:" + c.user + "." + c.tag,
		Seq: c.seq, StreamSum: c.stream, LiveSnapshot: c.live, Final: c.final, FinalSeen: c.finalSeen,
		State: c.state, FirstObservedUnix: c.firstObs, CreatedUnix: c.firstObs + int64(c.seq),
	}
	if s.State == "" {
		s.State = wire.StateLive
		if c.finalSeen {
			s.State = wire.StateFinal
		}
	}
	if s.FirstObservedUnix == 0 {
		s.FirstObservedUnix, s.CreatedUnix = cmSep30-100, cmSep30-100+int64(c.seq)
	}
	s.Seal()
	return s
}

func (e *cmEnv) post(token, relay string, snaps ...wire.Snapshot) (int, wire.Response) {
	e.t.Helper()
	body, _ := json.Marshal(wire.Request{RelayID: relay, Snapshots: snaps})
	req := httptest.NewRequest(http.MethodPost, wire.Path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	var resp wire.Response
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			e.t.Fatalf("decode: %v: %s", err, rec.Body.String())
		}
		if len(resp.Acks) != len(snaps) {
			e.t.Fatalf("want %d acks, got %d", len(snaps), len(resp.Acks))
		}
	}
	return rec.Code, resp
}

func (e *cmEnv) one(s wire.Snapshot) wire.Ack {
	e.t.Helper()
	tok := cmTokenA
	if s.RelayID == cmRelayB {
		tok = cmTokenB
	}
	code, resp := e.post(tok, s.RelayID, s)
	if code != http.StatusOK {
		e.t.Fatalf("post: HTTP %d", code)
	}
	a := resp.Acks[0]
	if a.Seq != s.Seq || a.Hash != s.Hash || a.Key != s.Key() {
		e.t.Fatalf("ack does not name the snapshot: %+v vs seq %d hash %s", a, s.Seq, s.Hash)
	}
	return a
}

func (e *cmEnv) relayed(user string) int64 {
	e.t.Helper()
	var n int64
	if err := e.st.db.QueryRow(`SELECT COALESCE(SUM(bytes),0) FROM usage_periods WHERE user_id=? AND billable=1`, user).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *cmEnv) period(user, p string) int64 {
	e.t.Helper()
	var n int64
	if err := e.st.db.QueryRow(`SELECT COALESCE(SUM(bytes),0) FROM usage_periods WHERE user_id=? AND period=?`, user, p).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *cmEnv) ledgerRows() (events, periods int) {
	e.t.Helper()
	if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&events); err != nil {
		e.t.Fatal(err)
	}
	if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM usage_periods`).Scan(&periods); err != nil {
		e.t.Fatal(err)
	}
	return
}

func wantAck(t *testing.T, a wire.Ack, status string, accepted uint64) {
	t.Helper()
	if a.Status != status || a.Accepted != accepted {
		t.Fatalf("ack = %s/%d (%s, clamp %q), want %s/%d", a.Status, a.Accepted, a.Reason, a.Clamp, status, accepted)
	}
}

const cmBoot1, cmBoot2, cmBoot3 = "8f9c0d4e-1111-4a2b-9c3d-000000000001", "8f9c0d4e-2222-4a2b-9c3d-000000000002", "8f9c0d4e-3333-4a2b-9c3d-000000000003"
const cmSess1 = "001000000000000001"

// The H2 money test: coturn reuses raw session ids across restarts and hosts.
// Under the retired Redis ingest, user B's allocation reusing A's id was folded
// into A's row (A billed for B, or B unmetered). Here each (relay, boot, pid,
// start, session) is its own binding and its own ledger row.
func TestCoturnIngestReusedRawSessionIDNeverCrossesOwners(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a, b := e.user("a@example.com"), e.user("b@example.com")

	// User A, epoch 1.
	wantAck(t, e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 100, ticks: 5000, sess: cmSess1, user: a, tag: "ga", seq: 1, final: 1000, finalSeen: true}.build()), wire.AckAccepted, 1000)
	// Same raw id, same host, after a coturn restart (new pid/start ticks): user B.
	wantAck(t, e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 200, ticks: 9000, sess: cmSess1, user: b, tag: "gb", seq: 1, final: 700, finalSeen: true}.build()), wire.AckAccepted, 700)
	// Same raw id and pid on another coturn host: user B again.
	wantAck(t, e.one(cmSnap{relay: cmRelayB, boot: cmBoot2, pid: 100, ticks: 5000, sess: cmSess1, user: b, tag: "gc", seq: 1, final: 300, finalSeen: true}.build()), wire.AckAccepted, 300)
	// Same raw id, same pid and start ticks, after a reboot (boot id differs): user A.
	wantAck(t, e.one(cmSnap{relay: cmRelayA, boot: cmBoot3, pid: 100, ticks: 5000, sess: cmSess1, user: a, tag: "gd", seq: 1, final: 50, finalSeen: true}.build()), wire.AckAccepted, 50)

	if got := e.relayed(a); got != 1050 {
		t.Fatalf("user A billed %d, want 1050", got)
	}
	if got := e.relayed(b); got != 1000 {
		t.Fatalf("user B billed %d, want 1000", got)
	}
	bs, err := e.st.CoturnBindings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, x := range bs {
		if !strings.HasPrefix(x.AllocID, coturnAllocIDPrefix) || len(x.AllocID) != len(coturnAllocIDPrefix)+32 || seen[x.AllocID] {
			t.Fatalf("binding alloc id %q not a fresh random coturn id", x.AllocID)
		}
		seen[x.AllocID] = true
	}
	if len(bs) != 4 {
		t.Fatalf("want 4 bindings, got %d", len(bs))
	}

	// Same key, another username: a conflict, never merged into A's row.
	ack := e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 100, ticks: 5000, sess: cmSess1, user: b, tag: "gb", seq: 2, final: 5000, finalSeen: true}.build())
	if ack.Status != wire.AckConflict {
		t.Fatalf("username change on a binding: %+v", ack)
	}
	if e.relayed(a) != 1050 || e.relayed(b) != 1000 {
		t.Fatalf("conflict moved bytes: A %d B %d", e.relayed(a), e.relayed(b))
	}
}

// Lost ACK, duplicate final, reordered and conflicting receipts.
func TestCoturnIngestReceiptIdempotenceAndConflicts(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	base := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1"}

	s1 := base
	s1.seq, s1.stream = 1, 100
	s3 := base
	s3.seq, s3.stream, s3.live = 3, 250, 300
	s5 := base
	s5.seq, s5.stream, s5.final, s5.finalSeen = 5, 480, 500, true

	wantAck(t, e.one(s1.build()), wire.AckAccepted, 100)
	wantAck(t, e.one(s5.build()), wire.AckAccepted, 500)
	// Lost ACK: the bridge resends the same final; nothing is added.
	wantAck(t, e.one(s5.build()), wire.AckAccepted, 500)
	wantAck(t, e.one(s5.build()), wire.AckAccepted, 500)
	// Reordered older snapshot after the final: stale, acks the current value.
	wantAck(t, e.one(s3.build()), wire.AckStale, 500)
	if got := e.relayed(a); got != 500 {
		t.Fatalf("billed %d after duplicates/reorder, want 500", got)
	}

	// Same seq, different content (hence hash): conflict.
	forged := base
	forged.seq, forged.stream, forged.final, forged.finalSeen = 5, 480, 900, true
	if a := e.one(forged.build()); a.Status != wire.AckConflict {
		t.Fatalf("same seq, different hash: %+v", a)
	}
	// Older seq claiming more than the latest: conflict.
	older := base
	older.seq, older.stream = 4, 600
	if a := e.one(older.build()); a.Status != wire.AckConflict {
		t.Fatalf("older seq, higher cumulative: %+v", a)
	}
	// Anything after a terminal snapshot: conflict.
	after := base
	after.seq, after.stream, after.final, after.finalSeen = 6, 480, 800, true
	if a := e.one(after.build()); a.Status != wire.AckConflict {
		t.Fatalf("snapshot after terminal: %+v", a)
	}
	if got := e.relayed(a); got != 500 {
		t.Fatalf("billed %d after conflicts, want 500", got)
	}

	// Newer seq with a lower cumulative on a live binding: conflict.
	l := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000002", user: a, tag: "g2"}
	l.seq, l.stream = 1, 400
	wantAck(t, e.one(l.build()), wire.AckAccepted, 400)
	l.seq, l.stream = 2, 300
	if a := e.one(l.build()); a.Status != wire.AckConflict {
		t.Fatalf("newer seq, lower cumulative: %+v", a)
	}
	if got := e.relayed(a); got != 900 {
		t.Fatalf("billed %d, want 900", got)
	}
}

// Concurrent duplicate deliveries of one snapshot serialize on the writer
// lock: the bytes are recorded once.
func TestCoturnIngestConcurrentDuplicatesRecordOnce(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	s := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 9, stream: 12345}.build()
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			body, _ := json.Marshal(wire.Request{RelayID: cmRelayA, Snapshots: []wire.Snapshot{s}})
			req := httptest.NewRequest(http.MethodPost, wire.Path, bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+cmTokenA)
			e.h.ServeHTTP(httptest.NewRecorder(), req)
		})
	}
	wg.Wait()
	if got := e.relayed(a); got != 12345 {
		t.Fatalf("billed %d after 16 concurrent duplicates, want 12345", got)
	}
}

// Month is central receive time; a replay cannot move bytes or rebill.
func TestCoturnIngestMonthBoundaryAndReplay(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	base := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1"}
	s1 := base
	s1.seq, s1.stream = 1, 100
	s2 := base
	s2.seq, s2.stream, s2.final, s2.finalSeen = 2, 240, 250, true

	e.set(cmSep30) // 2026-09-30 23:59:50
	wantAck(t, e.one(s1.build()), wire.AckAccepted, 100)
	e.set(cmSep30 + 20) // 2026-10-01 00:00:10
	wantAck(t, e.one(s2.build()), wire.AckAccepted, 250)
	if e.period(a, "202609") != 100 || e.period(a, "202610") != 150 {
		t.Fatalf("periods Sep %d Oct %d, want 100/150", e.period(a, "202609"), e.period(a, "202610"))
	}
	// Replays a month later add nothing anywhere.
	e.set(cmSep30 + 32*86400)
	wantAck(t, e.one(s1.build()), wire.AckStale, 250)
	wantAck(t, e.one(s2.build()), wire.AckAccepted, 250)
	if e.period(a, "202609") != 100 || e.period(a, "202610") != 150 || e.period(a, "202611") != 0 {
		t.Fatalf("replay moved bytes: Sep %d Oct %d Nov %d", e.period(a, "202609"), e.period(a, "202610"), e.period(a, "202611"))
	}
}

// The existing per-report clamp still applies; the ACK carries what the
// ledger actually accepted, and a retry of the same snapshot catches up as
// the elapsed-time budget accrues. Ceiling clamps are reported as permanent.
func TestCoturnIngestClampAckIsTheAcceptedCumulative(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	big := uint64(maxFirstReportBytes) + 5<<30
	s := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, final: big, finalSeen: true}.build()

	ack := e.one(s)
	if ack.Status != wire.AckAccepted || ack.Accepted != uint64(maxFirstReportBytes) || ack.Clamp != wire.ClampRate {
		t.Fatalf("first clamped ack: %+v", ack)
	}
	if got := e.relayed(a); got != maxFirstReportBytes {
		t.Fatalf("ledger %d, want the clamped %d", got, int64(maxFirstReportBytes))
	}
	e.set(cmSep30 + 600) // 600 s × 25 MiB/s ≫ 5 GiB
	ack = e.one(s)
	if ack.Status != wire.AckAccepted || ack.Accepted != big || ack.Clamp != wire.ClampNone {
		t.Fatalf("retry ack: %+v", ack)
	}
	if got := e.relayed(a); got != int64(big) {
		t.Fatalf("ledger %d after catch-up, want %d", got, big)
	}
	wantAck(t, e.one(s), wire.AckAccepted, big) // and once caught up, nothing more

	// Ceiling: beyond maxAllocRelayBytes nothing is ever accepted.
	huge := uint64(maxAllocRelayBytes) + 1<<30
	c := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000009", user: a, tag: "g9", seq: 1, stream: huge}.build()
	e.one(c)
	e.set(cmSep30 + 3*86400)
	ack = e.one(c)
	if ack.Accepted != uint64(maxAllocRelayBytes) || ack.Clamp != wire.ClampCeiling {
		t.Fatalf("ceiling ack: %+v", ack)
	}
}

// Shadow mode measures but never writes the billable ledger.
func TestCoturnIngestShadowNeverWritesLedger(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringShadow, 0)
	a := e.user("a@example.com")
	s := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, final: 4242, finalSeen: true}.build()
	ack := e.one(s)
	if ack.Status != wire.AckAccepted || ack.Accepted != 4242 || ack.Ledger != wire.LedgerShadow {
		t.Fatalf("shadow ack: %+v", ack)
	}
	if ev, p := e.ledgerRows(); ev != 0 || p != 0 {
		t.Fatalf("shadow wrote the ledger: %d usage_events, %d usage_periods", ev, p)
	}
}

// Activation needs an explicit baseline and never bills retroactively.
func TestCoturnIngestBillableActivationIsNotRetroactive(t *testing.T) {
	since := cmSep30
	e := newCMEnv(t, CoturnMeteringShadow, 0)
	a := e.user("a@example.com")
	pre := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", firstObs: since - 50}
	pre.seq, pre.stream = 1, 1000
	e.set(since - 10)
	e.one(pre.build()) // shadow binding

	// Billable mode without a baseline is refused outright.
	if _, err := NewCoturnMeteringIngest(e.st, nil, CoturnMeteringConfig{Relays: e.cfg.Relays, Mode: CoturnMeteringBillable}); err == nil {
		t.Fatal("billable mode built without billable-since")
	}
	e.cfg.Mode, e.cfg.BillableSince = CoturnMeteringBillable, since
	e.rebuild()
	e.set(since + 10)

	// The pre-activation allocation keeps growing: still shadow, never billed.
	pre.seq, pre.stream = 2, 5000
	if ack := e.one(pre.build()); ack.Ledger != wire.LedgerShadow || ack.Accepted != 5000 {
		t.Fatalf("pre-activation binding after activation: %+v", ack)
	}
	// An allocation the bridge first saw before activation but central first
	// receives after it (bridge backlog) is not billed either.
	backlog := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000002", user: a, tag: "g2", firstObs: since - 1}
	backlog.seq, backlog.stream = 1, 777
	if ack := e.one(backlog.build()); ack.Ledger != wire.LedgerShadow {
		t.Fatalf("backlog allocation billed: %+v", ack)
	}
	if got := e.relayed(a); got != 0 {
		t.Fatalf("billed %d retroactively", got)
	}
	// A post-activation allocation is billed.
	post := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000003", user: a, tag: "g3", firstObs: since + 1}
	post.seq, post.stream = 1, 300
	if ack := e.one(post.build()); ack.Ledger != wire.LedgerBillable || ack.Accepted != 300 {
		t.Fatalf("post-activation binding: %+v", ack)
	}

	// Rolling back to shadow demotes it for good: bytes reported in shadow are
	// not billed when billable mode returns.
	e.cfg.Mode = CoturnMeteringShadow
	e.rebuild()
	post.seq, post.stream = 2, 900
	if ack := e.one(post.build()); ack.Ledger != wire.LedgerShadow {
		t.Fatalf("shadow-mode snapshot on billable binding: %+v", ack)
	}
	e.cfg.Mode = CoturnMeteringBillable
	e.rebuild()
	post.seq, post.stream = 3, 1500
	if ack := e.one(post.build()); ack.Ledger != wire.LedgerShadow {
		t.Fatalf("demoted binding re-promoted: %+v", ack)
	}
	if got := e.relayed(a); got != 300 {
		t.Fatalf("billed %d, want only the 300 accepted while billable", got)
	}
}

// FirstObservedUnix 1 is the bridge's reserved "start unknown" value (an
// allocation it met with no "new" status and no psd start, e.g. a session
// coturn refused). It is never billable, whatever the activation time: not
// with a real baseline and not with BillableSince 1 either, where the plain
// "first observed ≥ activation" comparison alone would admit it. Its observed
// bytes stay visible as a shadow diagnostic; the user's ledger stays empty.
// A known start one second after the sentinel, and one exactly at a real
// baseline, are still billed.
func TestCoturnIngestUnknownStartNeverBillable(t *testing.T) {
	for _, tc := range []struct {
		name  string
		since int64
		known int64 // a known start that must still be billed
	}{
		{"billable-since 1", 1, 2},
		{"real activation baseline", cmSep30 - 1000, cmSep30 - 1000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newCMEnv(t, CoturnMeteringBillable, tc.since)
			refused := e.user("refused@example.com")
			unknown := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: refused, tag: "u1", firstObs: 1}
			unknown.seq, unknown.stream = 1, 580
			if ack := e.one(unknown.build()); ack.Status != wire.AckAccepted || ack.Ledger != wire.LedgerShadow || ack.Accepted != 580 {
				t.Fatalf("unknown start: %+v, want accepted shadow 580", ack)
			}
			// Its end (coturn's final) stays shadow too.
			unknown.seq, unknown.final, unknown.finalSeen = 2, 580, true
			if ack := e.one(unknown.build()); ack.Status != wire.AckAccepted || ack.Ledger != wire.LedgerShadow || ack.Accepted != 580 {
				t.Fatalf("unknown start final: %+v, want accepted shadow 580", ack)
			}
			if b := e.rawBinding(cmSess1); b["ledger"] != wire.LedgerShadow || b["accepted"] != "580" {
				t.Fatalf("unknown-start binding: %v, want shadow with the observed 580", b)
			}
			if ev, p := e.ledgerRows(); ev != 0 || p != 0 {
				t.Fatalf("unknown start wrote the ledger: %d usage_events, %d usage_periods", ev, p)
			}
			if got := e.relayed(refused); got != 0 {
				t.Fatalf("unknown start billed %d", got)
			}

			owner := e.user("known@example.com")
			known := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000002", user: owner, tag: "k1", firstObs: tc.known}
			known.seq, known.stream = 1, 300
			if ack := e.one(known.build()); ack.Status != wire.AckAccepted || ack.Ledger != wire.LedgerBillable || ack.Accepted != 300 {
				t.Fatalf("known start %d: %+v, want billable 300", tc.known, ack)
			}
			if got := e.relayed(owner); got != 300 {
				t.Fatalf("known start billed %d, want 300", got)
			}
			if got := e.relayed(refused); got != 0 {
				t.Fatalf("unknown-start owner billed %d after a known allocation", got)
			}
		})
	}
}

func TestCoturnIngestAuthenticationAndValidation(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	good := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, stream: 10}.build()

	if code, _ := e.post("", cmRelayA, good); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := e.post("wrong", cmRelayA, good); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", code)
	}
	// A valid token of relay B cannot report as relay A, in the body or the snapshot.
	if code, _ := e.post(cmTokenB, cmRelayA, good); code != http.StatusForbidden {
		t.Fatalf("body relay mismatch: %d", code)
	}
	if code, resp := e.post(cmTokenB, cmRelayB, good); code != http.StatusOK || resp.Acks[0].Status != wire.AckRejected {
		t.Fatalf("snapshot relay mismatch: %d %+v", code, resp)
	}
	// Fleet node token is not a metering identity.
	if code, _ := e.post("fleet-secret", cmRelayA, good); code != http.StatusUnauthorized {
		t.Fatalf("fleet token accepted: %d", code)
	}

	tampered := good
	tampered.StreamSum, tampered.Cumulative = 10<<30, 10<<30
	if a := e.one(tampered); a.Status != wire.AckRejected {
		t.Fatalf("tampered (hash mismatch) snapshot: %+v", a)
	}
	notMax := good
	notMax.Cumulative = 99
	notMax.Hash = notMax.ComputeHash()
	if a := e.one(notMax); a.Status != wire.AckRejected {
		t.Fatalf("cumulative != max(components): %+v", a)
	}
	ghost := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000004", user: "0123456789abcdef0123456789abcdef", tag: "g4", seq: 1, stream: 10}.build()
	if a := e.one(ghost); a.Status != wire.AckGone {
		t.Fatalf("unknown owner: %+v", a)
	}
	e.deny["gx"] = "tag owner someone-else != reported"
	forged := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000005", user: a, tag: "gx", seq: 1, stream: 10}.build()
	if a := e.one(forged); a.Status != wire.AckRejected {
		t.Fatalf("forged attribution: %+v", a)
	}
	if got := e.relayed(a); got != 0 {
		t.Fatalf("refused snapshots billed %d", got)
	}

	// Request shape.
	var many []wire.Snapshot
	for i := range wire.MaxSnapshotsPerRequest + 1 {
		s := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: fmt.Sprintf("%018d", 1000+i), user: a, tag: "g1", seq: 1, stream: 1}.build()
		many = append(many, s)
	}
	if code, _ := e.post(cmTokenA, cmRelayA, many...); code != http.StatusBadRequest {
		t.Fatalf("oversized batch: %d", code)
	}
	if code, _ := e.post(cmTokenA, cmRelayA); code != http.StatusBadRequest {
		t.Fatalf("empty batch: %d", code)
	}
	req := httptest.NewRequest(http.MethodPost, wire.Path, strings.NewReader(`{"relayId":"coturn-central","snapshots":[],"extra":1}`))
	req.Header.Set("Authorization", "Bearer "+cmTokenA)
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, wire.Path, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", rec.Code)
	}
}

// A storage failure is a transient retry, never an acceptance.
func TestCoturnIngestStorageErrorIsRetry(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	s := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, stream: 10}.build()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ack := e.h.apply(ctx, cmRelayA, &s, cmSep30)
	if ack.Status != wire.AckRetry || ack.Accepted != 0 {
		t.Fatalf("storage error ack: %+v", ack)
	}
}

// The coturn ingest leaves node ledger semantics alone: a node cannot report
// into a coturn binding's alloc id (owner check: node_id differs), and its
// own reports keep their usual result.
func TestCoturnIngestDoesNotChangeNodeLedger(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	e.one(cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, stream: 100}.build())
	bs, _ := e.st.CoturnBindings(context.Background())
	n, err := e.st.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.st.RecordNodeUsage(context.Background(), UsageEvent{AllocID: bs[0].AllocID, Token: "g1", UserID: a, RelayedBytes: 1 << 30, RecordedAt: cmSep30, NodeID: n.ID, Billable: true},
		RelayAttribBudget{RatePerSec: 1 << 20, WindowSecs: 60})
	if err != ErrUsageAllocOwnerMismatch {
		t.Fatalf("node report into a coturn alloc: %v", err)
	}
	if got := e.relayed(a); got != 100 {
		t.Fatalf("billed %d, want 100", got)
	}
	if err := e.st.RecordUsage(context.Background(), UsageEvent{AllocID: "node-alloc-1", Token: "t", UserID: a, RelayedBytes: 50, RecordedAt: cmSep30, Billable: true}); err != nil {
		t.Fatal(err)
	}
	if got := e.relayed(a); got != 150 {
		t.Fatalf("RecordUsage after refactor: %d, want 150", got)
	}
}

func TestParseCoturnMeteringRelays(t *testing.T) {
	h := sha256.Sum256([]byte("x"))
	hx := hex.EncodeToString(h[:])
	h2 := sha256.Sum256([]byte("y"))
	hx2 := hex.EncodeToString(h2[:])
	m, err := ParseCoturnMeteringRelays(" coturn-central=" + hx + ", other=" + hx2)
	if err != nil || len(m) != 2 || m["coturn-central"] != h || m["other"] != h2 {
		t.Fatalf("parse: %v %v", m, err)
	}
	// One token must authenticate exactly one identity.
	for _, bad := range []string{"noeq", "a=zz", "a=" + hx[:10], "a=" + hx + ",a=" + hx, "bad id=" + hx, "a=" + hx + ",b=" + hx} {
		if _, err := ParseCoturnMeteringRelays(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// A token hash shared by two identities is refused by the direct constructor
// too; with distinct tokens, authentication is deterministic.
func TestCoturnIngestRelayTokensAreDistinct(t *testing.T) {
	st := newTestStore(t)
	shared := cmHash("same-token")
	if _, err := NewCoturnMeteringIngest(st, nil, CoturnMeteringConfig{
		Relays: map[string][32]byte{"relay-a": shared, "relay-b": shared}, Mode: CoturnMeteringShadow,
	}); err == nil || !strings.Contains(err.Error(), "share one token") {
		t.Fatalf("shared token hash accepted: %v", err)
	}
	if _, err := NewCoturnMeteringIngest(st, nil, CoturnMeteringConfig{
		Relays: map[string][32]byte{"bad id": cmHash("t")}, Mode: CoturnMeteringShadow,
	}); err == nil {
		t.Fatal("invalid relay id accepted")
	}
	e := newCMEnv(t, CoturnMeteringShadow, 0)
	a := e.user("a@example.com")
	for i := range 50 {
		for _, c := range []struct{ relay, token string }{{cmRelayA, cmTokenA}, {cmRelayB, cmTokenB}} {
			s := cmSnap{relay: c.relay, boot: cmBoot1, pid: 7, ticks: 77, sess: fmt.Sprintf("%018d", i), user: a, tag: "g", seq: 1, stream: 1}.build()
			if c.relay == cmRelayB {
				s = cmSnap{relay: c.relay, boot: cmBoot2, pid: 7, ticks: 77, sess: fmt.Sprintf("%018d", i), user: a, tag: "g", seq: 1, stream: 1}.build()
			}
			if code, resp := e.post(c.token, c.relay, s); code != http.StatusOK || resp.Acks[0].Status != wire.AckAccepted {
				t.Fatalf("%s round %d: %d %+v", c.relay, i, code, resp)
			}
		}
	}
}

// F1 money control: two relay identities observing the SAME provider
// allocation (same boot, PID, start, raw session) must never produce two
// ledger allocations. The first reporter owns it; the second is a conflict.
func TestCoturnIngestSameProviderAllocationAcrossRelaysBilledOnce(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	fromA := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, stream: 600}
	fromB := fromA
	fromB.relay = cmRelayB
	wantAck(t, e.one(fromA.build()), wire.AckAccepted, 600)
	if ack := e.one(fromB.build()); ack.Status != wire.AckConflict || ack.Accepted != 0 || ack.Ledger != "" {
		t.Fatalf("second relay on the same provider allocation: %+v", ack)
	}
	// Later snapshots from the second relay stay refused; the owner continues.
	fromB.seq, fromB.final, fromB.finalSeen = 2, 1000, true
	if ack := e.one(fromB.build()); ack.Status != wire.AckConflict {
		t.Fatalf("second relay final: %+v", ack)
	}
	fromA.seq, fromA.final, fromA.finalSeen = 2, 1000, true
	wantAck(t, e.one(fromA.build()), wire.AckAccepted, 1000)
	if got := e.relayed(a); got != 1000 {
		t.Fatalf("billed %d, want 1000 once", got)
	}
	if bs, _ := e.st.CoturnBindings(context.Background()); len(bs) != 1 || bs[0].RelayID != cmRelayA {
		t.Fatalf("bindings %+v", bs)
	}
	if !e.logged("another relay identity") {
		t.Fatal("cross-relay conflict not alerted")
	}
}

// The same, concurrently: both relays race the first sight of one provider
// allocation, many times over. Exactly one binding and one ledger amount.
func TestCoturnIngestCrossRelayRaceBillsOnce(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	for round := range 8 {
		sess := fmt.Sprintf("%018d", 500+round)
		var wg sync.WaitGroup
		var mu sync.Mutex
		statuses := map[string]int{}
		for i := range 16 {
			relay, token := cmRelayA, cmTokenA
			if i%2 == 1 {
				relay, token = cmRelayB, cmTokenB
			}
			s := cmSnap{relay: relay, boot: cmBoot1, pid: 9, ticks: 99, sess: sess, user: a, tag: "g", seq: 1, final: 777, finalSeen: true}.build()
			wg.Go(func() {
				body, _ := json.Marshal(wire.Request{RelayID: relay, Snapshots: []wire.Snapshot{s}})
				req := httptest.NewRequest(http.MethodPost, wire.Path, bytes.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+token)
				rec := httptest.NewRecorder()
				e.h.ServeHTTP(rec, req)
				var resp wire.Response
				json.Unmarshal(rec.Body.Bytes(), &resp)
				mu.Lock()
				if len(resp.Acks) == 1 {
					statuses[relay+"/"+resp.Acks[0].Status]++
				}
				mu.Unlock()
			})
		}
		wg.Wait()
		winners := 0
		for k := range statuses {
			if strings.HasSuffix(k, "/"+wire.AckAccepted) {
				winners++
			}
		}
		if winners != 1 {
			t.Fatalf("round %d: accepted by %d relays: %v", round, winners, statuses)
		}
	}
	if got := e.relayed(a); got != 8*777 {
		t.Fatalf("billed %d, want %d (each allocation once)", got, 8*777)
	}
	if bs, _ := e.st.CoturnBindings(context.Background()); len(bs) != 8 {
		t.Fatalf("%d bindings, want 8", len(bs))
	}
}

// Ingest JSON must end after exactly one value (Decoder.More misses a
// trailing '}' or ']'); the body bound still applies.
func TestCoturnIngestStrictJSONEOF(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringShadow, 0)
	a := e.user("a@example.com")
	good, _ := json.Marshal(wire.Request{RelayID: cmRelayA, Snapshots: []wire.Snapshot{
		cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, stream: 5}.build()}})
	post := func(body string) int {
		req := httptest.NewRequest(http.MethodPost, wire.Path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+cmTokenA)
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, bad := range []string{string(good) + "}", string(good) + "]", string(good) + "]]]garbage", string(good) + " {}", string(good) + " junk", "null", ""} {
		if code := post(bad); code == http.StatusOK {
			t.Fatalf("accepted %q", bad[max(0, len(bad)-20):])
		}
	}
	if code := post(string(good) + " \n\t "); code != http.StatusOK {
		t.Fatalf("trailing whitespace refused: %d", code)
	}
	if code := post(`{"relayId":"` + cmRelayA + `","snapshots":[` + strings.Repeat(" ", 1<<20) + `]}`); code != http.StatusBadRequest {
		t.Fatalf("oversized body: %d", code)
	}
}

// An inferred end (ended_unfinalized) may be followed by exactly one
// monotone final from the same allocation; nothing follows a final or an
// epoch end, and the upgrade bills only the remainder, once.
func TestCoturnIngestInferredEndUpgradesToFinalOnce(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	a := e.user("a@example.com")
	base := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1"}
	live, ended, final := base, base, base
	live.seq, live.stream = 1, 300
	ended.seq, ended.stream, ended.live, ended.state = 2, 300, 400, wire.StateEndedUnfinalized
	final.seq, final.stream, final.live, final.final, final.finalSeen = 3, 300, 400, 1000, true
	wantAck(t, e.one(live.build()), wire.AckAccepted, 300)
	wantAck(t, e.one(ended.build()), wire.AckAccepted, 400)
	wantAck(t, e.one(final.build()), wire.AckAccepted, 1000)
	wantAck(t, e.one(final.build()), wire.AckAccepted, 1000) // lost-ACK retry
	wantAck(t, e.one(ended.build()), wire.AckStale, 1000)    // reordered
	if got := e.relayed(a); got != 1000 {
		t.Fatalf("billed %d, want 1000", got)
	}
	after := final
	after.seq, after.final = 4, 1500
	if ack := e.one(after.build()); ack.Status != wire.AckConflict {
		t.Fatalf("change after a true final: %+v", ack)
	}

	// Epoch end is not upgradable; neither is an end followed by another end,
	// nor a final below the inferred lower bound.
	for i, c := range []struct {
		first     string
		second    string
		secondCum uint64
	}{
		{wire.StateEpochEnded, wire.StateFinal, 900},
		{wire.StateEndedUnfinalized, wire.StateEndedUnfinalized, 900},
		{wire.StateEndedUnfinalized, wire.StateFinal, 100},
	} {
		x := base
		x.sess, x.tag = fmt.Sprintf("%018d", 900+i), fmt.Sprintf("gx%d", i)
		x.seq, x.stream, x.state = 1, 400, c.first
		e.one(x.build())
		y := x
		y.seq, y.stream, y.state = 2, c.secondCum, c.second
		if c.second == wire.StateFinal {
			y.stream, y.final, y.finalSeen, y.state = 0, c.secondCum, true, ""
		}
		if ack := e.one(y.build()); ack.Status != wire.AckConflict {
			t.Fatalf("case %d (%s → %s %d): %+v", i, c.first, c.second, c.secondCum, ack)
		}
	}
	if got := e.relayed(a); got != 1000+3*400 {
		t.Fatalf("billed %d, want %d", got, 1000+3*400)
	}
}

// rawBinding reads every persisted column of the binding for one provider
// key, as stored (NULLs as "<null>").
func (e *cmEnv) rawBinding(sess string) map[string]string {
	e.t.Helper()
	rows, err := e.st.db.Query(`SELECT * FROM coturn_metering_bindings WHERE session_id = ?`, sess)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	if !rows.Next() {
		return nil
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		e.t.Fatal(err)
	}
	out := map[string]string{}
	for i, c := range cols {
		if vals[i] == nil {
			out[c] = "<null>"
		} else {
			out[c] = fmt.Sprint(vals[i])
		}
	}
	if rows.Next() {
		e.t.Fatal("two rows for one provider key")
	}
	return out
}

func (e *cmEnv) bindingCount() int {
	var n int
	e.st.db.QueryRow(`SELECT COUNT(*) FROM coturn_metering_bindings`).Scan(&n)
	return n
}

// Hard purge: every user-linked or traffic field of the purged user's
// bindings is erased; what remains (provider key, owning relay, purged) is a
// replay-denial tombstone. Nothing can revive, re-bill or recreate user data:
// not the next snapshot, a same-seq or older replay, a late final, another
// relay, in billable or shadow mode. Another user's binding is untouched.
func TestCoturnIngestPurgeErasesBindingUserData(t *testing.T) {
	for _, mode := range []string{CoturnMeteringBillable, CoturnMeteringShadow} {
		t.Run(mode, func(t *testing.T) {
			e := newCMEnv(t, mode, cmSep30-1000)
			ctx := context.Background()
			a := e.user("purged@example.com")
			b := e.user("kept@example.com")
			sa := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, stream: 100}
			sb := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: "001000000000000002", user: b, tag: "g2", seq: 1, stream: 50}
			s2 := sa
			s2.seq, s2.stream = 2, 300
			wantAck(t, e.one(sa.build()), wire.AckAccepted, 100)
			wantAck(t, e.one(s2.build()), wire.AckAccepted, 300)
			wantAck(t, e.one(sb.build()), wire.AckAccepted, 50)
			if r := e.rawBinding(cmSess1); r["user_id"] != a || r["username_hash"] == "<null>" {
				t.Fatalf("lifecycle link missing: %v", r)
			}
			if err := e.st.SetAccountDeletion(ctx, a, 1, 100); err != nil {
				t.Fatal(err)
			}
			if err := e.st.ArchiveAndPurgeUser(ctx, a, 200); err != nil {
				t.Fatal(err)
			}
			want := map[string]string{
				"relay_id": cmRelayA, "boot_id": cmBoot1, "pid": "7", "start_ticks": "77", "session_id": cmSess1,
				"user_id": "<null>", "username_hash": "<null>", "alloc_id": "<null>", "ledger": "shadow",
				"created_at": "0", "updated_at": "0", "last_seq": "0", "last_hash": "", "last_cumulative": "0",
				"accepted": "0", "terminal": "1", "last_state": "purged", "purged": "1",
			}
			check := func(when string) {
				t.Helper()
				r := e.rawBinding(cmSess1)
				if len(r) != len(want) {
					t.Fatalf("%s: tombstone has columns %v, want exactly %v", when, r, want)
				}
				for k, v := range want {
					if r[k] != v {
						t.Fatalf("%s: tombstone %s = %q, want %q (row %v)", when, k, r[k], v, r)
					}
				}
			}
			check("after purge")
			if r := e.rawBinding("001000000000000002"); r["user_id"] != b || r["accepted"] != "50" || r["purged"] != "0" {
				t.Fatalf("other user's binding changed: %v", r)
			}

			fin := sa
			fin.seq, fin.stream, fin.final, fin.finalSeen = 3, 300, 900, true
			other := fin
			other.relay = cmRelayB
			for name, sn := range map[string]wire.Snapshot{
				"next seq": fin.build(), "same-seq replay": s2.build(), "older replay": sa.build(), "other relay": other.build(),
			} {
				if ack := e.one(sn); ack.Status != wire.AckGone || ack.Accepted != 0 || ack.Ledger != "" {
					t.Fatalf("%s after purge: %+v", name, ack)
				}
			}
			check("after replays")
			// A never-bound allocation of the deleted account: refused, no row.
			fresh := cmSnap{relay: cmRelayA, boot: cmBoot2, pid: 8, ticks: 88, sess: "001000000000000003", user: a, tag: "g3", seq: 1, stream: 10}
			if ack := e.one(fresh.build()); ack.Status != wire.AckGone {
				t.Fatalf("never-bound snapshot of a deleted owner: %+v", ack)
			}
			if n := e.bindingCount(); n != 2 {
				t.Fatalf("%d bindings after purge and replays, want 2 (tombstone + other user)", n)
			}
			var userRows int
			e.st.db.QueryRow(`SELECT COUNT(*) FROM usage_events WHERE user_id=?`, a).Scan(&userRows)
			if userRows != 0 || e.relayed(a) != 0 {
				t.Fatalf("purged owner in the ledger: %d rows, %d bytes", userRows, e.relayed(a))
			}
		})
	}
}

// An owner purged mid-allocation is never revived or re-billed: the binding
// stays as an idempotent tombstone and later snapshots are refused.
func TestCoturnIngestPurgeMidAllocationNoRevival(t *testing.T) {
	e := newCMEnv(t, CoturnMeteringBillable, cmSep30-1000)
	ctx := context.Background()
	a := e.user("purged@example.com")
	s1 := cmSnap{relay: cmRelayA, boot: cmBoot1, pid: 7, ticks: 77, sess: cmSess1, user: a, tag: "g1", seq: 1, stream: 100}
	wantAck(t, e.one(s1.build()), wire.AckAccepted, 100)
	if err := e.st.SetAccountDeletion(ctx, a, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := e.st.ArchiveAndPurgeUser(ctx, a, 200); err != nil {
		t.Fatal(err)
	}
	if ev, p := e.ledgerRows(); ev != 0 || p != 0 {
		t.Fatalf("purge left ledger rows: %d %d", ev, p)
	}
	s2 := s1
	s2.seq, s2.stream = 2, 900
	if ack := e.one(s2.build()); ack.Status != wire.AckGone {
		t.Fatalf("snapshot after purge: %+v", ack)
	}
	if ack := e.one(s1.build()); ack.Status != wire.AckGone { // replay of the pre-purge snapshot
		t.Fatalf("replay after purge: %+v", ack)
	}
	if ev, p := e.ledgerRows(); ev != 0 || p != 0 {
		t.Fatalf("purged owner revived in the ledger: %d %d", ev, p)
	}
	if bs, _ := e.st.CoturnBindings(ctx); len(bs) != 1 || !bs[0].Purged || bs[0].UserID != "" || bs[0].UsernameHash != "" {
		t.Fatalf("tombstone binding: %+v", bs)
	}
}
