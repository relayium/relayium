package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// confirmAction drives a high-risk write all the way through: it POSTs the
// original form (rendering the confirm page), extracts the token, then POSTs
// /admin/confirm with the password factor. Returns the confirm response.
func confirmAction(t *testing.T, ts *httptest.Server, cookie *http.Cookie, path string, form url.Values) *http.Response {
	t.Helper()
	resp := postAdminForm(t, ts, cookie, path, form)
	body := readAll(t, resp)
	resp.Body.Close()
	tok := extractConfirmToken(t, body)
	return postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{
		"confirm_token": {tok},
		"factor_code":   {"secret123"}, // password factor for newAdminAuditServer
	})
}

// A path-scoped confirmable action (node delete carries its id in the URL, not
// the form) must actually apply through the confirm flow. Regression: the
// pending action stashed only the form, so the {id} wildcard was lost and
// handleAdminDeleteNode ran with an empty id — a permanent no-op.
func TestConfirmedNodeDeleteActuallyDeletes(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	id := seedNode(t, store, "node-del-1", "N1")

	resp := confirmAction(t, ts, cookie, "/admin/nodes/"+id+"/delete", url.Values{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed node delete: want 302, got %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetNode(context.Background(), id); ok {
		t.Fatal("node still present after a confirmed delete")
	}
	// And the audit row must name the node it deleted, not "-".
	entries, err := store.ListAudit(context.Background(), 10, 0, AuditNodeDelete)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 node.delete audit entry, got %d", len(entries))
	}
	if entries[0].Target != "node:"+id {
		t.Fatalf("audit target: want %q, got %q", "node:"+id, entries[0].Target)
	}
	_ = svc
}

// A confirmed action whose handler REJECTS the write must not leave an audit
// entry claiming it happened. Regression: handleAdminConfirm wrote the audit
// (and refreshed the step-up grace window) unconditionally, ignoring the
// handler's status — so a 404/400 rejection was logged as a successful change.
func TestConfirmedFailingActionIsNotAudited(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)

	// Delete a node id that does not exist: handler returns 404.
	resp := confirmAction(t, ts, cookie, "/admin/nodes/ghost-node/delete", url.Values{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("deleting a missing node: want 404, got %d", resp.StatusCode)
	}
	entries, err := store.ListAudit(context.Background(), 10, 0, AuditNodeDelete)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("AUDIT INTEGRITY: a rejected node delete was logged as applied: %+v", entries)
	}
}
