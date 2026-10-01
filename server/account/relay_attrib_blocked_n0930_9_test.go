package account

import (
	"context"
	"strings"
	"testing"
	"time"
)

// N-0930-9: a period whose drain is blocked by a foreign legacy usage_periods
// row under the synthetic owed alloc id must not freeze the pair's LATER
// periods behind it. Only the blocked period stays owed.
func TestN0930_9_BlockedPeriodDoesNotFreezeLaterOwedPeriods(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	ctx := context.Background()
	node := e.fleetNode()
	victim := e.user("victim@n0930-9.test")
	legacy := e.user("legacy@n0930-9.test")
	sep := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC).Unix()
	oct := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC).Unix()
	allocID := relayAttribOwedAllocID(node, victim)
	t.Cleanup(func() { relayAttribOwedBlocked.Delete(allocID + "@" + periodOf(sep)) })

	for _, q := range []struct {
		sql  string
		args []any
	}{
		// An older binary's row under the synthetic id, for September, owned by someone else.
		{`INSERT INTO usage_periods (alloc_id, period, user_id, node_id, billable, bytes) VALUES (?, ?, ?, ?, 1, 5)`,
			[]any{allocID, periodOf(sep), legacy, node}},
		{`INSERT INTO relay_attrib_owed (node_id, user_id, period, billable, bytes) VALUES (?, ?, ?, 1, 100)`,
			[]any{node, victim, periodOf(sep)}},
		{`INSERT INTO relay_attrib_owed (node_id, user_id, period, billable, bytes) VALUES (?, ?, ?, 1, 200)`,
			[]any{node, victim, periodOf(oct)}},
		{`INSERT INTO relay_attrib_budget (node_id, user_id, level, updated_at, last_warned_at, owed) VALUES (?, ?, 0, ?, 0, 300)`,
			[]any{node, victim, oct}},
	} {
		if _, err := e.st.db.ExecContext(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	periodBytes := func(period string) (user string, n int64) {
		t.Helper()
		if err := e.st.db.QueryRow(`SELECT user_id, bytes FROM usage_periods WHERE alloc_id = ? AND period = ?`,
			allocID, period).Scan(&user, &n); err != nil {
			return "", 0
		}
		return user, n
	}

	for round := 0; round < 2; round++ {
		if _, _, err := e.st.SettleRelayAttribBudget(ctx, oct+int64(round), relayAttribBudget, relayAttribSettlePairs); err != nil {
			t.Fatal(err)
		}
		if u, n := periodBytes(periodOf(oct)); u != victim || n != 200 {
			t.Fatalf("round %d: October owed bytes recorded as user=%q bytes=%d, want %s 200 (frozen behind the blocked September row?)",
				round, u, n, victim)
		}
		if u, n := periodBytes(periodOf(sep)); u != legacy || n != 5 {
			t.Fatalf("round %d: the foreign legacy row changed: user=%q bytes=%d", round, u, n)
		}
		if got := e.owed(node, victim); got != 100 {
			t.Fatalf("round %d: owed %d, want only the blocked September 100", round, got)
		}
		var rows int
		_ = e.st.db.QueryRow(`SELECT COUNT(*) FROM relay_attrib_owed WHERE node_id = ? AND user_id = ? AND period = ?`,
			node, victim, periodOf(sep)).Scan(&rows)
		if rows != 1 {
			t.Fatalf("round %d: the blocked September owed row is gone", round)
		}
	}
	if c := strings.Count(logs.String(), "belongs to another owner"); c != 1 {
		t.Fatalf("blocked period logged %d times, want once:\n%s", c, logs)
	}
	// Quota readers see October's bytes in October, nothing added to September for the victim.
	if got, err := e.st.UserRelayedSince(ctx, victim, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC).Unix()); err != nil || got != 200 {
		t.Fatalf("October quota = %d (err %v), want 200", got, err)
	}
}
