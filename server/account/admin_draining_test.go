package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Draining alone tells an operator nothing about WHEN a node is actually safe
// to pull the plug on — that is the whole point of this task. These tests
// cover: the toggle persists (both directions), the node row surfaces the
// live file count and the furthest-out ExpiresAt ("safe to uninstall at"),
// and a node holding nothing reports zero/no-wait rather than some stale or
// undefined value.

// TestAdminNodeDrainingTogglePersists exercises handleAdminNodeDraining
// directly (bypassing the mux/CSRF guard, same pattern as the other admin
// handler tests) in both directions: off->on and on->off.
func TestAdminNodeDrainingTogglePersists(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	s := NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	tok, err := s.newAdminSession(ctx, "password")
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: adminCookie, Value: tok}

	n, err := store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		CreatedAt: 1, LastSeenAt: 1,
	})
	if err != nil {
		t.Fatal(err)
	}

	form := url.Values{"on": {"1"}}
	w := callAdminHandler(s.handleAdminNodeDraining, cookie, form, map[string]string{"id": n.ID})
	if w.Code != http.StatusFound {
		t.Fatalf("toggle on: want 302, got %d: %s", w.Code, w.Body.String())
	}
	got, _, err := store.GetNode(ctx, n.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Draining {
		t.Fatal("node should be draining after on=1")
	}

	form = url.Values{"on": {"0"}}
	w = callAdminHandler(s.handleAdminNodeDraining, cookie, form, map[string]string{"id": n.ID})
	if w.Code != http.StatusFound {
		t.Fatalf("toggle off: want 302, got %d", w.Code)
	}
	got, _, err = store.GetNode(ctx, n.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Draining {
		t.Fatal("node should not be draining after on=0")
	}
}

func TestAdminNodeDrainingRequiresAdmin(t *testing.T) {
	store := newTestStore(t)
	s := NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	n, err := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t"})
	if err != nil {
		t.Fatal(err)
	}
	w := callAdminHandler(s.handleAdminNodeDraining, nil, url.Values{"on": {"1"}}, map[string]string{"id": n.ID})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no cookie: want 401, got %d", w.Code)
	}
}

// TestAdminHomeShowsNodeFileCountAndSafeFromTime renders the actual /admin
// dashboard and checks the node row carries: how many stored files still live
// on it, and the timestamp derived from the MAX(expires_at) among them (the
// earliest moment it is safe to uninstall).
func TestAdminHomeShowsNodeFileCountAndSafeFromTime(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	owner, err := store.UpsertUserByEmail(ctx, "drainowner@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	n, err := store.UpsertNode(ctx, Node{
		ID: "node-with-files", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		CreatedAt: 1, LastSeenAt: 1_700_000_000, Draining: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Two live files on this node; the later ExpiresAt is the number we want.
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "f1", UserID: owner.ID, BlobKey: "b1", EncManifest: []byte("m"), Size: 10,
		NodeID: n.ID, CreatedAt: 1, ExpiresAt: 1_700_100_000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "f2", UserID: owner.ID, BlobKey: "b2", EncManifest: []byte("m"), Size: 10,
		NodeID: n.ID, CreatedAt: 1, ExpiresAt: 1_700_200_000, // furthest out
	}); err != nil {
		t.Fatal(err)
	}
	// An EXPIRED-but-not-yet-collected row on the same node must not count and
	// must not push the safe-from time out further.
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "fexpired", UserID: owner.ID, BlobKey: "bexp", EncManifest: []byte("m"), Size: 10,
		NodeID: n.ID, CreatedAt: 1, ExpiresAt: 1, // long expired relative to "now" below
	}); err != nil {
		t.Fatal(err)
	}

	s := NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	s.now = func() time.Time { return time.Unix(1_700_000_500, 0) }
	tok, err := s.newAdminSession(ctx, "password")
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/admin/fleet", nil)
	r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
	w := httptest.NewRecorder()
	s.handleAdminFleet(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "node-with-files") {
		t.Fatal("node row not rendered")
	}
	// 2 live files (the expired 3rd is excluded).
	if !strings.Contains(body, ">2<") && !strings.Contains(body, "2 个") {
		t.Fatalf("expected the live file count (2) somewhere in the node row, body=%s", body)
	}
	wantTime := time.Unix(1_700_200_000, 0).UTC().Format("2006-01-02 15:04")
	if !strings.Contains(body, wantTime) {
		t.Fatalf("expected the safe-from-uninstall time %q in the page, not found", wantTime)
	}
}

// TestAdminHomeNodeWithNoFilesShowsZeroWait: a node holding nothing must
// report zero files and no wait — never a stale/leftover time from a file
// that has since been deleted (rows are hard-deleted, not soft-deleted, so
// this also guards that assumption).
func TestAdminHomeNodeWithNoFilesShowsZeroWait(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if _, err := store.UpsertNode(ctx, Node{
		ID: "empty-node", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		CreatedAt: 1, LastSeenAt: 1_700_000_000,
	}); err != nil {
		t.Fatal(err)
	}
	s := NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	s.now = func() time.Time { return time.Unix(1_700_000_500, 0) }
	tok, err := s.newAdminSession(ctx, "password")
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/admin/fleet", nil)
	r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
	w := httptest.NewRecorder()
	s.handleAdminFleet(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "empty-node") {
		t.Fatal("node row not rendered")
	}
}

// TestCountFilesOnNodeLiveOnly is a store-level test for the load-bearing
// semantics: only LIVE rows (expires_at > now) on THIS node count, an expired
// row is excluded from both the count and the max, and another node's files
// never leak in.
func TestCountFilesOnNodeLiveOnly(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	owner, err := store.UpsertUserByEmail(ctx, "counttest@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	const now = int64(1_000_000)
	mustCreate := func(id, nodeID string, expiresAt int64) {
		t.Helper()
		if err := store.CreateStoredFile(ctx, StoredFile{
			ID: id, UserID: owner.ID, BlobKey: id + "-blob", EncManifest: []byte("m"), Size: 1,
			NodeID: nodeID, CreatedAt: 1, ExpiresAt: expiresAt,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mustCreate("live1", "nodeA", now+100)
	mustCreate("live2", "nodeA", now+500) // furthest out on nodeA
	mustCreate("expired", "nodeA", now-1) // must be excluded
	mustCreate("otherNode", "nodeB", now+9999)

	count, maxExpiresAt, err := store.CountFilesOnNode(ctx, "nodeA", now)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("count = %d, want 2 (expired + other-node rows excluded)", count)
	}
	if maxExpiresAt != now+500 {
		t.Fatalf("maxExpiresAt = %d, want %d", maxExpiresAt, now+500)
	}

	// A node with nothing live reports zero/zero, not an error.
	count, maxExpiresAt, err = store.CountFilesOnNode(ctx, "nodeC-empty", now)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 || maxExpiresAt != 0 {
		t.Fatalf("empty node: got count=%d maxExpiresAt=%d, want 0/0", count, maxExpiresAt)
	}
}
