package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// TestUploadToOwnNodeSkipsQuota: a user with an online own storage node has
// uploads routed there for free — the daily quota is NOT debited, and the
// stored row's NodeID points at the user's own node.
func TestUploadToOwnNodeSkipsQuota(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 130*1024, 1<<20)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "own@example.com", "")
	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	store.UpsertNode(ctx, Node{ID: "mynode", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:x:3478"},
		TURNSecret: "t", StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss", StorageFree: 100 << 30,
		CreatedAt: 1, LastSeenAt: time.Now().Unix()})

	cookie := loginCookie(t, ts, mail, "own@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("ciphertext")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)
	sf, _ := store.GetStoredFile(ctx, up.ID)
	if sf.NodeID != "mynode" || string(nodeStore[sf.BlobKey]) != "ciphertext" {
		t.Fatalf("not placed on own node: node=%q blob=%q", sf.NodeID, nodeStore[sf.BlobKey])
	}
	// non-billable: daily upload quota NOT debited
	used, _ := store.UserUploadedSince(ctx, u.ID, 0)
	if used != 0 {
		t.Fatalf("own-node upload must not debit quota, used=%d", used)
	}
}

// TestStrictModeOwnNodeOfflineIs503NoFallback is the privacy-contract regression
// test: a user in strict "only my nodes" mode (only_own_nodes=1) whose own
// storage node is offline (here: absent entirely) must get 503 from
// handleUploadFile, via placeUpload's errStrictNoNode sentinel — and must NOT
// silently fall back to our fleet/central infra, which would violate their
// strict privacy choice. We also assert nothing leaked to our infra: the daily
// quota is untouched and no StoredFile row was created for this user.
func TestStrictModeOwnNodeOfflineIs503NoFallback(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 130*1024, 1<<20)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "strict@example.com", "")
	if err := store.SetOnlyOwnNodes(ctx, u.ID, true); err != nil {
		t.Fatalf("SetOnlyOwnNodes: %v", err)
	}
	// No storage node registered for this user at all: placeUpload must see
	// zero online own nodes and, because the user is strict, refuse rather
	// than fall back to fleet/central.

	cookie := loginCookie(t, ts, mail, "strict@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("ciphertext")))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("strict user, no online own node: want 503, got %d", resp.StatusCode)
	}

	// Nothing must have leaked to our infra: quota untouched, no stored file.
	used, _ := store.UserUploadedSince(ctx, u.ID, 0)
	if used != 0 {
		t.Fatalf("strict-mode 503 must not debit quota, used=%d", used)
	}
	files, err := store.ListStoredFilesByUser(ctx, u.ID)
	if err != nil {
		t.Fatalf("ListStoredFilesByUser: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("strict-mode 503 must not create a stored file, got %d", len(files))
	}
}

// TestStrictModeStaleOwnNodeIs503NoFallback covers the other half of the
// contract: a strict user's own node that IS registered but hasn't sent a
// heartbeat within nodeOnlineWindow counts as offline too, so the same 503 /
// no-fallback guarantee must hold (not just for a wholly absent node).
func TestStrictModeStaleOwnNodeIs503NoFallback(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 130*1024, 1<<20)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "strictstale@example.com", "")
	if err := store.SetOnlyOwnNodes(ctx, u.ID, true); err != nil {
		t.Fatalf("SetOnlyOwnNodes: %v", err)
	}
	store.UpsertNode(ctx, Node{ID: "stalenode", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:x:3478"},
		TURNSecret: "t", StorageEnabled: true, StorageURL: "http://unused.invalid", StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: time.Now().Add(-1 * time.Hour).Unix()})

	cookie := loginCookie(t, ts, mail, "strictstale@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("ciphertext")))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("strict user, stale own node: want 503, got %d", resp.StatusCode)
	}

	used, _ := store.UserUploadedSince(ctx, u.ID, 0)
	if used != 0 {
		t.Fatalf("strict-mode 503 must not debit quota, used=%d", used)
	}
	files, err := store.ListStoredFilesByUser(ctx, u.ID)
	if err != nil {
		t.Fatalf("ListStoredFilesByUser: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("strict-mode 503 must not create a stored file, got %d", len(files))
	}
}
