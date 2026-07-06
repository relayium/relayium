package account

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
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
