package account

import (
	"context"
	"testing"
	"time"
)

func TestUploadRoutesToNode(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 1<<20, 1<<20)
	ctx := context.Background()

	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	n, _ := store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	})

	cookie := loginCookie(t, ts, mail, "up@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("ciphertext")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	sf, err := store.GetStoredFile(ctx, up.ID)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if sf.NodeID != n.ID {
		t.Fatalf("StoredFile.NodeID = %q, want node %q", sf.NodeID, n.ID)
	}
	if string(nodeStore[sf.BlobKey]) != "ciphertext" {
		t.Fatalf("node did not receive ciphertext under key %q: %q", sf.BlobKey, nodeStore[sf.BlobKey])
	}
}
