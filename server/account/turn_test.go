package account

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
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

func ownerResolver(owner, wantCode string) func(string) (string, bool) {
	return func(c string) (string, bool) {
		if c == wantCode {
			return owner, true
		}
		return "", false
	}
}

// verifiedOwner creates an email-verified user and returns its ID, for ICE tests
// that record relay usage against a real (foreign-key-valid) owner.
func verifiedOwner(t *testing.T, store *SQLiteStore, email string) string {
	t.Helper()
	u, err := store.UpsertUserByEmail(context.Background(), email, "O")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func TestICEValidPairCodeIncludesTurn(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetPairCodeOwner(ownerResolver("owner-1", "424242"))

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
			if !strings.HasSuffix(s.Username, ":owner-1.424242") {
				t.Fatalf("username should embed the owner and code, got %q", s.Username)
			}
		}
	}
}

func TestICEInvalidPairCodeReturnsStunOnly(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetPairCodeOwner(func(c string) (string, bool) { return "", false }) // no live codes
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=000000")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("invalid code must not yield TURN, got %+v", servers)
	}
}

func TestICEPairCodeNoValidatorReturnsStunOnly(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret") // SetPairCodeOwner never called
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("no validator wired must mean no TURN for codes, got %+v", servers)
	}
}

func TestICENoSecretReturnsStunOnly(t *testing.T) {
	ts, svc, _ := newICEServer(t, "") // TURN disabled
	svc.SetPairCodeOwner(ownerResolver("owner-1", "424242"))
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("no secret must mean no TURN, got %+v", servers)
	}
}

func TestICEEmbedsOwnerInTurnUsername(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetPairCodeOwner(ownerResolver("owner-1", "424242"))

	resp, err := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get: err=%v status=%v", err, resp.StatusCode)
	}
	servers := iceServersFromBody(t, resp)
	found := false
	for _, s := range servers {
		if len(s.URLs) > 0 && s.URLs[0] == "turn:turn.example.com:3478" {
			found = true
			if !strings.Contains(s.Username, ":owner-1.424242") {
				t.Fatalf("turn username = %q, want to contain :owner-1.424242", s.Username)
			}
		}
	}
	if !found {
		t.Fatal("expected a TURN entry in the response")
	}
}

// TestICEWithholdsTURNWhenOwnerOverPlanTraffic: once the pairing code's owner
// is already over their plan's combined monthly traffic (upload+download+relay),
// /api/ice must withhold TURN (STUN-only) and flag resp["relayDenied"] =
// "quota", even though the code itself is otherwise valid. P2P (STUN) still
// works.
func TestICEWithholdsTURNWhenOwnerOverPlanTraffic(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	ctx := context.Background()
	owner := verifiedOwner(t, store, "owner1@example.com")
	svc.SetPairCodeOwner(ownerResolver(owner, "424242"))

	now := svc.now().Unix()
	// owner's plan_id defaults to "free"; shrink that plan's traffic cap to 1
	// byte so already-recorded usage puts the owner over it.
	if err := store.UpsertPlan(ctx, Plan{
		ID: "free", Name: "Free", StorageBytes: 1 << 30, TrafficBytes: 1,
		RetentionSecs: 86400, Active: true, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}
	if err := store.RecordUsage(ctx, UsageEvent{
		AllocID: "x", Token: "424242", UserID: owner, RelayedBytes: 500, RecordedAt: now, Billable: true,
	}); err != nil {
		t.Fatalf("RecordUsage: %v", err)
	}

	resp, err := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get: err=%v status=%v", err, resp.StatusCode)
	}
	var out struct {
		ICEServers  []ICEServer `json:"iceServers"`
		RelayDenied string      `json:"relayDenied"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if hasTURN(out.ICEServers) {
		t.Fatalf("expected STUN-only when over plan traffic, got %+v", out.ICEServers)
	}
	if len(out.ICEServers) == 0 {
		t.Fatalf("STUN must still be offered when relay is withheld")
	}
	if out.RelayDenied != "quota" {
		t.Fatalf("relayDenied = %q, want %q", out.RelayDenied, "quota")
	}
}

// TestICEUnderPlanCapIncludesTurn: below the plan's monthly traffic cap, TURN
// is issued as usual and relayDenied is absent.
func TestICEUnderPlanCapIncludesTurn(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	ctx := context.Background()
	owner := verifiedOwner(t, store, "owner1@example.com")
	svc.SetPairCodeOwner(ownerResolver(owner, "424242"))

	now := svc.now().Unix()
	// owner's plan_id defaults to "free"; a 1000-byte cap comfortably covers
	// the 500 bytes recorded below.
	if err := store.UpsertPlan(ctx, Plan{
		ID: "free", Name: "Free", StorageBytes: 1 << 30, TrafficBytes: 1000,
		RetentionSecs: 86400, Active: true, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}
	if err := store.RecordUsage(ctx, UsageEvent{
		AllocID: "y", Token: "424242", UserID: owner, RelayedBytes: 500, RecordedAt: now, Billable: true,
	}); err != nil {
		t.Fatalf("RecordUsage: %v", err)
	}

	resp, err := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("get: err=%v status=%v", err, resp.StatusCode)
	}
	var out struct {
		ICEServers  []ICEServer `json:"iceServers"`
		RelayDenied string      `json:"relayDenied"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !hasTURN(out.ICEServers) {
		t.Fatalf("expected TURN when under cap, got %+v", out.ICEServers)
	}
	if out.RelayDenied != "" {
		t.Fatalf("relayDenied should be absent under cap, got %q", out.RelayDenied)
	}
}

func TestICEUnverifiedOwnerDeniedRelay(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	u, err := store.UpsertUserByEmail(context.Background(), "unv@example.com", "U")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	// u is unverified by default (email_verified = 0).
	svc.SetPairCodeOwner(ownerResolver(u.ID, "424242"))

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if hasTURN(servers) {
		t.Fatalf("unverified owner must be STUN-only, got %+v", servers)
	}
}

func TestICEVerifiedOwnerGetsRelay(t *testing.T) {
	ts, svc, store := newICEServer(t, "secret")
	u, err := store.UpsertUserByEmail(context.Background(), "v@example.com", "V")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := store.SetEmailVerified(context.Background(), u.ID); err != nil {
		t.Fatalf("verify user: %v", err)
	}
	svc.SetPairCodeOwner(ownerResolver(u.ID, "424242"))

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if !hasTURN(servers) {
		t.Fatalf("verified owner should get TURN, got %+v", servers)
	}
}

// relayErrStore wraps a real store but forces UserRelayedSince to error, to
// exercise the fail-open metering path. All other methods delegate.
type relayErrStore struct{ *SQLiteStore }

func (relayErrStore) UserRelayedSince(context.Context, string, int64) (int64, error) {
	return 0, fmt.Errorf("redis down")
}

func TestICEMeteringReadErrorFailsOpenWithAlert(t *testing.T) {
	base := newTestStore(t)
	u, err := base.UpsertUserByEmail(context.Background(), "v@example.com", "V")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := base.SetEmailVerified(context.Background(), u.ID); err != nil {
		t.Fatalf("verify user: %v", err)
	}

	var logbuf bytes.Buffer
	log.SetOutput(&logbuf)
	defer log.SetOutput(os.Stderr)

	svc := NewService(relayErrStore{base}, &capturingMailer{}, Config{
		TURNCredTTL: time.Hour,
		STUNURLs:    []string{"stun:stun.example.com:3478"},
		TURNURLs:    []string{"turn:turn.example.com:3478"},
		TURNSecret:  "secret",
	})
	svc.SetPairCodeOwner(ownerResolver(u.ID, "424242"))
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()

	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	servers := iceServersFromBody(t, resp)
	if !hasTURN(servers) {
		t.Fatalf("metering read error must fail-open to relay, got %+v", servers)
	}
	if !strings.Contains(logbuf.String(), "quota read failed") {
		t.Fatalf("expected a metering-blind alert log, got %q", logbuf.String())
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
	svc.SetPairCodeOwner(ownerResolver("owner-1", "424242"))
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
		if !strings.HasSuffix(r.ICEServers[0].Username, ":owner-1.424242") {
			t.Fatalf("relay %q username should embed the owner and code, got %q", r.ID, r.ICEServers[0].Username)
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
	// URLs are passed through verbatim. Whether a relay also answers on TCP is a
	// property of that relay, not of the credential, so the call site decides —
	// see withTCPTransport, which the two static config sources apply and the
	// UDP-only node sources deliberately do not.
	if fmt.Sprint(got.URLs) != fmt.Sprint(urls) {
		t.Fatalf("urls = %v, want %v unchanged", got.URLs, urls)
	}
}
