package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func getBlob(t *testing.T, ts *httptest.Server, id string) *http.Response {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/files/" + id + "/blob")
	if err != nil {
		t.Fatalf("get blob: %v", err)
	}
	return resp
}

func TestDownloadRoutesAndOffline(t *testing.T) {
	ts, _, store, _ := newFileServerWithQuota(t, 1<<20, 1<<20)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "dl@example.com", "")

	// (a) reachable node serves the blob.
	nodeStore := map[string][]byte{"bk1": []byte("plainish-ciphertext")}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	n, _ := store.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss", StorageFree: 1 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix()})
	store.CreateStoredFile(ctx, StoredFile{ID: "f1", UserID: u.ID, BlobKey: "bk1", EncManifest: []byte("m"),
		Size: int64(len(nodeStore["bk1"])), CreatedAt: 1, ExpiresAt: time.Now().Unix() + 3600, NodeID: n.ID})
	resp := getBlob(t, ts, "f1")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "plainish-ciphertext" {
		t.Fatalf("reachable download: %d %q", resp.StatusCode, body)
	}

	// (b)+(c) offline node -> 503, and a burn file is NOT consumed.
	off := fakeNode(t, map[string][]byte{})
	offURL := off.URL
	off.Close() // now unreachable
	no, _ := store.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:y:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: offURL, StorageSecret: "ss", StorageFree: 1 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix()})
	store.CreateStoredFile(ctx, StoredFile{ID: "f2", UserID: u.ID, BlobKey: "bk2", EncManifest: []byte("m"),
		Size: 5, BurnAfterRead: true, CreatedAt: 1, ExpiresAt: time.Now().Unix() + 3600, NodeID: no.ID})
	r2 := getBlob(t, ts, "f2")
	r2.Body.Close()
	if r2.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("offline node: want 503, got %d", r2.StatusCode)
	}
	if _, err := store.GetStoredFile(ctx, "f2"); err != nil {
		t.Fatalf("burn file on offline node must NOT be consumed, but row is gone: %v", err)
	}
}
