package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/dltoken"
)

// TestDirectDownloadRedirectsToNode: when direct download is on and a file lives
// on a fleet node advertising a DownloadURL, GET /api/files/{id}/blob 302s the
// client straight to <DownloadURL>/dl/{key}?t=<token> (central out of the data
// path), the token verifies under the node's secret, and the owner is metered
// the file size (pre-charge, since central won't see the bytes).
func TestDirectDownloadRedirectsToNode(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	_ = mail
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "dd@example.com", "")
	const nodeSecret = "nodesecret"
	if _, err := store.UpsertNode(ctx, Node{
		ID: "fleetnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: nodeSecret,
		DownloadURL: "https://node7.relayium.com", CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	const fid, bkey = "file1", "bkey1"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: bkey, EncManifest: []byte("m"), Size: 200, NodeID: "fleetnode",
		CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
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
		t.Fatalf("want 302 direct-download redirect, got %d", resp.StatusCode)
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatalf("bad Location %q: %v", resp.Header.Get("Location"), err)
	}
	if got := loc.Scheme + "://" + loc.Host; got != "https://node7.relayium.com" {
		t.Fatalf("redirect host = %q, want the node's DownloadURL", got)
	}
	if loc.Path != "/dl/"+bkey {
		t.Fatalf("redirect path = %q, want /dl/%s", loc.Path, bkey)
	}
	tok := loc.Query().Get("t")
	if !dltoken.Verify(nodeSecret, bkey, time.Now().Unix(), tok) {
		t.Fatalf("redirect token must verify under the node secret for this key; got %q", tok)
	}
	// Owner pre-charged the file size (central won't observe the actual egress).
	if _, d, _ := store.MonthlyUsage(ctx, owner.ID, periodOf(svc.now().Unix())); d != 200 {
		t.Fatalf("direct download must pre-meter the file size against the owner, got %d want 200", d)
	}
}

// TestByoOwnNodeDirectDownloadIsFree: a file on the OWNER's own BYO node that
// advertises a DownloadURL is served direct from that node — central pays no
// egress and the disk is the user's own, so the download is FREE (302, no
// metering, and not blocked even if the owner is over their traffic cap).
func TestByoOwnNodeDirectDownloadIsFree(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "byo@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "byonode", OwnerType: "user", OwnerUserID: owner.ID, StorageEnabled: true,
		StorageURL: "https://internal.byo", StorageSecret: "bs",
		DownloadURL: "https://mynode.example.com", CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "bf", UserID: owner.ID, BlobKey: "bbk", EncManifest: []byte("m"), Size: 500,
		NodeID: "byonode", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/files/bf/blob")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("BYO own-node download must redirect direct, got %d", resp.StatusCode)
	}
	loc, _ := url.Parse(resp.Header.Get("Location"))
	if loc.Host != "mynode.example.com" {
		t.Fatalf("must redirect to the BYO node, got host %q", loc.Host)
	}
	// FREE: central pays nothing, so the owner is NOT metered.
	if _, d, _ := store.MonthlyUsage(ctx, owner.ID, periodOf(svc.now().Unix())); d != 0 {
		t.Fatalf("BYO own-node direct download must NOT be metered, got download=%d want 0", d)
	}
}

// seedDirectFile sets up an owner + a fleet node + one unlimited stored file on
// it, returning the file id. downloadURL="" models a node without direct support;
// maxDownloads>0 models a limited/burn file. Returns (ts, svc, store, fileID).
func seedDirectFile(t *testing.T, downloadURL string, maxDownloads int64) (*httptest.Server, *Service, *SQLiteStore, string) {
	t.Helper()
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "dd2@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "fleetnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: "s",
		DownloadURL: downloadURL, CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "f", UserID: owner.ID, BlobKey: "bk", EncManifest: []byte("m"), Size: 200,
		NodeID: "fleetnode", MaxDownloads: maxDownloads,
		CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	return ts, svc, store, "f"
}

// mustNotRedirect asserts GET blob does not take the direct-download branch (a
// 302). It reaching the proxy path (503 here, no real node) proves the branch
// was skipped.
func mustNotRedirect(t *testing.T, ts *httptest.Server, fid string) {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusFound {
		t.Fatalf("expected NO direct-download redirect, but got 302 to %q", resp.Header.Get("Location"))
	}
}

func TestDirectDownloadOffFallsBackToProxy(t *testing.T) {
	ts, svc, _, fid := seedDirectFile(t, "https://node7.relayium.com", 0)
	svc.SetDirectDownload(false) // kill-switch off
	mustNotRedirect(t, ts, fid)
}

func TestDirectDownloadSkippedWithoutDownloadURL(t *testing.T) {
	ts, svc, _, fid := seedDirectFile(t, "", 0) // node advertises no public URL
	svc.SetDirectDownload(true)
	mustNotRedirect(t, ts, fid)
}

func TestDirectDownloadSkippedForLimitedFile(t *testing.T) {
	ts, svc, _, fid := seedDirectFile(t, "https://node7.relayium.com", 1) // burn-equivalent
	svc.SetDirectDownload(true)
	mustNotRedirect(t, ts, fid)
}
