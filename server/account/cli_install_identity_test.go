package account

import (
	"net/http"
	"strings"
	"testing"
)

func cliInstallLogin(t *testing.T, tsURL string, client *http.Client, cookie *http.Cookie, hint string) string {
	t.Helper()
	start := doJSONMap(t, client, tsURL+"/api/cli/device/start", nil, `{"cli_install_id":"`+hint+`"}`)
	user, _ := start["user_code"].(string)
	device, _ := start["device_code"].(string)
	approve := doJSONMap(t, client, tsURL+"/api/cli/device/approve", cookie, `{"user_code":"`+user+`"}`)
	if approve["status"] != "ok" {
		t.Fatalf("approval not accepted")
	}
	poll := doJSONMap(t, client, tsURL+"/api/cli/device/poll", nil, `{"device_code":"`+device+`"}`)
	token, _ := poll["access_token"].(string)
	if token == "" {
		t.Fatal("missing token")
	}
	return token
}

func TestCLIInstallationReusesOnlyItsOwnAccountAndKind(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "cli-install@example.com")
	uid := userIDFor(t, store, "cli-install@example.com")
	first := cliInstallLogin(t, ts.URL, ts.Client(), cookie, sampleInstallID)
	firstID, ok := tokenResolves(t, store, first)
	if !ok {
		t.Fatal("first token not live")
	}
	second := cliInstallLogin(t, ts.URL, ts.Client(), cookie, sampleInstallID)
	secondID, ok := tokenResolves(t, store, second)
	if !ok || secondID != firstID {
		t.Fatalf("approved CLI relogin did not reuse its device")
	}
	if _, ok := tokenResolves(t, store, first); ok {
		t.Fatal("old bearer survived approved rotation")
	}
	rows := devicesOf(t, store, uid)
	if len(rows) != 1 || rows[0].Kind != "cli" {
		t.Fatalf("CLI identity rows/kind: count=%d", len(rows))
	}
	native := signInWithInstallID(t, ts, cookie, sampleInstallID)
	nativeID, ok := tokenResolves(t, store, native)
	if !ok || nativeID == firstID {
		t.Fatal("native and CLI identity namespaces collided")
	}
	if _, ok := tokenResolves(t, store, second); !ok {
		t.Fatal("native approval revoked CLI bearer")
	}
	otherCookie := loginCookie(t, ts, mail, "cli-other@example.com")
	other := cliInstallLogin(t, ts.URL, ts.Client(), otherCookie, sampleInstallID)
	otherID, ok := tokenResolves(t, store, other)
	if !ok || otherID == firstID {
		t.Fatal("installation hint crossed account boundary")
	}
	if _, ok := tokenResolves(t, store, second); !ok {
		t.Fatal("other account revoked CLI bearer")
	}
}

func TestCLIIdentityMalformedHintsDoNotAdoptRows(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "cli-malformed@example.com")
	uid := userIDFor(t, store, "cli-malformed@example.com")
	first := cliInstallLogin(t, ts.URL, ts.Client(), cookie, "not-an-installation")
	second := cliInstallLogin(t, ts.URL, ts.Client(), cookie, "not-an-installation")
	a, okA := tokenResolves(t, store, first)
	b, okB := tokenResolves(t, store, second)
	if !okA || !okB || a == b {
		t.Fatal("malformed hint adopted or revoked a device")
	}
	for _, row := range devicesOf(t, store, uid) {
		if row.Kind != "cli" || row.InstallID != "" {
			t.Fatal("malformed hint persisted or changed kind")
		}
	}
}

func TestCLIAndNativeIdentityHintsAreMutuallyExclusive(t *testing.T) {
	ts, _, _ := newUserNodesServer(t)
	resp, err := ts.Client().Post(ts.URL+"/api/cli/device/start", "application/json", strings.NewReader(`{"install_id":"`+sampleInstallID+`","cli_install_id":"`+sampleInstallID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("ambiguous hints not refused: HTTP%d", resp.StatusCode)
	}
}

func TestDeviceStartAdvertisesCLIIdentitySupport(t *testing.T) {
	ts, _, _ := newUserNodesServer(t)
	start := doJSONMap(t, ts.Client(), ts.URL+"/api/cli/device/start", nil, "")
	if start["cli_install_identity"] != true {
		t.Fatal("server did not advertise stable CLI identity support")
	}
}
