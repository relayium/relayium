package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/account"
	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/storage"
)

// noopMailer satisfies account.Mailer without sending anything: the e2e flow
// authenticates via the device-code path (session cookie + approve/poll), so
// no magic-link/verify/reset mail is ever produced.
type noopMailer struct{}

func (noopMailer) SendMagicLink(context.Context, string, string) error     { return nil }
func (noopMailer) SendVerifyEmail(context.Context, string, string) error   { return nil }
func (noopMailer) SendPasswordReset(context.Context, string, string) error { return nil }

// newE2EService stands up a real account.Service over an in-memory SQLite
// store and a real on-disk blob store, using only exported APIs (the account
// package's own test helpers are package-private and unreachable from here).
func newE2EService(t *testing.T) (*httptest.Server, *account.Service, *account.SQLiteStore) {
	t.Helper()
	store, err := account.OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	svc := account.NewService(store, noopMailer{}, account.Config{
		BaseURL:    "http://127.0.0.1",
		SessionTTL: time.Hour,
		MagicTTL:   15 * time.Minute,
		// Small stored-transfer limits are fine; MaxMaxDownloads must be >= the
		// maxDownloads we test (2) so the clamp doesn't reduce it, and
		// DefaultRetention=1 (ttl) keeps a plain upload unlimited-until-TTL.
		MaxFileSize:         1 << 20,
		DailyQuota:          8 << 20,
		DefaultTTL:          3600,
		MaxTTL:              7200,
		DefaultRetention:    1, // ttl
		DefaultMaxDownloads: 5,
		MaxMaxDownloads:     100,
	})
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk store: %v", err)
	}
	svc.SetBlobStore(disk)
	if err := svc.SeedSettings(context.Background()); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, svc, store
}

// cliToken drives the real device-code flow over HTTP to mint a CLI access
// token for the given user, exactly as `relayium login` would: start a device
// authorization, approve it with a logged-in session cookie, then poll for the
// bearer token. No unexported account helpers are needed.
func cliToken(t *testing.T, ts *httptest.Server, svc *account.Service, userID string) string {
	t.Helper()
	ctx := context.Background()

	sess, err := svc.IssueSession(ctx, userID)
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}

	// 1. start
	var start struct {
		UserCode   string `json:"user_code"`
		DeviceCode string `json:"device_code"`
	}
	postE2E(t, ts, "/api/cli/device/start", nil, nil, &start)
	if start.UserCode == "" || start.DeviceCode == "" {
		t.Fatalf("device start: empty codes %+v", start)
	}

	// 2. approve (authenticated by the session cookie)
	cookie := &http.Cookie{Name: "relayium_session", Value: sess.ID}
	approveBody := map[string]string{"user_code": start.UserCode}
	postE2E(t, ts, "/api/cli/device/approve", cookie, approveBody, nil)

	// 3. poll for the token
	var poll struct {
		Status      string `json:"status"`
		AccessToken string `json:"access_token"`
	}
	postE2E(t, ts, "/api/cli/device/poll", nil, map[string]string{"device_code": start.DeviceCode}, &poll)
	if poll.Status != "ok" || poll.AccessToken == "" {
		t.Fatalf("device poll: status=%q token empty=%v", poll.Status, poll.AccessToken == "")
	}
	return poll.AccessToken
}

// postE2E POSTs an optional JSON body (with an optional cookie) and decodes the
// JSON response into out when non-nil, asserting a 2xx status.
func postE2E(t *testing.T, ts *httptest.Server, path string, cookie *http.Cookie, body, out any) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s body: %v", path, err)
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(http.MethodPost, ts.URL+path, rdr)
	if err != nil {
		t.Fatalf("new request %s: %v", path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do %s: %v", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		t.Fatalf("%s: unexpected status %d", path, resp.StatusCode)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
}

// TestCloudUpDownE2E proves the whole CLI cloud chain end-to-end against a real
// account.Service: a real device-code login mints a bearer token, the cloud
// client Uploads an encrypted file, Downloads it the two times its
// max-downloads budget allows (verifying the round-tripped plaintext each
// time), and the third Download fails once the retention budget is spent.
func TestCloudUpDownE2E(t *testing.T) {
	ts, svc, store := newE2EService(t)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "a@example.com", "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	token := cliToken(t, ts, svc, u.ID)

	c := cloud.NewClient(ts.URL)
	c.Token = token

	// up: encrypt + upload a small file with a 2-download retention budget.
	src := filepath.Join(t.TempDir(), "hello.txt")
	const content = "hello world"
	if err := os.WriteFile(src, []byte(content), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	id, key, err := c.Upload(ctx, []string{src}, cloud.UploadOpts{MaxDownloads: 2})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if id == "" || key == "" {
		t.Fatalf("upload returned empty id/key: id=%q key=%q", id, key)
	}

	// down: the two allowed downloads must each reproduce the plaintext.
	for i := 0; i < 2; i++ {
		dest := t.TempDir()
		if _, err := c.Download(ctx, id, key, dest); err != nil {
			t.Fatalf("download %d: %v", i, err)
		}
		got, err := os.ReadFile(filepath.Join(dest, "hello.txt"))
		if err != nil {
			t.Fatalf("read downloaded %d: %v", i, err)
		}
		if string(got) != content {
			t.Fatalf("download %d content = %q, want %q", i, got, content)
		}
	}

	// The third download must fail: the 2 download slots are spent (server 404).
	if _, err := c.Download(ctx, id, key, t.TempDir()); err == nil {
		t.Fatal("third download should fail: max-downloads=2 already spent")
	}
}

// TestCloudPlainUpDownE2E covers the plain (no-opts) path: with
// DefaultRetention=ttl a plain upload is unlimited-until-TTL, so it round-trips
// and can be downloaded more than twice.
func TestCloudPlainUpDownE2E(t *testing.T) {
	ts, svc, store := newE2EService(t)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "b@example.com", "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	c := cloud.NewClient(ts.URL)
	c.Token = cliToken(t, ts, svc, u.ID)

	src := filepath.Join(t.TempDir(), "plain.txt")
	const content = "unlimited until ttl"
	if err := os.WriteFile(src, []byte(content), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	id, key, err := c.Upload(ctx, []string{src}, cloud.UploadOpts{})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}

	// Three downloads all succeed: no per-download budget on a ttl-retention file.
	for i := 0; i < 3; i++ {
		dest := t.TempDir()
		if _, err := c.Download(ctx, id, key, dest); err != nil {
			t.Fatalf("plain download %d: %v", i, err)
		}
		got, err := os.ReadFile(filepath.Join(dest, "plain.txt"))
		if err != nil {
			t.Fatalf("read downloaded %d: %v", i, err)
		}
		if string(got) != content {
			t.Fatalf("plain download %d content = %q, want %q", i, got, content)
		}
	}
}
