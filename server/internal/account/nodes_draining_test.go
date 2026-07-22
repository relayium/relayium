package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// Draining is the first half of a safe uninstall: stop feeding the node new
// files so the ones already on it can age out. Without this there is no moment
// at which the node is safe to remove — new files keep arriving.
func TestDrainingNodeReceivesNoNewUploads(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(1000, 0) },
		nodeHTTP: http.DefaultClient, cfg: Config{MaxFileSize: 1 << 20},
		pickN: func(n int) int { return 0 }}

	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://x:8081", StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1000,
		Draining: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	id, _, billable, err := s.placeUpload(ctx, "nobody", 1<<10)
	if err != nil {
		t.Fatalf("placeUpload: %v", err)
	}
	if id == n.ID {
		t.Errorf("upload placed on draining node %q; it must be out of the pool", id)
	}
	if id != "" || !billable {
		t.Errorf("got node %q billable=%v, want the central fallback (\"\", true)", id, billable)
	}
}

// Draining must NOT break downloads: the files already on the node have to stay
// reachable for their full TTL — that wait is the entire point of draining.
func TestDrainingNodeStillServesExistingDownloads(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "drain@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "drainingnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: "nodesecret",
		DownloadURL: "https://node7.relayium.com", CreatedAt: 1,
		LastSeenAt: time.Now().Unix(), Draining: true,
	}); err != nil {
		t.Fatal(err)
	}
	const fid, bkey = "drainfile", "drainbkey"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: bkey, EncManifest: []byte("m"), Size: 200,
		NodeID: "drainingnode", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("draining node returned %d for an existing file, want a 302 — draining is not offline",
			resp.StatusCode)
	}
}
