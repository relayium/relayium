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
func seedByoOwnNodeOffline(t *testing.T, updateStartedAt func(now time.Time) int64) (ts *httptest.Server, svc *Service, store *SQLiteStore, ownerID, fileID string) {
	t.Helper()
	return seedByoOwnNode(t, updateStartedAt, 0, true)
}

// seedByoOwnNode generalizes seedByoOwnNodeOffline to also control MaxDownloads
// (so a burn/limited file can be seeded) and whether s.directDownload is on at
// all, since byoUpdateExempt now requires both to match the direct-download
// branch's own eligibility gate. Returns (ts, svc, store, ownerID, fileID).
// updateStartedAt is a function of the service clock, not a timestamp, and the
// clock is frozen below. byoUpdateExempt compares s.now() against the seeded
// value at REQUEST time, so seeding from wall time meant the gap grew by
// however long setup took — and a test seeding the exact window boundary was
// really asserting "setup finished within one second". Under -race, or a loaded
// machine, it did not, and the boundary tests failed at random.
func seedByoOwnNode(t *testing.T, updateStartedAt func(now time.Time) int64, maxDownloads int64, directDownload bool) (ts *httptest.Server, svc *Service, store *SQLiteStore, ownerID, fileID string) {
	t.Helper()
	ts, svc, store, _ = newFileServer(t)
	frozen := time.Now()
	svc.now = func() time.Time { return frozen }
	svc.SetDirectDownload(directDownload)
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
		UpdateStartedAt: updateStartedAt(frozen),
	}); err != nil {
		t.Fatal(err)
	}
	const fid = "bf"
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: fid, UserID: owner.ID, BlobKey: "bbk", EncManifest: []byte("m"), Size: int64(len(byoBlob)),
		NodeID: "byonode", CreatedAt: 1, ExpiresAt: svc.now().Add(time.Hour).Unix(),
		MaxDownloads: maxDownloads,
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
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, func(now time.Time) int64 { return now.Unix() })
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
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, func(time.Time) int64 { return 0 }) // no update in flight
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
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, func(now time.Time) int64 { return now.Add(-2 * time.Hour).Unix() })
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

// A burn/limited file (MaxDownloads != 0) is ALWAYS proxied by design, on the
// owner's own node or anywhere else, regardless of node health — central must
// enforce the download-count/burn semantics itself. So an update in flight on
// that node caused nothing: absent the update this download would STILL have
// been proxied (never eligible for the free direct path in the first place),
// and it must stay metered.
func TestByoOwnNodeLimitedFileStillMeteredDuringUpdateWindow(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOwnNode(t, func(now time.Time) int64 { return now.Unix() }, 1, true)
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
		t.Fatalf("a burn/limited own-node download during an update window must still be metered, got download=%d want 29", d)
	}
}

// directDownload is a service-wide flag, not per-file. With it off, EVERY
// download is always proxied regardless of node state, so an update in
// flight on the owner's own node caused nothing here either — absent the
// update this download would never have taken the direct path anyway.
func TestByoOwnNodeStillMeteredWhenDirectDownloadOff(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOwnNode(t, func(now time.Time) int64 { return now.Unix() }, 0, false)
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
		t.Fatalf("with directDownload off, an own-node download during an update window must still be metered, got download=%d want 29", d)
	}
}

// Boundary: exactly at byoUpdateExemptWindow the check ("<=") must still
// treat the update as in flight, so the download stays exempt.
func TestByoUpdateExemptionAtExactWindowBoundaryIsStillExempt(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, func(now time.Time) int64 { return now.Add(-byoUpdateExemptWindow).Unix() })
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
		t.Fatalf("a download exactly at byoUpdateExemptWindow must still be exempt, got download=%d want 0", d)
	}
}

// Boundary: one second past byoUpdateExemptWindow the update must be treated
// as stuck/broken, not in flight, so the download is metered again.
func TestByoUpdateExemptionOneSecondPastWindowIsMetered(t *testing.T) {
	ts, svc, store, ownerID, fid := seedByoOwnNodeOffline(t, func(now time.Time) int64 { return now.Add(-byoUpdateExemptWindow - time.Second).Unix() })
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
		t.Fatalf("a download one second past byoUpdateExemptWindow must be metered, got download=%d want 29", d)
	}
}
