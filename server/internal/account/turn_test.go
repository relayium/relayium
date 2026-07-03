package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newICEServer(t *testing.T, secret string) (*httptest.Server, *Service, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		TURNCredTTL: time.Hour,
		STUNURLs:    []string{"stun:stun.example.com:3478"},
		TURNURLs:    []string{"turn:turn.example.com:3478"},
		TURNSecret:  secret,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, svc, store
}

func iceServersFromBody(t *testing.T, resp *http.Response) []ICEServer {
	t.Helper()
	var out struct {
		ICEServers []ICEServer `json:"iceServers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out.ICEServers
}

func hasTURN(servers []ICEServer) bool {
	for _, s := range servers {
		for _, u := range s.URLs {
			if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
				return true
			}
		}
	}
	return false
}

func TestICENoRendezvousReturnsStunOnly(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret")
	resp, err := ts.Client().Get(ts.URL + "/api/ice")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get: err=%v status=%v", err, resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)
	if len(servers) == 0 || hasTURN(servers) {
		t.Fatalf("expected STUN-only, got %+v", servers)
	}
}

func TestICERoomParamIsIgnored(t *testing.T) {
	// The legacy share-link "?room=" parameter is retired; supplying it must
	// no longer yield TURN credentials.
	ts, _, _ := newICEServer(t, "secret")
	resp, err := ts.Client().Get(ts.URL + "/api/ice?room=deadbeef")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get: err=%v status=%v", err, resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("room param must not yield TURN credentials, got %+v", servers)
	}
}

func TestICEValidPairCodeIncludesTurn(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetPairCodeValidator(func(c string) bool { return c == "424242" })

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)
	if !hasTURN(servers) {
		t.Fatalf("valid pairing code should yield a TURN entry, got %+v", servers)
	}
	for _, s := range servers {
		if len(s.URLs) > 0 && s.URLs[0] == "turn:turn.example.com:3478" {
			if !strings.HasSuffix(s.Username, ":424242") {
				t.Fatalf("username should embed the code, got %q", s.Username)
			}
		}
	}
}

func TestICEInvalidPairCodeReturnsStunOnly(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetPairCodeValidator(func(c string) bool { return false }) // no live codes
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=000000")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("invalid code must not yield TURN, got %+v", servers)
	}
}

func TestICEPairCodeNoValidatorReturnsStunOnly(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret") // SetPairCodeValidator never called
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("no validator wired must mean no TURN for codes, got %+v", servers)
	}
}

func TestICENoSecretReturnsStunOnly(t *testing.T) {
	ts, svc, _ := newICEServer(t, "") // TURN disabled
	svc.SetPairCodeValidator(func(c string) bool { return c == "424242" })
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("no secret must mean no TURN, got %+v", servers)
	}
}

func relaysFromBody(t *testing.T, resp *http.Response) []relayEntry {
	t.Helper()
	var out struct {
		Relays []relayEntry `json:"relays"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out.Relays
}

func newPoolICEServer(t *testing.T, relays []RelayConfig) (*httptest.Server, *Service) {
	t.Helper()
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{
		TURNCredTTL: time.Hour,
		STUNURLs:    []string{"stun:stun.example.com:3478"},
		TURNRelays:  relays,
	})
	svc.SetPairCodeValidator(func(c string) bool { return c == "424242" })
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, svc
}

func TestICEPoolReturnsPerRelayCredentials(t *testing.T) {
	ts, _ := newPoolICEServer(t, []RelayConfig{
		{ID: "asia-tok", Region: "asia", URLs: []string{"turn:tok.example.com:3478"}, Secret: "s1"},
		{ID: "us-la", Region: "us-west", URLs: []string{"turn:la.example.com:3478"}, Secret: "s2"},
	})
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	relays := relaysFromBody(t, resp)
	if len(relays) != 2 {
		t.Fatalf("want 2 relays, got %d: %+v", len(relays), relays)
	}
	// Each relay carries its own HMAC credential (computed with ITS secret) and the
	// username embeds the code so coturn/metering can attribute it.
	for _, r := range relays {
		if len(r.ICEServers) != 1 || len(r.ICEServers[0].URLs) == 0 {
			t.Fatalf("relay %q missing iceServers: %+v", r.ID, r)
		}
		if !strings.HasSuffix(r.ICEServers[0].Username, ":424242") {
			t.Fatalf("relay %q username should embed the code, got %q", r.ID, r.ICEServers[0].Username)
		}
	}
	if relays[0].ICEServers[0].Credential == relays[1].ICEServers[0].Credential {
		t.Fatal("distinct per-relay secrets must yield distinct credentials")
	}
}

func TestICEPoolOmittedWithoutValidCode(t *testing.T) {
	ts, _ := newPoolICEServer(t, []RelayConfig{
		{ID: "asia-tok", URLs: []string{"turn:tok.example.com:3478"}, Secret: "s1"},
	})
	// No code and an invalid code both yield no pool (and no TURN at all).
	for _, url := range []string{ts.URL + "/api/ice", ts.URL + "/api/ice?code=000000"} {
		resp, _ := ts.Client().Get(url)
		if r := relaysFromBody(t, resp); len(r) != 0 {
			t.Fatalf("%s: expected no relays, got %+v", url, r)
		}
	}
}

func TestICEPoolSkipsMisconfiguredRelays(t *testing.T) {
	ts, _ := newPoolICEServer(t, []RelayConfig{
		{ID: "ok", URLs: []string{"turn:ok.example.com:3478"}, Secret: "s"},
		{ID: "", URLs: []string{"turn:x:3478"}, Secret: "s"}, // missing id
		{ID: "no-secret", URLs: []string{"turn:y:3478"}},     // missing secret
		{ID: "no-urls", Secret: "s"},                         // missing urls
	})
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	relays := relaysFromBody(t, resp)
	if len(relays) != 1 || relays[0].ID != "ok" {
		t.Fatalf("only the well-formed relay should survive, got %+v", relays)
	}
}

func TestTurnCredentials(t *testing.T) {
	secret := "s3cr3t"
	token := "abc123"
	expiry := int64(1_000_000)
	urls := []string{"turn:turn.example.com:3478", "turns:turn.example.com:5349"}

	got := turnCredentials(secret, token, expiry, urls)

	wantUser := "1000000:abc123"
	if got.Username != wantUser {
		t.Fatalf("username = %q, want %q", got.Username, wantUser)
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(wantUser))
	wantCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got.Credential != wantCred {
		t.Fatalf("credential = %q, want %q", got.Credential, wantCred)
	}
	if fmt.Sprint(got.URLs) != fmt.Sprint(urls) {
		t.Fatalf("urls = %v, want %v", got.URLs, urls)
	}
}
