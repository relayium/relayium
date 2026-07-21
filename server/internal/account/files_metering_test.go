package account

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestUploadAndDownloadRecordMonthlyMeter(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	cookie := loginCookie(t, ts, mail, "owner@example.com")

	// Upload a 200-byte ciphertext blob (well under the 1024 test MaxFileSize).
	blob := bytes.Repeat([]byte("x"), 200)
	resp := postUpload(t, ts, cookie, "?burnAfterRead=0&ttl=3600", uploadBody([]byte("manifest"), blob))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	// Response carries id + expiresAt; decode id for the download.
	var raw map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&raw)
	resp.Body.Close()
	up.ID, _ = raw["id"].(string)
	if up.ID == "" {
		t.Fatal("no file id in upload response")
	}

	// Find the user to read their meter.
	owner, _ := store.UpsertUserByEmail(ctx, "owner@example.com", "owner")
	if u, _, _ := store.MonthlyUsage(ctx, owner.ID, period); u != 200 {
		t.Fatalf("after upload: monthly upload = %d, want 200", u)
	}

	// Download the blob (public endpoint, no auth) to completion.
	dl, err := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	_, _ = io.Copy(io.Discard, dl.Body)
	dl.Body.Close()
	if dl.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d", dl.StatusCode)
	}

	if _, d, _ := store.MonthlyUsage(ctx, owner.ID, period); d != 200 {
		t.Fatalf("after download: monthly download = %d, want 200", d)
	}
}

// TestOwnNodeDownloadIsMetered pins the cost-hardening fix: a file stored on the
// user's OWN node still has its DOWNLOAD metered against the owner, because the
// download is proxied through central (node -> central -> client) and so costs
// central egress. Storage on an own node is free; the download bandwidth is not.
// (Own-node uploads remain quota-free — that is the upload side, unchanged.)
func TestOwnNodeDownloadIsMetered(t *testing.T) {
	ts, svc, store, mail := newFileServerWithQuota(t, 130*1024, 1<<20)
	ctx := context.Background()
	period := periodOf(svc.now().Unix())
	u, _ := store.UpsertUserByEmail(ctx, "ownmeter@example.com", "")
	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	store.UpsertNode(ctx, Node{ID: "mynode", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:x:3478"},
		TURNSecret: "t", StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss", StorageFree: 100 << 30,
		CreatedAt: 1, LastSeenAt: time.Now().Unix()})

	cookie := loginCookie(t, ts, mail, "ownmeter@example.com")
	blob := bytes.Repeat([]byte("z"), 200)
	resp := postUpload(t, ts, cookie, "?ttl=3600", uploadBody([]byte("m"), blob))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)
	sf, _ := store.GetStoredFile(ctx, up.ID)
	if sf.NodeID != "mynode" {
		t.Fatalf("precondition: file must be on the own node, got node=%q", sf.NodeID)
	}
	// Upload to the own node is free (no upload quota debited) — unchanged.
	if uUp, _, _ := store.MonthlyUsage(ctx, u.ID, period); uUp != 0 {
		t.Fatalf("own-node upload must not meter upload traffic, got %d", uUp)
	}

	dl, err := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	io.Copy(io.Discard, dl.Body)
	dl.Body.Close()
	if dl.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d", dl.StatusCode)
	}
	// The fix: the central-proxied download IS metered against the owner.
	if _, d, _ := store.MonthlyUsage(ctx, u.ID, period); d != 200 {
		t.Fatalf("own-node download must meter central egress against the owner, got download=%d want 200", d)
	}
}

// TestDownloadLimiterBlocks429 proves the per-IP download rate limit gates the
// public blob endpoint (defence-in-depth against a burst amplifying central
// egress before the traffic gate reacts).
func TestDownloadLimiterBlocks429(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	svc.SetDownloadLimiter(denyLimiter{})
	cookie := loginCookie(t, ts, mail, "dllimit@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=3600", uploadBody([]byte("m"), bytes.Repeat([]byte("y"), 50)))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)
	_ = store

	dl, err := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer dl.Body.Close()
	if dl.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("download with a denying limiter must be 429, got %d", dl.StatusCode)
	}
}
