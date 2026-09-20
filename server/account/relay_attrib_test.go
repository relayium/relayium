package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/relayusage"
	"github.com/relayium/relayium/internal/signal"
)

// Relay attribution, end to end through the two real production paths: the ICE
// endpoint that issues a credential and the authenticated node heartbeat that
// reports bytes against it.
//
// Nothing here stubs either of those. The only thing a test ever substitutes is
// the pairing-code registry's answer, which is the INPUT being varied — "who do
// these six digits belong to right now" is precisely the value that changes
// underneath a live credential in production.

// attribFixture is one service with a real store, a real fleet node and a real
// pairing-code registry, at a fixed clock.
type attribFixture struct {
	s     *Service
	mux   *http.ServeMux
	reg   *signal.PairRegistry
	now   int64
	nodeA Node
}

func newAttribFixture(t *testing.T) *attribFixture {
	t.Helper()
	f := &attribFixture{now: 5000}
	f.s = nodeService(t, "fixture-node-token")
	f.s.now = func() time.Time { return time.Unix(f.now, 0) }
	f.s.cfg.TURNCredTTL = time.Hour
	f.s.cfg.TURNSecret = "fixture-turn-secret"
	f.s.cfg.TURNURLs = []string{"turn:127.0.0.1:3478"}

	f.reg = signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return f.now })

	ctx := context.Background()
	node, err := f.s.store.UpsertNode(ctx, Node{
		ID: "attrib-relay", OwnerType: "fleet", URLs: []string{"turn:127.0.0.1:3478"},
		TURNSecret: "fixture-turn-secret", CreatedAt: 1, LastSeenAt: f.now,
	})
	if err != nil {
		t.Fatalf("upsert node: %v", err)
	}
	f.nodeA = node

	f.mux = http.NewServeMux()
	f.s.RegisterNodeRoutes(f.mux)
	return f
}

// user creates a verified account (the ICE endpoint refuses relay to an
// unverified one).
func (f *attribFixture) user(t *testing.T, email string) User {
	t.Helper()
	ctx := context.Background()
	u, err := f.s.store.UpsertUserByEmail(ctx, email, email)
	if err != nil {
		t.Fatalf("upsert user %s: %v", email, err)
	}
	if err := f.s.store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatalf("verify %s: %v", email, err)
	}
	return u
}

// issue runs the REAL /api/ice handler and returns the credential username it
// handed out. Empty means the endpoint issued no relay at all.
func (f *attribFixture) issue(t *testing.T, code string) string {
	t.Helper()
	w := httptest.NewRecorder()
	f.s.handleICE(w, httptest.NewRequest("GET", "/api/ice?code="+code, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("/api/ice status %d", w.Code)
	}
	var answer struct {
		Servers []ICEServer `json:"iceServers"`
		Relays  []struct {
			ICEServers []ICEServer `json:"iceServers"`
		} `json:"relays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatalf("decode /api/ice: %v", err)
	}
	username := ""
	for _, e := range answer.Servers {
		if e.Username != "" {
			username = e.Username
		}
	}
	for _, r := range answer.Relays {
		for _, e := range r.ICEServers {
			if e.Username != "" {
				username = e.Username
			}
		}
	}
	return username
}

// heartbeat posts one authenticated node heartbeat reporting a cumulative total
// for an allocation, through the real route and auth.
func (f *attribFixture) heartbeat(t *testing.T, allocID, username string, total int64) {
	t.Helper()
	body, err := json.Marshal(nodeHeartbeatReq{
		NodeID: f.nodeA.ID, Status: "ok", RelayedTotal: total,
		Usage: []nodeUsage{{AllocID: allocID, Username: username, RelayedBytes: total}},
	})
	if err != nil {
		t.Fatalf("marshal heartbeat: %v", err)
	}
	req := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer fixture-node-token")
	out := httptest.NewRecorder()
	f.mux.ServeHTTP(out, req)
	if out.Code != http.StatusOK {
		t.Fatalf("heartbeat status %d: %s", out.Code, out.Body.String())
	}
}

func (f *attribFixture) billed(t *testing.T, u User) int64 {
	t.Helper()
	n, err := f.s.store.UserRelayedSince(context.Background(), u.ID, 0)
	if err != nil {
		t.Fatalf("UserRelayedSince: %v", err)
	}
	return n
}

// mint takes a real code from the real registry for owner.
func (f *attribFixture) mint(t *testing.T, owner User) string {
	t.Helper()
	code, _ := f.reg.MintFor(owner.ID)
	if code == "" {
		t.Fatal("registry refused to mint")
	}
	return code
}

// ---------------------------------------------------------------------------

// The lost-billing regression, with the production wiring in place.
//
// Root's baseline reproduced this against the pre-change server: a credential
// issued to owner A stopped being billed the moment those digits resolved to
// somebody else, and the bytes went to nobody at all. With a per-generation
// attribution tag there is no lookup left that can change its answer.
func TestIssuedGrantKeepsOriginalOwnerAfterCodeReuse(t *testing.T) {
	f := newAttribFixture(t)
	original := f.user(t, "original@example.com")
	stranger := f.user(t, "stranger@example.com")
	f.s.SetPairCodes(f.reg)

	code := f.mint(t, original)
	username := f.issue(t, code)
	if username == "" {
		t.Fatal("/api/ice issued no relay credential")
	}
	f.heartbeat(t, "attrib-alloc", username, 100)
	if got := f.billed(t, original); got != 100 {
		t.Fatalf("positive control: billed %d, want 100", got)
	}

	// The digits are handed to somebody else while the original credential is
	// still valid — the one-hour credential against the five-minute code. The
	// registry is real; only the answer to "whose digits are these" moves, and
	// it is the recyclable lookup that used to be consulted here. A spy so the
	// test can prove it is not consulted at all.
	codeLookups := 0
	f.s.SetPairCodeOwner(func(string) (string, bool) {
		codeLookups++
		return stranger.ID, true
	})

	f.heartbeat(t, "attrib-alloc", username, 300)

	if got := f.billed(t, original); got != 300 {
		t.Fatalf("original owner lost metering after code reuse: billed %d, want 300", got)
	}
	if got := f.billed(t, stranger); got != 0 {
		t.Fatalf("reused digits charged the new owner %d bytes", got)
	}
	if codeLookups != 0 {
		t.Fatalf("attribution consulted the recyclable code lookup %d times", codeLookups)
	}
}

// The same scenario for the same account re-minting the digits: no double
// counting, no cross-generation aggregation, each generation its own tag.
func TestReusedDigitsBySameOwnerStayDistinctGenerations(t *testing.T) {
	f := newAttribFixture(t)
	owner := f.user(t, "same-owner@example.com")
	f.s.SetPairCodes(f.reg)

	firstCode := f.mint(t, owner)
	firstUser := f.issue(t, firstCode)
	secondCode := f.mint(t, owner)
	secondUser := f.issue(t, secondCode)
	if firstUser == "" || secondUser == "" {
		t.Fatal("issuance produced no credential")
	}
	firstTag := tokenOf(t, firstUser)
	secondTag := tokenOf(t, secondUser)
	if firstTag == secondTag {
		t.Fatalf("two generations of one owner share attribution tag %q", firstTag)
	}

	f.heartbeat(t, "alloc-1", firstUser, 100)
	f.heartbeat(t, "alloc-2", secondUser, 250)
	if got := f.billed(t, owner); got != 350 {
		t.Fatalf("billed %d, want 350 across both generations", got)
	}
}

// A node claiming a DIFFERENT account than the one central bound to the tag is
// forging attribution. That check gets stricter here, not weaker: it now has an
// answer that cannot go stale.
func TestKnownTagMismatchIsRefused(t *testing.T) {
	f := newAttribFixture(t)
	original := f.user(t, "victim@example.com")
	attacker := f.user(t, "attacker@example.com")
	f.s.SetPairCodes(f.reg)

	code := f.mint(t, original)
	username := f.issue(t, code)
	tag := tokenOf(t, username)

	// Same credential expiry and same tag, but billed to somebody else.
	expiry, _, _ := strings.Cut(username, ":")
	forged := expiry + ":" + attacker.ID + "." + tag
	f.heartbeat(t, "forged-alloc", forged, 999)

	if got := f.billed(t, attacker); got != 0 {
		t.Fatalf("forged attribution billed the attacker %d bytes", got)
	}
	if got := f.billed(t, original); got != 0 {
		t.Fatalf("forged attribution reached the victim: %d bytes", got)
	}
}

// A user-owned node may still only ever bill its own owner. Unchanged by this
// change, and checked before attribution is consulted at all.
func TestBYONodeCrossUserAttributionStillRefused(t *testing.T) {
	f := newAttribFixture(t)
	nodeOwner := f.user(t, "byo-owner@example.com")
	victim := f.user(t, "byo-victim@example.com")
	f.s.SetPairCodes(f.reg)

	ctx := context.Background()
	byo, err := f.s.store.UpsertNode(ctx, Node{
		ID: "byo-relay", OwnerType: "user", OwnerUserID: nodeOwner.ID,
		URLs: []string{"turn:127.0.0.2:3478"}, TURNSecret: "byo-secret",
		CreatedAt: 1, LastSeenAt: f.now,
	})
	if err != nil {
		t.Fatalf("upsert byo node: %v", err)
	}
	// A BYO node heartbeats with its OWNER's node token, not the fleet one.
	f.s.cfg.EnableUserNodes = true
	const byoToken = "byo-node-token"
	if err := f.s.store.CreateNodeToken(ctx, NodeToken{
		ID: "byo-tok", TokenHash: authx.HashToken(byoToken), UserID: nodeOwner.ID,
		NodeID: byo.ID, Name: "byo", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("create node token: %v", err)
	}

	code := f.mint(t, victim)
	username := f.issue(t, code)
	if username == "" {
		t.Fatal("issuance produced no credential")
	}

	body, _ := json.Marshal(nodeHeartbeatReq{
		NodeID: byo.ID, Status: "ok", RelayedTotal: 500,
		Usage: []nodeUsage{{AllocID: "byo-alloc", Username: username, RelayedBytes: 500}},
	})
	req := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+byoToken)
	out := httptest.NewRecorder()
	f.mux.ServeHTTP(out, req)
	if out.Code != http.StatusOK {
		t.Fatalf("heartbeat status %d: %s", out.Code, out.Body.String())
	}
	if got := f.billed(t, victim); got != 0 {
		t.Fatalf("BYO node billed a stranger %d bytes", got)
	}
	if got := f.billed(t, nodeOwner); got != 0 {
		t.Fatalf("BYO node billed its own owner %d bytes for a stranger's credential", got)
	}
}

// A tag this process cannot speak to — retired past its grace, or issued before
// a restart — must still bill the account its username names. Refusing instead
// would throw away real bytes on every deploy, which is the same loss from the
// other end.
func TestUnknownTagAfterRestartStillBillsTheUsernameOwner(t *testing.T) {
	f := newAttribFixture(t)
	owner := f.user(t, "restart@example.com")
	f.s.SetPairCodes(f.reg)

	code := f.mint(t, owner)
	username := f.issue(t, code)
	tag := tokenOf(t, username)

	// A fresh registry is exactly what a restart leaves behind: the same
	// process wiring, none of the previous process's tags.
	restarted := signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return f.now })
	f.s.SetPairCodes(restarted)
	if _, known := restarted.OwnerForTag(tag); known {
		t.Fatal("a restarted registry should not know the previous tag")
	}

	f.heartbeat(t, "restart-alloc", username, 700)
	if got := f.billed(t, owner); got != 700 {
		t.Fatalf("restart dropped billing: %d, want 700", got)
	}
}

// Production wires the registry with ONE call. If that call stopped carrying
// attribution with it, issuance would silently go back to the recyclable
// digits — the whole bug. Referenced by the comment on main.go's SetPairCodes.
func TestProductionWiringIssuesTaggedAttribution(t *testing.T) {
	f := newAttribFixture(t)
	owner := f.user(t, "wiring@example.com")

	f.s.SetPairCodes(f.reg) // the only wiring call main.go makes

	code := f.mint(t, owner)
	username := f.issue(t, code)
	if username == "" {
		t.Fatal("issuance produced no credential")
	}
	userID, token := relayusage.SplitAttrib(relayusage.TokenFromUsername(username))
	if userID != owner.ID {
		t.Fatalf("username owner %q, want %q", userID, owner.ID)
	}
	if token == code {
		t.Fatal("production wiring issued the recyclable pairing code as attribution")
	}
	if got, known := f.reg.OwnerForTag(token); !known || got != owner.ID {
		t.Fatalf("issued token is not a live registry tag: (%q,%v)", got, known)
	}
	// Issuance registers retention against the tag, on its own clock: the code
	// is dead for issuance and the tag is still resolvable for billing. (The
	// sweep itself is exercised in the signal package, where reap is reachable.)
	f.now += signal.CodeTTLSeconds + 1
	if _, _, ok := f.reg.AttribFor(code); ok {
		t.Fatal("expired code still issues credentials")
	}
	if _, known := f.reg.OwnerForTag(token); !known {
		t.Fatal("tag retired with its code")
	}
	// ...and it is still the identity a heartbeat arriving now is billed under.
	f.heartbeat(t, "late-alloc", username, 512)
	if got := f.billed(t, owner); got != 512 {
		t.Fatalf("post-code-expiry report billed %d, want 512", got)
	}
}

// Repeated /api/ice calls for one code — which is what the two peers do, before
// either has paired — must produce one stable billing identity.
func TestRepeatedIssuanceBeforePairedKeepsOneTag(t *testing.T) {
	f := newAttribFixture(t)
	owner := f.user(t, "repeat@example.com")
	f.s.SetPairCodes(f.reg)

	code := f.mint(t, owner)
	first := f.issue(t, code)
	tag := tokenOf(t, first)
	for i := 0; i < 4; i++ {
		f.now += 10
		again := f.issue(t, code)
		if got := tokenOf(t, again); got != tag {
			t.Fatalf("issue %d produced tag %q, want the stable %q", i, got, tag)
		}
	}
	// Two peers reporting under two allocations of one generation aggregate to
	// one payer.
	f.heartbeat(t, "peer-a", first, 40)
	f.heartbeat(t, "peer-b", first, 60)
	if got := f.billed(t, owner); got != 100 {
		t.Fatalf("billed %d, want 100", got)
	}
}

// Old parsers must not need to change, and the credential's expiry must be
// exactly what it always was.
func TestTaggedCredentialParsesAsBeforeAndKeepsItsExpiry(t *testing.T) {
	f := newAttribFixture(t)
	owner := f.user(t, "parse@example.com")
	f.s.SetPairCodes(f.reg)

	code := f.mint(t, owner)
	username := f.issue(t, code)

	// "<expiry>:<owner>.<token>", unchanged shape.
	head, rest, found := strings.Cut(username, ":")
	if !found {
		t.Fatalf("username %q has no expiry separator", username)
	}
	exp, err := strconv.ParseInt(head, 10, 64)
	if err != nil {
		t.Fatalf("expiry %q does not parse: %v", head, err)
	}
	if want := f.now + int64(f.s.cfg.TURNCredTTL.Seconds()); exp != want {
		t.Fatalf("expiry %d, want %d (TURNCredTTL unchanged)", exp, want)
	}
	if got := relayusage.TokenFromUsername(username); got != rest {
		t.Fatalf("TokenFromUsername gave %q, want %q", got, rest)
	}
	userID, token := relayusage.SplitAttrib(rest)
	if userID != owner.ID || token == "" {
		t.Fatalf("SplitAttrib gave (%q,%q)", userID, token)
	}
	// The relay node's own expiry check (cmd/relayium-node credentialExpired)
	// reads only the digits before the first colon, so it must still see a
	// future instant and nothing else.
	if strings.ContainsAny(head, ".") {
		t.Fatalf("expiry field %q is no longer a bare integer", head)
	}
}

// A deployment (or an isolated test) that wires only the owner lookup keeps
// exactly the behaviour it has today, including the recycling bug. That is what
// makes credentials already in flight at deploy time safe.
func TestLegacyOwnerOnlyWiringIsUnchanged(t *testing.T) {
	f := newAttribFixture(t)
	original := f.user(t, "legacy@example.com")
	stranger := f.user(t, "legacy-stranger@example.com")

	owner := original.ID
	f.s.SetPairCodeOwner(func(code string) (string, bool) { return owner, code == "123456" })

	username := f.issue(t, "123456")
	if username == "" {
		t.Fatal("legacy wiring issued no credential")
	}
	if got := tokenOf(t, username); got != "123456" {
		t.Fatalf("legacy wiring token %q, want the pairing code", got)
	}
	f.heartbeat(t, "legacy-alloc", username, 100)
	if got := f.billed(t, original); got != 100 {
		t.Fatalf("legacy positive control billed %d, want 100", got)
	}

	// And the legacy drop is still the legacy drop — preserved deliberately,
	// not accidentally repaired.
	owner = stranger.ID
	f.heartbeat(t, "legacy-alloc", username, 300)
	if got := f.billed(t, original); got != 100 {
		t.Fatalf("legacy branch changed behaviour: billed %d, want it stuck at 100", got)
	}
}

// attributionRefused is the whole decision, so exercise it directly for the
// combinations the HTTP tests above cannot reach cheaply.
func TestAttributionRefusedBranchOrder(t *testing.T) {
	f := newAttribFixture(t)
	owner := f.user(t, "branches@example.com")
	f.s.SetPairCodes(f.reg)
	code := f.mint(t, owner)
	_, tag, ok := f.reg.AttribFor(code)
	if !ok {
		t.Fatal("AttribFor failed")
	}

	codeLookups := 0
	f.s.SetPairCodeOwner(func(string) (string, bool) {
		codeLookups++
		return "somebody-else", true
	})

	if why := f.s.attributionRefused(tag, owner.ID); why != "" {
		t.Fatalf("known matching tag refused: %s", why)
	}
	if codeLookups != 0 {
		t.Fatal("a known tag still consulted the code lookup")
	}
	if why := f.s.attributionRefused(tag, "somebody-else"); why == "" {
		t.Fatal("known tag with the wrong owner was accepted")
	}
	// An unknown token falls through to the legacy branch, which is where the
	// code lookup belongs and the only place it may run.
	if why := f.s.attributionRefused("123456", owner.ID); why == "" {
		t.Fatal("legacy branch stopped refusing a contradicted code")
	}
	if codeLookups != 1 {
		t.Fatalf("code lookups = %d, want exactly the one legacy call", codeLookups)
	}
	// With no resolver at all, nothing is refused — unchanged.
	f.s.relayAttrib = nil
	f.s.pairCodeOwner = nil
	if why := f.s.attributionRefused(tag, owner.ID); why != "" {
		t.Fatalf("unwired service refused attribution: %s", why)
	}
}

// tokenOf returns the attribution token from a credential username.
func tokenOf(t *testing.T, username string) string {
	t.Helper()
	_, token := relayusage.SplitAttrib(relayusage.TokenFromUsername(username))
	if token == "" {
		t.Fatalf("username %q carries no attribution token", username)
	}
	return token
}
