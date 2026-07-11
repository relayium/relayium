package account

import (
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

func TestDevicePollUnknownCode(t *testing.T) {
	ts, _ := newTestServer(t)
	p := doJSONMap(t, ts.Client(), ts.URL+"/api/cli/device/poll", nil, `{"device_code":"nope"}`)
	if p["status"] != "expired" {
		t.Fatalf("unknown device_code should read as expired, got %+v", p)
	}
}
