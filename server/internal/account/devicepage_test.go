package account

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// TestDevicePageRequiresSession covers the anonymous path: /device must
// still render 200 (not redirect/401 — this is a browser landing page a
// human is sent to by the CLI), but tell them to sign in first.
func TestDevicePageRequiresSession(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, err := ts.Client().Get(ts.URL + "/device")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "sign in") {
		t.Fatalf("anon /device should prompt sign-in, code=%d body=%s", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("want html content-type, got %q", ct)
	}
}

// TestDevicePageShowsFormWhenAuthed covers the signed-in path: the page
// must show which account the CLI login will be bound to, and prefill the
// user_code from ?code= so the human doesn't have to retype it.
func TestDevicePageShowsFormWhenAuthed(t *testing.T) {
	ts, mail := newTestServer(t)
	cookie := loginCookie(t, ts, mail, "a@example.com")
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/device?code=WDJB-MJHT", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	bs := string(body)
	if !strings.Contains(bs, "a@example.com") || !strings.Contains(bs, "WDJB-MJHT") {
		t.Fatalf("authed /device should show email + prefilled code, got: %s", bs)
	}
	// The approve control must fetch the JSON endpoint (not a native form
	// post, which the JSON decoder would reject) with same-origin creds so
	// CSRFGuard's Origin check passes without a separate CSRF token.
	if !strings.Contains(bs, "/api/cli/device/approve") || !strings.Contains(bs, "credentials") {
		t.Fatalf("authed /device should wire an approve fetch to the JSON endpoint, got: %s", bs)
	}
}

// TestDevicePageEscapesCodeQueryParam is the XSS regression: ?code= is
// attacker-controlled (it's a URL query param a human can be tricked into
// clicking) and gets echoed back into the page as a prefilled value. It
// must never be able to break out of the HTML attribute it's placed in.
func TestDevicePageEscapesCodeQueryParam(t *testing.T) {
	ts, mail := newTestServer(t)
	cookie := loginCookie(t, ts, mail, "xss@example.com")
	payload := `"><script>alert(1)</script>`
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/device?code="+url.QueryEscape(payload), nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	bs := string(body)
	if strings.Contains(bs, "<script>alert(1)</script>") {
		t.Fatalf("XSS: raw <script> tag survived into the page: %s", bs)
	}
	if strings.Contains(bs, `"><script>`) {
		t.Fatalf("XSS: query param broke out of its attribute: %s", bs)
	}
}
