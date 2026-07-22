package account

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Deregistration is the MOST COMMON way a node leaves service — the uninstaller
// calls the endpoint — and it used to leave nothing behind but a log line,
// while the two admin equivalents (mark-removed / restore) both wrote audit
// entries. An operator reconstructing "when did node7 go away" found nothing.
//
// The entry must also be honest about WHO did it: no admin was in the room, so
// it must not be attributed to one.
func TestDeregisterWritesAuditEntry(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(4242, 0) },
		cfg: Config{NodeToken: "fleet-secret"}}

	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		CreatedAt: 1, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if code := postDeregister(t, s, "fleet-secret", `{"nodeID":"`+n.ID+`"}`); code != http.StatusOK {
		t.Fatalf("deregister: got %d want 200", code)
	}

	entries, err := st.ListAudit(ctx, 10, 0, AuditNodeDeregister)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d %q audit entries, want 1", len(entries), AuditNodeDeregister)
	}
	e := entries[0]
	if e.Target != "node:"+n.ID {
		t.Errorf("target = %q, want %q", e.Target, "node:"+n.ID)
	}
	// Self-initiated: the actor is the node, not a person. An empty actor (what
	// s.adminUsername() yields with nobody logged in) would read as "the admin
	// whose name we failed to record", which is exactly the wrong story.
	if !strings.Contains(e.Actor, n.ID) {
		t.Errorf("actor = %q, want it to name the node %q — the node deregistered ITSELF", e.Actor, n.ID)
	}
	if e.Auth == "password" || e.Auth == "passkey" {
		t.Errorf("auth = %q, want a node credential: no admin authenticated this", e.Auth)
	}
	if e.At != 4242 {
		t.Errorf("at = %d, want 4242", e.At)
	}
	if !strings.Contains(e.Changes, "removed_at") {
		t.Errorf("changes = %q, want the removed_at transition", e.Changes)
	}
}

// A deregister call that changes nothing (unknown node) must not manufacture an
// audit entry — the trail records what happened, not what was attempted.
func TestDeregisterUnknownNodeWritesNoAudit(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(4242, 0) },
		cfg: Config{NodeToken: "fleet-secret"}}

	if code := postDeregister(t, s, "fleet-secret", `{"nodeID":"nope"}`); code != http.StatusOK {
		t.Fatalf("deregister unknown: got %d want 200", code)
	}
	entries, err := st.ListAudit(ctx, 10, 0, AuditNodeDeregister)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("got %d audit entries for an unknown node, want 0", len(entries))
	}
}

// AuditNodeDeregister must be filterable on the audit page like every other
// action, which is what auditActions feeds.
func TestDeregisterActionIsFilterable(t *testing.T) {
	for _, a := range auditActions {
		if a == AuditNodeDeregister {
			return
		}
	}
	t.Fatalf("%q missing from auditActions — it would be unfilterable on the audit page", AuditNodeDeregister)
}
