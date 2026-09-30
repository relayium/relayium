package account

// B-L4 (audit 2026-09-28): RecordUsage keys its per-allocation high-water row
// by alloc_id alone, and usage_periods increments ON CONFLICT(alloc_id,
// period). A report that reuses an existing alloc_id under a different user or
// node must not advance the original row or add bytes to anybody's period.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type b_l4Row struct {
	Bytes, RecordedAt int64
	UserID            string
	NodeID            sql.NullString
}

func b_l4AllocRow(t *testing.T, st *SQLiteStore, alloc string) b_l4Row {
	t.Helper()
	var r b_l4Row
	if err := st.db.QueryRow(`SELECT relayed_bytes, recorded_at, user_id, node_id FROM usage_events WHERE alloc_id=?`, alloc).
		Scan(&r.Bytes, &r.RecordedAt, &r.UserID, &r.NodeID); err != nil {
		t.Fatalf("usage_events row %s: %v", alloc, err)
	}
	return r
}

// b_l4PeriodBytes is every usage_periods byte attributed to userID, billable or
// not, so a mismatch cannot hide in a non-billable bucket.
func b_l4PeriodBytes(t *testing.T, st *SQLiteStore, userID string) int64 {
	t.Helper()
	var n int64
	if err := st.db.QueryRow(`SELECT COALESCE(SUM(bytes),0) FROM usage_periods WHERE user_id=?`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func b_l4AllocPeriodRows(t *testing.T, st *SQLiteStore, alloc string) int64 {
	t.Helper()
	var n int64
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM usage_periods WHERE alloc_id=?`, alloc).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

var b_l4Base = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC).Unix()

func TestB_L4RecordUsageRefusesAForeignOwnerOfAnExistingAlloc(t *testing.T) {
	cases := []struct {
		name           string
		ownerNode      string // node the allocation was first recorded from
		intruderUser   bool   // report under a different user
		intruderNodeID string // node the intruding report names
	}{
		{name: "different user, same node", ownerNode: "n1", intruderUser: true, intruderNodeID: "n1"},
		{name: "same user, different node", ownerNode: "n1", intruderNodeID: "n2"},
		{name: "same user, node report against a NULL-node row", ownerNode: "", intruderNodeID: "n1"},
		{name: "same user, NULL-node report against a node row", ownerNode: "n1", intruderNodeID: ""},
		{name: "different user, NULL node on both", ownerNode: "", intruderUser: true, intruderNodeID: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newTestStore(t)
			ctx := context.Background()
			victim, _ := st.UpsertUserByEmail(ctx, "victim@b-l4.test", "")
			attacker, _ := st.UpsertUserByEmail(ctx, "attacker@b-l4.test", "")

			if err := st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "tok", UserID: victim.ID,
				RelayedBytes: 1000, RecordedAt: b_l4Base, NodeID: tc.ownerNode, Billable: true}); err != nil {
				t.Fatalf("owner's first report: %v", err)
			}
			before := b_l4AllocRow(t, st, "a1")

			intruder := victim.ID
			if tc.intruderUser {
				intruder = attacker.ID
			}
			err := st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "tok", UserID: intruder,
				RelayedBytes: 50000, RecordedAt: b_l4Base + 60, NodeID: tc.intruderNodeID, Billable: true})
			if after := b_l4AllocRow(t, st, "a1"); after != before {
				t.Fatalf("the allocation's high-water row moved: %+v -> %+v (RecordUsage returned %v)", before, after, err)
			}
			if got := b_l4PeriodBytes(t, st, victim.ID); got != 1000 {
				t.Fatalf("victim's period bytes = %d, want 1000 (unchanged; RecordUsage returned %v)", got, err)
			}
			if got := b_l4PeriodBytes(t, st, attacker.ID); got != 0 {
				t.Fatalf("attacker's period bytes = %d, want 0", got)
			}
			if got := b_l4AllocPeriodRows(t, st, "a1"); got != 1 {
				t.Fatalf("usage_periods rows for a1 = %d, want 1", got)
			}
			if q, _ := st.UserRelayedSince(ctx, victim.ID, 0); q != 1000 {
				t.Fatalf("victim's billed relay = %d, want 1000", q)
			}
			if q, _ := st.UserRelayedSince(ctx, attacker.ID, 0); q != 0 {
				t.Fatalf("attacker's billed relay = %d, want 0", q)
			}
			if !errors.Is(err, ErrUsageAllocOwnerMismatch) {
				t.Fatalf("foreign report on an existing alloc returned %v, want ErrUsageAllocOwnerMismatch", err)
			}

			// Positive control: the rightful owner's next report still advances.
			if err := st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "tok", UserID: victim.ID,
				RelayedBytes: 3000, RecordedAt: b_l4Base + 120, NodeID: tc.ownerNode, Billable: true}); err != nil {
				t.Fatalf("owner's later report: %v", err)
			}
			if r := b_l4AllocRow(t, st, "a1"); r.Bytes != 3000 || r.RecordedAt != b_l4Base+120 {
				t.Fatalf("owner's later report did not advance the row: %+v", r)
			}
			if got := b_l4PeriodBytes(t, st, victim.ID); got != 3000 {
				t.Fatalf("victim's period bytes after the owner's report = %d, want 3000", got)
			}
			if got := b_l4PeriodBytes(t, st, attacker.ID); got != 0 {
				t.Fatalf("attacker's period bytes = %d, want 0", got)
			}
		})
	}
}

// A NULL-node allocation (central coturn metering sends no node) keeps being
// advanced by NULL-node reports from the same user, and a node-bound one by its
// own node.
func TestB_L4RecordUsageOwnerReportsKeepAdvancing(t *testing.T) {
	for _, node := range []string{"", "n1"} {
		t.Run("node="+node, func(t *testing.T) {
			st := newTestStore(t)
			ctx := context.Background()
			u, _ := st.UpsertUserByEmail(ctx, "owner@b-l4.test", "")
			for i, cum := range []int64{500, 1500, 1200 /* stale: keep-max */, 4000} {
				if err := st.RecordUsage(ctx, UsageEvent{AllocID: "c1", Token: "tok", UserID: u.ID,
					RelayedBytes: cum, RecordedAt: b_l4Base + int64(i)*30, NodeID: node, Billable: true}); err != nil {
					t.Fatalf("report %d (%d): %v", i, cum, err)
				}
			}
			r := b_l4AllocRow(t, st, "c1")
			if r.Bytes != 4000 || r.UserID != u.ID || r.NodeID.String != node || r.NodeID.Valid != (node != "") {
				t.Fatalf("row %+v, want 4000 bytes owned by %s on node %q", r, u.ID, node)
			}
			if got := b_l4PeriodBytes(t, st, u.ID); got != 4000 {
				t.Fatalf("period bytes %d, want 4000", got)
			}
		})
	}
}

// The heartbeat caller logs a refused allocation and still records the rest of
// the batch: a mismatch must neither abort the heartbeat nor bill anyone.
func TestB_L4HeartbeatSkipsAMismatchedAllocAndRecordsTheRest(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, _ := st.UpsertNode(ctx, Node{ID: "fn", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	victim, _ := st.UpsertUserByEmail(ctx, "hbvictim@b-l4.test", "")
	// The allocation already belongs to the victim on another fleet node.
	if err := st.RecordUsage(ctx, UsageEvent{AllocID: "shared", Token: "code", UserID: victim.ID,
		RelayedBytes: 1000, RecordedAt: 40, NodeID: "other", Billable: true}); err != nil {
		t.Fatal(err)
	}
	s := &Service{store: st, cfg: Config{NodeToken: "fleet-secret"}, now: func() time.Time { return time.Unix(50, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	// send posts one heartbeat and returns what it logged.
	send := func(usage []nodeUsage) string {
		t.Helper()
		body, _ := json.Marshal(nodeHeartbeatReq{NodeID: n.ID, Status: "ok", Usage: usage})
		r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer fleet-secret")
		w := httptest.NewRecorder()
		var buf bytes.Buffer
		old := log.Writer()
		log.SetOutput(&buf)
		mux.ServeHTTP(w, r)
		log.SetOutput(old)
		if w.Code != http.StatusOK {
			t.Fatalf("heartbeat: %d body=%s", w.Code, w.Body)
		}
		return buf.String()
	}
	// The refused report claims far more than implausiblePerHeartbeat: it billed
	// nobody, so it must not raise the implausible-attribution warning naming
	// the victim.
	out := send([]nodeUsage{
		{AllocID: "shared", Username: "9999:" + victim.ID + ".code", RelayedBytes: 200 << 30}, // refused: alloc owned by node "other"
		{AllocID: "fresh", Username: "9999:" + victim.ID + ".code", RelayedBytes: 700},        // recorded
	})
	if !strings.Contains(out, "record alloc shared failed") {
		t.Fatalf("the refusal was not logged: %q", out)
	}
	if strings.Contains(out, "attributed") {
		t.Fatalf("a refused report raised the implausible-attribution warning: %q", out)
	}
	if row := b_l4AllocRow(t, st, "shared"); row.Bytes != 1000 || row.NodeID.String != "other" {
		t.Fatalf("the refused alloc's row moved: %+v", row)
	}
	if row := b_l4AllocRow(t, st, "fresh"); row.Bytes != 700 || row.NodeID.String != "fn" {
		t.Fatalf("the rest of the batch was not recorded: %+v", row)
	}
	if q, _ := st.UserRelayedSince(ctx, victim.ID, 0); q != 1700 {
		t.Fatalf("victim's billed relay = %d, want 1000 + 700", q)
	}

	// Control: ACCEPTED reports whose RECORDED bytes exceed the threshold
	// still warn, so the check above is not passing because the capture or the
	// warning is dead. (The warning counts recorded bytes — A-M8 — and one
	// fresh alloc records at most maxFirstReportBytes, so it takes many.)
	var big []nodeUsage
	for i := 0; i < maxAllocsPerUser; i++ {
		big = append(big, nodeUsage{AllocID: fmt.Sprintf("big%d", i), Username: "9999:" + victim.ID + ".code", RelayedBytes: 200 << 30})
	}
	out = send(big)
	if !strings.Contains(out, "WARNING") || !strings.Contains(out, "attributed") || !strings.Contains(out, victim.ID) {
		t.Fatalf("an accepted implausible report did not warn: %q", out)
	}
}
