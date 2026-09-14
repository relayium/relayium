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

// TestFleetNodeDownloadIsNeverRedirected: a fleet node that is online and
// advertising a DownloadURL — every condition the withdrawn optimization
// required — must still be proxied, and nothing may be billed before the bytes
// are served. Central cannot observe a redirect's egress, so charging the file
// size up front billed requests that delivered nothing and created the unissued
// refund the node receipt then had to hand back.
func TestFleetNodeDownloadIsNeverRedirected(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	_ = mail
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "dd@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "fleetnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "https://internal.node", StorageSecret: "nodesecret",
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
	if resp.StatusCode == http.StatusFound {
		t.Fatalf("fleet-hosted download was redirected to %q; central must stay in the data path",
			resp.Header.Get("Location"))
	}
	// The fake StorageURL is unreachable, so this request egressed nothing.
	if _, d, _ := store.MonthlyUsage(ctx, owner.ID, periodOf(svc.now().Unix())); d != 0 {
		t.Fatalf("a download that served no bytes metered %d against the owner, want 0", d)
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
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/files/bf/blob", nil)
	req.Header.Set("X-Relayium-Direct-Download", "1")
	resp, err := client.Do(req)
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
	if loc.Path != "/dl/bbk" {
		t.Fatalf("redirect path = %q, want /dl/bbk", loc.Path)
	}
	// The node verifies this offline, against its own secret: a redirect central
	// signs wrong is a download that simply fails at the node.
	if tok := loc.Query().Get("t"); !dltoken.Verify("bs", "bbk", time.Now().Unix(), tok) {
		t.Fatalf("redirect token must verify under the node secret for this key; got %q", tok)
	}
	// FREE: central pays nothing, so the owner is NOT metered.
	if _, d, _ := store.MonthlyUsage(ctx, owner.ID, periodOf(svc.now().Unix())); d != 0 {
		t.Fatalf("BYO own-node direct download must NOT be metered, got download=%d want 0", d)
	}
}

func TestByoCustomDomainBrowserRequestStaysSameOrigin(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "web-byo@example.com", "")
	_, _ = store.UpsertNode(ctx, Node{
		ID: "webbyo", OwnerType: "user", OwnerUserID: owner.ID, StorageEnabled: true,
		StorageURL: "https://internal.byo", StorageSecret: "bs",
		DownloadURL: "https://files.example.net", CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	})
	_ = store.CreateStoredFile(ctx, StoredFile{
		ID: "webfile", UserID: owner.ID, BlobKey: "key", EncManifest: []byte("m"), Size: 1,
		NodeID: "webbyo", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(ts.URL + "/api/files/webfile/blob")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusFound {
		t.Fatalf("browser-compatible request must not redirect outside CSP: %s", resp.Header.Get("Location"))
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
