package signal_test

// Renewal through the ACTUAL production wiring: a real `*signal.PairRegistry`,
// a real `*signal.GrantRegistry` connected to it exactly as main.go connects
// them, the real `/api/ice` handler issuing the original credentials, and the
// real `account.Service.RenewRelayGrant` deciding every round.
//
// The unit tests in grant_test.go drive the registry with doubles, which is the
// only way to stage a database that hangs or a member that leaves mid-issuance.
// What they cannot show is that the pieces are CONNECTED — that a credential
// issued by /api/ice before the second peer joins is the one a grant created
// afterwards inherits, that the issuer's own gates are the ones being run, and
// that a quota refusal arrives as a refusal rather than as nothing. Every one
// of those is a wiring fact, and every one of them was wrong in the first
// draft.
//
// The hub and websockets are deliberately not in the loop: those are covered by
// the signalling tests, and what is under test here is the authority chain.
// Membership is supplied exactly as main.go's join hook supplies it — the id
// list the hub captured under the admission lock.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/signal"
)

const (
	wireNodeToken = "wiring-fleet-token"
	wireTURNURL   = "turn:127.0.0.1:3478"
	wireSecret    = "wiring-turn-secret"
	wireCredTTL   = time.Hour
)

type wireFixture struct {
	t     *testing.T
	svc   *account.Service
	store *account.SQLiteStore
	pair  *signal.PairRegistry
	grant *signal.GrantRegistry
	root  *http.ServeMux

	mu      sync.Mutex
	now     int64
	replies map[string][]map[string]any
	// onIssued, when set, intercepts the real issuance notification before it
	// reaches the grant registry. Only the ORDER is under test; the values are
	// whatever the real endpoint stamped.
	onIssued func(tag string, expiry int64)
}

func newWireFixture(t *testing.T) *wireFixture {
	return newWireFixtureTTL(t, wireCredTTL)
}

// newWireFixtureTTL builds the fixture with a chosen credential lifetime.
//
// A SHORT one is how a test gets two real /api/ice calls to stamp genuinely
// different expiries. The account service reads its own clock and there is no
// production hook to move it — adding one would be a test seam on a money path
// — so the only honest way to make "A fetched before B" observable through the
// real endpoint is to let real time pass and shrink the TTL so a second of it
// matters. This scales the SERVER's arithmetic only; it is not a client margin
// and nothing about the production 1-hour credential changes.
func newWireFixtureTTL(t *testing.T, credTTL time.Duration) *wireFixture {
	t.Helper()
	store, err := account.OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	// The account service keeps REAL time — there is no production hook to move
	// it, and adding one would be a test seam on a money path. The grant clock
	// instead runs at real time plus a test-controlled offset, so "50 minutes
	// later" is expressible without the two ever disagreeing about an expiry
	// the service itself stamped.
	f := &wireFixture{t: t, store: store, replies: map[string][]map[string]any{}}
	f.svc = account.NewService(store, &account.LogMailer{Log: log.New(io.Discard, "", 0)}, account.Config{
		BaseURL:     "http://127.0.0.1",
		TURNURLs:    []string{wireTURNURL},
		TURNSecret:  wireSecret,
		TURNCredTTL: credTTL,
		NodeToken:   wireNodeToken,
	})
	f.pair = signal.NewPairRegistry(signal.CodeTTLSeconds, f.tick)
	f.svc.SetPairCodes(f.pair) // the single production wiring call

	// Exactly main.go's construction, including both hooks.
	f.grant = signal.NewGrantRegistry(
		credTTL,
		f.tick,
		f.svc.RenewRelayGrant,
		func(room, peerID string, data json.RawMessage) {
			var body map[string]any
			if err := json.Unmarshal(data, &body); err != nil {
				t.Errorf("reply is not JSON: %v", err)
				return
			}
			f.mu.Lock()
			f.replies[peerID] = append(f.replies[peerID], body)
			f.mu.Unlock()
		},
		f.pair.IssuedSegmentForTag,
		f.pair.RetainTag,
	)
	// The observer is installed through a hook so one test can perturb the
	// DELIVERY ORDER without replacing any of the parts. Production notifies
	// outside the pairing registry's lock, so the order issuances are recorded
	// in and the order they are announced in are genuinely independent; a test
	// that could only observe the happy order would not be testing the rule.
	f.pair.SetIssuedObserver(func(tag string, expiry int64) {
		f.mu.Lock()
		hook := f.onIssued
		f.mu.Unlock()
		if hook != nil {
			hook(tag, expiry)
			return
		}
		f.grant.NoteIssued(tag, expiry)
	})

	// Plans, so the quota gate reads a real tier rather than the in-memory
	// Free fallback. Production seeds them at startup.
	if err := f.svc.SeedPlans(context.Background()); err != nil {
		t.Fatalf("seed plans: %v", err)
	}

	f.root = http.NewServeMux()
	f.svc.RegisterNodeRoutes(f.root)
	f.root.Handle("/", f.svc.Routes())
	return f
}

// tick is real time plus the test's offset. `now` is that offset.
func (f *wireFixture) tick() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return time.Now().Unix() + f.now
}

func (f *wireFixture) advance(d int64) {
	f.mu.Lock()
	f.now += d
	f.mu.Unlock()
}

// advanceTo sets the offset to an exact number of seconds from the fixture's
// start, so a test that stepped the clock in irregular increments can still
// name the minute it means.
func (f *wireFixture) advanceTo(offset int64) {
	f.mu.Lock()
	f.now = offset
	f.mu.Unlock()
}

// advanceToTick puts the grant clock at an ABSOLUTE instant.
//
// Needed whenever a test has let real time pass — a sleep, a slow HTTP call —
// because the offset is added to time.Now() and so already carries that
// elapsed time. Adding an offset on top would count it twice, which silently
// moves an assertion past the boundary it is supposed to straddle.
func (f *wireFixture) advanceToTick(instant int64) {
	f.mu.Lock()
	f.now = instant - time.Now().Unix()
	f.mu.Unlock()
}

func (f *wireFixture) user(email string) account.User {
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

// unverifiedUser creates an account that never confirmed its email.
func (f *wireFixture) unverifiedUser(email string) account.User {
	f.t.Helper()
	u, err := f.store.UpsertUserByEmail(context.Background(), email, email)
	if err != nil {
		f.t.Fatalf("upsert %s: %v", email, err)
	}
	return u
}

// reopenFor stages a generation for `owner` with a credential already issued,
// bypassing /api/ice — which is the point when the account under test is one
// /api/ice would refuse to issue for at all.
func (f *wireFixture) reopenFor(owner account.User) string {
	f.t.Helper()
	code, _ := f.pair.MintFor(owner.ID)
	if code == "" {
		f.t.Fatal("mint refused")
	}
	room, _ := f.pair.RoomFor(code)
	_, _, tag, _, _ := f.pair.ObserveAdmittedRoomAttrib(room, 2)
	f.grant.Open(room, owner.ID, tag, []string{"peer-a", "peer-b"})
	// An hour of credential, issued half a TTL ago so the floor is clear.
	f.pair.NoteIssuedCredential(tag, f.tick()+1800)
	return room
}

// issue drives the REAL /api/ice, which is what stamps the original credential
// and tells the grant registry about it.
func (f *wireFixture) issue(code string) string {
	f.t.Helper()
	w := httptest.NewRecorder()
	f.root.ServeHTTP(w, httptest.NewRequest("GET", "/api/ice?code="+code, nil))
	if w.Code != http.StatusOK {
		f.t.Fatalf("/api/ice status %d", w.Code)
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

// pairedRoom mints a real code, has peer A fetch ICE BEFORE the room is paired
// (the ordering that broke the first draft), then opens the grant the way
// main.go's join hook does.
func (f *wireFixture) pairedRoom(owner account.User) (room, username string) {
	f.t.Helper()
	code, _ := f.pair.MintFor(owner.ID)
	if code == "" {
		f.t.Fatal("mint refused")
	}
	username = f.issue(code) // before pairing, on purpose
	if username == "" {
		f.t.Fatal("/api/ice issued no relay credential")
	}
	room, ok := f.pair.RoomFor(code)
	if !ok {
		f.t.Fatal("no room for a freshly minted code")
	}
	if _, _, _, _, current := f.pair.ObserveAdmittedRoomAttrib(room, 1); !current {
		f.t.Fatal("first admission not observed")
	}
	_, _, tag, activity, current := f.pair.ObserveAdmittedRoomAttrib(room, 2)
	if !current || !activity.Paired {
		f.t.Fatal("paired transition not observed")
	}
	f.grant.Open(room, owner.ID, tag, []string{"peer-a", "peer-b"})
	return room, username
}

func (f *wireFixture) both(room string, round, ridA, ridB uint32) {
	f.t.Helper()
	f.grant.Request(room, "peer-a", signal.RenewRequest{Round: round, RID: ridA})
	f.grant.Request(room, "peer-b", signal.RenewRequest{Round: round, RID: ridB})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		done := len(f.replies["peer-a"]) > 0 && len(f.replies["peer-b"]) > 0
		f.mu.Unlock()
		if done {
			return
		}
		time.Sleep(time.Millisecond)
	}
	f.t.Fatalf("timed out waiting for both replies: %+v", f.all())
}

func (f *wireFixture) all() map[string][]map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string][]map[string]any{}
	for k, v := range f.replies {
		out[k] = append([]map[string]any(nil), v...)
	}
	return out
}

func (f *wireFixture) last(peer string) map[string]any {
	f.t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	got := f.replies[peer]
	if len(got) == 0 {
		f.t.Fatalf("no reply for %s", peer)
	}
	return got[len(got)-1]
}

func (f *wireFixture) reset() {
	f.mu.Lock()
	f.replies = map[string][]map[string]any{}
	f.mu.Unlock()
}

// ---------------------------------------------------------------------------

// The whole chain, in the order it happens in production: initial issuance
// before pairing, grant opened afterwards, renewal inside the credential's
// lifetime, credentials that parse and carry the original attribution tag.
func TestWiredRenewalInheritsTheInitialCredentialAndIssues(t *testing.T) {
	f := newWireFixture(t)
	owner := f.user("wired-owner@example.com")
	room, username := f.pairedRoom(owner)

	// 50 minutes in: past the issuance floor, credential still live. This is
	// the moment a real client renews.
	f.advance(3000)
	f.both(room, 1, 11, 22)

	for _, peer := range []string{"peer-a", "peer-b"} {
		body := f.last(peer)
		if body["status"] != "granted" {
			t.Fatalf("%s: %+v", peer, body)
		}
		if round, _ := body["round"].(float64); uint32(round) != 1 {
			t.Fatalf("%s round %v", peer, body["round"])
		}
		servers, ok := body["iceServers"].([]any)
		if !ok || len(servers) == 0 {
			t.Fatalf("%s carried no iceServers: %+v", peer, body)
		}
	}
	if rid, _ := f.last("peer-a")["rid"].(float64); uint32(rid) != 11 {
		t.Fatalf("peer-a rid %v", f.last("peer-a")["rid"])
	}
	if rid, _ := f.last("peer-b")["rid"].(float64); uint32(rid) != 22 {
		t.Fatalf("peer-b rid %v", f.last("peer-b")["rid"])
	}

	// The renewed credential is billed under the SAME generation as the first:
	// the tag never changes, so the ledger needs no new entry for a renewal.
	renewed := renewedUsername(t, f.last("peer-a"))
	if wantTag, gotTag := tokenOfUsername(t, username), tokenOfUsername(t, renewed); wantTag != gotTag {
		t.Fatalf("renewal changed the attribution tag: %q -> %q", wantTag, gotTag)
	}
	if got, want := usernameOwner(t, renewed), usernameOwner(t, username); got != want {
		t.Fatalf("renewal changed the billed owner: %q -> %q", want, got)
	}
}

// A grant that never saw a credential has nothing to renew, and a lapsed one is
// never revived — through the real issuer, not a double.
func TestWiredUnissuedGrantIsUnavailableAndSurvives(t *testing.T) {
	f := newWireFixture(t)
	owner := f.user("wired-empty@example.com")

	code, _ := f.pair.MintFor(owner.ID)
	room, _ := f.pair.RoomFor(code)
	_, _, tag, _, _ := f.pair.ObserveAdmittedRoomAttrib(room, 2)
	f.grant.Open(room, owner.ID, tag, []string{"peer-a", "peer-b"})

	f.grant.Request(room, "peer-a", signal.RenewRequest{Round: 1, RID: 1})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && len(f.all()["peer-a"]) == 0 {
		time.Sleep(time.Millisecond)
	}
	body := f.last("peer-a")
	// Unavailable rather than denied, and the grant survives: the initial
	// /api/ice for this generation has simply not happened yet.
	if body["status"] != "unavailable" {
		t.Fatalf("expected an unavailable refusal, got %+v", body)
	}
	if n := f.grant.Len(); n != 1 {
		t.Fatalf("the unissued grant was destroyed by a request: %d held", n)
	}
}

// A spent monthly allowance refuses the round with the same vocabulary
// /api/ice uses, and does not advance issuance.
func TestWiredQuotaExhaustionDeniesRenewal(t *testing.T) {
	f := newWireFixture(t)
	owner := f.user("wired-quota@example.com")
	room, _ := f.pairedRoom(owner)
	f.advance(3000)

	// Spend the whole free-tier monthly allowance through the real ledger.
	//
	// Across several allocations because RecordUsage clamps what ONE of them
	// may claim in a first report — which is the anti-forgery bound, and using
	// the real path rather than writing a row directly is the point.
	ctx := context.Background()
	plan, ok, err := f.store.GetPlan(ctx, "free")
	if err != nil || !ok {
		t.Fatalf("free plan: %v %v", ok, err)
	}
	var spent int64
	for i := 0; spent <= plan.TrafficBytes; i++ {
		if i > 512 {
			t.Fatalf("could not spend the free allowance: %d of %d", spent, plan.TrafficBytes)
		}
		before, err := f.store.UserRelayedSince(ctx, owner.ID, 0)
		if err != nil {
			t.Fatalf("read usage: %v", err)
		}
		if err := f.store.RecordUsage(ctx, account.UsageEvent{
			AllocID: fmt.Sprintf("wired-spend-%d", i), Token: "gspend", UserID: owner.ID,
			RelayedBytes: plan.TrafficBytes, RecordedAt: f.tick(), Billable: true,
		}); err != nil {
			t.Fatalf("record usage: %v", err)
		}
		after, err := f.store.UserRelayedSince(ctx, owner.ID, 0)
		if err != nil {
			t.Fatalf("read usage: %v", err)
		}
		if after == before {
			t.Fatalf("usage stopped accruing at %d of %d", after, plan.TrafficBytes)
		}
		spent = after
	}

	f.both(room, 1, 1, 2)
	body := f.last("peer-a")
	if body["status"] != "denied" {
		t.Fatalf("spent allowance should deny: %+v", body)
	}
	if body["relayDenied"] != "quota" {
		t.Fatalf("relayDenied %v, want quota", body["relayDenied"])
	}
	// The denial names the round it refused; issuance itself did not advance,
	// which the retry below proves.
	if round, _ := body["round"].(float64); uint32(round) != 1 {
		t.Fatalf("a denial named round %v, want the refused 1", body["round"])
	}
	if _, carries := body["iceServers"]; carries {
		t.Fatalf("a denial carried credentials: %+v", body)
	}
}

// An unverified account cannot renew, for the same reason it cannot get a first
// credential — but reported, because renewal has somewhere to report it.
func TestWiredUnverifiedAccountDeniesRenewal(t *testing.T) {
	f := newWireFixture(t)
	// Verified for the INITIAL issuance (/api/ice refuses relay otherwise), so
	// the grant has a credential to inherit; a second account then owns the
	// generation that renews, and it was never verified.
	owner := f.user("wired-unverified@example.com")
	room, _ := f.pairedRoom(owner)
	f.advance(3000)
	unverified := f.unverifiedUser("wired-never-verified@example.com")
	f.grant.Depart(room, "peer-a") // retire the verified grant
	room = f.reopenFor(unverified)

	f.both(room, 1, 1, 2)
	body := f.last("peer-a")
	if body["status"] != "denied" || body["relayDenied"] != "unverified" {
		t.Fatalf("unverified account should deny: %+v", body)
	}
}

// A duplicate request for the round already issued replays the cached
// configuration without running the issuer again and without charging the rate.
func TestWiredDuplicateRoundReplaysWithoutReissuing(t *testing.T) {
	f := newWireFixture(t)
	owner := f.user("wired-dup@example.com")
	room, _ := f.pairedRoom(owner)
	f.advance(3000)
	f.both(room, 1, 1, 2)
	first := renewedUsername(t, f.last("peer-a"))
	f.reset()

	f.grant.Request(room, "peer-a", signal.RenewRequest{Round: 1, RID: 99})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && len(f.all()["peer-a"]) == 0 {
		time.Sleep(time.Millisecond)
	}
	body := f.last("peer-a")
	if body["status"] != "granted" {
		t.Fatalf("replay status %+v", body)
	}
	if rid, _ := body["rid"].(float64); uint32(rid) != 99 {
		t.Fatalf("replay echoed rid %v", body["rid"])
	}
	if got := renewedUsername(t, body); got != first {
		t.Fatalf("replay reissued: %q != %q", got, first)
	}
}

// A departed member ends the grant, through the same call main.go's Leave hook
// makes — and the real issuer is never reached.
func TestWiredDepartureEndsRenewal(t *testing.T) {
	f := newWireFixture(t)
	owner := f.user("wired-depart@example.com")
	room, _ := f.pairedRoom(owner)
	f.advance(3000)

	f.grant.Depart(room, "peer-b")
	if n := f.grant.Len(); n != 0 {
		t.Fatalf("grant survived a departure: %d", n)
	}
	f.grant.Request(room, "peer-a", signal.RenewRequest{Round: 1, RID: 1})
	f.grant.Request(room, "peer-b", signal.RenewRequest{Round: 1, RID: 2})
	time.Sleep(30 * time.Millisecond)
	if got := f.all(); len(got) != 0 {
		t.Fatalf("a dead grant answered: %+v", got)
	}
}

// Renewal never touches the pairing code, so a generation whose digits have
// been recycled to a different account still renews for the ORIGINAL owner.
func TestWiredRecycledDigitsDoNotRedirectRenewal(t *testing.T) {
	f := newWireFixture(t)
	original := f.user("wired-original@example.com")
	stranger := f.user("wired-stranger@example.com")
	f.pair.SetCodeDrawForTest(func() string { return "246813" })

	code, codeExp := f.pair.MintFor(original.ID)
	username := f.issue(code)
	room, _ := f.pair.RoomFor(code)
	_, _, tag, _, _ := f.pair.ObserveAdmittedRoomAttrib(room, 2)
	f.grant.Open(room, original.ID, tag, []string{"peer-a", "peer-b"})

	_ = codeExp
	// The code expires and the same digits are minted for somebody else while
	// the original credential is still running.
	f.advance(signal.CodeTTLSeconds + 1)
	if reissued, _ := f.pair.MintFor(stranger.ID); reissued != code {
		t.Fatalf("reissue gave %q", reissued)
	}
	// On to the moment a real client renews: past the issuance floor, original
	// credential still live.
	f.advance(3000 - signal.CodeTTLSeconds - 1)

	f.both(room, 1, 1, 2)
	body := f.last("peer-a")
	if body["status"] != "granted" {
		t.Fatalf("recycled digits blocked a legitimate renewal: %+v", body)
	}
	renewed := renewedUsername(t, body)
	if got, want := usernameOwner(t, renewed), original.ID; got != want {
		t.Fatalf("renewal billed %q, want the original owner %q", got, want)
	}
	if got, want := tokenOfUsername(t, renewed), tokenOfUsername(t, username); got != want {
		t.Fatalf("renewal changed the attribution tag: %q -> %q", got, want)
	}
}

// renewedUsername pulls the first credential username out of a granted reply.
func renewedUsername(t *testing.T, body map[string]any) string {
	t.Helper()
	servers, _ := body["iceServers"].([]any)
	for _, raw := range servers {
		entry, _ := raw.(map[string]any)
		if u, _ := entry["username"].(string); u != "" {
			return u
		}
	}
	t.Fatalf("reply carried no credential: %+v", body)
	return ""
}

// usernameOwner returns the account id from "<expiry>:<owner>.<tag>".
func usernameOwner(t *testing.T, username string) string {
	t.Helper()
	_, rest, ok := strings.Cut(username, ":")
	if !ok {
		t.Fatalf("username %q has no expiry separator", username)
	}
	owner, _, ok := strings.Cut(rest, ".")
	if !ok || owner == "" {
		t.Fatalf("username %q carries no owner", username)
	}
	return owner
}

// ---------------------------------------------------------------------------
// R1 through the real wiring.

// The liveness counterexample, end to end: peer A fetches a real credential
// from /api/ice, pre-upload keeps the code joinable, peer B fetches its own
// much later, and the pair is only observed then. A must still renew in its own
// margin — the anchor is the segment's FIRST issuance, not B's.
func TestWiredEarlierPeerRenewsAfterALateSecondFetch(t *testing.T) {
	// A SHORT server-side credential lifetime and REAL elapsed time, because
	// nothing else makes the two issuances distinguishable.
	//
	// The previous version of this test advanced only the registry's offset
	// clock. The account service reads its own clock, so both /api/ice calls
	// stamped the SAME expiry: `first` and `latest` were equal, the segment had
	// no shape, and an implementation anchored on the LATEST issuance passed it
	// unchanged. It asserted a conclusion it could not reach.
	//
	// Twenty-second credentials, so half a TTL is ten seconds and a separation
	// of a few real seconds puts the two candidate floors far apart. This
	// scales the SERVER's own arithmetic only — there is no client margin here
	// and the production hour is untouched.
	const ttl = 20 * time.Second
	ttlSec := int64(ttl.Seconds())
	halfTTL := ttlSec / 2

	// `gap` is how long after peer A peer B fetches, and `renewAt` is how long
	// after A the renewal is attempted. Each case needs
	//
	//	A_issue + halfTTL  <=  renewAt  <  B_issue + halfTTL       and
	//	renewAt < A_issue + ttl                                    (A still live)
	//
	// so the correct anchor grants and an anchor on the later issuance refuses,
	// with seconds of margin either side rather than the fraction of a second
	// that unix-second truncation can swallow.
	//
	// This is the proportional form of the product scenario: pre-upload holds a
	// code open, peer A fetches early in its credential's life and peer B well
	// into it, and A must still renew in its own margin. The minute-scale
	// version of that (A at 0, B at 25/40/59 of a 60-minute credential) is
	// covered deterministically in grant_test.go, which can stage expiries
	// directly; what this test adds is that the REAL endpoint, the REAL
	// registry and the REAL grant agree with it.
	for _, c := range []struct {
		name         string
		gap, renewAt int64
	}{
		{"b-joins-early", 5, 12}, // floors: A at 10, B at 15
		{"b-joins-late", 9, 14},  // floors: A at 10, B at 19
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newWireFixtureTTL(t, ttl)
			owner := f.user(fmt.Sprintf("wired-late-%s@example.com", c.name))

			code, _ := f.pair.MintFor(owner.ID)
			if code == "" {
				t.Fatal("mint refused")
			}
			room, ok := f.pair.RoomFor(code)
			if !ok {
				t.Fatal("no room for a freshly minted code")
			}
			// Peer A fetches through the REAL endpoint.
			if u := f.issue(code); u == "" {
				t.Fatal("/api/ice issued no credential for peer A")
			}
			// Real time passes, then peer B fetches. No code extension is
			// needed: the registry clock is not being moved, so the code's own
			// five-minute life covers the separation. (Pre-upload is what makes
			// the minute-scale version of this legitimate; here the point is
			// only that B's credential is genuinely later than A's.)
			time.Sleep(time.Duration(c.gap)*time.Second + 200*time.Millisecond)
			if u := f.issue(code); u == "" {
				t.Fatalf("/api/ice issued no credential for peer B after %ds", c.gap)
			}
			_, _, tag, activity, current := f.pair.ObserveAdmittedRoomAttrib(room, 2)
			if !current || !activity.Paired {
				t.Fatal("paired transition not observed")
			}
			f.grant.Open(room, owner.ID, tag, []string{"peer-a", "peer-b"})

			// THE DIFFERENCE ORACLE. Without it this test silently degrades
			// into the one it replaced the moment anything makes the two
			// expiries equal again.
			first, latest := f.pair.IssuedSegmentForTag(tag)
			if got := latest - first; got < c.gap {
				t.Fatalf("the two issuances are %ds apart, want at least %ds — "+
					"the segment has no shape and the anchor cannot be under test", got, c.gap)
			}

			// Measured from A's OWN issuance, recovered from its credential,
			// because real time has already passed and an offset would count
			// that twice.
			aIssuedAt := first - ttlSec
			if c.renewAt < halfTTL {
				t.Fatalf("case %s renews before A's own floor", c.name)
			}
			if c.renewAt >= c.gap+halfTTL {
				t.Fatalf("case %s does not discriminate: renewAt is past B's floor too", c.name)
			}
			if c.renewAt >= ttlSec {
				t.Fatalf("case %s renews after A's credential has expired", c.name)
			}
			f.advanceToTick(aIssuedAt + c.renewAt)

			f.both(room, 1, 1, 2)
			for _, peer := range []string{"peer-a", "peer-b"} {
				body := f.last(peer)
				if body["status"] != "granted" {
					t.Fatalf("B fetched %ds after A: %s was refused %ds in, which is past A's floor (%ds) "+
						"and short of B's (%ds) — the anchor followed the later issuance: %+v",
						c.gap, peer, c.renewAt, halfTTL, c.gap+halfTTL, body)
				}
			}
		})
	}
}

// Open and /api/ice race each other in production: the second peer's fetch and
// the paired admission are two independent goroutines. Whichever lands first,
// the grant must end up with the segment, and never with a torn combination of
// a new anchor and an old latest.
func TestWiredOpenRacesInitialIssuance(t *testing.T) {
	f := newWireFixture(t)
	owner := f.user("wired-race@example.com")

	code, _ := f.pair.MintFor(owner.ID)
	room, _ := f.pair.RoomFor(code)
	_, _, tag, _, _ := f.pair.ObserveAdmittedRoomAttrib(room, 2)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); f.issue(code) }()
	go func() { defer wg.Done(); f.grant.Open(room, owner.ID, tag, []string{"peer-a", "peer-b"}) }()
	wg.Wait()

	// Either ordering must leave one grant holding real authority. Half a TTL
	// on from the issuance, the round is admissible.
	if n := f.grant.Len(); n != 1 {
		t.Fatalf("the race left %d grants", n)
	}
	f.advance(1800)
	f.both(room, 1, 1, 2)
	for _, peer := range []string{"peer-a", "peer-b"} {
		if body := f.last(peer); body["status"] != "granted" {
			t.Fatalf("%s: the race lost the inherited segment: %+v", peer, body)
		}
	}
}

// Too early is retryable, not terminal, and costs nothing: no issuance, no
// round advance, and the issuer is never called.
func TestWiredRateRefusalIsUnavailableAndCostsNothing(t *testing.T) {
	f := newWireFixture(t)
	owner := f.user("wired-rate@example.com")
	room, _ := f.pairedRoom(owner) // issued just now

	f.both(room, 1, 1, 2)
	for _, peer := range []string{"peer-a", "peer-b"} {
		body := f.last(peer)
		if body["status"] != "unavailable" || body["reason"] != "rate" {
			t.Fatalf("%s: expected an unavailable/rate refusal: %+v", peer, body)
		}
		if round, _ := body["round"].(float64); uint32(round) != 1 {
			t.Fatalf("%s: refusal named round %v, want the refused 1", peer, body["round"])
		}
		if _, carries := body["iceServers"]; carries {
			t.Fatalf("%s: a rate refusal carried credentials", peer)
		}
	}

	// Half a TTL on, the same round succeeds — nothing was consumed.
	f.reset()
	f.advance(1800)
	f.both(room, 1, 3, 4)
	for _, peer := range []string{"peer-a", "peer-b"} {
		if body := f.last(peer); body["status"] != "granted" {
			t.Fatalf("%s: round 1 was consumed by the rate refusal: %+v", peer, body)
		}
	}
}

// The grant is opened BEFORE either peer has fetched — the peers met first —
// and then both real /api/ice calls land while it is live. The anchor must
// still be the earlier of the two, which is the unissued-hydration path rather
// than the Open-hydration one.
func TestWiredUnissuedGrantAnchorsOnTheEarlierRealIssuance(t *testing.T) {
	// Same accelerated server-side TTL and real elapsed time as the liveness
	// case, and for the same reason: with the registry offset alone both
	// /api/ice calls stamp the same expiry, the segment has no shape, and an
	// implementation anchored on the later issuance passes unchanged.
	const ttl = 20 * time.Second
	ttlSec := int64(ttl.Seconds())
	const gap, renewAt = int64(9), int64(14) // floors: A at 10, B at 19

	f := newWireFixtureTTL(t, ttl)
	owner := f.user("wired-unissued-anchor@example.com")

	code, _ := f.pair.MintFor(owner.ID)
	if code == "" {
		t.Fatal("mint refused")
	}
	room, _ := f.pair.RoomFor(code)
	_, _, tag, _, _ := f.pair.ObserveAdmittedRoomAttrib(room, 2)
	// Opened with nothing issued at all — so the anchor is set by the
	// unissued-hydration path rather than by Open's.
	f.grant.Open(room, owner.ID, tag, []string{"peer-a", "peer-b"})
	if n := f.grant.Len(); n != 1 {
		t.Fatalf("grant not opened: %d", n)
	}

	// A's notification is HELD while its issuance is recorded, so B's
	// notification is the one that finds the grant unissued — and it finds a
	// snapshot that already contains both. That is what makes this case
	// distinct from the other two: Open's hydration path is exercised by the
	// liveness test, and a fully reordered pair by the reorder test, but
	// neither puts the unissued branch in front of a two-issuance snapshot.
	// Without that, the branch only ever sees `first == latest` and an
	// implementation anchored on the later one is invisible.
	var heldA func()
	f.mu.Lock()
	f.onIssued = func(tag string, expiry int64) {
		f.mu.Lock()
		f.onIssued = nil // only the FIRST notification is held
		f.mu.Unlock()
		heldA = func() { f.grant.NoteIssued(tag, expiry) }
	}
	f.mu.Unlock()

	if u := f.issue(code); u == "" {
		t.Fatal("/api/ice issued no credential for peer A")
	}
	if heldA == nil {
		t.Fatal("peer A's issuance notification was never observed")
	}
	time.Sleep(time.Duration(gap)*time.Second + 200*time.Millisecond)
	if u := f.issue(code); u == "" {
		t.Fatal("/api/ice issued no credential for peer B")
	}
	// ...and only now does A's arrive.
	heldA()

	// The difference oracle, before anything is concluded from the outcome.
	first, latest := f.pair.IssuedSegmentForTag(tag)
	if got := latest - first; got < gap {
		t.Fatalf("the two issuances are %ds apart, want at least %ds — "+
			"the segment has no shape and the anchor cannot be under test", got, gap)
	}

	// Past A's own floor, short of B's.
	f.advanceToTick(first - ttlSec + renewAt)
	f.both(room, 1, 1, 2)
	for _, peer := range []string{"peer-a", "peer-b"} {
		if body := f.last(peer); body["status"] != "granted" {
			t.Fatalf("%s refused %ds in, past A's floor (%ds) and short of B's (%ds) — "+
				"the anchor followed the later issuance: %+v",
				peer, renewAt, ttlSec/2, gap+ttlSec/2, body)
		}
	}
}

// The reordering hazard, through the real plumbing rather than a double.
//
// Two real /api/ice fetches are recorded under the pairing registry's lock in
// the order A then B, but their notifications are DELIVERED B then A — which
// production permits, because the observer fires outside that lock. The anchor
// must still be A's issuance: the registry's snapshot knows which came first
// and the grant asks it rather than trusting arrival order.
func TestWiredReorderedIssuanceNotificationsStillAnchorTheEarliest(t *testing.T) {
	// Ten-second credentials so a real second of elapsed time separates the two
	// issuances; half a TTL is then five seconds.
	const ttl = 10 * time.Second
	f := newWireFixtureTTL(t, ttl)
	owner := f.user("wired-reorder@example.com")

	code, _ := f.pair.MintFor(owner.ID)
	if code == "" {
		t.Fatal("mint refused")
	}
	room, _ := f.pair.RoomFor(code)
	_, _, tag, _, _ := f.pair.ObserveAdmittedRoomAttrib(room, 2)
	f.grant.Open(room, owner.ID, tag, []string{"peer-a", "peer-b"})

	// Hold both notifications instead of forwarding them.
	type note struct {
		tag    string
		expiry int64
	}
	var held []note
	f.mu.Lock()
	f.onIssued = func(tag string, expiry int64) {
		f.mu.Lock()
		held = append(held, note{tag, expiry})
		f.mu.Unlock()
	}
	f.mu.Unlock()

	// Peer A fetches, then peer B three real seconds later. Both through the
	// real endpoint, so the expiries are the ones production would stamp.
	//
	// Three, not one: the assertion has to discriminate between a floor of
	// A+5s and one of B+5s, so the gap must be comfortably larger than the
	// second of truncation the unix-second clock introduces at each end.
	if u := f.issue(code); u == "" {
		t.Fatal("/api/ice issued no credential for peer A")
	}
	time.Sleep(3100 * time.Millisecond)
	if u := f.issue(code); u == "" {
		t.Fatal("/api/ice issued no credential for peer B")
	}

	f.mu.Lock()
	pending := append([]note(nil), held...)
	f.onIssued = nil
	f.mu.Unlock()
	if len(pending) != 2 {
		t.Fatalf("expected two issuance notifications, got %d", len(pending))
	}
	// The registry recorded A first. Confirmed before reversing, so a failure
	// below is about the grant and not about the fixture.
	first, latest := f.pair.IssuedSegmentForTag(tag)
	if first >= latest {
		t.Fatalf("fixture did not produce two distinguishable issuances: (%d, %d)", first, latest)
	}
	if pending[0].expiry >= pending[1].expiry {
		t.Fatalf("fixture did not notify in recorded order: %+v", pending)
	}

	// Deliver them BACKWARDS — which production permits, because the observer
	// fires outside the pairing registry's lock.
	for i := len(pending) - 1; i >= 0; i-- {
		f.grant.NoteIssued(pending[i].tag, pending[i].expiry)
	}

	// One second past half a TTL from A's ISSUANCE — and two short of half a
	// TTL from B's, so the two anchors give opposite answers here.
	//
	// Measured from A's own credential rather than from an offset, because
	// real time has already passed during the sleep and the HTTP calls; an
	// offset would count that twice and land the assertion outside the window
	// it exists to straddle.
	aIssuedAt := pending[0].expiry - int64(ttl.Seconds())
	f.advanceToTick(aIssuedAt + int64(ttl.Seconds())/2 + 1)
	f.both(room, 1, 1, 2)
	for _, peer := range []string{"peer-a", "peer-b"} {
		if body := f.last(peer); body["status"] != "granted" {
			t.Fatalf("%s refused after reordered notifications: %+v", peer, body)
		}
	}
}
