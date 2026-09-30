package account

// A-M8 (audit 2026-09-28): a heartbeat names, per usage entry, the account the
// allocation's bytes are billed to. Per-heartbeat and per-alloc clamps did not
// bound a stream of heartbeats minting fresh alloc ids, so a fleet-token holder
// could fill any victim's monthly relay quota at will. These tests pin the
// per-(node, user) wall-clock budget that closes that multiplier, and prove it
// does not eat a heavy but physically plausible relay.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// a_m8Base is mid-month, so nothing below crosses a usage_periods boundary.
var a_m8Base = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC).Unix()

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
	st := newTestStore(t)
	e := &a_m8Env{t: t, st: st, clock: a_m8Base}
	e.s = &Service{store: st, cfg: Config{NodeToken: "fleet-secret"}, now: func() time.Time {
		e.mu.Lock()
		defer e.mu.Unlock()
		return time.Unix(e.clock, 0)
	}}
	e.mux = http.NewServeMux()
	e.s.RegisterNodeRoutes(e.mux)
	return e
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

func (e *a_m8Env) heartbeat(nodeID string, usage []nodeUsage) {
	e.t.Helper()
	body, _ := json.Marshal(nodeHeartbeatReq{NodeID: nodeID, Status: "ok", Usage: usage})
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		e.t.Errorf("heartbeat: %d %s", w.Code, w.Body)
	}
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

// The attack: a forged stream — fresh alloc ids every heartbeat, one heartbeat
// per second for a minute — attributing to a victim. Whatever the cadence, the
// victim's recorded relay through that node is held to one window of burst plus
// the rate for the elapsed wall-clock time, and the exhausted budget is logged
// once per window, naming node and user.
func TestA_M8ForgedHeartbeatStreamCannotExceedWindowBudget(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("victim@a-m8.test")

	const beats = 60
	for i := 0; i < beats; i++ {
		e.set(a_m8Base + int64(i))
		e.heartbeat(node, forgedBatch(fmt.Sprintf("hb%d", i), victim))
	}
	budget := a_m8Capacity + relayAttribRatePerSec*(beats-1)
	got := e.recorded(victim, "")
	if got > budget {
		t.Fatalf("forged stream recorded %d bytes for the victim, over the window budget %d", got, budget)
	}
	// The budget is actually spent (the stream is not being dropped for some
	// other reason): everything up to it went through.
	if got != budget {
		t.Fatalf("forged stream recorded %d, want exactly the budget %d", got, budget)
	}
	// Without the budget the same stream would have put far more on the victim.
	if unbounded := int64(beats) * maxAllocsPerUser * maxFirstReportBytes; unbounded < 10*budget {
		t.Fatalf("test does not exercise the multiplier: unbounded %d vs budget %d", unbounded, budget)
	}
	warns := strings.Count(logs.String(), "exceeded the relay attribution budget")
	if warns != 1 {
		t.Fatalf("got %d budget warnings in one window, want exactly 1:\n%s", warns, logs)
	}
	if !strings.Contains(logs.String(), "node "+node+" exceeded the relay attribution budget for user "+victim) {
		t.Fatalf("warning does not name node and user:\n%s", logs)
	}

	// A new window logs again (once).
	e.set(a_m8Base + beats + relayAttribWindowSecs)
	e.heartbeat(node, forgedBatch("late", victim))
	e.heartbeat(node, forgedBatch("later", victim))
	if warns := strings.Count(logs.String(), "exceeded the relay attribution budget"); warns != 2 {
		t.Fatalf("got %d budget warnings after a second window, want 2", warns)
	}
}

// Heartbeat cadence must not multiply the budget: a burst of heartbeats at the
// same instant — including concurrent ones — records no more than one window.
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
		t.Fatalf("burst at one instant recorded %d, want exactly one window %d", got, a_m8Capacity)
	}
}

// Positive control: a heavy, physically plausible relay — eight allocations
// (four concurrent double-relayed transfers; the concurrency the budget is
// justified by, written out literally so lowering the constant fails here)
// all at the per-alloc ceiling for
// two hours, rotating to fresh alloc ids every ten minutes as transfers end —
// is recorded to the byte. So is a node's catch-up after an hour offline with
// a transfer running at the per-alloc ceiling throughout.
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
		into := tsec - gen*transferSecs // seconds into the current transfers
		var usage []nodeUsage
		for a := 0; a < legitAllocs; a++ {
			// The just-closed generation's final total is re-sent once, as
			// the node does until central acknowledges it.
			if into == interval && gen > 0 {
				usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("g%d-a%d", gen-1, a),
					Username: a_m8Username(user), RelayedBytes: int64(maxRelayBytesPerSec) * transferSecs})
			}
			usage = append(usage, nodeUsage{AllocID: fmt.Sprintf("g%d-a%d", gen, a),
				Username: a_m8Username(user), RelayedBytes: int64(maxRelayBytesPerSec) * into})
		}
		e.heartbeat(node, usage)
		want += legitAllocs * perBeat
	}
	if got := e.recorded(user, node); got != want {
		t.Fatalf("plausible heavy relay recorded %d, want every byte %d (lost %d)", got, want, want-got)
	}

	// Catch-up: an hour offline, one transfer at the per-alloc ceiling, then
	// one heartbeat carrying its cumulative total.
	start := a_m8Base + total + 60
	e.set(start)
	e.heartbeat(node, []nodeUsage{{AllocID: "outage", Username: a_m8Username(user), RelayedBytes: int64(maxRelayBytesPerSec) * interval}})
	e.set(start + 3600)
	final := int64(maxRelayBytesPerSec) * (interval + 3600)
	e.heartbeat(node, []nodeUsage{{AllocID: "outage", Username: a_m8Username(user), RelayedBytes: final}})
	want += final
	if got := e.recorded(user, node); got != want {
		t.Fatalf("catch-up after an outage recorded %d total, want %d (lost %d)", got, want, want-got)
	}
	if strings.Contains(logs.String(), "exceeded the relay attribution budget") {
		t.Fatalf("a plausible relay tripped the budget warning:\n%s", logs)
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

	e.heartbeat(nodeA, forgedBatch("a", victim))
	e.heartbeat(nodeA, forgedBatch("a2", victim))
	if got := e.recorded(victim, nodeA); got != a_m8Capacity {
		t.Fatalf("victim via node A = %d, want exhausted at %d", got, a_m8Capacity)
	}
	e.heartbeat(nodeB, forgedBatch("b", victim))
	if got := e.recorded(victim, nodeB); got != a_m8Capacity {
		t.Fatalf("victim via node B = %d, want its own full budget %d", got, a_m8Capacity)
	}
	e.heartbeat(nodeA, []nodeUsage{{AllocID: "o1", Username: a_m8Username(other), RelayedBytes: 5 << 20}})
	if got := e.recorded(other, nodeA); got != 5<<20 {
		t.Fatalf("other user via node A = %d, want 5 MiB unaffected by the victim's budget", got)
	}
}

// Grants the ledger does not use go back to the bucket: an entry RecordUsage
// refuses (an alloc owned by someone else) or clamps harder (the first-report
// cap) must not burn budget that the next entries legitimately need.
func TestA_M8UnusedGrantIsReturnedToTheBudget(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("user@a-m8.test")
	owner := e.user("owner@a-m8.test")
	ctx := context.Background()

	e.set(a_m8Base)
	if err := e.st.RecordUsage(ctx, UsageEvent{AllocID: "taken", Token: "t", UserID: owner, RelayedBytes: 1,
		RecordedAt: a_m8Base - 10, NodeID: node, Billable: true}); err != nil {
		t.Fatal(err)
	}
	// Refused: someone else's alloc, reporting a whole window for user.
	e.heartbeat(node, []nodeUsage{{AllocID: "taken", Username: a_m8Username(user), RelayedBytes: a_m8Capacity}})
	if got := e.recorded(user, ""); got != 0 {
		t.Fatalf("refused entry recorded %d for user", got)
	}
	// Each forged entry is granted the whole remaining window but recorded at
	// only maxFirstReportBytes; the rest must flow to the following entries.
	e.heartbeat(node, forgedBatch("f", user))
	if got := e.recorded(user, ""); got != a_m8Capacity {
		t.Fatalf("after refunds recorded %d, want the whole window %d", got, a_m8Capacity)
	}
}

// The budget row is pruned once idle for a full window (its level has drained
// to 0 by then, so pruning changes no budget) — a user id does not linger.
func TestA_M8IdleBudgetRowsArePruned(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	nodeA, nodeB := e.fleetNode(), e.fleetNode()
	user := e.user("user@a-m8.test")
	e.set(a_m8Base)
	e.heartbeat(nodeA, forgedBatch("x", user))
	count := func() int {
		var n int
		if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM relay_attrib_budget WHERE user_id=?`, user).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count() != 1 {
		t.Fatalf("expected one budget row after attribution")
	}
	e.set(a_m8Base + relayAttribWindowSecs + 1)
	e.heartbeat(nodeB, []nodeUsage{{AllocID: "y", Username: a_m8Username(e.user("z@a-m8.test")), RelayedBytes: 1}})
	if n := count(); n != 0 {
		t.Fatalf("idle budget row for user not pruned after a window: %d", n)
	}
	// And the drained budget is whole again.
	e.heartbeat(nodeA, forgedBatch("x2", user))
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
	post := func(usage []nodeUsage) {
		body, _ := json.Marshal(nodeHeartbeatReq{NodeID: n.ID, Status: "ok", Usage: usage})
		r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer usertok")
		w := httptest.NewRecorder()
		e.mux.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("user-node heartbeat: %d %s", w.Code, w.Body)
		}
	}
	post(forgedBatch("v", victim))
	if got := e.recorded(victim, ""); got != 0 {
		t.Fatalf("BYO node attributed %d to a foreign user", got)
	}
	post(forgedBatch("o", owner))
	post(forgedBatch("o2", owner))
	if got := e.recorded(owner, n.ID); got != a_m8Capacity {
		t.Fatalf("BYO owner recorded %d, want held to the window %d", got, a_m8Capacity)
	}
}
