package account

import (
	"context"
	"io"
	"net/http/httptest"
	"testing"
	"time"
)

// seedByoOwnNodeOffline sets up an owner with one file stored on their own BYO
// node; the node is registered but stale (LastSeenAt older than
// nodeOnlineWindow, so central must fall back to proxying rather than
// redirecting direct to it), with UpdateStartedAt set as given. Returns
// (ts, svc, store, ownerID, fileID).
func seedByoOwnNodeOffline(t *testing.T, updateStartedAt int64) (ts *httptest.Server, svc *Service, store *SQLiteStore, ownerID, fileID string) {
	t.Helper()
	ts, svc, store, _ = newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "byoupdate@example.com", "")
	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	t.Cleanup(fn.Close)
	// Seed the blob directly into the fake node's store so a GET can serve it
	// without needing to go through the upload path.
	const byoBlob = "hello world byo update exempt"
	nodeStore["bbk"] = []byte(byoBlob)
	if _, err := store.UpsertNode(ctx, Node{
		ID: "byonode", OwnerType: "user", OwnerUserID: owner.ID, StorageEnabled: true,
		StorageURL: fn.URL, StorageSecret: "ss",
		DownloadURL: "https://mynode.example.com", // BYO direct-capable in general
		CreatedAt:   1,
		// Offline: last heartbeat well outside nodeOnlineWindow (90s), so the
		// direct-redirect path is skipped and the download falls back to proxy.
		LastSeenAt:      svc.now().Add(-1 * time.Hour).Unix(),
		UpdateStartedAt: updateStartedAt,
	}); err != nil {
		t.Fatal(err)
	}
	const fid = "bf"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: "bbk", EncManifest: []byte("m"), Size: int64(len(byoBlob)),
		NodeID: "byonode", CreatedAt: 1, ExpiresAt: svc.now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	return ts, svc, store, owner.ID, fid
}

// A BYO owner's downloads from their OWN node are free — that is the whole
// deal: it is their disk and their bandwidth. When we restart that node to
// update it, central proxies instead and would normally meter the owner. That
// bill exists only because WE chose to update their machine, so we eat it.
func TestByoOwnNodeDownloadIsNotMeteredDuringItsUpdateWindow(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, time.Now().Unix())
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	dl, err := ts.Client().Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	io.Copy(io.Discard, dl.Body)
	dl.Body.Close()
	if dl.StatusCode != 200 {
		t.Fatalf("download status = %d, want 200", dl.StatusCode)
	}

	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != 0 {
		t.Fatalf("BYO own-node download during its update window must NOT be metered, got download=%d want 0", d)
	}
}

// The exemption must be narrow. A user who simply powered their node off is not
// our doing, and central really is paying that egress — keep metering it.
func TestByoOwnNodeDownloadIsStillMeteredWhenOfflineForOtherReasons(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, 0) // no update in flight
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	dl, err := ts.Client().Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	io.Copy(io.Discard, dl.Body)
	dl.Body.Close()
	if dl.StatusCode != 200 {
		t.Fatalf("download status = %d, want 200", dl.StatusCode)
	}

	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != 29 {
		t.Fatalf("BYO own-node download while offline for a non-update reason must be metered, got download=%d want 29", d)
	}
}

// The window must expire. A node that was commanded to update hours ago and
// never came back is a broken node, not an update in progress — metering
// resumes, otherwise a single stuck update would grant permanent free egress.
func TestByoUpdateExemptionExpires(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, time.Now().Add(-2*time.Hour).Unix())
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	dl, err := ts.Client().Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	io.Copy(io.Discard, dl.Body)
	dl.Body.Close()
	if dl.StatusCode != 200 {
		t.Fatalf("download status = %d, want 200", dl.StatusCode)
	}

	if _, d, _ := store.MonthlyUsage(ctx, ownerID, period); d != 29 {
		t.Fatalf("an update commanded hours ago is a stuck/broken node, must be metered, got download=%d want 29", d)
	}
}

// Fleet nodes are ours; their egress is an operator cost either way. The
// exemption must not silently widen to fleet-hosted files.
func TestFleetNodeDownloadIsStillMeteredDuringItsUpdateWindow(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	period := periodOf(svc.now().Unix())
	owner, _ := store.UpsertUserByEmail(ctx, "fleetupdate@example.com", "")
	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	const fleetBlob = "fleet node bytes during update"
	nodeStore["fbk"] = []byte(fleetBlob)
	if _, err := store.UpsertNode(ctx, Node{
		ID: "fleetnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: fn.URL, StorageSecret: "ss",
		DownloadURL:     "", // no direct download support; forces proxy path either way
		CreatedAt:       1,
		LastSeenAt:      svc.now().Add(-1 * time.Hour).Unix(), // offline, mid "update"
		UpdateStartedAt: svc.now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	const fid = "ff"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: "fbk", EncManifest: []byte("m"), Size: int64(len(fleetBlob)),
		NodeID: "fleetnode", CreatedAt: 1, ExpiresAt: svc.now().Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}

	dl, err := ts.Client().Get(ts.URL + "/api/files/" + fid + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	io.Copy(io.Discard, dl.Body)
	dl.Body.Close()
	if dl.StatusCode != 200 {
		t.Fatalf("download status = %d, want 200", dl.StatusCode)
	}

	if _, d, _ := store.MonthlyUsage(ctx, owner.ID, period); d != int64(len(fleetBlob)) {
		t.Fatalf("fleet-node download must stay metered regardless of its update window, got download=%d want %d", d, len(fleetBlob))
	}
}
