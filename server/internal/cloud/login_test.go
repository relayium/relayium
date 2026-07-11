package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func writeJSONTest(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func TestLoginPollsUntilApproved(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/device/start":
			writeJSONTest(w, map[string]any{"user_code": "WDJB-MJHT", "device_code": "dc", "verification_uri": "http://x/device", "interval": 0, "expires_in": 60})
		case "/api/cli/device/poll":
			polls++
			if polls < 2 {
				writeJSONTest(w, map[string]any{"status": "authorization_pending"})
			} else {
				writeJSONTest(w, map[string]any{"status": "ok", "access_token": "rlm_cli_t", "account_email": "a@example.com"})
			}
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {} // no real waiting in tests
	var shown DeviceStart
	creds, err := c.Login(context.Background(), func(d DeviceStart) { shown = d })
	if err != nil {
		t.Fatal(err)
	}
	if shown.UserCode != "WDJB-MJHT" || creds.AccessToken != "rlm_cli_t" || creds.AccountEmail != "a@example.com" {
		t.Fatalf("bad login result: shown=%+v creds=%+v", shown, creds)
	}
	if creds.Server != srv.URL {
		t.Fatalf("creds.Server = %q, want %q", creds.Server, srv.URL)
	}
}

func TestLoginExpired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/device/start":
			writeJSONTest(w, map[string]any{"user_code": "AAAA-BBBB", "device_code": "dc2", "verification_uri": "http://x/device", "interval": 0, "expires_in": 60})
		case "/api/cli/device/poll":
			writeJSONTest(w, map[string]any{"status": "expired"})
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	_, err := c.Login(context.Background(), func(DeviceStart) {})
	if err == nil {
		t.Fatal("expected error on expired device code")
	}
}

func TestLoginDenied(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/device/start":
			writeJSONTest(w, map[string]any{"user_code": "CCCC-DDDD", "device_code": "dc3", "verification_uri": "http://x/device", "interval": 0, "expires_in": 60})
		case "/api/cli/device/poll":
			writeJSONTest(w, map[string]any{"status": "denied"})
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	c.sleep = func(time.Duration) {}
	_, err := c.Login(context.Background(), func(DeviceStart) {})
	if err == nil {
		t.Fatal("expected error on denied device code")
	}
}

func TestLoginSlowDown(t *testing.T) {
	polls := 0
	var sleeps []time.Duration
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/device/start":
			writeJSONTest(w, map[string]any{"user_code": "EEEE-FFFF", "device_code": "dc4", "verification_uri": "http://x/device", "interval": 1, "expires_in": 60})
		case "/api/cli/device/poll":
			polls++
			switch {
			case polls == 1:
				writeJSONTest(w, map[string]any{"status": "slow_down"})
			case polls < 3:
				writeJSONTest(w, map[string]any{"status": "authorization_pending"})
			default:
				writeJSONTest(w, map[string]any{"status": "ok", "access_token": "rlm_cli_t2", "account_email": "b@example.com"})
			}
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	c.sleep = func(d time.Duration) { sleeps = append(sleeps, d) }
	creds, err := c.Login(context.Background(), func(DeviceStart) {})
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "rlm_cli_t2" {
		t.Fatalf("unexpected creds: %+v", creds)
	}
	// first sleep at base interval (1s), subsequent sleeps bumped by 5s after slow_down.
	if len(sleeps) < 2 || sleeps[0] != 1*time.Second || sleeps[1] != 6*time.Second {
		t.Fatalf("unexpected sleep schedule: %v", sleeps)
	}
}

func TestLoginTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/cli/device/start":
			writeJSONTest(w, map[string]any{"user_code": "GGGG-HHHH", "device_code": "dc5", "verification_uri": "http://x/device", "interval": 1, "expires_in": 2})
		case "/api/cli/device/poll":
			writeJSONTest(w, map[string]any{"status": "authorization_pending"})
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	elapsed := time.Duration(0)
	c.sleep = func(d time.Duration) { elapsed += d }
	_, err := c.Login(context.Background(), func(DeviceStart) {})
	if err == nil {
		t.Fatal("expected timeout error")
	}
}
