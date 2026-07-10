package account

import (
	"context"
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
