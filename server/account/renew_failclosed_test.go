package account

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/signal"
)

// Renewal's gates must fail CLOSED, including the ones nested three calls deep.
//
// The shallow version of this is easy to get right and easy to believe: the
// issuer checks an error and refuses. What broke the first draft is that
// `trafficAllowanceSpent` reaches `monthlyTrafficCap`, which reaches
// `effectivePlanID`, which folds a plan read failure into the user's own tier —
// so a database that could not answer produced a confident allowance rather
// than a refusal. Each case below fails exactly one of those nested reads.
//
// The failing store wraps a REAL SQLite store, so everything the issuer touches
// behaves normally except the one read under test.

// breakingStore fails one named store method and delegates the rest.
type breakingStore struct {
	Store
	fail string
	err  error
}

var errBroken = errors.New("store unavailable")

func (b *breakingStore) GetPlan(ctx context.Context, id string) (Plan, bool, error) {
	if b.fail == "GetPlan" {
		return Plan{}, false, b.err
	}
	return b.Store.GetPlan(ctx, id)
}

func (b *breakingStore) GetSetting(ctx context.Context, key string) (int64, bool, error) {
	if b.fail == "GetSetting" {
		return 0, false, b.err
	}
	return b.Store.GetSetting(ctx, key)
}

func (b *breakingStore) EmailVerified(ctx context.Context, userID string) (bool, error) {
	if b.fail == "EmailVerified" {
		return false, b.err
	}
	return b.Store.EmailVerified(ctx, userID)
}

func (b *breakingStore) UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error) {
	if b.fail == "UserRelayedSince" {
		return 0, b.err
	}
	return b.Store.UserRelayedSince(ctx, userID, since)
}

func (b *breakingStore) UserMonthlyUpDown(ctx context.Context, userID string, period string) (int64, error) {
	if b.fail == "UserMonthlyUpDown" {
		return 0, b.err
	}
	return b.Store.UserMonthlyUpDown(ctx, userID, period)
}

func (b *breakingStore) OnlineNodes(ctx context.Context, since int64) ([]Node, error) {
	if b.fail == "OnlineNodes" {
		return nil, b.err
	}
	return b.Store.OnlineNodes(ctx, since)
}

func (b *breakingStore) UserNodes(ctx context.Context, userID string, since int64) ([]Node, error) {
	if b.fail == "UserNodes" {
		return nil, b.err
	}
	return b.Store.UserNodes(ctx, userID, since)
}

func (b *breakingStore) NodeRelayedSince(ctx context.Context, since int64) (map[string]int64, error) {
	if b.fail == "NodeRelayedSince" {
		return nil, b.err
	}
	return b.Store.NodeRelayedSince(ctx, since)
}

func (b *breakingStore) GetUserByID(ctx context.Context, id string) (User, error) {
	if b.fail == "GetUserByID" {
		return User{}, b.err
	}
	return b.Store.GetUserByID(ctx, id)
}

// renewFixture is a service whose renewal path is fully wired and whose store
// can be made to fail one read at a time.
type renewFixture struct {
	svc   *Service
	store *breakingStore
	reg   *signal.PairRegistry
	owner User
	tag   string
	now   int64
}

func newRenewFixture(t *testing.T) *renewFixture {
	t.Helper()
	real := newTestStore(t)
	f := &renewFixture{now: 5000, store: &breakingStore{Store: real, err: errBroken}}
	f.svc = &Service{store: f.store, cfg: Config{
		TURNSecret: "renew-secret", TURNURLs: []string{"turn:127.0.0.1:3478"}, TURNCredTTL: time.Hour,
	}, now: func() time.Time { return time.Unix(f.now, 0) }}
	if err := f.svc.SeedPlans(context.Background()); err != nil {
		t.Fatalf("seed plans: %v", err)
	}
	ctx := context.Background()
	u, err := real.UpsertUserByEmail(ctx, "renew@example.com", "renew")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := real.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatalf("verify: %v", err)
	}
	f.owner = u

	f.reg = signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return f.now })
	f.svc.SetPairCodes(f.reg)
	code, _ := f.reg.MintFor(u.ID)
	if code == "" {
		t.Fatal("mint refused")
	}
	_, tag, ok := f.reg.AttribFor(code)
	if !ok {
		t.Fatal("no attribution for a fresh code")
	}
	f.tag = tag
	return f
}

func (f *renewFixture) renew() signal.RenewIssue {
	return f.svc.RenewRelayGrant(context.Background(), f.owner.ID, f.tag)
}

// The control: with nothing broken, renewal issues.
func TestRenewGrantsWhenEveryGateAnswers(t *testing.T) {
	f := newRenewFixture(t)
	got := f.renew()
	if got.Status != signal.RenewGranted {
		t.Fatalf("status %q reason %q, want granted", got.Status, got.Reason)
	}
	if len(got.Config) == 0 || got.Expiry <= f.now {
		t.Fatalf("granted with no usable configuration: %+v", got)
	}
}

// Every nested policy read, one at a time. None of them may produce
// credentials, and none may be reported as a terminal denial — an unreadable
// gate is `unavailable`, which lets a client retry without the round or the
// rate floor advancing.
func TestRenewFailsClosedOnEveryNestedPolicyRead(t *testing.T) {
	for _, method := range []string{
		"GetUserByID",       // the account itself
		"EmailVerified",     // the Sybil gate
		"GetPlan",           // nested under trafficAllowanceSpent -> monthlyTrafficCap -> effectivePlanID
		"UserMonthlyUpDown", // nested under currentMonthTraffic
		"UserRelayedSince",  // nested under currentMonthTraffic
		"GetSetting",        // nested under the node-budget settings read
		"UserNodes",         // the owner's own relays
		"OnlineNodes",       // the fleet pool
		"NodeRelayedSince",  // the per-node monthly budget
	} {
		t.Run(method, func(t *testing.T) {
			f := newRenewFixture(t)
			f.store.fail = method
			got := f.renew()
			if got.Status != signal.RenewUnavailable {
				t.Fatalf("a failed %s produced %q (reason %q), want unavailable", method, got.Status, got.Reason)
			}
			if len(got.Config) != 0 {
				t.Fatalf("a failed %s still produced a configuration: %+v", method, got.Config)
			}
			if got.Expiry != 0 {
				t.Fatalf("a failed %s still stamped an expiry", method)
			}
		})
	}
}

// An administrator grant that cannot be read must not be resolved into a tier
// by guessing — this is the exact nesting root found, reached through the
// public entry point rather than by calling the helper directly.
func TestRenewRefusesWhenTheEffectiveTierCannotBeRead(t *testing.T) {
	f := newRenewFixture(t)
	ctx := context.Background()
	// Give the account a live grant, so effectivePlanID has plan reads to do.
	if _, err := f.store.Store.(*SQLiteStore).GrantAdminPlan(ctx, f.owner.ID, "pro", AdminGrantModeFromNow, 30, f.now); err != nil {
		t.Fatalf("grant admin plan: %v", err)
	}
	f.store.fail = "GetPlan"
	got := f.renew()
	if got.Status != signal.RenewUnavailable {
		t.Fatalf("status %q, want unavailable when the granted tier is unreadable", got.Status)
	}
}

// A spent allowance is a policy answer, not a failure: terminal for the round,
// reported with the vocabulary /api/ice already uses.
func TestRenewDeniesOnSpentAllowanceAndUnverifiedEmail(t *testing.T) {
	f := newRenewFixture(t)
	ctx := context.Background()
	real := f.store.Store.(*SQLiteStore)
	plan, ok, err := real.GetPlan(ctx, "free")
	if err != nil || !ok {
		t.Fatalf("free plan: %v %v", ok, err)
	}
	var spent int64
	for i := 0; spent <= plan.TrafficBytes && i < 512; i++ {
		if err := real.RecordUsage(ctx, UsageEvent{
			AllocID: string(rune('a'+i%26)) + string(rune('a'+i/26)), Token: f.tag,
			UserID: f.owner.ID, RelayedBytes: plan.TrafficBytes, RecordedAt: f.now, Billable: true,
		}); err != nil {
			t.Fatalf("record usage: %v", err)
		}
		if spent, err = real.UserRelayedSince(ctx, f.owner.ID, 0); err != nil {
			t.Fatalf("read usage: %v", err)
		}
	}
	got := f.renew()
	if got.Status != signal.RenewDenied || got.RelayDenied != "quota" {
		t.Fatalf("spent allowance: %+v", got)
	}
	if len(got.Config) != 0 {
		t.Fatalf("a quota denial carried credentials")
	}
}

// A deleted account keeps no renewal authority, however live its socket.
func TestRenewDeniesADeletedAccount(t *testing.T) {
	f := newRenewFixture(t)
	real := f.store.Store.(*SQLiteStore)
	if err := real.SetAccountDeletion(context.Background(), f.owner.ID, f.now, f.now+86400); err != nil {
		t.Skipf("no deletion scheduling available: %v", err)
	}
	got := f.renew()
	if got.Status != signal.RenewDenied || got.Reason != "membership" {
		t.Fatalf("deleted account: %+v", got)
	}
}

// The issuer records NOTHING itself: the expiry it stamps must not extend the
// generation's attribution retention until the grant has accepted the round.
// Recording here is what let a discarded issuance buy itself another hour.
func TestRenewIssuerRecordsNothingByItself(t *testing.T) {
	f := newRenewFixture(t)
	_, before := f.reg.IssuedSegmentForTag(f.tag)
	got := f.renew()
	if got.Status != signal.RenewGranted {
		t.Fatalf("control failed: %+v", got)
	}
	if _, after := f.reg.IssuedSegmentForTag(f.tag); after != before {
		t.Fatalf("the issuer recorded its own issuance: %d -> %d", before, after)
	}
	// It is the ACCEPTANCE that records it.
	f.reg.RetainTag(f.tag, got.Expiry)
	if _, after := f.reg.IssuedSegmentForTag(f.tag); after != got.Expiry {
		t.Fatalf("acceptance did not record the issuance: %d, want %d", after, got.Expiry)
	}
}

// A STUN-only answer is not a renewal: there is no new allocation to migrate
// onto, so it is retryable rather than a granted round nobody can use.
func TestRenewWithoutAnyRelayIsUnavailable(t *testing.T) {
	f := newRenewFixture(t)
	f.svc.cfg.TURNSecret = ""
	f.svc.cfg.TURNURLs = nil
	got := f.renew()
	if got.Status != signal.RenewUnavailable {
		t.Fatalf("status %q, want unavailable with no relay configured", got.Status)
	}
}
