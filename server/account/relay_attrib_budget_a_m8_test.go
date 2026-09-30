package account

// A-M8 (audit 2026-09-28): a heartbeat names, per usage entry, the account the
// allocation's bytes are billed to. Per-heartbeat and per-alloc clamps did not
// bound a stream of heartbeats minting fresh alloc ids, so a fleet-token holder
// could fill any victim's monthly relay quota at will. These tests pin the
// per-(node, user) wall-clock budget, charged inside the ledger write's own
// transaction, that closes that multiplier — and prove it does not eat a heavy
// but physically plausible relay, including a whole node's catch-up after an
// hour offline.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// a_m8Base is mid-month, so nothing below crosses a usage_periods boundary.
var a_m8Base = time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC).Unix()

const a_m8Capacity = relayAttribRatePerSec * relayAttribWindowSecs

type a_m8Env struct {
	t     *testing.T
	s     *Service
	st    *SQLiteStore
	mux   *http.ServeMux
	mu    sync.Mutex
	clock int64
}

func newA_M8Env(t *testing.T) *a_m8Env {
	t.Helper()
	e := &a_m8Env{t: t, st: newTestStore(t), clock: a_m8Base}
	e.restart()
	return e
}

// restart replaces the Service (and its mux) over the same store, as a
// central process restart would.
func (e *a_m8Env) restart() {
	e.s = &Service{store: e.st, cfg: Config{NodeToken: "fleet-secret"}, now: func() time.Time {
		e.mu.Lock()
		defer e.mu.Unlock()
		return time.Unix(e.clock, 0)
	}}
	e.mux = http.NewServeMux()
	e.s.RegisterNodeRoutes(e.mux)
}

func (e *a_m8Env) set(at int64) { e.mu.Lock(); e.clock = at; e.mu.Unlock() }

func (e *a_m8Env) fleetNode() string {
	e.t.Helper()
	n, err := e.st.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		e.t.Fatal(err)
	}
	return n.ID
}

func (e *a_m8Env) user(email string) string {
	e.t.Helper()
	u, err := e.st.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

func a_m8Username(userID string) string { return "6000:" + userID + ".123456" }

// post sends a heartbeat and returns the HTTP status and the response's OK.
func (e *a_m8Env) post(bearer, nodeID string, usage []nodeUsage) (int, bool) {
	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: nodeID, Status: "ok", Usage: usage})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+bearer)
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	var resp nodeHeartbeatResp
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	return w.Code, resp.OK
}

// heartbeat is a fleet heartbeat that must be answered 200; it returns OK.
func (e *a_m8Env) heartbeat(nodeID string, usage []nodeUsage) bool {
	e.t.Helper()
	code, ok := e.post("fleet-secret", nodeID, usage)
	if code != http.StatusOK {
		e.t.Errorf("heartbeat: %d", code)
	}
	return ok
}

// recorded is every usage_periods byte attributed to userID, optionally only
// through nodeID (billable or not, so nothing can hide in another bucket).
func (e *a_m8Env) recorded(userID, nodeID string) int64 {
	e.t.Helper()
	q := `SELECT COALESCE(SUM(bytes),0) FROM usage_periods WHERE user_id=?`
	args := []any{userID}
	if nodeID != "" {
		q += ` AND node_id=?`
		args = append(args, nodeID)
	}
	var n int64
	if err := e.st.db.QueryRow(q, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *a_m8Env) budgetRows(userID string) int {
	e.t.Helper()
	var n int
	if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM relay_attrib_budget WHERE user_id=?`, userID).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// forgedBatch is what a fleet-token holder can send in one heartbeat: the
// per-user entry limit's worth of never-seen alloc ids, each claiming far more
// than any first report may record.
func forgedBatch(prefix, victim string) []nodeUsage {
	out := make([]nodeUsage, maxAllocsPerUser)
	for i := range out {
		out[i] = nodeUsage{AllocID: fmt.Sprintf("%s-%d", prefix, i), Username: a_m8Username(victim), RelayedBytes: 1 << 50}
	}
	return out
}

func a_m8CaptureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

const a_m8WarnText = "exceeded the relay attribution budget"

// The attack: a forged stream — fresh alloc ids every heartbeat, one heartbeat
// per second for a minute — attributing to a victim. Whatever the cadence, the
// victim's recorded relay through that node is held to one bucket of burst
// plus the rate for the elapsed wall-clock time; the exhausted budget is
// logged once per window, naming node and user, and answered OK:false.
func TestA_M8ForgedHeartbeatStreamCannotExceedWindowBudget(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("victim@a-m8.test")

	const beats = 60
	lastOK := true
	for i := 0; i < beats; i++ {
		e.set(a_m8Base + int64(i))
		lastOK = e.heartbeat(node, forgedBatch(fmt.Sprintf("hb%d", i), victim))
	}
	budget := a_m8Capacity + relayAttribRatePerSec*(beats-1)
	got := e.recorded(victim, "")
	if got > budget {
		t.Fatalf("forged stream recorded %d bytes for the victim, over the window budget %d", got, budget)
	}
	if got != budget {
		t.Fatalf("forged stream recorded %d, want exactly the budget %d", got, budget)
	}
	if unbounded := int64(beats) * maxAllocsPerUser * maxFirstReportBytes; unbounded < 5*budget {
		t.Fatalf("test does not exercise the multiplier: unbounded %d vs budget %d", unbounded, budget)
	}
	if lastOK {
		t.Fatalf("a heartbeat whose bytes were withheld answered OK:true")
	}
	if warns := strings.Count(logs.String(), a_m8WarnText); warns != 1 {
		t.Fatalf("got %d budget warnings in one window, want exactly 1:\n%s", warns, logs)
	}
	if !strings.Contains(logs.String(), "node "+node+" "+a_m8WarnText+" for user "+victim) {
		t.Fatalf("warning does not name node and user:\n%s", logs)
	}
	e.set(a_m8Base + beats + relayAttribWindowSecs)
	for i := 0; i < 5; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("late%d", i), victim))
	}
	if warns := strings.Count(logs.String(), a_m8WarnText); warns != 2 {
		t.Fatalf("got %d budget warnings after a second window, want 2", warns)
	}
}

// The per-report slack multiplier: ONE alloc re-reported many times at the
// same instant gains relayReportSlack per report from the per-alloc clamp
// alone (4000 x 256 MiB = 1000 GiB). The budget holds it to one bucket.
func TestA_M8SameAllocSlackStreamIsBudgeted(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("victim@a-m8.test")
	const reports = 4000
	if unbounded := int64(reports) * relayReportSlack; unbounded <= a_m8Capacity {
		t.Fatalf("test does not exceed the bucket: %d vs %d", unbounded, a_m8Capacity)
	}
	e.set(a_m8Base)
	e.heartbeat(node, []nodeUsage{{AllocID: "one", Username: a_m8Username(victim), RelayedBytes: 1}})
	for i := 0; i < reports; i++ {
		e.heartbeat(node, []nodeUsage{{AllocID: "one", Username: a_m8Username(victim), RelayedBytes: 1 << 50}})
	}
	if got := e.recorded(victim, ""); got != a_m8Capacity {
		t.Fatalf("slack stream on one alloc recorded %d, want held to the bucket %d", got, a_m8Capacity)
	}
}

// Heartbeat cadence must not multiply the budget: a burst of heartbeats at the
// same instant — including concurrent ones — records no more than one bucket.
func TestA_M8HeartbeatBurstAtOneInstantIsHeldToOneWindow(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("victim@a-m8.test")

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			e.heartbeat(node, forgedBatch(fmt.Sprintf("c%d", i), victim))
		}(i)
	}
	wg.Wait()
	for i := 0; i < 16; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("s%d", i), victim))
	}
	if got := e.recorded(victim, ""); got != a_m8Capacity {
		t.Fatalf("burst at one instant recorded %d, want exactly one bucket %d", got, a_m8Capacity)
	}
}

// Concurrent duplicate reports of ONE alloc are fail-safe: recorded once, and
// the bucket is charged once.
func TestA_M8ConcurrentDuplicateReportsChargeOnce(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("dup@a-m8.test")
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.heartbeat(node, []nodeUsage{{AllocID: "dup", Username: a_m8Username(user), RelayedBytes: 1 << 30}})
		}()
	}
	wg.Wait()
	if got := e.recorded(user, ""); got != 1<<30 {
		t.Fatalf("duplicate reports recorded %d, want %d", got, 1<<30)
	}
	var level int64
	if err := e.st.db.QueryRow(`SELECT level FROM relay_attrib_budget WHERE user_id=?`, user).Scan(&level); err != nil {
		t.Fatal(err)
	}
	if level != 1<<30 {
		t.Fatalf("bucket charged %d for one alloc's %d bytes", level, 1<<30)
	}
}

// Positive control 1: a heavy, physically plausible relay — eight allocations
// (four concurrent double-relayed transfers; written out literally so lowering
// the constant fails here) all at the per-alloc ceiling for two hours, rotating
// to fresh alloc ids every ten minutes as transfers end — is recorded to the
// byte, with every heartbeat answered OK.
func TestA_M8PlausibleHeavyRelayIsFullyRecorded(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("heavy@a-m8.test")

	const legitAllocs = 8
	const interval = int64(nodeHeartbeatInterval)
	const transferSecs = int64(600)
	const total = int64(7200)
	perBeat := int64(maxRelayBytesPerSec) * interval
	var want int64
	for tsec := interval; tsec <= total; tsec += interval {
		e.set(a_m8Base + tsec)
		gen := (tsec - 1) / transferSecs
		into := tsec - gen*transferSecs
		var usage []nodeUsage
		for a := 0; a < legitAllocs; a++ {
			if into == interval && gen > 0 {
				usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("g%d-a%d", gen-1, a),
					Username: a_m8Username(user), RelayedBytes: int64(maxRelayBytesPerSec) * transferSecs})
			}
			usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("g%d-a%d", gen, a),
				Username: a_m8Username(user), RelayedBytes: int64(maxRelayBytesPerSec) * into})
		}
		if !e.heartbeat(node, usage) {
			t.Fatalf("plausible heartbeat at t=%d answered OK:false", tsec)
		}
		want += legitAllocs * perBeat
	}
	if got := e.recorded(user, node); got != want {
		t.Fatalf("plausible heavy relay recorded %d, want every byte %d (lost %d)", got, want, want-got)
	}
	if strings.Contains(logs.String(), a_m8WarnText) {
		t.Fatalf("a plausible relay tripped the budget warning:\n%s", logs)
	}
}

// Positive control 2: the whole plausible load catching up together — eight
// allocations at the per-alloc ceiling through a 60-minute reporting outage,
// four of which closed during it (their reports are final totals) — is
// recorded to the byte in the one catch-up heartbeat, answered OK.
func TestA_M8EightAllocsCatchUpAfterAnHourOutage(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("outage@a-m8.test")
	const legitAllocs = 8
	rate := int64(maxRelayBytesPerSec)
	interval := int64(nodeHeartbeatInterval)

	// Steady before the outage.
	e.set(a_m8Base + interval)
	var usage []nodeUsage
	for a := 0; a < legitAllocs; a++ {
		usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("o%d", a), Username: a_m8Username(user), RelayedBytes: rate * interval})
	}
	e.heartbeat(node, usage)
	// 60 minutes offline; four allocs ran the whole time, four closed at the
	// end of it (same bytes; their report is final).
	e.set(a_m8Base + interval + 3600)
	usage = usage[:0]
	for a := 0; a < legitAllocs; a++ {
		usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("o%d", a), Username: a_m8Username(user), RelayedBytes: rate * (interval + 3600)})
	}
	if !e.heartbeat(node, usage) {
		t.Fatalf("an hour's catch-up of the plausible load answered OK:false")
	}
	want := int64(legitAllocs) * rate * (interval + 3600)
	if got := e.recorded(user, node); got != want {
		t.Fatalf("catch-up recorded %d, want %d (lost %d)", got, want, want-got)
	}
	if strings.Contains(logs.String(), a_m8WarnText) {
		t.Fatalf("an hour's catch-up tripped the budget warning:\n%s", logs)
	}
}

// Beyond the bucket, withheld CLOSED finals stay retryable: the heartbeat
// answers OK:false, a node that retains unacknowledged finals resends them,
// and every byte is recorded as the bucket drains.
func TestA_M8WithheldFinalsAreRecordedOnResend(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("retry@a-m8.test")
	const legitAllocs = 8
	rate := int64(maxRelayBytesPerSec)
	interval := int64(nodeHeartbeatInterval)
	start := a_m8Base
	e.set(start + interval)
	var usage []nodeUsage
	for a := 0; a < legitAllocs; a++ {
		usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("r%d", a), Username: a_m8Username(user), RelayedBytes: rate * interval})
	}
	e.heartbeat(node, usage)
	// 90 minutes offline; every alloc closed at the end: all finals.
	final := rate * (interval + 5400)
	for i := range usage {
		usage[i].RelayedBytes = final
	}
	now := start + interval + 5400
	e.set(now)
	if e.heartbeat(node, usage) {
		t.Fatalf("a heartbeat with withheld finals answered OK:true — the node would evict them")
	}
	want := int64(legitAllocs) * final
	if got := e.recorded(user, node); got >= want {
		t.Fatalf("expected the first catch-up to be partly withheld, recorded %d of %d", got, want)
	}
	// The node keeps and resends the same finals every heartbeat until OK.
	ok := false
	for i := 0; i < 500 && !ok; i++ {
		now += interval
		e.set(now)
		ok = e.heartbeat(node, usage)
	}
	if !ok {
		t.Fatalf("resent finals never acknowledged")
	}
	if got := e.recorded(user, node); got != want {
		t.Fatalf("resent finals recorded %d, want every byte %d (lost %d)", got, want, want-got)
	}
}

// Budgets are per (node, user): exhausting one pair leaves the same victim's
// budget on another node, and another user's on the same node, untouched.
func TestA_M8BudgetsAreIndependentPerNodeAndUser(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	nodeA, nodeB := e.fleetNode(), e.fleetNode()
	victim := e.user("victim@a-m8.test")
	other := e.user("other@a-m8.test")

	for i := 0; i < 5; i++ {
		e.heartbeat(nodeA, forgedBatch(fmt.Sprintf("a%d", i), victim))
	}
	if got := e.recorded(victim, nodeA); got != a_m8Capacity {
		t.Fatalf("victim via node A = %d, want exhausted at %d", got, a_m8Capacity)
	}
	for i := 0; i < 5; i++ {
		e.heartbeat(nodeB, forgedBatch(fmt.Sprintf("b%d", i), victim))
	}
	if got := e.recorded(victim, nodeB); got != a_m8Capacity {
		t.Fatalf("victim via node B = %d, want its own full budget %d", got, a_m8Capacity)
	}
	e.heartbeat(nodeA, []nodeUsage{{AllocID: "o1", Username: a_m8Username(other), RelayedBytes: 5 << 20}})
	if got := e.recorded(other, nodeA); got != 5<<20 {
		t.Fatalf("other user via node A = %d, want 5 MiB unaffected by the victim's budget", got)
	}
}

// A restart does not refill the budget: it lives in the store.
func TestA_M8BudgetSurvivesRestart(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("victim@a-m8.test")
	for i := 0; i < 5; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("p%d", i), victim))
	}
	e.restart()
	for i := 0; i < 5; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("q%d", i), victim))
	}
	if got := e.recorded(victim, ""); got != a_m8Capacity {
		t.Fatalf("after a restart recorded %d, want still held to %d", got, a_m8Capacity)
	}
}

// Negative reports: refused at the heartbeat (400, nothing written) and by
// the store; and a negative high-water an older binary may have stored cannot
// be used to make an increment wrap — Codex's sequence: MinInt64 then 1 on a
// fresh alloc, then many fresh allocs at maxFirstReportBytes, stays within the
// budget.
func TestA_M8NegativeReportsCannotOpenHeadroom(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("victim@a-m8.test")
	ctx := context.Background()

	code, _ := e.post("fleet-secret", node, []nodeUsage{
		{AllocID: "fine", Username: a_m8Username(victim), RelayedBytes: 10},
		{AllocID: "neg", Username: a_m8Username(victim), RelayedBytes: math.MinInt64},
	})
	if code != http.StatusBadRequest {
		t.Fatalf("negative report answered %d, want 400", code)
	}
	var rows int
	if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("a rejected heartbeat wrote %d usage rows", rows)
	}
	if err := e.st.RecordUsage(ctx, UsageEvent{AllocID: "neg", Token: "t", UserID: victim, RelayedBytes: math.MinInt64,
		RecordedAt: a_m8Base, NodeID: node, Billable: true}); !errors.Is(err, ErrUsageNegativeBytes) {
		t.Fatalf("store accepted a negative report: %v", err)
	}
	// A negative high-water as an older binary could have stored it.
	if _, err := e.st.db.Exec(`INSERT INTO usage_events (alloc_id, token, user_id, relayed_bytes, recorded_at, node_id, billable)
		VALUES ('neg', 't', ?, ?, ?, ?, 1)`, victim, int64(math.MinInt64), a_m8Base, node); err != nil {
		t.Fatal(err)
	}
	e.set(a_m8Base)
	e.heartbeat(node, []nodeUsage{{AllocID: "neg", Username: a_m8Username(victim), RelayedBytes: 1}})
	if got := e.recorded(victim, ""); got != 1 {
		t.Fatalf("report of 1 on a negative high-water recorded %d, want 1", got)
	}
	for i := 0; i < 10; i++ {
		var usage []nodeUsage
		for j := 0; j < maxAllocsPerUser; j++ {
			usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("m%d-%d", i, j), Username: a_m8Username(victim), RelayedBytes: maxFirstReportBytes})
		}
		e.heartbeat(node, usage)
	}
	if got := e.recorded(victim, ""); got > a_m8Capacity {
		t.Fatalf("after the negative sequence recorded %d, over budget %d", got, a_m8Capacity)
	}
}

// Attribution to a user id that does not exist creates no budget state: the
// ledger's foreign key refuses the row and the bucket write rolls back with it.
func TestA_M8NonexistentUserCreatesNoBudgetRow(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	e.heartbeat(node, forgedBatch("ghost", "ghost-user-id"))
	if n := e.budgetRows("ghost-user-id"); n != 0 {
		t.Fatalf("nonexistent user got %d budget rows", n)
	}
}

// Both account purges delete the user's budget rows, with no later heartbeat.
func TestA_M8PurgesDeleteBudgetRows(t *testing.T) {
	a_m8CaptureLog(t)
	for _, which := range []string{"transient", "archive"} {
		t.Run(which, func(t *testing.T) {
			e := newA_M8Env(t)
			node := e.fleetNode()
			user := e.user("purge-" + which + "@a-m8.test")
			keep := e.user("keep-" + which + "@a-m8.test")
			e.heartbeat(node, forgedBatch("x", user))
			e.heartbeat(node, forgedBatch("k", keep))
			if e.budgetRows(user) != 1 {
				t.Fatalf("expected a budget row before purge")
			}
			ctx := context.Background()
			var err error
			if which == "transient" {
				_, err = e.st.PurgeTransientUserData(ctx, user)
			} else {
				if err := e.st.SetAccountDeletion(ctx, user, 1, a_m8Base+5); err != nil {
					t.Fatalf("schedule deletion: %v", err)
				}
				err = e.st.ArchiveAndPurgeUser(ctx, user, a_m8Base+10)
				var n int
				if qerr := e.st.db.QueryRow(`SELECT COUNT(*) FROM users WHERE id=?`, user).Scan(&n); qerr != nil || n != 0 {
					t.Fatalf("archive purge did not delete the user (n=%d, %v)", n, qerr)
				}
			}
			if err != nil {
				t.Fatalf("purge: %v", err)
			}
			if n := e.budgetRows(user); n != 0 {
				t.Fatalf("%s purge left %d budget rows for the user", which, n)
			}
			if e.budgetRows(keep) != 1 {
				t.Fatalf("%s purge removed another user's budget row", which)
			}
		})
	}
}

// Rows idle for a full window are pruned by the next heartbeat (their level
// has drained to 0, so pruning changes no budget).
func TestA_M8IdleBudgetRowsArePruned(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	nodeA, nodeB := e.fleetNode(), e.fleetNode()
	user := e.user("user@a-m8.test")
	e.set(a_m8Base)
	for i := 0; i < 5; i++ {
		e.heartbeat(nodeA, forgedBatch(fmt.Sprintf("x%d", i), user))
	}
	if e.budgetRows(user) != 1 {
		t.Fatalf("expected one budget row after attribution")
	}
	e.set(a_m8Base + relayAttribWindowSecs + 1)
	e.heartbeat(nodeB, nil)
	if n := e.budgetRows(user); n != 0 {
		t.Fatalf("idle budget row not pruned after a window: %d", n)
	}
	for i := 0; i < 5; i++ {
		e.heartbeat(nodeA, forgedBatch(fmt.Sprintf("y%d", i), user))
	}
	if got := e.recorded(user, nodeA); got != 2*a_m8Capacity {
		t.Fatalf("after a full idle window recorded %d, want %d", got, 2*a_m8Capacity)
	}
}

// A BYO node's cross-user attribution is still dropped before the budget, and
// its own owner is still budgeted (exempt from nothing).
func TestA_M8UserNodeStaysOwnerOnlyAndBudgeted(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	ctx := context.Background()
	owner := e.user("owner@a-m8.test")
	victim := e.user("victim@a-m8.test")
	if err := e.st.CreateNodeToken(ctx, NodeToken{ID: "t1", TokenHash: authx.HashToken("usertok"), UserID: owner, Name: "n", CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	e.s.cfg.EnableUserNodes = true
	n, err := e.st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: owner, URLs: []string{"turn:y:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if code, _ := e.post("usertok", n.ID, forgedBatch(fmt.Sprintf("v%d", i), victim)); code != http.StatusOK {
			t.Fatalf("user-node heartbeat: %d", code)
		}
	}
	if got := e.recorded(victim, ""); got != 0 {
		t.Fatalf("BYO node attributed %d to a foreign user", got)
	}
	for i := 0; i < 5; i++ {
		e.post("usertok", n.ID, forgedBatch(fmt.Sprintf("o%d", i), owner))
	}
	if got := e.recorded(owner, n.ID); got != a_m8Capacity {
		t.Fatalf("BYO owner recorded %d, want held to the bucket %d", got, a_m8Capacity)
	}
}
