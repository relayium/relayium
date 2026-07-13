package account

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// doJSONMap POSTs (optionally empty) JSON to path using the shared doJSON
// helper (usernodes_test.go) and decodes the response body as a generic map,
// which is convenient for asserting on status fields without a typed struct
// per response shape.
func doJSONMap(t *testing.T, ts *http.Client, url string, cookie *http.Cookie, body string) map[string]any {
	t.Helper()
	var reqBody *strings.Reader
	if body != "" {
		reqBody = strings.NewReader(body)
	} else {
		reqBody = strings.NewReader("")
	}
	req, err := http.NewRequest(http.MethodPost, url, reqBody)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := ts.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode (status %d): %v", resp.StatusCode, err)
	}
	return out
}

func TestDeviceCodeFlow(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()

	// start
	start := doJSONMap(t, client, ts.URL+"/api/cli/device/start", nil, "")
	userCode, _ := start["user_code"].(string)
	deviceCode, _ := start["device_code"].(string)
	if userCode == "" || deviceCode == "" {
		t.Fatalf("start missing fields: %+v", start)
	}
	if start["verification_uri"] != "http://example.test/device" {
		t.Fatalf("unexpected verification_uri: %+v", start["verification_uri"])
	}

	// poll before approval -> pending
	p1 := doJSONMap(t, client, ts.URL+"/api/cli/device/poll", nil, `{"device_code":"`+deviceCode+`"}`)
	if p1["status"] != "authorization_pending" {
		t.Fatalf("want pending, got %v", p1["status"])
	}

	// create a user + session (via magic link), approve via the session-authed endpoint
	cookie := loginCookie(t, ts, mail, "clidev@example.com")
	approve := doJSONMap(t, client, ts.URL+"/api/cli/device/approve", cookie, `{"user_code":"`+userCode+`"}`)
	if approve["status"] != "ok" || approve["account_email"] != "clidev@example.com" {
		t.Fatalf("approve failed: %+v", approve)
	}

	// poll after approval -> ok + token
	p2 := doJSONMap(t, client, ts.URL+"/api/cli/device/poll", nil, `{"device_code":"`+deviceCode+`"}`)
	tok, _ := p2["access_token"].(string)
	if p2["status"] != "ok" || tok == "" {
		t.Fatalf("want ok+token, got %+v", p2)
	}
	if !strings.HasPrefix(tok, "rlm_cli_") {
		t.Fatalf("token missing rlm_cli_ prefix: %q", tok)
	}
	if p2["account_email"] != "clidev@example.com" {
		t.Fatalf("account_email mismatch: %+v", p2)
	}

	// second poll -> already consumed (denied/expired path, not a second token)
	p3 := doJSONMap(t, client, ts.URL+"/api/cli/device/poll", nil, `{"device_code":"`+deviceCode+`"}`)
	if p3["status"] == "ok" {
		t.Fatal("token must be issued only once")
	}
}

// TestDeviceApproveInvalidCodeCreatesNoRows is the regression test for the
// validate-then-mint fix: an ordinary bad/never-started user_code must 400
// without leaving a phantom "CLI" device or an orphaned cli_token behind.
func TestDeviceApproveInvalidCodeCreatesNoRows(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "badapprove@example.com")

	// Approve a code that was never started.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/cli/device/approve",
		strings.NewReader(`{"user_code":"ZZZZ-ZZZZ"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for unknown user_code, got %d", resp.StatusCode)
	}

	// The user must have gained no device (CLI or otherwise) from the failed
	// approve, which also means no CLI token row was minted for one.
	ctx := context.Background()
	// UpsertUserByEmail is idempotent: the account already exists from
	// loginCookie, so this returns it (resolving its ID) without inserting.
	u, err := store.UpsertUserByEmail(ctx, "badapprove@example.com", "")
	if err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	devs, err := store.ListDevices(ctx, u.ID)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	for _, d := range devs {
		if d.Kind == "cli" {
			t.Fatalf("failed approve left a phantom cli device: %+v", d)
		}
	}
}

func TestDevicePollUnknownCode(t *testing.T) {
	ts, _ := newTestServer(t)
	p := doJSONMap(t, ts.Client(), ts.URL+"/api/cli/device/poll", nil, `{"device_code":"nope"}`)
	if p["status"] != "expired" {
		t.Fatalf("unknown device_code should read as expired, got %+v", p)
	}
}

// TestDevicePendingShowsOrigin: device/start records the CLI's IP + User-Agent,
// and the session-authed /pending lookup surfaces them (so the approval page can
// show what's being authorized). The lookup rejects anonymous callers.
func TestDevicePendingShowsOrigin(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()

	startReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/cli/device/start", strings.NewReader(""))
	startReq.Header.Set("User-Agent", "relayium-cli/9.9.9")
	sresp, err := client.Do(startReq)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	var start map[string]any
	_ = json.NewDecoder(sresp.Body).Decode(&start)
	sresp.Body.Close()
	userCode, _ := start["user_code"].(string)
	if userCode == "" {
		t.Fatalf("start missing user_code: %+v", start)
	}

	// Anonymous lookup is refused.
	anon, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/cli/device/pending?user_code="+userCode, nil)
	ar, err := client.Do(anon)
	if err != nil {
		t.Fatalf("anon pending: %v", err)
	}
	ar.Body.Close()
	if ar.StatusCode != http.StatusUnauthorized {
		t.Fatalf("pending without session should 401, got %d", ar.StatusCode)
	}

	// A signed-in session sees the captured origin.
	cookie := loginCookie(t, ts, mail, "pend@example.com")
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/cli/device/pending?user_code="+userCode, nil)
	req.AddCookie(cookie)
	r, err := client.Do(req)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	var d map[string]any
	_ = json.NewDecoder(r.Body).Decode(&d)
	r.Body.Close()
	if d["found"] != true {
		t.Fatalf("pending should be found: %+v", d)
	}
	if d["user_agent"] != "relayium-cli/9.9.9" {
		t.Fatalf("user_agent = %v, want relayium-cli/9.9.9", d["user_agent"])
	}
	if ip, _ := d["client_ip"].(string); ip == "" {
		t.Fatalf("client_ip should be recorded: %+v", d)
	}
}
