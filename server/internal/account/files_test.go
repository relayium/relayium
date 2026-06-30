package account

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// newFileServer builds a magic-link-capable account server with a disk blob store.
func newFileServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		TransferTTL: time.Hour, EnableMagic: true,
		MaxFileSize: 1024, DailyQuota: 4096, DefaultTTL: 3600, MaxTTL: 7200,
	})
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk: %v", err)
	}
	svc.SetBlobStore(disk)
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, svc, store, mail
}

// loginCookie logs a user in via magic link and returns the session cookie.
func loginCookie(t *testing.T, ts *httptest.Server, mail *capturingMailer, email string) *http.Cookie {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", map[string][]string{"email": {email}})
	i := strings.Index(mail.lastLink, "token=")
	verify, _ := client.Get(ts.URL + "/api/auth/magic/verify?token=" + mail.lastLink[i+len("token="):])
	for _, c := range verify.Cookies() {
		if c.Name == sessionCookie {
			return c
		}
	}
	t.Fatal("no session cookie")
	return nil
}

// uploadBody frames an opaque manifest + blob stream per the wire format.
func uploadBody(manifest, blob []byte) *bytes.Buffer {
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.BigEndian, uint32(len(manifest)))
	buf.Write(manifest)
	buf.Write(blob)
	return &buf
}

func postUpload(t *testing.T, ts *httptest.Server, cookie *http.Cookie, query string, body *bytes.Buffer) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", ts.URL+"/api/files"+query, body)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return resp
}

func decodeJSON(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestUploadSuccess(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "up@example.com")
	resp := postUpload(t, ts, cookie, "?burnAfterRead=1&ttl=0", uploadBody([]byte("manifestCT"), []byte("ciphertextblob")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var out struct {
		ID        string `json:"id"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	decodeJSON(t, resp, &out)
	if out.ID == "" || out.ExpiresAt == 0 {
		t.Fatalf("bad response %+v", out)
	}
	sf, err := store.GetStoredFile(context.Background(), out.ID)
	if err != nil {
		t.Fatalf("stored file missing: %v", err)
	}
	if !sf.BurnAfterRead || sf.Size != int64(len("ciphertextblob")) || string(sf.EncManifest) != "manifestCT" {
		t.Fatalf("stored row wrong: %+v", sf)
	}
	// ttl=0 → DefaultTTL (3600); created at now → expiresAt ≈ now+3600.
	if out.ExpiresAt != sf.ExpiresAt {
		t.Fatalf("expiresAt mismatch")
	}
}

func TestUploadOversizeIs413(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "big@example.com")
	big := bytes.Repeat([]byte("x"), 2048) // > MaxFileSize 1024
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), big))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize: want 413, got %d", resp.StatusCode)
	}
}

func TestUploadOverQuotaIs429(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "quota@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "quota@example.com", "")
	// Pre-fill the rolling window to within 100 bytes of the 4096 quota.
	_ = store.RecordUpload(context.Background(), UploadEvent{ID: newID(), UserID: u.ID, Bytes: 4000, UploadedAt: time.Now().Unix()})
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("y"), 500)))
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("over quota: want 429, got %d", resp.StatusCode)
	}
}

func TestUploadUnauthIs401(t *testing.T) {
	ts, _, _, _ := newFileServer(t)
	resp := postUpload(t, ts, nil, "?ttl=0", uploadBody([]byte("m"), []byte("c")))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth: want 401, got %d", resp.StatusCode)
	}
}
