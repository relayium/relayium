package account

// A-M8 (audit 2026-09-28): a heartbeat names, per usage entry, the account the
// allocation's bytes are billed to. Per-heartbeat and per-alloc clamps did not
// bound a stream of heartbeats minting fresh alloc ids, so a fleet-token holder
// could fill any victim's monthly relay quota at will. These tests pin the
// per-(node, user) wall-clock budget, charged inside the ledger write's own
// transaction, that closes that multiplier — and prove it does not eat a heavy
// but physically plausible relay, including a whole node's catch-up after an
// hour offline, and that bytes beyond the bucket are deferred centrally (owed)
// rather than refused to the node.

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

// owed is the pair's owed backlog, checked against the rows it summarizes.
func (e *a_m8Env) owed(nodeID, userID string) int64 {
	e.t.Helper()
	var col, rows int64
	if err := e.st.db.QueryRow(`SELECT COALESCE((SELECT owed FROM relay_attrib_budget WHERE node_id=? AND user_id=?),0)`, nodeID, userID).Scan(&col); err != nil {
		e.t.Fatal(err)
	}
	if err := e.st.db.QueryRow(`SELECT COALESCE(SUM(bytes),0) FROM relay_attrib_owed WHERE node_id=? AND user_id=?`, nodeID, userID).Scan(&rows); err != nil {
		e.t.Fatal(err)
	}
	if col != rows {
		e.t.Fatalf("owed column %d disagrees with owed rows %d", col, rows)
	}
	return col
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
	if !lastOK {
		t.Fatalf("an over-budget heartbeat answered OK:false — the node would retain every final it carried")
	}
	if owed := e.owed(node, victim); owed != a_m8Capacity {
		t.Fatalf("owed backlog %d, want capped at one bucket %d", owed, a_m8Capacity)
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

// Beyond the bucket, closed finals are acknowledged at once (OK:true) and
// their withheld bytes are kept centrally: the node never sends them again,
// and upkeep on later heartbeats — which carry no usage at all — records
// every byte, each in the month it was relayed.
func TestA_M8DeferredFinalsAreRecordedWithoutResend(t *testing.T) {
	logs := a_m8CaptureLog(t)
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
	if !e.heartbeat(node, usage) {
		t.Fatalf("a heartbeat with deferred finals answered OK:false")
	}
	want := int64(legitAllocs) * final
	got := e.recorded(user, node)
	if got >= want || got+e.owed(node, user) != want {
		t.Fatalf("after the catch-up: recorded %d + owed %d, want recorded < %d and the sum exact", got, e.owed(node, user), want)
	}
	if !strings.Contains(logs.String(), a_m8WarnText) {
		t.Fatalf("deferral was not logged")
	}
	// The finals were acknowledged; the node only sends empty heartbeats now.
	for i := 0; i < 500 && e.owed(node, user) > 0; i++ {
		now += interval
		e.set(now)
		e.heartbeat(node, nil)
	}
	if got := e.recorded(user, node); got != want {
		t.Fatalf("deferred finals recorded %d, want every byte %d (lost %d)", got, want, want-got)
	}
	if e.owed(node, user) != 0 {
		t.Fatalf("owed backlog not drained")
	}
}

// Codex round 2: one user over budget must not hold up anyone else. User A
// runs nine allocs at the per-alloc ceiling (above the budget rate) after a
// 90-minute outage and keeps going; user B closes one allocation every
// heartbeat. Every heartbeat is answered OK, so the node retires B's finals at
// once, and B's bytes are recorded in full the heartbeat they arrive.
func TestA_M8OverBudgetUserDoesNotHoldUpOthers(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	heavy := e.user("heavy@a-m8.test")
	other := e.user("other@a-m8.test")
	rate := int64(maxRelayBytesPerSec)
	interval := int64(nodeHeartbeatInterval)
	now := a_m8Base + interval
	e.set(now)
	var a []nodeUsage
	for i := 0; i < 9; i++ {
		a = append(a, nodeUsage{AllocID: fmt.Sprintf("h%d", i), Username: a_m8Username(heavy), RelayedBytes: rate * interval})
	}
	e.heartbeat(node, a)
	elapsed := interval + 5400
	var otherWant int64
	for beat := 0; beat < 200; beat++ {
		now = a_m8Base + elapsed
		e.set(now)
		for i := range a {
			a[i].RelayedBytes = rate * elapsed
		}
		final := nodeUsage{AllocID: fmt.Sprintf("b%d", beat), Username: a_m8Username(other), RelayedBytes: 100 << 20}
		if !e.heartbeat(node, append(append([]nodeUsage{}, a...), final)) {
			t.Fatalf("heartbeat %d answered OK:false while one user was over budget — the node would retain the other user's final", beat)
		}
		otherWant += 100 << 20
		if got := e.recorded(other, node); got != otherWant {
			t.Fatalf("heartbeat %d: other user's finals recorded %d, want %d", beat, got, otherWant)
		}
		elapsed += interval
	}
	if e.owed(node, heavy) == 0 {
		t.Fatalf("the heavy user was never over budget; the test does not exercise deferral")
	}
}

// An ErrUsageAllocOwnerMismatch entry is logged and skipped; the heartbeat is
// still OK, so the node retires the rest of its batch.
func TestA_M8OwnerMismatchEntryStillAnswersOK(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("u@a-m8.test")
	if err := e.st.RecordUsage(context.Background(), UsageEvent{AllocID: "taken", Token: "t", UserID: user, RelayedBytes: 1,
		RecordedAt: a_m8Base - 10, NodeID: "other-node", Billable: true}); err != nil {
		t.Fatal(err)
	}
	if !e.heartbeat(node, []nodeUsage{
		{AllocID: "taken", Username: a_m8Username(user), RelayedBytes: 5000},
		{AllocID: "mine", Username: a_m8Username(user), RelayedBytes: 700},
	}) {
		t.Fatalf("a batch with a refused entry answered OK:false")
	}
	if got := e.recorded(user, node); got != 700 {
		t.Fatalf("recorded %d via node, want 700", got)
	}
}

// The owed backlog is capped at one bucket per pair: a forger's flood leaves
// at most one bucket recorded now and one owed, and after the bucket drains
// nothing beyond those two is ever recorded.
func TestA_M8OwedBacklogIsCappedAtOneBucket(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node, quiet := e.fleetNode(), e.fleetNode()
	victim := e.user("victim@a-m8.test")
	for i := 0; i < 40; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("f%d", i), victim))
	}
	if got := e.recorded(victim, ""); got != a_m8Capacity {
		t.Fatalf("flood recorded %d now, want one bucket %d", got, a_m8Capacity)
	}
	if owed := e.owed(node, victim); owed != a_m8Capacity {
		t.Fatalf("flood owes %d, want capped at %d", owed, a_m8Capacity)
	}
	if !strings.Contains(logs.String(), "dropped over the owed cap") {
		t.Fatalf("dropping was not logged:\n%s", logs)
	}
	// Upkeep driven by ANOTHER node's heartbeats drains it: the flooding node
	// has gone quiet.
	for step := int64(1); step <= 3; step++ {
		e.set(a_m8Base + step*relayAttribWindowSecs)
		e.heartbeat(quiet, nil)
	}
	if got := e.recorded(victim, ""); got != 2*a_m8Capacity {
		t.Fatalf("after draining recorded %d, want exactly two buckets %d", got, 2*a_m8Capacity)
	}
	if e.owed(node, victim) != 0 {
		t.Fatalf("owed backlog not drained")
	}
}

// Reports under the synthetic alloc id owed bytes are drained into are
// refused: usage_periods is keyed by alloc id alone.
func TestA_M8ReservedAllocIDIsRefused(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("u@a-m8.test")
	err := e.st.RecordUsage(context.Background(), UsageEvent{AllocID: relayAttribOwedAllocID(node, user), Token: "t", UserID: user,
		RelayedBytes: 5, RecordedAt: a_m8Base, NodeID: node, Billable: true})
	if !errors.Is(err, ErrUsageReservedAllocID) {
		t.Fatalf("reserved alloc id accepted: %v", err)
	}
	e.heartbeat(node, []nodeUsage{{AllocID: relayAttribOwedAllocID(node, user), Username: a_m8Username(user), RelayedBytes: 5}})
	if got := e.recorded(user, ""); got != 0 {
		t.Fatalf("reserved alloc id recorded %d", got)
	}
}

// A backwards clock drains nothing and never goes negative; saturating budget
// parameters cannot overflow level or owed.
func TestA_M8BackwardsClockAndSaturation(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("clock@a-m8.test")
	for i := 0; i < 5; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("t%d", i), user))
	}
	// Clock steps back an hour: nothing drains, nothing more is recorded.
	e.set(a_m8Base - relayAttribWindowSecs)
	for i := 0; i < 5; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("u%d", i), user))
	}
	if got := e.recorded(user, ""); got != a_m8Capacity {
		t.Fatalf("backwards clock recorded %d, want still %d", got, a_m8Capacity)
	}
	var level, owed int64
	if err := e.st.db.QueryRow(`SELECT level, owed FROM relay_attrib_budget WHERE user_id=?`, user).Scan(&level, &owed); err != nil {
		t.Fatal(err)
	}
	if level < 0 || level > a_m8Capacity || owed < 0 || owed > a_m8Capacity {
		t.Fatalf("level %d / owed %d out of [0, %d]", level, owed, a_m8Capacity)
	}
	// Store level: a report stamped before the bucket's last update (backwards
	// clock) on a lightly used pair is recorded in full, and the result's
	// parts are non-negative and add up to the increment.
	ctx0 := context.Background()
	if _, err := e.st.RecordNodeUsage(ctx0, UsageEvent{AllocID: "bc1", Token: "t", UserID: user,
		RelayedBytes: maxFirstReportBytes, RecordedAt: a_m8Base, NodeID: "bc-node", Billable: true}, relayAttribBudget); err != nil {
		t.Fatal(err)
	}
	res, err := e.st.RecordNodeUsage(ctx0, UsageEvent{AllocID: "bc2", Token: "t", UserID: user,
		RelayedBytes: maxFirstReportBytes, RecordedAt: a_m8Base - relayAttribWindowSecs, NodeID: "bc-node", Billable: true}, relayAttribBudget)
	if err != nil || res.Recorded != maxFirstReportBytes || res.Deferred != 0 || res.Dropped != 0 {
		t.Fatalf("backwards-clock report on a light pair: %+v, %v", res, err)
	}
	// Saturation: rate x window overflows int64; capacity saturates, and a
	// report is recorded without wrapping.
	huge := RelayAttribBudget{RatePerSec: math.MaxInt64 / 2, WindowSecs: 1 << 20}
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		res, err := e.st.RecordNodeUsage(ctx, UsageEvent{AllocID: fmt.Sprintf("sat%d", i), Token: "t", UserID: user,
			RelayedBytes: maxFirstReportBytes, RecordedAt: a_m8Base, NodeID: "sat-node", Billable: true}, huge)
		if err != nil || res.Recorded != maxFirstReportBytes || res.Deferred != 0 || res.Dropped != 0 {
			t.Fatalf("saturated budget report %d: %+v, %v", i, res, err)
		}
	}
	if err := e.st.db.QueryRow(`SELECT level, owed FROM relay_attrib_budget WHERE node_id='sat-node'`).Scan(&level, &owed); err != nil {
		t.Fatal(err)
	}
	if level != 3*maxFirstReportBytes || owed != 0 {
		t.Fatalf("saturated bucket level %d owed %d", level, owed)
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

// A restart does not refill the budget: it lives in the SQLite file, which is
// closed and reopened here, owed backlog included.
func TestA_M8BudgetSurvivesCloseAndReopen(t *testing.T) {
	a_m8CaptureLog(t)
	path := t.TempDir() + "/a-m8.db"
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	e := &a_m8Env{t: t, st: st, clock: a_m8Base}
	e.restart()
	node := e.fleetNode()
	victim := e.user("victim@a-m8.test")
	for i := 0; i < 5; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("p%d", i), victim))
	}
	owedBefore := e.owed(node, victim)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st2, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st2.Close() })
	e.st = st2
	e.restart()
	if got := e.owed(node, victim); got != owedBefore || got == 0 {
		t.Fatalf("owed after reopen %d, want %d (non-zero)", got, owedBefore)
	}
	for i := 0; i < 5; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("q%d", i), victim))
	}
	if got := e.recorded(victim, ""); got != a_m8Capacity {
		t.Fatalf("after reopen recorded %d, want still held to %d", got, a_m8Capacity)
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
	var owedRows int
	if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM relay_attrib_owed`).Scan(&owedRows); err != nil {
		t.Fatal(err)
	}
	if owedRows != 0 {
		t.Fatalf("nonexistent user got %d owed rows", owedRows)
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
			for i := 0; i < 5; i++ {
				e.heartbeat(node, forgedBatch(fmt.Sprintf("x%d", i), user))
			}
			e.heartbeat(node, forgedBatch("k", keep))
			if e.owed(node, user) == 0 {
				t.Fatalf("setup: expected owed bytes before purge")
			}
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
			var owedRows int
			if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM relay_attrib_owed WHERE user_id=?`, user).Scan(&owedRows); err != nil {
				t.Fatal(err)
			}
			if owedRows != 0 {
				t.Fatalf("%s purge left %d owed rows for the user", which, owedRows)
			}
			if e.budgetRows(keep) != 1 {
				t.Fatalf("%s purge removed another user's budget row", which)
			}
		})
	}
}

// Rows idle for a full window that owe nothing are pruned by the next
// heartbeat of any node (their level has drained to 0, so pruning changes no
// budget); a row that still owes is kept until drained.
func TestA_M8IdleBudgetRowsArePruned(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	nodeA, nodeB := e.fleetNode(), e.fleetNode()
	user := e.user("user@a-m8.test")
	owing := e.user("owing@a-m8.test")
	e.set(a_m8Base)
	e.heartbeat(nodeA, []nodeUsage{{AllocID: "x", Username: a_m8Username(user), RelayedBytes: 1 << 30}})
	for i := 0; i < 8; i++ {
		e.heartbeat(nodeA, forgedBatch(fmt.Sprintf("o%d", i), owing))
	}
	if e.budgetRows(user) != 1 || e.owed(nodeA, owing) == 0 {
		t.Fatalf("setup: expected a budget row and an owing pair")
	}
	e.set(a_m8Base + relayAttribWindowSecs + 1)
	e.heartbeat(nodeB, nil)
	if n := e.budgetRows(user); n != 0 {
		t.Fatalf("idle budget row not pruned after a window: %d", n)
	}
	if e.budgetRows(owing) != 1 {
		t.Fatalf("a pair that still owed bytes was pruned")
	}
	// Prune alone (upkeep reaching no owing pair): an idle pair that owes
	// must survive it, or its owed bytes would be orphaned.
	for i := 0; i < 8; i++ {
		e.heartbeat(nodeA, forgedBatch(fmt.Sprintf("p%d", i), owing))
	}
	idle := a_m8Base + 3*relayAttribWindowSecs
	if _, _, err := e.st.SettleRelayAttribBudget(context.Background(), idle, relayAttribBudget, 0); err != nil {
		t.Fatal(err)
	}
	if e.budgetRows(owing) != 1 || e.owed(nodeA, owing) == 0 {
		t.Fatalf("prune removed an idle pair that still owes bytes")
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

// ---- Round 4 ----

// a_m8Owe makes (node, user) owe a full bucket through the store directly (no
// heartbeat, so no upkeep runs): one byte a day before `at`, then the alloc's
// per-alloc maximum at `at`, which the drained bucket takes one capacity of and
// defers one capacity of.
func (e *a_m8Env) a_m8Owe(node, user, alloc string, at int64, billable bool) {
	e.t.Helper()
	ctx := context.Background()
	for _, r := range []struct{ at, bytes int64 }{{at - 86400, 1}, {at, maxAllocRelayBytes}} {
		if _, err := e.st.RecordNodeUsage(ctx, UsageEvent{AllocID: alloc, Token: "t", UserID: user, RelayedBytes: r.bytes,
			RecordedAt: r.at, NodeID: node, Billable: billable}, relayAttribBudget); err != nil {
			e.t.Fatal(err)
		}
	}
	if e.owed(node, user) != a_m8Capacity {
		e.t.Fatalf("setup: pair owes %d, want %d", e.owed(node, user), a_m8Capacity)
	}
}

// Codex round 3 finding 2: an older binary accepted any alloc id, so a legacy
// usage_periods row may already sit under the synthetic drain id and belong to
// someone else (or be non-billable). The drain must not add to it: the bytes
// stay owed, the legacy row is untouched, and it is logged once.
func TestA_M8DrainNeverAddsToAForeignLegacyRow(t *testing.T) {
	for _, tc := range []struct {
		name     string
		foreign  bool // legacy row belongs to another user
		billable int  // legacy row's billable
	}{{"another user", true, 1}, {"same user, not billable", false, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			logs := a_m8CaptureLog(t)
			e := newA_M8Env(t)
			node, other := e.fleetNode(), e.fleetNode()
			victim := e.user("victim@a-m8.test")
			owner := victim
			if tc.foreign {
				owner = e.user("legacy@a-m8.test")
			}
			at := a_m8Base
			if _, err := e.st.db.Exec(`INSERT INTO usage_periods (alloc_id, period, user_id, node_id, billable, bytes) VALUES (?, ?, ?, ?, ?, 5)`,
				relayAttribOwedAllocID(node, victim), periodOf(at), owner, node, tc.billable); err != nil {
				t.Fatal(err)
			}
			e.a_m8Owe(node, victim, "big", at, true)
			for step := int64(1); step <= 3; step++ {
				e.set(at + step*relayAttribWindowSecs)
				e.heartbeat(other, nil)
			}
			var uid string
			var bill, n int64
			if err := e.st.db.QueryRow(`SELECT user_id, billable, bytes FROM usage_periods WHERE alloc_id=?`,
				relayAttribOwedAllocID(node, victim)).Scan(&uid, &bill, &n); err != nil {
				t.Fatal(err)
			}
			if uid != owner || bill != int64(tc.billable) || n != 5 {
				t.Fatalf("legacy row changed: user %s billable %d bytes %d", uid, bill, n)
			}
			if got := e.owed(node, victim); got != a_m8Capacity {
				t.Fatalf("blocked owed bytes %d, want kept at %d", got, a_m8Capacity)
			}
			if c := strings.Count(logs.String(), "belongs to another owner"); c != 1 {
				t.Fatalf("blocked drain logged %d times, want once:\n%s", c, logs)
			}
			relayAttribOwedBlocked.Delete(relayAttribOwedAllocID(node, victim) + "@" + periodOf(at))
		})
	}
}

// Owed bytes relayed in September and drained in October count in September
// — through the real readers: the monthly quota (UserRelayedSince), the node
// cap (NodeRelayedSince), the admin monthly metric and the lifetime display —
// for a billable fleet node and a non-billable BYO node.
func TestA_M8SeptemberOwedDrainedInOctoberCountsInSeptember(t *testing.T) {
	for _, byo := range []bool{false, true} {
		t.Run(fmt.Sprintf("byo=%v", byo), func(t *testing.T) {
			a_m8CaptureLog(t)
			e := newA_M8Env(t)
			ctx := context.Background()
			user := e.user("month@a-m8.test")
			node := e.fleetNode()
			if byo {
				n, err := e.st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: user, URLs: []string{"turn:y:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
				if err != nil {
					t.Fatal(err)
				}
				node = n.ID
			}
			sepStart, _ := monthRange("202609")
			octStart, _ := monthRange("202610")
			deferAt := octStart - 3600 // Sep 30 23:00 UTC
			e.a_m8Owe(node, user, "big", deferAt, !byo)
			quiet := e.fleetNode()
			e.set(octStart + 3600) // Oct 1 01:00: bucket long drained
			e.heartbeat(quiet, nil)
			if e.owed(node, user) != 0 {
				t.Fatalf("owed not drained in October")
			}
			all := 1 + 2*a_m8Capacity
			billable := all
			if byo {
				billable = 0
			}
			if q, _ := e.st.UserRelayedSince(ctx, user, octStart); q != 0 {
				t.Fatalf("October quota counts %d of September's owed bytes", q)
			}
			if q, _ := e.st.UserRelayedSince(ctx, user, sepStart); q != billable {
				t.Fatalf("September quota %d, want %d", q, billable)
			}
			if m, _ := e.st.NodeRelayedSince(ctx, octStart); m[node] != 0 {
				t.Fatalf("October node cap counts %d", m[node])
			}
			if m, _ := e.st.NodeRelayedSince(ctx, sepStart); m[node] != all {
				t.Fatalf("node relayed since September %d, want %d", m[node], all)
			}
			if am, err := e.st.AdminMetrics(ctx, "202609", octStart+3600); err != nil || am.RelayBytes != all {
				t.Fatalf("admin September relay %d (%v), want %d", am.RelayBytes, err, all)
			}
			if am, _ := e.st.AdminMetrics(ctx, "202610", octStart+3600); am.RelayBytes != 0 {
				t.Fatalf("admin October relay %d, want 0", am.RelayBytes)
			}
			if tot, _ := e.st.UserUsageTotal(ctx, user); tot != all {
				t.Fatalf("lifetime display %d, want recorded bytes only %d", tot, all)
			}
		})
	}
}

// The lifetime display counts recorded bytes only: a flood whose bytes are
// partly owed and partly dropped does not show the unrecorded part.
func TestA_M8LifetimeDisplayExcludesUnrecordedBytes(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	user := e.user("display@a-m8.test")
	for i := 0; i < 8; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("d%d", i), user))
	}
	if tot, _ := e.st.UserUsageTotal(context.Background(), user); tot != a_m8Capacity {
		t.Fatalf("lifetime display %d, want recorded %d", tot, a_m8Capacity)
	}
}

// More pairs owe than one upkeep reaches (relayAttribSettlePairs): each
// heartbeat's upkeep makes progress, and all of them drain within
// ceil(pairs/64) heartbeats.
func TestA_M8UpkeepProgressesBeyondItsPerHeartbeatBound(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node, quiet := e.fleetNode(), e.fleetNode()
	const pairs = relayAttribSettlePairs + 6
	users := make([]string, pairs)
	for i := range users {
		users[i] = e.user(fmt.Sprintf("p%d@a-m8.test", i))
		e.a_m8Owe(node, users[i], fmt.Sprintf("big%d", i), a_m8Base, true)
	}
	owing := func() int {
		var n int
		if err := e.st.db.QueryRow(`SELECT COUNT(*) FROM relay_attrib_budget WHERE owed > 0`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	e.set(a_m8Base + 2*relayAttribWindowSecs)
	e.heartbeat(quiet, nil)
	if n := owing(); n != pairs-relayAttribSettlePairs {
		t.Fatalf("after one upkeep %d pairs owe, want %d", n, pairs-relayAttribSettlePairs)
	}
	e.set(a_m8Base + 2*relayAttribWindowSecs + 30)
	e.heartbeat(quiet, nil)
	if n := owing(); n != 0 {
		t.Fatalf("after two upkeeps %d pairs still owe", n)
	}
	for _, u := range users {
		if got := e.recorded(u, node); got != 1+2*a_m8Capacity {
			t.Fatalf("pair %s recorded %d, want %d", u, got, 1+2*a_m8Capacity)
		}
	}
}

// FIFO inside a pair's own charge, for a pair the upkeep does not reach this
// heartbeat (64 older owing pairs come first): its September owed bytes are
// recorded before its new October report, so October's quota is not charged
// ahead of September's backlog.
func TestA_M8PairOutsideUpkeepDrainsOwedBeforeNewBytes(t *testing.T) {
	a_m8CaptureLog(t)
	e := newA_M8Env(t)
	ctx := context.Background()
	node := e.fleetNode()
	octStart, _ := monthRange("202610")
	t1 := octStart - 4*3600 // Sep 30 20:00
	for i := 0; i < relayAttribSettlePairs; i++ {
		e.a_m8Owe(node, e.user(fmt.Sprintf("o%d@a-m8.test", i)), fmt.Sprintf("ob%d", i), t1, true)
	}
	p := e.user("fifo@a-m8.test")
	e.a_m8Owe(node, p, "pbig", t1+10, true) // most recently touched: last in upkeep order
	e.set(octStart + 1800)
	e.heartbeat(node, []nodeUsage{{AllocID: "pnew", Username: a_m8Username(p), RelayedBytes: 1 << 30}})
	if q, _ := e.st.UserRelayedSince(ctx, p, octStart); q != 0 {
		t.Fatalf("October recorded %d of the new report ahead of September's owed backlog", q)
	}
	sepStart, _ := monthRange("202609")
	if q, _ := e.st.UserRelayedSince(ctx, p, sepStart); q != 1+2*a_m8Capacity {
		t.Fatalf("September recorded %d, want the backlog drained first %d", q, 1+2*a_m8Capacity)
	}
	var octOwed int64
	if err := e.st.db.QueryRow(`SELECT COALESCE(SUM(bytes),0) FROM relay_attrib_owed WHERE user_id=? AND period='202610'`, p).Scan(&octOwed); err != nil {
		t.Fatal(err)
	}
	if octOwed != 1<<30 {
		t.Fatalf("new October bytes owed %d, want %d", octOwed, 1<<30)
	}
}
