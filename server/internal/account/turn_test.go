package account

import (
	"context"
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
		TransferTTL: time.Hour,
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

func TestICENoTokenReturnsStunOnly(t *testing.T) {
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

func TestICEValidTokenIncludesTurn(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	u, _ := store.UpsertUserByEmail(context.Background(), "o@example.com", "O")
	tr, _ := svc.CreateTransfer(context.Background(), u.ID)

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?room=" + tr.Token)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)
	if !hasTURN(servers) {
		t.Fatalf("expected a TURN entry, got %+v", servers)
	}
	for _, s := range servers {
		if len(s.URLs) > 0 && (s.URLs[0] == "turn:turn.example.com:3478") {
			if s.Username == "" || s.Credential == "" {
				t.Fatalf("TURN entry missing username/credential: %+v", s)
			}
			if !strings.HasSuffix(s.Username, ":"+tr.Token) {
				t.Fatalf("username should embed token, got %q", s.Username)
			}
		}
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

func TestICEInvalidTokenReturnsStunOnly(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret")
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?room=bogus")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("invalid token must not yield TURN, got %+v", servers)
	}
}

func TestICENoSecretReturnsStunOnly(t *testing.T) {
	ts, svc, store := newICEServer(t, "") // TURN disabled
	u, _ := store.UpsertUserByEmail(context.Background(), "o@example.com", "O")
	tr, _ := svc.CreateTransfer(context.Background(), u.ID)
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?room=" + tr.Token)
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("no secret must mean no TURN, got %+v", servers)
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
