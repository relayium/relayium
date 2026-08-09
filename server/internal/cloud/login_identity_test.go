package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

// startRecorder returns a device-code server that approves immediately and
// records the raw start body plus the User-Agent of every request it saw.
func startRecorder(t *testing.T) (*httptest.Server, *string, *[]string) {
	t.Helper()
	var body string
	var agents []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agents = append(agents, r.UserAgent())
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/cli/device/start":
			b, _ := io.ReadAll(r.Body)
			body = string(b)
			writeJSONTest(w, map[string]any{
				"user_code": "AAAA-BBBB", "device_code": "dc",
				"verification_uri": "http://x/device", "interval": 0, "expires_in": 60,
			})
		case "/api/cli/device/poll":
			writeJSONTest(w, map[string]any{
				"status": "ok", "access_token": "rlm_cli_t", "account_email": "a@example.com",
			})
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &body, &agents
}

func TestDeviceStartCarriesTheDeviceName(t *testing.T) {
	srv, body, _ := startRecorder(t)
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	c.DeviceName = "prod-backup-1"
	if _, err := c.Login(context.Background(), func(DeviceStart) {}); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(*body), &got); err != nil {
		t.Fatalf("start body %q is not JSON: %v", *body, err)
	}
	if got["device_name"] != "prod-backup-1" {
		t.Fatalf("start body = %s, want device_name prod-backup-1", *body)
	}
}

func TestDeviceStartOmitsAnEmptyDeviceName(t *testing.T) {
	// A server that predates labels must see exactly what it saw before. An
	// explicit "device_name":"" would still be understood, but omitting the key
	// keeps the request byte-identical to the pre-label one, which is the
	// version of "remains usable" that needs no argument.
	srv, body, _ := startRecorder(t)
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	if _, err := c.Login(context.Background(), func(DeviceStart) {}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(*body, "device_name") {
		t.Fatalf("start body = %s, want no device_name key at all", *body)
	}
}

func TestCloudRequestsCarryABoundedUserAgent(t *testing.T) {
	// The approval page shows this so a user can tell what asked for access.
	// Before it, every CLI login read "Go-http-client/2.0".
	restore := userAgent
	t.Cleanup(func() { userAgent = restore })
	SetClientVersion("v0.6.1")

	srv, _, agents := startRecorder(t)
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	if _, err := c.Login(context.Background(), func(DeviceStart) {}); err != nil {
		t.Fatal(err)
	}
	if len(*agents) < 2 {
		t.Fatalf("expected start + poll requests, saw %d", len(*agents))
	}
	want := "relayium-cli/v0.6.1 (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
	for i, ua := range *agents {
		if ua != want {
			t.Fatalf("request %d User-Agent = %q, want %q", i, ua, want)
		}
	}
}

func TestSetClientVersionBoundsWhatItIsGiven(t *testing.T) {
	// The version is stamped by the linker rather than by a user, but it lands
	// in a stored field that an approval page renders — so it is bounded here
	// rather than trusted to be well formed.
	restore := userAgent
	t.Cleanup(func() { userAgent = restore })

	for _, c := range []struct{ in, want string }{
		{"v1.2.3", "relayium-cli/v1.2.3"},
		{"", "relayium-cli/unknown"},
		{"   ", "relayium-cli/unknown"},
		{"1.0 dirty\nbuild", "relayium-cli/1.0-dirty-build"},
		{strings.Repeat("9", 100), "relayium-cli/" + strings.Repeat("9", 32)},
	} {
		SetClientVersion(c.in)
		if !strings.HasPrefix(userAgent, c.want+" (") {
			t.Fatalf("SetClientVersion(%q) produced %q, want prefix %q", c.in, userAgent, c.want)
		}
		if strings.ContainsAny(userAgent, "\r\n") {
			t.Fatalf("SetClientVersion(%q) produced a multi-line agent %q", c.in, userAgent)
		}
	}
}
