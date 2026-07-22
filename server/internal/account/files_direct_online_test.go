package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// A node that stopped heartbeating may be restarting for an update or simply
// gone; either way a 302 there hands the downloader a dead origin (522 through
// Cloudflare). Central must proxy instead. The online case is already covered
// by TestDirectDownloadRedirectsToNode, which sets LastSeenAt to now.
func TestDirectDownloadSkipsOfflineNode(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "offline@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "restartingnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: "nodesecret",
		DownloadURL: "https://node7.relayium.com", CreatedAt: 1,
		// Well past nodeOnlineWindow — this is what a node mid-restart looks like.
		LastSeenAt: time.Now().Add(-time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	const fid, bkey = "offfile", "offbkey"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: bkey, EncManifest: []byte("m"), Size: 200,
		NodeID: "restartingnode", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
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

	if resp.StatusCode == http.StatusFound {
		t.Fatalf("offline node still got a 302 to %q; central must proxy instead",
			resp.Header.Get("Location"))
	}
}
