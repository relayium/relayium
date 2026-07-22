package account

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// postDeregister POSTs an uninstall notice with the given bearer token.
func postDeregister(t *testing.T, s *Service, bearer, body string) int {
	t.Helper()
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	r := httptest.NewRequest("POST", "/api/nodes/deregister", bytes.NewReader([]byte(body)))
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w.Code
}

// The point of deregistering: the machine is gone, so central must stop
// choosing it for new uploads. Without this the placement pool keeps handing
// out a host that is being torn down and those uploads fail (or worse, land on
// a node seconds before its disk goes away).
func TestDeregisteredNodeReceivesNoNewUploads(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(1000, 0) },
		nodeHTTP: http.DefaultClient, cfg: Config{MaxFileSize: 1 << 20, NodeToken: "fleet-secret"},
		pickN: func(n int) int { return 0 }}

	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://x:8081", StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Sanity: it IS in the pool before the uninstall, or the test proves nothing.
	if id, _, _, err := s.placeUpload(ctx, "nobody", 1<<10); err != nil || id != n.ID {
		t.Fatalf("before deregister: placeUpload = %q (err %v), want the node %q", id, err, n.ID)
	}

	if code := postDeregister(t, s, "fleet-secret", `{"nodeID":"`+n.ID+`"}`); code != http.StatusOK {
		t.Fatalf("deregister: got %d want 200", code)
	}

	id, _, billable, err := s.placeUpload(ctx, "nobody", 1<<10)
	if err != nil {
		t.Fatalf("placeUpload: %v", err)
	}
	if id == n.ID {
		t.Errorf("upload placed on deregistered node %q; it must be out of the pool", id)
	}
	if id != "" || !billable {
		t.Errorf("got node %q billable=%v, want the central fallback (\"\", true)", id, billable)
	}
}

// A deregistered node keeps heartbeating for up to a minute after it is told to
// go away (the uninstaller deregisters, THEN stops the service), so its row
// still looks online. Redirecting a downloader there hands them a dead origin.
// Central must proxy instead — contrast TestDrainingNodeStillServesExistingDownloads,
// where the node is alive and the 302 is exactly right.
func TestDeregisteredNodeGetsNoDownloadRedirect(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "gone@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "goingaway", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: "nodesecret",
		DownloadURL: "https://node7.relayium.com", CreatedAt: 1,
		LastSeenAt: time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	const fid, bkey = "gonefile", "gonebkey"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: bkey, EncManifest: []byte("m"), Size: 200,
		NodeID: "goingaway", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// Sanity: it redirects while installed.
	resp, err := client.Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("before deregister: got %d, want a 302 (otherwise this test proves nothing)", resp.StatusCode)
	}

	if err := store.MarkNodeRemoved(ctx, "goingaway", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}

	resp2, err := client.Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode == http.StatusFound {
		t.Errorf("deregistered node still received a 302 to %q — the host is gone",
			resp2.Header.Get("Location"))
	}
}

// The ownership boundary, both directions. This is the one node endpoint that
// takes a node OUT of service, so a token must never reach across it.
func TestDeregisterOwnershipBoundary(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	alice, _ := st.UpsertUserByEmail(ctx, "alice@example.com", "")
	bob, _ := st.UpsertUserByEmail(ctx, "bob@example.com", "")
	if err := st.CreateNodeToken(ctx, NodeToken{ID: "ta", TokenHash: hashToken("alicetok"), UserID: alice.ID, Name: "a", CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateNodeToken(ctx, NodeToken{ID: "tb", TokenHash: hashToken("bobtok"), UserID: bob.ID, Name: "b", CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	s := &Service{store: st, cfg: Config{NodeToken: "fleet-secret", EnableUserNodes: true},
		now: func() time.Time { return time.Unix(5000, 0) }}

	if _, err := st.UpsertNode(ctx, Node{ID: "alicenode", OwnerType: "user", OwnerUserID: alice.ID,
		URLs: []string{"turn:x:3478"}, TURNSecret: "t", CreatedAt: 1, LastSeenAt: 5000}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{ID: "fleetnode", OwnerType: "fleet",
		URLs: []string{"turn:y:3478"}, TURNSecret: "t", CreatedAt: 1, LastSeenAt: 5000}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, bearer, nodeID string
		want                 int
	}{
		{"no token", "", "fleetnode", http.StatusUnauthorized},
		{"garbage token", "nope", "fleetnode", http.StatusUnauthorized},
		{"no nodeID", "fleet-secret", "", http.StatusBadRequest},
		{"fleet token on a user's node", "fleet-secret", "alicenode", http.StatusForbidden},
		{"user token on another user's node", "bobtok", "alicenode", http.StatusForbidden},
		{"user token on a fleet node", "alicetok", "fleetnode", http.StatusForbidden},
		{"owner deregisters own node", "alicetok", "alicenode", http.StatusOK},
		{"fleet token on a fleet node", "fleet-secret", "fleetnode", http.StatusOK},
	}
	for _, c := range cases {
		body := `{"nodeID":"` + c.nodeID + `"}`
		if got := postDeregister(t, s, c.bearer, body); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}

	// Every refusal must have left the node installed; only the two authorised
	// calls above may have marked anything.
	for _, id := range []string{"alicenode", "fleetnode"} {
		n, ok, err := st.GetNode(ctx, id)
		if err != nil || !ok {
			t.Fatalf("GetNode(%s): ok=%v err=%v — the row must survive for audit", id, ok, err)
		}
		if n.RemovedAt != 5000 {
			t.Errorf("%s RemovedAt = %d, want 5000", id, n.RemovedAt)
		}
	}
}

// The uninstaller treats every failure as non-fatal and may be re-run. Neither
// repetition nor an id central has never heard of may become an error the
// operator has to work around, and a repeat must not rewrite WHEN the machine
// went away.
func TestDeregisterIsIdempotent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	clock := time.Unix(5000, 0)
	s := &Service{store: st, cfg: Config{NodeToken: "fleet-secret"}, now: func() time.Time { return clock }}
	if _, err := st.UpsertNode(ctx, Node{ID: "n1", OwnerType: "fleet",
		URLs: []string{"turn:x:3478"}, TURNSecret: "t", CreatedAt: 1, LastSeenAt: 5000}); err != nil {
		t.Fatal(err)
	}
	if code := postDeregister(t, s, "fleet-secret", `{"nodeID":"n1"}`); code != http.StatusOK {
		t.Fatalf("first deregister: got %d want 200", code)
	}
	clock = time.Unix(9999, 0)
	if code := postDeregister(t, s, "fleet-secret", `{"nodeID":"n1"}`); code != http.StatusOK {
		t.Fatalf("repeat deregister: got %d want 200", code)
	}
	n, _, _ := st.GetNode(ctx, "n1")
	if n.RemovedAt != 5000 {
		t.Errorf("RemovedAt = %d after a repeat, want the first stamp 5000", n.RemovedAt)
	}
	// A node central never knew about is not an error: the uninstall is still correct.
	if code := postDeregister(t, s, "fleet-secret", `{"nodeID":"never-existed"}`); code != http.StatusOK {
		t.Errorf("unknown node: got %d want 200", code)
	}
}

// A node on its way out must also stop being handed to clients as a relay
// candidate, even though its last heartbeat is still inside the online window.
func TestDeregisteredNodeLeavesTheICEPool(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "ice@example.com", "")
	if _, err := st.UpsertNode(ctx, Node{ID: "fleetice", OwnerType: "fleet",
		URLs: []string{"turn:x:3478"}, TURNSecret: "t", CreatedAt: 1, LastSeenAt: 5000}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{ID: "userice", OwnerType: "user", OwnerUserID: u.ID,
		URLs: []string{"turn:y:3478"}, TURNSecret: "t", CreatedAt: 1, LastSeenAt: 5000}); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkNodeRemoved(ctx, "fleetice", 5001); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkNodeRemoved(ctx, "userice", 5001); err != nil {
		t.Fatal(err)
	}
	if got, err := st.OnlineNodes(ctx, 4000); err != nil || len(got) != 0 {
		t.Errorf("OnlineNodes = %d nodes (err %v), want 0", len(got), err)
	}
	if got, err := st.UserNodes(ctx, u.ID, 4000); err != nil || len(got) != 0 {
		t.Errorf("UserNodes = %d nodes (err %v), want 0", len(got), err)
	}
	// The row itself stays: the admin panel and the audit trail still have to be
	// able to say where a file's node went.
	if _, ok, err := st.GetNode(ctx, "fleetice"); err != nil || !ok {
		t.Errorf("GetNode after removal: ok=%v err=%v, want the row kept for audit", ok, err)
	}
	if err := st.MarkNodeRemoved(ctx, "nosuchnode", 5001); err != ErrNotFound {
		t.Errorf("MarkNodeRemoved(unknown) = %v, want ErrNotFound", err)
	}
}
