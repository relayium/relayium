package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	sqlite "modernc.org/sqlite"
)

const stripeEventLeaseSeconds int64 = 60

type StripeWebhookClaimState int

const (
	StripeWebhookClaimed StripeWebhookClaimState = iota
	StripeWebhookProcessed
	StripeWebhookInFlight
)

type StripeWebhookClaim struct {
	State      StripeWebhookClaimState
	Generation int64
}

func (s *SQLiteStore) ClaimStripeWebhookEvent(ctx context.Context, eventID, eventType string, now int64) (StripeWebhookClaim, error) {
	if eventID == "" {
		return StripeWebhookClaim{}, errors.New("account: empty Stripe webhook event id")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return StripeWebhookClaim{}, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO stripe_webhook_events
		(event_id,event_type,status,attempts,claimed_at) VALUES(?,?,'processing',1,?)`, eventID, eventType, now)
	if err != nil {
		return StripeWebhookClaim{}, err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		if err := tx.Commit(); err != nil {
			return StripeWebhookClaim{}, err
		}
		return StripeWebhookClaim{State: StripeWebhookClaimed, Generation: 1}, nil
	}
	var status string
	var claimed int64
	var attempts int64
	if err := tx.QueryRowContext(ctx, `SELECT status,claimed_at,attempts FROM stripe_webhook_events WHERE event_id=?`, eventID).Scan(&status, &claimed, &attempts); err != nil {
		if err == sql.ErrNoRows {
			return StripeWebhookClaim{State: StripeWebhookInFlight}, nil
		}
		return StripeWebhookClaim{}, err
	}
	if status == "processed" {
		return StripeWebhookClaim{State: StripeWebhookProcessed}, tx.Commit()
	}
	if status == "processing" && now-claimed < stripeEventLeaseSeconds {
		return StripeWebhookClaim{State: StripeWebhookInFlight}, tx.Commit()
	}
	res, err = tx.ExecContext(ctx, `UPDATE stripe_webhook_events SET status='processing',attempts=attempts+1,claimed_at=?,finished_at=0,failure='' WHERE event_id=? AND status=? AND claimed_at=? AND attempts=?`, now, eventID, status, claimed, attempts)
	if err != nil {
		return StripeWebhookClaim{}, err
	}
	if n, err := res.RowsAffected(); err != nil {
		return StripeWebhookClaim{}, err
	} else if n != 1 {
		return StripeWebhookClaim{State: StripeWebhookInFlight}, tx.Commit()
	}
	if err := tx.Commit(); err != nil {
		return StripeWebhookClaim{}, err
	}
	return StripeWebhookClaim{State: StripeWebhookClaimed, Generation: attempts + 1}, nil
}

func (s *SQLiteStore) FinishStripeWebhookEvent(ctx context.Context, eventID string, claimGeneration int64, processed bool, failure string, now int64) error {
	if claimGeneration <= 0 {
		return errors.New("account: invalid Stripe webhook claim generation")
	}
	if eventID == "" {
		return nil
	}
	status := "failed"
	if processed {
		status, failure = "processed", ""
	}
	if len(failure) > 500 {
		failure = failure[:500]
	}
	res, err := s.db.ExecContext(ctx, `UPDATE stripe_webhook_events SET status=?,finished_at=?,failure=? WHERE event_id=? AND status='processing' AND attempts=?`, status, now, failure, eventID, claimGeneration)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("account: Stripe webhook event %s is not processing", eventID)
	}
	return nil
}

// SQLite storage for provider-neutral subscription state: the per-(user,
// provider) source rows, the effective-projection recompute they all funnel
// through, the Apple app-account token, and the Apple product catalog.
//
// Everything that CHANGES a source row goes through applySourceTx, so the
// projection can never be recomputed from a half-written set: the source row
// update, the quota segmentation and the users-row projection are one
// transaction or none of them.

// ErrExternalSubscriptionOwned is returned when an external subscription id is
// already bound to a DIFFERENT Relayium user. One external subscription has one
// owner; the second claimant is refused rather than silently taking it over.
var ErrExternalSubscriptionOwned = errors.New("account: external subscription already owned by another user")

// ErrAppleSubscriptionConflict is returned when one Relayium account already
// has a LIVE Apple subscription and an event tries to replace it with a
// different original transaction or App Store app. Both are paid ownership
// boundaries: replacing either would orphan the subscription that is still
// billing the customer.
var ErrAppleSubscriptionConflict = errors.New("account: another apple subscription is already live for this user")

// subscriptionSourceCols is the column list every source-row read shares.
const subscriptionSourceCols = `user_id, provider, plan_id, status, cycle, period_end, external_id, external_scope, event_at, updated_at`

func scanSubscriptionSource(sc rowScanner) (SubscriptionSource, error) {
	var s SubscriptionSource
	err := sc.Scan(&s.UserID, &s.Provider, &s.PlanID, &s.Status, &s.Cycle,
		&s.PeriodEnd, &s.ExternalID, &s.ExternalScope, &s.EventAt, &s.UpdatedAt)
	return s, err
}

// ApplySubscriptionSource records one provider event and recomputes the user's
// effective entitlement, atomically. See applySourceTx for the rules.
func (s *SQLiteStore) ApplySubscriptionSource(ctx context.Context, ev SourceEvent) (SubscriptionApply, error) {
	if !knownProvider(ev.Provider) {
		return SubscriptionApply{}, fmt.Errorf("account: %q is not a subscription provider", ev.Provider)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SubscriptionApply{}, err
	}
	defer tx.Rollback()
	res, err := applySourceTx(ctx, tx, ev)
	if err != nil {
		return SubscriptionApply{}, err
	}
	return res, tx.Commit()
}

// applySourceTx is the single write path for provider subscription state.
func applySourceTx(ctx context.Context, tx *sql.Tx, ev SourceEvent) (SubscriptionApply, error) {
	var curPlan, curSource, curStatus, curCycle string
	var curEnd int64
	err := tx.QueryRowContext(ctx,
		`SELECT plan_id, plan_source, subscription_status, subscription_end, billing_cycle
		   FROM users WHERE id = ?`, ev.UserID).
		Scan(&curPlan, &curSource, &curStatus, &curEnd, &curCycle)
	if err == sql.ErrNoRows {
		// No such user. The pre-existing single-UPDATE path simply affected zero
		// rows here, so this stays a silent no-op rather than becoming a new
		// foreign-key failure on a path that used to succeed.
		return SubscriptionApply{}, nil
	}
	if err != nil {
		return SubscriptionApply{}, err
	}

	// The provider's OWN clock — never another provider's, and never the shared
	// users.sub_event_at, which cannot distinguish two independent streams.
	var prev SubscriptionSource
	havePrev := true
	prev, err = scanSubscriptionSource(tx.QueryRowContext(ctx,
		`SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE user_id = ? AND provider = ?`,
		ev.UserID, ev.Provider))
	if err == sql.ErrNoRows {
		havePrev = false
	} else if err != nil {
		return SubscriptionApply{}, err
	}
	// Both branches below leave the row and the projection exactly as they are,
	// and both must report the CURRENT state rather than what the refused event
	// would have produced.
	unchanged := SubscriptionApply{
		Applied: false,
		Effective: EffectiveEntitlement{
			PlanID: curPlan, Status: curStatus, Cycle: curCycle,
			PeriodEnd: curEnd, Source: curSource,
		},
	}
	// Environment transitions are ordered by trust, not by purchase clocks from
	// two independent stores. Sandbox may never take a Production binding. A real
	// Production subscription must always be allowed to replace a Sandbox binding,
	// even when the real subscription was purchased earlier (for example, an
	// annual subscription restored after a fresh TestFlight purchase). Otherwise
	// the newer Sandbox clock would permanently stale-drop every restore of the
	// still-valid paid subscription, and the Sandbox expiry could revoke access.
	appleProductionSupersedesSandbox := ev.Provider == ProviderApple && havePrev &&
		ev.ExternalID != "" && !appleExternalIDIsSandbox(ev.ExternalID) &&
		appleExternalIDIsSandbox(prev.ExternalID)
	// Resolve a canonical id already owned by ANOTHER Relayium user before the
	// same-user live-source guard below. The two conflicts have different user
	// recovery paths and HTTP codes; a claimant who also has their own Apple
	// source must still be told that this particular subscription belongs to a
	// different Relayium account.
	if ev.Provider == ProviderApple && ev.ExternalID != "" {
		if err := assertExternalSubscriptionUnowned(ctx, tx, ev.UserID, ev.Provider, ev.ExternalID); err != nil {
			return SubscriptionApply{}, err
		}
	}
	// A Sandbox purchase is a zero-charge test transaction, not a second
	// commercial subscription. Once this account has a Production binding it may
	// never displace that binding, but it must converge as an accepted no-op so
	// StoreKit can finish the test transaction instead of redelivering it forever.
	// Ownership is checked first above so a sandbox id bound to another Relayium
	// account is still refused rather than consumed by the wrong account.
	if ev.Provider == ProviderApple && havePrev && appleExternalIDIsSandbox(ev.ExternalID) &&
		prev.ExternalID != "" && !appleExternalIDIsSandbox(prev.ExternalID) {
		return unchanged, nil
	}
	// A live Apple source may only be advanced by the SAME original transaction
	// in the SAME app. A different id in the same bundle is still a second paid
	// subscription, while a different bundle is a second App Store product
	// family; overwriting either would make the first subscription impossible to
	// renew, revoke or show to the user. Check before replay ordering so an older
	// competing transaction cannot be mistaken for a harmless no-op and then be
	// finished by the client.
	//
	// Production replacing Sandbox is the one exception. It is an explicit trust
	// transition rather than a second commercial subscription, and the existing
	// environment rule requires the real store to win even when its clock is
	// older. Empty migrated scope is safe to backfill only when the non-empty
	// canonical id still matches; a different id is refused.
	if ev.Provider == ProviderApple && havePrev && prev.stillBillingAt(ev.Now) && !appleProductionSupersedesSandbox {
		differentID := ev.ExternalID != "" && prev.ExternalID != "" && ev.ExternalID != prev.ExternalID
		differentScope := ev.ExternalScope != "" && prev.ExternalScope != "" && ev.ExternalScope != prev.ExternalScope
		if differentID || differentScope {
			return SubscriptionApply{}, ErrAppleSubscriptionConflict
		}
	}
	// Apple's clock orders only one external subscription. A replacement
	// originalTransactionId starts a new domain after the prior source lapses;
	// while it is live, the conflict guard above refuses the second identity.
	sameOrderingDomain := ev.Provider != ProviderApple || ev.ExternalID == "" || prev.ExternalID == "" || ev.ExternalID == prev.ExternalID
	if ev.EventAt > 0 && havePrev && sameOrderingDomain && ev.EventAt < prev.EventAt && !appleProductionSupersedesSandbox {
		// Stale/replayed: leave BOTH the source row and the projection exactly as
		// they are. Advancing the clock without applying the state (or vice
		// versa) is what makes a replay permanently corrupting.
		return unchanged, nil
	}
	// Ownership is settled BEFORE anything is written, inside this same
	// transaction: an event that names a subscription belonging to somebody else
	// must leave the source row and the projection exactly as they were, not
	// grant the tier and fail to record who is paying for it. An omitted id
	// PRESERVES the recorded one (see SourceEvent.ExternalID) — most events
	// carry none, and blanking it would drop the binding that cancel, refund and
	// reconcile all resolve through.
	externalID := prev.ExternalID // '' when there is no prior row
	externalScope := prev.ExternalScope
	if ev.ExternalID != "" {
		if err := assertExternalSubscriptionUnowned(ctx, tx, ev.UserID, ev.Provider, ev.ExternalID); err != nil {
			return SubscriptionApply{}, err
		}
		externalID = ev.ExternalID
	}
	if ev.ExternalScope != "" {
		externalScope = ev.ExternalScope
	}

	// '' cycle leaves the stored one alone (see SourceEvent.Cycle); the clock is
	// kept monotonic so an equal-timestamped redelivery cannot move it backwards.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO subscription_sources (`+subscriptionSourceCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, provider) DO UPDATE SET
		   plan_id = excluded.plan_id,
		   status = excluded.status,
		   cycle = CASE WHEN excluded.cycle = '' THEN subscription_sources.cycle ELSE excluded.cycle END,
		   period_end = excluded.period_end,
		   external_id = excluded.external_id,
		   external_scope = excluded.external_scope,
		   event_at = CASE WHEN excluded.event_at > subscription_sources.event_at
		                   THEN excluded.event_at ELSE subscription_sources.event_at END,
		   updated_at = excluded.updated_at`,
		ev.UserID, ev.Provider, ev.PlanID, ev.Status, ev.Cycle, ev.PeriodEnd,
		externalID, externalScope, ev.EventAt, ev.Now); err != nil {
		// The precheck above normally answers first; the index is what refuses a
		// claimant it could not see (see isExternalSubscriptionConflict), and the
		// refusal must reach the caller in the same vocabulary either way.
		if isExternalSubscriptionConflict(err) {
			return SubscriptionApply{}, ErrExternalSubscriptionOwned
		}
		return SubscriptionApply{}, err
	}

	eff, err := recomputeProjectionTx(ctx, tx, ev.UserID, ev.Provider, curPlan, curSource)
	if err != nil {
		return SubscriptionApply{}, err
	}
	// users.sub_event_at is legacy bookkeeping now that each provider carries
	// its own clock, and it is advanced ONLY by Stripe events: a previous binary
	// rolled back onto this database would read it as "the last Stripe event I
	// applied", and an Apple timestamp written there would make it silently drop
	// live Stripe events.
	legacyClock := int64(0)
	if ev.Provider == ProviderStripe {
		legacyClock = ev.EventAt
	}
	if err := writeProjectionTx(ctx, tx, ev.UserID, eff, ev.Now, legacyClock); err != nil {
		return SubscriptionApply{}, err
	}
	return SubscriptionApply{Applied: true, Effective: eff}, nil
}

// recomputeProjectionTx derives the effective entitlement from every source row
// this user has. trigger names the provider whose event is being applied — the
// one the projection follows when nothing is live (a cancellation) and whose
// status/period-end an admin comp records for visibility.
func recomputeProjectionTx(ctx context.Context, tx *sql.Tx, userID, trigger, curPlan, curSource string) (EffectiveEntitlement, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE user_id = ?`, userID)
	if err != nil {
		return EffectiveEntitlement{}, err
	}
	var sources []SubscriptionSource
	var triggerSource SubscriptionSource
	triggerSource.Provider = trigger
	for rows.Next() {
		src, err := scanSubscriptionSource(rows)
		if err != nil {
			rows.Close()
			return EffectiveEntitlement{}, err
		}
		if src.Provider == trigger {
			triggerSource = src
		}
		sources = append(sources, src)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return EffectiveEntitlement{}, err
	}

	ranks, err := planRanksTx(ctx, tx, sources)
	if err != nil {
		return EffectiveEntitlement{}, err
	}
	adminPlan := ""
	if curSource == SourceAdmin {
		adminPlan = curPlan
	}
	return resolveEffective(adminPlan, triggerSource, sources, ranks), nil
}

// writeProjectionTx applies the effective entitlement to the users row, cutting
// a quota segment first when — and only when — the effective TIER actually
// moves (accrueQuotaTx short-circuits on an unchanged plan, which is what keeps
// a lower or repeated provider event from re-issuing or truncating the month's
// allowance).
func writeProjectionTx(ctx context.Context, tx *sql.Tx, userID string, eff EffectiveEntitlement, now, legacyClock int64) error {
	if err := accrueQuotaTx(ctx, tx, userID, eff.PlanID, now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx,
		`UPDATE users SET plan_id = ?, subscription_status = ?, subscription_end = ?, plan_source = ?,
		        billing_cycle = CASE WHEN ? = '' THEN billing_cycle ELSE ? END,
		        sub_event_at = CASE WHEN ? > sub_event_at THEN ? ELSE sub_event_at END
		  WHERE id = ?`,
		eff.PlanID, eff.Status, eff.PeriodEnd, eff.Source, eff.Cycle, eff.Cycle,
		legacyClock, legacyClock, userID)
	return err
}

// planRanksTx loads the ordering inputs for every tier the sources reference.
// A tier with no plans row ranks at zero: an unresolvable plan must not be able
// to outrank a real one.
func planRanksTx(ctx context.Context, tx *sql.Tx, sources []SubscriptionSource) (map[string]planRank, error) {
	out := map[string]planRank{}
	if len(sources) == 0 {
		return out, nil
	}
	ids := make([]any, 0, len(sources))
	seen := map[string]bool{}
	for _, s := range sources {
		if s.PlanID == "" || seen[s.PlanID] {
			continue
		}
		seen[s.PlanID] = true
		ids = append(ids, s.PlanID)
		out[s.PlanID] = planRank{id: s.PlanID}
	}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT id, sort_order, price_monthly FROM plans WHERE id IN (?`+
			strings.Repeat(", ?", len(ids)-1)+`)`, ids...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r planRank
		if err := rows.Scan(&r.id, &r.sortOrder, &r.priceMonthly); err != nil {
			return nil, err
		}
		out[r.id] = r
	}
	return out, rows.Err()
}

// GetSubscriptionSource returns one provider's recorded state for a user.
func (s *SQLiteStore) GetSubscriptionSource(ctx context.Context, userID, provider string) (SubscriptionSource, bool, error) {
	src, err := scanSubscriptionSource(s.reader().QueryRowContext(ctx,
		`SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE user_id = ? AND provider = ?`,
		userID, provider))
	if err == sql.ErrNoRows {
		return SubscriptionSource{}, false, nil
	}
	if err != nil {
		return SubscriptionSource{}, false, err
	}
	return src, true, nil
}

// ListSubscriptionSources returns every provider row a user holds.
func (s *SQLiteStore) ListSubscriptionSources(ctx context.Context, userID string) ([]SubscriptionSource, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+subscriptionSourceCols+` FROM subscription_sources WHERE user_id = ? ORDER BY provider`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SubscriptionSource
	for rows.Next() {
		src, err := scanSubscriptionSource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, src)
	}
	return out, rows.Err()
}

// LiveEntitlementProviders names the providers currently granting this user
// paid access, sorted. Two of them is the double-billing state clients surface.
//
// The live test is grantsAccess() in Go rather than a status list in SQL, so
// there is exactly one definition of "this subscription is paying for
// something" for every reader of this model.
func (s *SQLiteStore) LiveEntitlementProviders(ctx context.Context, userID string) ([]string, error) {
	sources, err := s.ListSubscriptionSources(ctx, userID)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, src := range sources {
		if src.grantsAccess() {
			out = append(out, src.Provider)
		}
	}
	return out, nil
}

// BindExternalSubscription records which external subscription a provider row
// stands for, first-write-wins across users. An empty id clears the binding.
func (s *SQLiteStore) BindExternalSubscription(ctx context.Context, userID, provider, externalID string) error {
	if !knownProvider(provider) {
		return fmt.Errorf("account: %q is not a subscription provider", provider)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := bindExternalSubscriptionTx(ctx, tx, userID, provider, externalID); err != nil {
		return err
	}
	return tx.Commit()
}

// assertExternalSubscriptionUnowned is the single definition of "may this user
// claim this external subscription id". Explicit, so the answer is decided
// before anything is written rather than discovered halfway through; the unique
// index behind it is the backstop for the interleavings it cannot see, and
// isExternalSubscriptionConflict makes that backstop speak the same error. It
// must be called inside the transaction that does the claiming — checking in
// one transaction and writing in another is the race it exists to prevent.
func assertExternalSubscriptionUnowned(ctx context.Context, tx *sql.Tx, userID, provider, externalID string) error {
	if externalID == "" {
		return nil
	}
	var owner string
	err := tx.QueryRowContext(ctx,
		`SELECT user_id FROM subscription_sources WHERE provider = ? AND external_id = ?`,
		provider, externalID).Scan(&owner)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if owner != userID {
		return ErrExternalSubscriptionOwned
	}
	return nil
}

// sqliteConstraintUnique is SQLite's extended result code for a UNIQUE INDEX
// violation (SQLITE_CONSTRAINT_UNIQUE). It is deliberately the ONLY code
// isExternalSubscriptionConflict accepts: a primary key (1555), a foreign key
// (787), a NOT NULL (1299) and a locked database all have codes of their own,
// and each is a real fault that has to keep propagating as itself rather than
// being reported to a caller as somebody else's subscription.
const sqliteConstraintUnique = 2067

// isExternalSubscriptionConflict reports whether err is the unique index
// refusing a second owner for one external subscription id.
//
// It is the fallback under assertExternalSubscriptionUnowned, which normally
// answers first: inside one process the write pool is a single connection
// taking an IMMEDIATE lock, so check and claim are one serialized unit and the
// index never gets the chance to speak. Across INSTANCES that no longer holds,
// and a future write path that checked and claimed in different transactions
// would lose it too. In both cases the index is what refuses the claimant — and
// it does so in the driver's vocabulary, which no caller switches on.
//
// The two statements that use this are the only two that can violate that index
// (subscription_sources has exactly one unique index besides its primary key,
// which both statements resolve with ON CONFLICT), so a UNIQUE violation from
// either has one meaning.
func isExternalSubscriptionConflict(err error) bool {
	var serr *sqlite.Error
	return errors.As(err, &serr) && serr.Code() == sqliteConstraintUnique
}

func bindExternalSubscriptionTx(ctx context.Context, tx *sql.Tx, userID, provider, externalID string) error {
	if err := assertExternalSubscriptionUnowned(ctx, tx, userID, provider, externalID); err != nil {
		return err
	}
	// The row may not exist yet: a subscription id can be observed before the
	// first state event for it lands. Created inert (free/no status), so it
	// grants nothing and stays out of the reconcile sweep.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO subscription_sources (user_id, provider, plan_id, status, cycle, period_end, external_id, event_at, updated_at)
		 VALUES (?, ?, 'free', '', '', 0, ?, 0, 0)
		 ON CONFLICT(user_id, provider) DO UPDATE SET external_id = excluded.external_id`,
		userID, provider, externalID); err != nil {
		if isExternalSubscriptionConflict(err) {
			return ErrExternalSubscriptionOwned
		}
		return err
	}
	return nil
}

// UserByExternalSubscription resolves the owner of an external subscription id.
// An empty id fails closed: every row defaults to ”, so matching it would
// return an arbitrary user rather than "unknown".
func (s *SQLiteStore) UserByExternalSubscription(ctx context.Context, provider, externalID string) (string, bool, error) {
	if externalID == "" || !knownProvider(provider) {
		return "", false, nil
	}
	var uid string
	err := s.reader().QueryRowContext(ctx,
		`SELECT user_id FROM subscription_sources WHERE provider = ? AND external_id = ?`,
		provider, externalID).Scan(&uid)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return uid, true, nil
}

// LastSourceEventAt returns the last event clock applied for ONE provider (0
// when that provider has never been seen), for the webhook's ordering guard.
func (s *SQLiteStore) LastSourceEventAt(ctx context.Context, userID, provider string) (int64, error) {
	var at int64
	err := s.db.QueryRowContext(ctx,
		`SELECT event_at FROM subscription_sources WHERE user_id = ? AND provider = ?`,
		userID, provider).Scan(&at)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return at, err
}

// ---- Apple app account token -------------------------------------------------

// EnsureAppleAccountToken preserves and imports pre-dispatch App Store
// `appAccountToken` state. No production HTTP path calls it to authorize a new
// purchase; purchase-dispatch mints a unique token with its attempt instead.
//
// The token remains outside User so ordinary account surfaces cannot expose it.
func (s *SQLiteStore) EnsureAppleAccountToken(ctx context.Context, userID, candidate string) (string, error) {
	if !validAppAccountToken(candidate) {
		return "", errors.New("account: app account token must be an RFC 4122 v4 UUID")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var current string
	if err := tx.QueryRowContext(ctx,
		`SELECT apple_account_token FROM users WHERE id = ?`, userID).Scan(&current); err != nil {
		return "", err
	}
	if current != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO apple_billing_subjects(app_account_token,user_id,attempt_id,bundle_id,authority_epoch,created_at)
 VALUES(?,?,? || ?,?,0,strftime('%s','now')) ON CONFLICT(app_account_token) DO NOTHING`, current, userID, "legacy:", userID, billingUnknownAppleScope); err != nil {
			return "", err
		}
		return current, tx.Commit()
	}
	var retained int
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM apple_billing_subjects WHERE app_account_token=?)`, strings.ToLower(candidate)).Scan(&retained); err != nil {
		return "", err
	}
	if retained != 0 {
		return "", errors.New("account: app account token is retained by billing history")
	}
	// The unique index refuses a token another account already holds, so one
	// token can never address two users.
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET apple_account_token = ? WHERE id = ?`, candidate, userID); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO apple_billing_subjects(app_account_token,user_id,attempt_id,bundle_id,authority_epoch,created_at)
 VALUES(?,?,? || ?,?,0,strftime('%s','now'))`, strings.ToLower(candidate), userID, "legacy:", userID, billingUnknownAppleScope); err != nil {
		return "", err
	}
	return candidate, tx.Commit()
}

// UserByAppleAccountToken resolves the account a token belongs to. An empty or
// malformed token fails closed rather than scanning: every account that has
// never minted one stores ”, so matching it would return an arbitrary user.
func (s *SQLiteStore) UserByAppleAccountToken(ctx context.Context, token string) (User, bool, error) {
	if token == "" || !validAppAccountToken(token) {
		return User{}, false, nil
	}
	var u User
	var strict int
	err := s.reader().QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes, deleted_at, purge_after, plan_id,
		        stripe_customer_id, stripe_subscription_id, subscription_status, subscription_end, plan_source, scheduled_plan_id, scheduled_cycle, billing_cycle,
		        plan_started_at, quota_accrued_bytes, quota_accrued_period
		   FROM users WHERE apple_account_token = ?`, token,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.StripeSubscriptionID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID, &u.ScheduledCycle, &u.BillingCycle,
		&u.PlanStartedAt, &u.QuotaAccruedBytes, &u.QuotaAccruedPeriod)
	if err == sql.ErrNoRows {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, err
	}
	u.OnlyOwnNodes = strict != 0
	return u, true, nil
}

// ---- Apple product catalog ---------------------------------------------------

// AppleProductPlan resolves one app's product id to a Relayium tier. Both keys
// are required: the same product id under the other bundle is a different
// product, and an empty key matches nothing.
//
// The tier is re-checked HERE, not just in UpsertAppleProduct. Validation on
// the way in settles what was true when the row was written; the tier it names
// can be retired afterwards through the ordinary admin lifecycle, and nothing
// revisits the mapping when that happens — its own active flag stays 1 and the
// product stays on sale in App Store Connect. So the two conditions are joined
// at read time: the mapping must be live AND its tier must currently exist and
// be on sale. Either one failing is a not-found, which is what makes a purchase
// for a withdrawn tier fail closed instead of granting it.
//
// This is deliberately a read-time gate rather than a sweep that retires
// mappings when a plan is deactivated: it needs no lifecycle hook to stay
// correct, and it reverses cleanly if the tier goes back on sale.
func (s *SQLiteStore) AppleProductPlan(ctx context.Context, bundleID, productID string) (AppleProduct, bool, error) {
	if bundleID == "" || productID == "" {
		return AppleProduct{}, false, nil
	}
	var p AppleProduct
	var active int64
	err := s.reader().QueryRowContext(ctx,
		`SELECT ap.bundle_id, ap.product_id, ap.plan_id, ap.cycle, ap.active, ap.updated_at
		   FROM apple_products ap
		   JOIN plans p ON p.id = ap.plan_id
		  WHERE ap.bundle_id = ? AND ap.product_id = ? AND ap.active = 1 AND p.active = 1`,
		bundleID, productID).Scan(&p.BundleID, &p.ProductID, &p.PlanID, &p.Cycle, &active, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return AppleProduct{}, false, nil
	}
	if err != nil {
		return AppleProduct{}, false, err
	}
	p.Active = active != 0
	return p, true, nil
}

// GetAppleProduct reads one RAW catalog row by its exact key.
//
// No join and no filtering, and that is the entire difference between this and
// AppleProductPlan above. It is what the admin confirmation page's "before"
// image is built from: the operator must be shown the row that is actually
// there, including the ones the live projection deliberately hides (retired
// mapping, retired tier, missing tier). Reading the projection instead would
// show an empty before-image for exactly those rows, and the confirmation page
// would then say "creating a new mapping" while the write overwrote an existing
// one — a diff that lies in the one place its whole job is to be true.
//
// The key is trimmed for the same reason UpsertAppleProduct trims it: a pasted
// bundle id with a trailing newline must address the row the write will address,
// or the before-image and the write disagree about which row they are about.
func (s *SQLiteStore) GetAppleProduct(ctx context.Context, bundleID, productID string) (AppleProduct, bool, error) {
	bundleID, productID = strings.TrimSpace(bundleID), strings.TrimSpace(productID)
	if bundleID == "" || productID == "" {
		return AppleProduct{}, false, nil
	}
	var p AppleProduct
	var active int64
	err := s.reader().QueryRowContext(ctx,
		`SELECT bundle_id, product_id, plan_id, cycle, active, updated_at
		   FROM apple_products WHERE bundle_id = ? AND product_id = ?`,
		bundleID, productID).Scan(&p.BundleID, &p.ProductID, &p.PlanID, &p.Cycle, &active, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return AppleProduct{}, false, nil
	}
	if err != nil {
		return AppleProduct{}, false, err
	}
	p.Active = active != 0
	return p, true, nil
}

// ListAppleProducts returns every raw catalog row with the state of the tier it
// points at, for the admin console.
//
// LEFT JOIN, not the inner join AppleProductPlan uses: a row whose plan_id has
// no plans row must still appear. That row should be unreachable — the foreign
// key is real — but "unreachable" is a claim about the write paths, and the
// admin list is the surface whose job is to show what is actually in the table.
// Rendering it through an inner join would make a broken row invisible in the
// one place someone could fix it.
//
// ORDER BY the primary key, which is total: the list is the same on every
// render and in every test, and two rows can never swap places between the page
// an operator read and the row they clicked.
//
// Unpaged, unlike the BYO node tables on the same dashboard, and the difference
// is the population rather than the preference: BYO nodes grow with the user
// base and have no ceiling, while this table is written only by an operator
// through the step-up-confirmed console — its size is the number of App Store
// products Relayium sells. If that ever stops being a handful, this needs the
// same SQL paging treatment, not a bigger render.
func (s *SQLiteStore) ListAppleProducts(ctx context.Context) ([]AppleProductRow, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT ap.bundle_id, ap.product_id, ap.plan_id, ap.cycle, ap.active, ap.updated_at,
		        p.id IS NOT NULL, COALESCE(p.active, 0), COALESCE(p.name, '')
		   FROM apple_products ap
		   LEFT JOIN plans p ON p.id = ap.plan_id
		  ORDER BY ap.bundle_id, ap.product_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AppleProductRow
	for rows.Next() {
		var r AppleProductRow
		var active, planFound, planActive int64
		if err := rows.Scan(&r.BundleID, &r.ProductID, &r.PlanID, &r.Cycle, &active, &r.UpdatedAt,
			&planFound, &planActive, &r.PlanName); err != nil {
			return nil, err
		}
		r.Active, r.PlanFound, r.PlanActive = active != 0, planFound != 0, planActive != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertAppleProduct records (or retires, with Active=false) one mapping.
//
// It fails CLOSED, because this table is the whole of what stands between a
// signed App Store transaction and a granted tier. By the time an adapter reads
// a row here the purchase has already happened and the money has already moved:
// there is no point at which "this product maps to a tier that does not exist"
// or "…on a cycle the projection has no rules for" can be resolved into
// anything but a wrong entitlement. So the check belongs on the way IN, where
// the only cost of being wrong is a rejected admin edit.
//
// The rules:
//   - keys and plan are TRIMMED, then required non-empty. A pasted bundle id
//     with a trailing newline must address the same product as the clean one,
//     not create a second row nothing will ever match.
//   - the keys must fit appleProductKeyMaxLen, which IS the purchase verifier's
//     bound. Beyond it the row is unreachable by construction: Verify refuses
//     the payload before any lookup, so the mapping could never resolve for
//     anyone. Enforced here and not only in the admin parser because this method
//     is the authority — every caller, including a future adapter or migration
//     that never sees a form, has to be unable to write a row no purchase can
//     reach. Length only; the FORM of an identifier is Apple's business, and a
//     wrong format rule would reject a product Relayium sells.
//   - cycle must be exactly monthly or yearly. The empty string is what an
//     unresolvable Stripe price yields, where it means UNKNOWN; a catalog row is
//     written by hand and has no excuse for not knowing, and every other value
//     is a third cycle the projection cannot represent.
//   - a LIVE mapping's plan must exist and be active. Pointing purchases at a
//     tier that is not on sale is exactly the "unsafe state" this guards.
//     AppleProductPlan re-checks the same thing at read time, because this
//     check can only speak for the moment the row was written; together they
//     mean a mapping is live only while an operator both wrote it and still
//     sells the tier.
//
// Retirement (Active=false) deliberately does NOT require an active plan: the
// mapping most in need of retiring is the one whose tier was just taken off
// sale, and refusing that would leave a live App Store product wired to a dead
// tier with no way to switch it off. It still gets the shape checks, so a
// retired row is a well-formed row.
func (s *SQLiteStore) UpsertAppleProduct(ctx context.Context, p AppleProduct) error {
	p.BundleID = strings.TrimSpace(p.BundleID)
	p.ProductID = strings.TrimSpace(p.ProductID)
	p.PlanID = strings.TrimSpace(p.PlanID)
	p.Cycle = strings.TrimSpace(p.Cycle)
	if p.BundleID == "" || p.ProductID == "" {
		return errors.New("account: apple product needs a bundle id and a product id")
	}
	if len(p.BundleID) > appleProductKeyMaxLen || len(p.ProductID) > appleProductKeyMaxLen {
		return fmt.Errorf("account: apple product bundle id and product id must each be at most %d bytes",
			appleProductKeyMaxLen)
	}
	if p.PlanID == "" {
		return errors.New("account: apple product needs a plan id")
	}
	if p.Cycle != "monthly" && p.Cycle != "yearly" {
		return fmt.Errorf("account: apple product cycle must be monthly or yearly, got %q", p.Cycle)
	}
	if p.Active {
		var active int64
		err := s.reader().QueryRowContext(ctx, `SELECT active FROM plans WHERE id = ?`, p.PlanID).Scan(&active)
		if err == sql.ErrNoRows {
			return fmt.Errorf("account: apple product references unknown plan %q", p.PlanID)
		}
		if err != nil {
			return err
		}
		if active == 0 {
			return fmt.Errorf("account: apple product references inactive plan %q", p.PlanID)
		}
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO apple_products (bundle_id, product_id, plan_id, cycle, active, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(bundle_id, product_id) DO UPDATE SET
		   plan_id = excluded.plan_id, cycle = excluded.cycle,
		   active = excluded.active, updated_at = excluded.updated_at`,
		p.BundleID, p.ProductID, p.PlanID, p.Cycle, b2i(p.Active), p.UpdatedAt)
	return err
}

// ---- migration ---------------------------------------------------------------

// backfillSubscriptionSources reconstructs the Stripe source row for every user
// whose users-row projection IS Stripe state, so a database written by a
// pre-provider-neutral binary keeps behaving identically: same effective plan,
// same canonical subscription ownership, same reconcile-sweep membership.
//
// It runs on EVERY boot rather than only when the table is created. Gating it
// on the CREATE would mean a process that died between creating the table and
// filling it never backfilled again, and those users would silently drop out of
// the reconcile sweep. Insert-only-where-missing makes repeating it free, and
// makes it incapable of overwriting a row that real events have since moved on.
//
// Two populations deliberately get NO row:
//   - plan_source='admin': the users row holds the COMPED tier, not what Stripe
//     is billing, so there is nothing truthful to copy. Their next Stripe event
//     writes the real row (the projection keeps the comp on top meanwhile).
//   - never-subscribed accounts: no provider state exists to record.
func backfillSubscriptionSources(ctx context.Context, db *sql.DB) error {
	// A duplicated stripe_subscription_id across two users cannot exist by
	// construction (one customer, one user) but it must not be able to fail a
	// STARTUP: leaving such an id unrecorded costs only the ownership hint,
	// which the next event re-establishes, whereas a failed migration is an
	// outage.
	_, err := db.ExecContext(ctx,
		`INSERT INTO subscription_sources (user_id, provider, plan_id, status, cycle, period_end, external_id, event_at, updated_at)
		 SELECT u.id, 'stripe', u.plan_id, u.subscription_status, u.billing_cycle, u.subscription_end,
		        CASE WHEN u.stripe_subscription_id <> '' AND (
		               SELECT COUNT(*) FROM users d WHERE d.stripe_subscription_id = u.stripe_subscription_id
		             ) = 1 THEN u.stripe_subscription_id ELSE '' END,
		        u.sub_event_at, 0
		   FROM users u
		  WHERE u.plan_source = 'stripe'
		    AND NOT EXISTS (
		          SELECT 1 FROM subscription_sources s
		           WHERE s.user_id = u.id AND s.provider = 'stripe')`)
	return err
}
