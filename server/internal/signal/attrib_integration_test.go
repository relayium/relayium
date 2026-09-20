package signal_test

// The relay-attribution regression, staged end to end against the REAL pieces:
// a real `*signal.PairRegistry` minting the same six digits twice, the real
// `/api/ice` handler issuing credentials, and the real authenticated node
// heartbeat reporting bytes against them.
//
// It lives in an external test package for one structural reason. The judge
// needs the registry AND the account layer, and `account` imports `signal`, so
// an in-package test could not reach it without a cycle. `package signal_test`
// is compiled separately and is allowed to import a package that depends on the
// package under test, which is exactly this shape.
//
// The account package's own `relay_attrib_test.go` covers the same rule with a
// spy in place of the reissue. This one exists because the property being
// defended is what a real reissue does, and a spy is the assumption rather than
// the evidence: it is the difference between "the code branch is not consulted"
// and "the digits really did change owner and the bytes still landed right".

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/signal"
)

const (
	integNodeToken = "integration-fleet-token"
	integTURNURL   = "turn:127.0.0.1:3478"
	integSecret    = "integration-turn-secret"
	integNodeID    = "integration-relay"
)

// integFixture is a whole server slice: real store, real service, real routes,
// real registry. The registry's clock is the only injected one — it is what
// lets the test expire a code and mint those digits again.
type integFixture struct {
	t     *testing.T
	svc   *account.Service
	store *account.SQLiteStore
	reg   *signal.PairRegistry
	root  *http.ServeMux
	now   int64 // registry clock
}

func newIntegFixture(t *testing.T) *integFixture {
	t.Helper()
	store, err := account.OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	svc := account.NewService(store, &account.LogMailer{Log: log.New(io.Discard, "", 0)}, account.Config{
		BaseURL:     "http://127.0.0.1",
		TURNURLs:    []string{integTURNURL},
		TURNSecret:  integSecret,
		TURNCredTTL: time.Hour,
		NodeToken:   integNodeToken,
	})

	f := &integFixture{t: t, svc: svc, store: store, now: time.Now().Unix()}
	f.reg = signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return f.now })
	// The one production wiring call. Attribution has to arrive with it.
	svc.SetPairCodes(f.reg)

	f.root = http.NewServeMux()
	svc.RegisterNodeRoutes(f.root)
	f.root.Handle("/", svc.Routes())

	// A fleet node, live now, so the heartbeat route accepts its reports.
	if _, err := store.UpsertNode(context.Background(), account.Node{
		ID: integNodeID, OwnerType: "fleet", URLs: []string{integTURNURL},
		TURNSecret: integSecret, CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("upsert node: %v", err)
	}
	return f
}

func (f *integFixture) user(email string) account.User {
	f.t.Helper()
	ctx := context.Background()
	u, err := f.store.UpsertUserByEmail(ctx, email, email)
	if err != nil {
		f.t.Fatalf("upsert %s: %v", email, err)
	}
	if err := f.store.SetEmailVerified(ctx, u.ID); err != nil {
		f.t.Fatalf("verify %s: %v", email, err)
	}
	return u
}

// issue drives the real GET /api/ice and returns the TURN credential username.
func (f *integFixture) issue(code string) string {
	f.t.Helper()
	w := httptest.NewRecorder()
	f.root.ServeHTTP(w, httptest.NewRequest("GET", "/api/ice?code="+code, nil))
	if w.Code != http.StatusOK {
		f.t.Fatalf("/api/ice status %d: %s", w.Code, w.Body.String())
	}
	var answer struct {
		ICEServers []struct {
			Username string `json:"username"`
		} `json:"iceServers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		f.t.Fatalf("decode /api/ice: %v", err)
	}
	for _, e := range answer.ICEServers {
		if e.Username != "" {
			return e.Username
		}
	}
	return ""
}

// heartbeat posts a real authenticated node heartbeat. The body is written as
// literal JSON rather than through the (unexported) request struct, so this
// also pins the wire contract the node binary actually sends.
func (f *integFixture) heartbeat(allocID, username string, total int64) {
	f.t.Helper()
	body := fmt.Sprintf(
		`{"nodeID":%q,"status":"ok","relayedTotal":%d,"usage":[{"allocID":%q,"username":%q,"relayedBytes":%d}]}`,
		integNodeID, total, allocID, username, total)
	req := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+integNodeToken)
	w := httptest.NewRecorder()
	f.root.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		f.t.Fatalf("heartbeat status %d: %s", w.Code, w.Body.String())
	}
}

func (f *integFixture) billed(u account.User) int64 {
	f.t.Helper()
	n, err := f.store.UserRelayedSince(context.Background(), u.ID, 0)
	if err != nil {
		f.t.Fatalf("UserRelayedSince: %v", err)
	}
	return n
}

// TestRealCodeReuseKeepsBillingWithTheOriginalOwner is the persistent form of
// the baseline judge. Against the pre-tag server it fails with 100 where 300
// was relayed.
func TestRealCodeReuseKeepsBillingWithTheOriginalOwner(t *testing.T) {
	f := newIntegFixture(t)
	original := f.user("integration-original@example.com")
	stranger := f.user("integration-stranger@example.com")

	// Force the registry to hand out one fixed code, so the reissue below is a
	// genuine reuse of the same six digits rather than a stand-in for one.
	f.reg.SetCodeDrawForTest(func() string { return "424242" })

	code, codeExp := f.reg.MintFor(original.ID)
	if code != "424242" {
		t.Fatalf("mint gave %q", code)
	}
	username := f.issue(code)
	if username == "" {
		t.Fatal("/api/ice issued no relay credential")
	}
	originalToken := tokenOfUsername(t, username)

	f.heartbeat("integration-alloc", username, 100)
	if got := f.billed(original); got != 100 {
		t.Fatalf("positive control: billed %d, want 100", got)
	}

	// The code expires and the very same digits are minted for a different
	// account, while the original credential is still valid. This is the state
	// that used to make the next report look forged.
	f.now = codeExp + 1
	if reissued, _ := f.reg.MintFor(stranger.ID); reissued != code {
		t.Fatalf("reissue gave %q, want the same digits", reissued)
	}
	if owner, ok := f.reg.OwnerOf(code); !ok || owner != stranger.ID {
		t.Fatalf("precondition lost: code owner is (%q,%v)", owner, ok)
	}
	strangerUsername := f.issue(code)
	if strangerUsername == "" {
		t.Fatal("reused digits are a legitimate new code and must still issue")
	}

	// The original credential reports again. Every byte still belongs to the
	// account that minted the generation it was issued for.
	//
	// These two assertions are FIRST on purpose: they are the financial oracle,
	// and a regression here must report as the lost bytes it is rather than as
	// whatever structural detail happens to be checked earliest.
	f.heartbeat("integration-alloc", username, 300)

	if got := f.billed(original); got != 300 {
		t.Fatalf("original owner lost metering after code reuse: billed %d, want 300", got)
	}
	if got := f.billed(stranger); got != 0 {
		t.Fatalf("reused digits charged the new owner %d bytes", got)
	}

	// ...and the mechanism behind them: two generations, two identities.
	if tokenOfUsername(t, strangerUsername) == originalToken {
		t.Fatal("the reissued generation reused the first one's attribution token")
	}
}

// The reissued generation bills its own owner, so the fix is not "freeze the
// first answer" — it is "every generation has its own answer".
func TestRealCodeReuseBillsTheNewGenerationToItsOwnOwner(t *testing.T) {
	f := newIntegFixture(t)
	original := f.user("integration-first@example.com")
	second := f.user("integration-second@example.com")
	f.reg.SetCodeDrawForTest(func() string { return "313131" })

	code, codeExp := f.reg.MintFor(original.ID)
	firstUsername := f.issue(code)
	f.heartbeat("alloc-first", firstUsername, 50)

	f.now = codeExp + 1
	if reissued, _ := f.reg.MintFor(second.ID); reissued != code {
		t.Fatalf("reissue gave %q", reissued)
	}
	secondUsername := f.issue(code)
	f.heartbeat("alloc-second", secondUsername, 70)

	if got := f.billed(original); got != 50 {
		t.Fatalf("first generation billed %d, want 50", got)
	}
	if got := f.billed(second); got != 70 {
		t.Fatalf("second generation billed %d, want 70", got)
	}
}

// tokenOfUsername returns the attribution half of "<expiry>:<owner>.<token>".
func tokenOfUsername(t *testing.T, username string) string {
	t.Helper()
	_, rest, ok := strings.Cut(username, ":")
	if !ok {
		t.Fatalf("username %q has no expiry separator", username)
	}
	_, token, ok := strings.Cut(rest, ".")
	if !ok || token == "" {
		t.Fatalf("username %q carries no attribution token", username)
	}
	return token
}
