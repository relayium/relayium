package account

import (
	"context"
	"strings"
	"testing"
)

// N-0930-7: the node-reference probes look rows up by node_id through an
// index instead of scanning upload_sessions / pending_node_deletes.
func TestN0930_7_NodeReferenceProbesUseNodeIndexes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	plan := func(q string, args ...any) string {
		t.Helper()
		rows, err := st.db.QueryContext(ctx, `EXPLAIN QUERY PLAN `+q, args...)
		if err != nil {
			t.Fatalf("explain %q: %v", q, err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var id, parent, notused int
			var detail string
			if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
				t.Fatal(err)
			}
			out = append(out, detail)
		}
		return strings.Join(out, " | ")
	}
	for _, tc := range []struct {
		name, query, want string
	}{
		{"upload_sessions by node", `SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE node_id = ?)`, "idx_upload_sessions_node"},
		{"pending_node_deletes by node", `SELECT EXISTS(SELECT 1 FROM pending_node_deletes WHERE node_id = ?)`, "idx_pending_node_deletes_node"},
		{"purge retired: sessions probe", `SELECT id FROM nodes WHERE deleted_at != 0
		   AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.node_id = nodes.id)`, "idx_upload_sessions_node"},
		{"purge retired: queue probe", `SELECT id FROM nodes WHERE deleted_at != 0
		   AND NOT EXISTS (SELECT 1 FROM pending_node_deletes p WHERE p.node_id = nodes.id)`, "idx_pending_node_deletes_node"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var args []any
			if strings.Contains(tc.query, "?") {
				args = []any{"n1"}
			}
			got := plan(tc.query, args...)
			t.Logf("plan: %s", got)
			if !strings.Contains(got, tc.want) {
				t.Fatalf("plan %q does not use %s", got, tc.want)
			}
		})
	}
}
