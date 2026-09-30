package account

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/relayium/relayium/httpx"
)

// handleBillingCheckout starts a Stripe Checkout Session for the signed-in
// user to subscribe to a plan/cycle. 404 when billing is unconfigured
// (s.biller == nil, i.e. RELAYIUM_STRIPE_SECRET_KEY unset); 400 when the
// requested plan has no Stripe price id for the requested cycle (free tier,
// or an admin-only/unmapped plan).
func (s *Service) handleBillingCheckout(w http.ResponseWriter, r *http.Request, u User) {
	if s.biller == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if s.refuseFrozenBilling(w, r, u) {
		return
	}
	// Guard against creating a SECOND concurrent subscription (double billing).
	// Checkout is subscription-mode; Stripe will happily open another live
	// subscription on a customer that already has one. A user who is already
	// subscribed must change tiers via change-plan, not a fresh Checkout
	// Session. A canceled/expired subscription (SubscriptionStatus not live)
	// correctly falls through so the user can re-subscribe. liveSubStatus is the
	// authoritative signal — PlanSource stays "stripe" after cancellation, so it
	// alone cannot distinguish a live sub from a lapsed one.
	live, err := s.Store().LiveEntitlementProviders(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if u.StripeCustomerID != "" && liveSubStatus(u.SubscriptionStatus) {
		writeAlreadySubscribed(w, blockingProvider(u, live, ProviderStripe))
		return
	}
	// ...and the same guard for a live entitlement from ANY OTHER provider. The
	// Stripe condition above cannot see one: an Apple subscriber has no Stripe
	// customer at all, so without this they would be sold a second, parallel
	// subscription through a provider that knows nothing about the first. This
	// has to exist BEFORE Apple purchases can be made, not alongside them.
	if len(live) > 0 {
		writeAlreadySubscribed(w, blockingProvider(u, live, ProviderStripe))
		return
	}
	var in struct {
		PlanID string `json:"planId"`
		Cycle  string `json:"cycle"` // "monthly" | "yearly"
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	plan, ok, err := s.Store().GetPlan(r.Context(), in.PlanID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var priceID string
	switch in.Cycle {
	case "monthly":
		priceID = plan.StripePriceMonthlyID
	case "yearly":
		priceID = plan.StripePriceYearlyID
	default:
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid billing cycle"})
		return
	}
	if priceID == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "plan not purchasable"})
		return
	}
	if err := s.validateStripePlanPrice(r.Context(), plan, in.Cycle); err != nil {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "billing_catalog_unavailable"})
		return
	}
	authorities, ok := s.Store().(interface {
		AcquireBillingAuthority(context.Context, BillingAuthorityRequest) (BillingAuthority, error)
		DispatchBillingPurchase(context.Context, BillingAuthority, string, int64) (BillingPurchaseAttempt, bool, error)
		SetBillingPurchaseProviderSession(context.Context, string, string, string, string) error
	})
	if !ok {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	authority, err := authorities.AcquireBillingAuthority(r.Context(), BillingAuthorityRequest{
		UserID: u.ID, Provider: ProviderStripe, Now: s.Now().Unix(),
	})
	if errors.Is(err, ErrBillingAuthorityConflict) {
		writeAlreadySubscribed(w, "billing_authority")
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Bind a SINGLE Stripe customer to the user before checkout, then always pass
	// it explicitly. Otherwise subscription-mode Checkout mints a fresh customer
	// per session, so two concurrent first-time checkouts (double tab / retry
	// before the first webhook binds one) produced TWO customers with TWO parallel
	// subscriptions — the second invisible in the Billing Portal and uncancelable
	// in-product. EnsureCustomer is idempotent (keyed on user id) and the CAS store
	// write makes even a bypassed key converge on one customer.
	customerID := u.StripeCustomerID
	if customerID == "" {
		created, err := s.biller.EnsureCustomer(r.Context(), u.Email, u.ID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if customerID, err = s.Store().SetUserStripeCustomerIfEmpty(r.Context(), u.ID, created); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	attempt, created, err := authorities.DispatchBillingPurchase(r.Context(), authority, priceID, s.Now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// An existing attempt normally means "you already have a Checkout open".
	// But a Checkout the user abandoned stays dispatched forever, and until
	// something retires it the same-plan retry below hands back a dead URL and
	// the changed-plan path 409s permanently. releaseAbandonedStripeCheckout
	// retires it only when a live canonical Session read proves it expired,
	// unpaid and free of any liability or recovery lineage. A blocked release
	// proved nothing and falls through to exactly the behaviour below; a lost
	// one proved the Session dead and is handled separately, because that
	// fall-through would hand back a URL already known to be expired.
	//
	// This runs at most ONCE and is not a loop: it advances the authority
	// generation, so the re-dispatch either creates the single new attempt or
	// it does not, and either way no third pass exists to create another
	// Session.
	if !created {
		outcome, releaseErr := s.releaseAbandonedStripeCheckout(r.Context(), u, authority, attempt, customerID)
		if releaseErr != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if outcome == checkoutReleaseLost {
			// The canonical read PROVED this Session dead, and then the CAS did
			// not apply. Falling through would serve attempt.ProviderURL — a URL
			// we have just established is expired — so this returns the
			// reconciliation refusal instead. It deliberately does not retry the
			// dispatch: the CAS may have lost to a concurrent release, but it may
			// equally have lost to a webhook binding a subscription, an account
			// freeze, or an authority change, and those must not be dispatched
			// through on an assumption. The next request re-reads the real state
			// and proceeds from there.
			httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "billing_reconciliation_required"})
			return
		}
		if outcome == checkoutReleaseDone {
			// Re-read the authority: the release advanced its epoch and intent,
			// and dispatching against the stale generation would conflict.
			authority, err = authorities.AcquireBillingAuthority(r.Context(), BillingAuthorityRequest{
				UserID: u.ID, Provider: ProviderStripe, Now: s.Now().Unix(),
			})
			if errors.Is(err, ErrBillingAuthorityConflict) {
				writeAlreadySubscribed(w, "billing_authority")
				return
			}
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			attempt, created, err = authorities.DispatchBillingPurchase(r.Context(), authority, priceID, s.Now().Unix())
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
	}
	if attempt.ProductID != priceID {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "billing_reconciliation_required"})
		return
	}
	if !created {
		if attempt.ProviderSessionID != "" && attempt.ProviderURL != "" {
			httpx.WriteJSON(w, http.StatusOK, map[string]string{"url": attempt.ProviderURL})
			return
		}
		// The provider call may already have succeeded while its response or our
		// provider_ref write failed. Stripe's idempotency cache is bounded, so
		// replaying the same key later is not proof against a second live Session.
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "billing_reconciliation_required"})
		return
	}
	session, err := s.biller.CreateCheckoutSession(r.Context(), CheckoutInput{
		PriceID:          priceID,
		CustomerID:       customerID,
		CustomerEmail:    u.Email,
		ClientRefUserID:  u.ID,
		BillingAttemptID: attempt.ID,
		SuccessURL:       s.Cfg().BaseURL + "/me?billing=success",
		CancelURL:        s.Cfg().BaseURL + "/me?billing=cancel",
		IdempotencyKey:   "checkout:" + attempt.ID,
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := authorities.SetBillingPurchaseProviderSession(r.Context(), u.ID, attempt.ID, session.ID, session.URL); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"url": session.URL})
}

// writeAlreadySubscribed is the one double-purchase refusal. The `provider`
// field is additive — the pre-existing `error` code is unchanged — so an older
// client keeps reading exactly what it always did, while a current one can say
// WHERE the existing subscription lives instead of offering a second one.
func writeAlreadySubscribed(w http.ResponseWriter, provider string) {
	httpx.WriteJSON(w, http.StatusConflict, map[string]string{
		"error":    "already_subscribed",
		"provider": provider,
	})
}

func (s *Service) refuseFrozenBilling(w http.ResponseWriter, r *http.Request, u User) bool {
	store, ok := s.Store().(interface {
		BillingUserFrozen(context.Context, string) (bool, error)
	})
	if !ok {
		http.Error(w, "server error", http.StatusInternalServerError)
		return true
	}
	frozen, err := store.BillingUserFrozen(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return true
	}
	if !frozen {
		return false
	}
	httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "billing_deletion_pending"})
	return true
}

// blockingProvider attributes a refusal: which provider's live subscription is
// standing in the way.
//
// It names the LIVE PROVIDERS, deliberately not entitlementProviderWire, which
// answers a different question. For an admin-comped account that wire value is
// "admin" — correct for "where does this plan come from", and useless as the
// answer to "why can I not buy this", where the honest answer is the provider
// that is actually billing them. fallback covers the case where the users-row
// projection says a subscription is live but no source row does (a legacy or
// hand-edited row): naming the provider the guard fired on beats reporting
// nothing, and an admin comp is named as such because that IS the blocker then.
func blockingProvider(u User, live []string, fallback string) string {
	switch len(live) {
	case 0:
		if u.PlanSource == SourceAdmin {
			return SourceAdmin
		}
		return fallback
	case 1:
		return live[0]
	default:
		return ProviderMultiple
	}
}

// providerManagedElsewhere reports whether this account's entitlement is owned
// by something other than a plain Stripe subscription, so the Stripe management
// endpoints must decline it.
//
// The distinction matters for what the client does NEXT. `no_active_subscription`
// means "you have nothing here — go and subscribe", which for an Apple
// subscriber would walk them straight into a second, parallel subscription.
// `managed_by_provider` means "this exists, but not here", which is the truth
// and the only routing that cannot double-bill. A user who holds BOTH a Stripe
// and an Apple subscription is reported as `multiple` for the same reason: the
// Stripe change they are asking for would not move their effective plan, and
// silently performing it would be a charge with no effect.
func (s *Service) providerManagedElsewhere(ctx context.Context, u User) (string, bool, error) {
	authority, exists, err := s.Store().BillingAuthority(ctx, u.ID)
	if err != nil {
		return "", false, err
	}
	if exists && authority.Provider != ProviderStripe {
		return authority.Provider, true, nil
	}
	live, err := s.Store().LiveEntitlementProviders(ctx, u.ID)
	if err != nil {
		return "", false, err
	}
	if len(live) == 0 || (len(live) == 1 && live[0] == ProviderStripe) {
		return "", false, nil
	}
	return blockingProvider(u, live, live[0]), true, nil
}

// refuseIfManagedElsewhere writes the 409 and reports true when the caller must
// stop. A store failure fails CLOSED (500): guessing "Stripe owns it" during a
// DB blip is how an Apple subscriber would end up in a Stripe checkout.
func (s *Service) refuseIfManagedElsewhere(w http.ResponseWriter, r *http.Request, u User) bool {
	provider, managed, err := s.providerManagedElsewhere(r.Context(), u)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return true
	}
	if !managed {
		return false
	}
	httpx.WriteJSON(w, http.StatusConflict, map[string]string{
		"error":    "managed_by_provider",
		"provider": provider,
	})
	return true
}

// handleBillingPortal opens a Stripe Billing Portal session for the signed-in
// user to manage an existing subscription. 404 when billing is unconfigured
// or the user has no Stripe customer yet (never checked out); 409
// managed_by_provider when the entitlement belongs to another provider.
func (s *Service) handleBillingPortal(w http.ResponseWriter, r *http.Request, u User) {
	if s.biller == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if s.refuseFrozenBilling(w, r, u) {
		return
	}
	// BEFORE the customer check, not after it. `has a Stripe customer` is not a
	// proxy for `Stripe owns this entitlement`: stripe_customer_id is written
	// once and never cleared, so a user who paid by card years ago and now
	// subscribes on the App Store still satisfies it. Ordering the two the other
	// way would make the answer depend on that residue — 409 for an Apple
	// subscriber who never touched Stripe, a live Stripe cancel/update surface
	// for one who did. The portal governs Stripe subscriptions only; for a dual
	// subscriber it would offer to cancel half of what they pay for while
	// reporting it as "cancel subscription".
	//
	// This runs before ANY Stripe call, so a refused account never reaches
	// CreatePortalSession.
	if s.refuseIfManagedElsewhere(w, r, u) {
		return
	}
	if u.StripeCustomerID == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// return_url is set per session and overrides the "Redirect link" configured
	// in the Stripe dashboard, so that field is dead config — change this line,
	// not the dashboard. /me rather than the home page: the user arrived from
	// there and expects to land back on their plan state.
	url, err := s.biller.CreatePortalSession(r.Context(), u.StripeCustomerID, s.Cfg().BaseURL+"/me")
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"url": url})
}

// cycleOfPrice tells which billing cycle a Stripe Price id represents for the
// plan it belongs to. Stripe's subscription events carry no interval field, so
// matching the price id against the tier's two ids is the only way to know
// whether a subscription is monthly or yearly.
//
// Returns "" when the id matches neither — an admin mid-edit of the price ids,
// or a price retired in Stripe but still attached to a live subscription.
// Callers must treat "" as "unknown", never as a default cycle.
func cycleOfPrice(p Plan, priceID string) string {
	switch priceID {
	case p.StripePriceMonthlyID:
		return "monthly"
	case p.StripePriceYearlyID:
		return "yearly"
	default:
		return ""
	}
}

// priceIDForCycle returns the Stripe Price id a plan bills on for one cycle, or
// "" when that cycle is not purchasable (no id configured) or the cycle string
// is not one we recognise. The inverse of cycleOfPrice.
func priceIDForCycle(p Plan, cycle string) string {
	switch cycle {
	case "yearly":
		return p.StripePriceYearlyID
	case "monthly":
		return p.StripePriceMonthlyID
	default:
		return ""
	}
}

// planChangeEffect is when a requested plan change takes effect. It doubles as
// the `effective` field both billing endpoints return.
type planChangeEffect string

const (
	// effectNow applies the whole change immediately, prorated.
	effectNow planChangeEffect = "now"
	// effectPeriodEnd applies nothing now and switches at the period boundary.
	effectPeriodEnd planChangeEffect = "period_end"
	// effectComposite does both: an immediate stage now AND a second stage at
	// the period end that follows it. See resolvePlanChange.
	effectComposite planChangeEffect = "now_then_period_end"
)

// planChangeDecision is the resolved plan of action for one change request: what
// to bill now, and what to leave pending. Empty ImmediateCycle means "nothing is
// applied now"; an empty ScheduledPlanID means "nothing stays pending", which is
// also the value that CLEARS a previously recorded pending change.
type planChangeDecision struct {
	Effect planChangeEffect
	// ImmediateCycle is the cycle whose price the subscription moves to right
	// now. It is NOT always the cycle the user asked for — see the composite
	// case in resolvePlanChange.
	ImmediateCycle string
	// ScheduledPlanID / ScheduledCycle are the tier and cycle a pending
	// period-end stage will land on, persisted as the users.scheduled_* hint.
	ScheduledPlanID string
	ScheduledCycle  string
}

// resolvePlanChange decides how moving the subscription from cur (billed at
// curCycle) to target at wantCycle should be applied.
//
// Tier direction and cycle direction are two independent axes, and conflating
// them is what this function exists to prevent:
//
//   - Tier direction outranks cycle. A lower-priced tier is always a downgrade
//     (defer to period end) even when the new cycle costs more up front, and a
//     higher-priced tier is always an upgrade. Two distinct tiers that happen to
//     share a monthly price are neither, and apply now.
//   - On the SAME tier only the cycle moved. Lengthening the commitment
//     (monthly→yearly) is the upgrade and applies now; shortening it
//     (yearly→monthly) is the downgrade and waits for the period end, so the
//     year already paid for is not refunded or credited away.
//   - The combined case is the one that has no single-stage answer: a customer
//     on a YEARLY lower tier asking for a MONTHLY higher tier is upgrading the
//     tier (which must happen now) while shortening the cycle (which must not).
//     Collapsing that into one immediate yearly→monthly switch would credit away
//     the unused year and re-bill it as a month, so instead it becomes two
//     stages — immediately move to the target tier's YEARLY price, then schedule
//     the target's MONTHLY price at the period end that results. The customer
//     gets the tier they paid for now and the cycle they asked for at the only
//     boundary where switching to it costs them nothing.
//
// A composite needs the target's yearly price to exist; without it there is no
// immediate stage to bill, so the change degrades to a plain immediate one at
// the requested cycle rather than being refused. curCycle == "" is a row that
// predates the billing_cycle column: unknown, never composite.
//
// Kept in step with the front-end's plan-relation.ts.
func resolvePlanChange(cur Plan, curCycle string, target Plan, wantCycle string) planChangeDecision {
	immediate := planChangeDecision{Effect: effectNow, ImmediateCycle: wantCycle}
	deferred := planChangeDecision{Effect: effectPeriodEnd, ScheduledPlanID: target.ID, ScheduledCycle: wantCycle}

	if target.PriceMonthly != cur.PriceMonthly {
		if target.PriceMonthly < cur.PriceMonthly {
			return deferred // tier downgrade, whatever the cycle does
		}
		// Tier upgrade. Only a yearly→monthly request splits into two stages.
		if curCycle == "yearly" && wantCycle == "monthly" && target.StripePriceYearlyID != "" {
			return planChangeDecision{
				Effect:          effectComposite,
				ImmediateCycle:  "yearly",
				ScheduledPlanID: target.ID,
				ScheduledCycle:  "monthly",
			}
		}
		return immediate
	}
	if target.ID == cur.ID && wantCycle == "monthly" {
		return deferred // same tier, cycle shortened
	}
	return immediate
}

// handleBillingChangePlan switches an already-subscribed user's Stripe
// subscription to a different tier in place (in-app upgrade/downgrade), so they
// don't have to cancel + re-checkout. 404 when billing is unconfigured; 409 when
// the user has no Stripe-sourced subscription to change (they should use
// /api/billing/checkout instead); 400 for a free/unmapped target or the tier
// they're already on. The actual plan_id flip happens when Stripe delivers the
// resulting customer.subscription.updated to the webhook — the sole authority —
// so the client should refresh /api/me shortly after a 200.
func (s *Service) handleBillingChangePlan(w http.ResponseWriter, r *http.Request, u User) {
	if s.biller == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if s.refuseFrozenBilling(w, r, u) {
		return
	}
	var in struct {
		PlanID string `json:"planId"`
		Cycle  string `json:"cycle"` // "monthly" | "yearly"
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// An entitlement owned by another provider is refused here BEFORE the
	// Stripe-shaped check below, so the client is never told to go and buy a
	// second subscription. No Stripe call is made on this path.
	if s.refuseIfManagedElsewhere(w, r, u) {
		return
	}
	// Only a live Stripe-sourced subscription can be changed in place. Free users
	// (no customer), admin-comped accounts (plan_source=admin, which the webhook
	// must never override), AND already-canceled subscribers (plan_source stays
	// "stripe" after cancellation, so liveSubStatus is the authority) fall through
	// to a clear 409 that routes them back to checkout — not a 500 from Stripe's
	// "no live subscription".
	if u.StripeCustomerID == "" || u.PlanSource != "stripe" || !liveSubStatus(u.SubscriptionStatus) {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "no_active_subscription"})
		return
	}
	plan, ok, err := s.Store().GetPlan(r.Context(), in.PlanID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Cycle is a second, independent axis: the same tier billed yearly instead
	// of monthly is a real change, so "already on this plan" must compare BOTH.
	// Comparing the tier alone is what made an in-app monthly -> yearly switch
	// impossible — it 400'd before ever reaching Stripe.
	//
	// A stored cycle of '' (row predates the column) means we cannot compare
	// cycles at all. Fall back to the tier-only check there, so a legacy
	// subscriber clicking their current tier still gets a no-op instead of a
	// pointless Stripe write.
	wantCycle := "monthly"
	if in.Cycle == "yearly" {
		wantCycle = "yearly"
	}
	sameTier := plan.ID == u.PlanID
	if sameTier && (u.BillingCycle == "" || u.BillingCycle == wantCycle) {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "already_on_plan"})
		return
	}
	// Never trust the local scheduled marker as a no-op decision. It is a UI
	// projection, not Stripe's canonical state, and a stale marker must not turn a
	// repeated request into false success without touching Stripe.
	// Resolve the plan of action BEFORE the price id, because the composite
	// upgrade bills the target's YEARLY price now even though the request asked
	// for monthly. If the current plan can't be resolved, apply now.
	decision := planChangeDecision{Effect: effectNow, ImmediateCycle: wantCycle}
	if cur, ok, err := s.Store().GetPlan(r.Context(), u.PlanID); err == nil && ok {
		decision = resolvePlanChange(cur, u.BillingCycle, plan, wantCycle)
	}
	immediatePriceID := priceIDForCycle(plan, decision.ImmediateCycle)
	scheduledPriceID := priceIDForCycle(plan, decision.ScheduledCycle)
	// Every stage this change needs must be purchasable before we touch Stripe —
	// checking only the requested cycle would let a composite reach Stripe, apply
	// its immediate stage, and only then discover it has no second stage to
	// schedule.
	if (decision.Effect != effectPeriodEnd && immediatePriceID == "") ||
		(decision.Effect != effectNow && scheduledPriceID == "") {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "plan not purchasable"})
		return
	}

	// A pending downgrade's Stripe schedule manages the subscription and blocks a
	// fresh change. Release it unconditionally: ReleaseSchedule is a documented
	// no-op when nothing is scheduled, and relying on ScheduledPlanID != "" as the
	// guard is what wedged this path at 500 whenever the marker desynced from
	// Stripe (e.g. the same-tier-cycle premature-clear bug). One extra Stripe list
	// call on the change path is cheap insurance against that lockout.
	if decision.Effect != effectPeriodEnd {
		if err := s.biller.ReleaseSchedule(r.Context(), u.StripeCustomerID); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// Stripe no longer has the schedule, so its local projection must be
		// cleared before an immediate stage can fail or become payment-pending.
		// Otherwise a later same-target request can falsely return period_end
		// without recreating anything at Stripe.
		if err := s.Store().SetScheduledPlan(r.Context(), u.ID, "", ""); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	// Apply the stages the decision calls for. Stripe has no primitive that makes
	// the composite's two stages atomic, so the order is chosen to be safely
	// retryable instead: the immediate stage first (idempotent in the client, and
	// a no-op once the subscription already sits on the target yearly price), then
	// the schedule. A retry after a half-applied composite therefore re-runs the
	// immediate stage for free and finishes the scheduling.
	switch decision.Effect {
	case effectPeriodEnd:
		if err := s.biller.ScheduleDowngrade(r.Context(), u.StripeCustomerID, scheduledPriceID); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	case effectComposite:
		if err := s.biller.ChangeSubscriptionPlan(r.Context(), u.StripeCustomerID, immediatePriceID); err != nil {
			if errors.Is(err, ErrPaymentPending) {
				httpx.WriteJSON(w, http.StatusAccepted, map[string]string{
					"status": "payment_pending", "effective": "payment_pending",
					"requestedEffect": string(effectComposite),
				})
				return
			}
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if err := s.biller.ScheduleDowngrade(r.Context(), u.StripeCustomerID, scheduledPriceID); err != nil {
			// The immediate stage APPLIED and the second one did not. Report the
			// failure rather than a 200 that claims a cycle change which will never
			// fire, and leave the scheduled marker cleared so the DB does not
			// advertise a pending change Stripe knows nothing about. The user is on
			// the target tier billed yearly, which a retry converges from without
			// charging again.
			log.Printf("billing: composite change for user %s (customer %s): immediate %s applied but scheduling %s failed: %v",
				u.ID, u.StripeCustomerID, immediatePriceID, scheduledPriceID, err)
			httpx.WriteJSON(w, http.StatusBadGateway, map[string]any{
				"status": "partial", "effective": string(effectNow),
				"failedStage": "period_end", "retryable": true,
			})
			return
		}
	default:
		if err := s.biller.ChangeSubscriptionPlan(r.Context(), u.StripeCustomerID, immediatePriceID); err != nil {
			if errors.Is(err, ErrPaymentPending) {
				httpx.WriteJSON(w, http.StatusAccepted, map[string]string{
					"status": "payment_pending", "effective": "payment_pending",
					"requestedEffect": string(decision.Effect),
				})
				return
			}
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	// Record (or clear) the pending-change hint. Best-effort: the Stripe op
	// already succeeded, so don't fail the request if this write hiccups.
	_ = s.Store().SetScheduledPlan(r.Context(), u.ID, decision.ScheduledPlanID, decision.ScheduledCycle)
	out := map[string]string{"status": "ok", "effective": string(decision.Effect)}
	if decision.Effect == effectComposite {
		// Name both stages: the client cannot infer from "the user asked for pro
		// monthly" that they are on pro YEARLY until the period end.
		out["immediatePlanId"] = plan.ID
		out["immediateCycle"] = decision.ImmediateCycle
		out["scheduledPlanId"] = decision.ScheduledPlanID
		out["scheduledCycle"] = decision.ScheduledCycle
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// handleBillingPreview reports what changing to {planId,cycle} would do
// BEFORE the user commits, so the confirmation UI can show it: for an
// upgrade, the immediate prorated charge (via Stripe's upcoming-invoice
// preview) and the next full amount/cycle; for a downgrade, that it takes
// effect at period end with no charge now. Same auth/preconditions as
// change-plan (404 unconfigured, 409 no Stripe-sourced subscription); unlike
// change-plan this performs no state change and never touches Stripe except
// the read-only preview call. All amounts are cents.
func (s *Service) handleBillingPreview(w http.ResponseWriter, r *http.Request, u User) {
	if s.refuseFrozenBilling(w, r, u) {
		return
	}
	if s.biller == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		PlanID string `json:"planId"`
		Cycle  string `json:"cycle"` // "monthly" | "yearly"
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Same guards as change-plan, in the same order: another provider's
	// entitlement is named as such, and only then does the Stripe-shaped check
	// run. Preview performs no state change either way.
	if s.refuseIfManagedElsewhere(w, r, u) {
		return
	}
	// A canceled subscriber (plan_source still "stripe") gets a clean 409, not a
	// 500, when previewing a change with no live sub.
	if u.StripeCustomerID == "" || u.PlanSource != "stripe" || !liveSubStatus(u.SubscriptionStatus) {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "no_active_subscription"})
		return
	}
	plan, ok, err := s.Store().GetPlan(r.Context(), in.PlanID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	wantCycle := "monthly"
	if in.Cycle == "yearly" {
		wantCycle = "yearly"
	}
	nextAmount := plan.PriceMonthly
	if wantCycle == "yearly" {
		nextAmount = plan.PriceYearly
	}
	if priceIDForCycle(plan, wantCycle) == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "plan not purchasable"})
		return
	}
	// The same decision the real change would make, so the preview describes the
	// operation the user is actually about to authorize; it also decides whether
	// we bother asking Stripe for a proration preview at all. If the current plan
	// can't be resolved, apply now (matches handleBillingChangePlan's fallback).
	decision := planChangeDecision{Effect: effectNow, ImmediateCycle: wantCycle}
	if cur, ok, err := s.Store().GetPlan(r.Context(), u.PlanID); err == nil && ok {
		decision = resolvePlanChange(cur, u.BillingCycle, plan, wantCycle)
	}
	resp := map[string]any{
		"effective":            string(decision.Effect),
		"immediateChargeCents": int64(0),
		// immediateAdjustmentCents is the SIGNED proration: negative is a credit
		// the customer is owed. immediateChargeCents floors at zero (Stripe never
		// charges a negative invoice), so reporting only that renders a real credit
		// as "$0.00 due now" — true about the card, misleading about the money.
		"immediateAdjustmentCents": int64(0),
		"nextAmountCents":          nextAmount,
		"nextCycle":                wantCycle,
		"effectiveDate":            u.SubscriptionEnd,
	}
	if decision.Effect == effectPeriodEnd {
		// Nothing is applied now, so the current period end IS the effective date
		// and there is no proration to preview.
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}
	// A composite previews its IMMEDIATE stage — the target tier's yearly price —
	// because that is what gets charged today. resolvePlanChange only returns a
	// composite when that price exists, and for every other effect the immediate
	// cycle is the requested one, whose id priceID already proved non-empty.
	previewPriceID := priceIDForCycle(plan, decision.ImmediateCycle)
	pv, err := s.biller.PreviewChange(r.Context(), u.StripeCustomerID, previewPriceID)
	if err != nil {
		// Log the underlying Stripe error — the handler otherwise collapses it to a
		// bare 500 ("Couldn't load the change preview"), leaving no diagnostic trail.
		log.Printf("billing: preview change for user %s (customer %s, price %s): %v", u.ID, u.StripeCustomerID, previewPriceID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	resp["immediateChargeCents"] = pv.AmountDueCents
	resp["immediateAdjustmentCents"] = pv.TotalCents
	// Stripe's projection beats users.subscription_end, which is the CURRENT
	// anchor and goes stale the moment a change crosses billing intervals: a
	// monthly→yearly switch renews a year out, not at the old monthly boundary.
	// A 0 means Stripe gave us no usable period — keep the stored date rather
	// than showing the epoch.
	if pv.PeriodEnd > 0 {
		resp["effectiveDate"] = pv.PeriodEnd
	}
	if decision.Effect == effectComposite {
		// Both stages, named. effectiveDate above is the yearly renewal the
		// immediate stage creates, which is exactly when the monthly stage lands —
		// so nextAmountCents/nextCycle (the requested monthly plan) already
		// describe what bills on that date.
		resp["immediatePlanId"] = plan.ID
		resp["immediateCycle"] = decision.ImmediateCycle
		resp["immediateAmountCents"] = plan.PriceYearly
		resp["scheduledPlanId"] = decision.ScheduledPlanID
		resp["scheduledCycle"] = decision.ScheduledCycle
		resp["scheduledAmountCents"] = plan.PriceMonthly
	}
	httpx.WriteJSON(w, http.StatusOK, resp)
}

// handleBillingCancelScheduledChange cancels a pending period-end downgrade,
// releasing its Stripe schedule so the subscription stays on the current tier.
// 404 unconfigured; 409 for a non-Stripe subscription; a no-op 200 when nothing
// is scheduled.
func (s *Service) handleBillingCancelScheduledChange(w http.ResponseWriter, r *http.Request, u User) {
	if s.biller == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if s.refuseFrozenBilling(w, r, u) {
		return
	}
	if s.refuseIfManagedElsewhere(w, r, u) {
		return
	}
	if u.StripeCustomerID == "" || u.PlanSource != "stripe" {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "no_active_subscription"})
		return
	}
	if u.ScheduledPlanID == "" {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "none"})
		return
	}
	if err := s.biller.ReleaseSchedule(r.Context(), u.StripeCustomerID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	_ = s.Store().SetScheduledPlan(r.Context(), u.ID, "", "")
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// publicPlanView is the pricing UI's projection of a Plan: never includes the
// Stripe price ids or any other secret, only whether each billing cycle is
// currently purchasable (biller configured AND the tier has a price id).
type publicPlanView struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	StorageBytes       int64  `json:"storageBytes"`
	TrafficBytes       int64  `json:"trafficBytes"`
	RetentionSecs      int64  `json:"retentionSecs"`
	PriceMonthly       int64  `json:"priceMonthly"`
	PriceYearly        int64  `json:"priceYearly"`
	PurchasableMonthly bool   `json:"purchasableMonthly"`
	PurchasableYearly  bool   `json:"purchasableYearly"`
}

// handlePublicPlans serves the active billing tiers for the pricing UI.
// Unauthenticated; carries no secrets.
func (s *Service) handlePublicPlans(w http.ResponseWriter, r *http.Request) {
	plans, err := s.Store().ListPlans(r.Context())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]publicPlanView, 0, len(plans))
	for _, p := range plans {
		if !p.Active {
			continue
		}
		out = append(out, publicPlanView{
			ID:                 p.ID,
			Name:               p.Name,
			StorageBytes:       p.StorageBytes,
			TrafficBytes:       p.TrafficBytes,
			RetentionSecs:      p.RetentionSecs,
			PriceMonthly:       p.PriceMonthly,
			PriceYearly:        p.PriceYearly,
			PurchasableMonthly: s.biller != nil && p.StripePriceMonthlyID != "",
			PurchasableYearly:  s.biller != nil && p.StripePriceYearlyID != "",
		})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// maxWebhookBodyBytes caps the raw Stripe webhook payload we'll read before
// giving up; real Stripe event payloads are a few KB, so 1 MiB is generous
// headroom while still bounding memory against a malicious/broken sender.
const maxWebhookBodyBytes = 1 << 20

// reconcileSubscriptions is the authoritative double-checkout dedup. It reads the
// customer's LIVE active subscriptions from Stripe, keeps the EARLIEST one as
// canonical (deterministic → always converges to the same winner regardless of
// event order), cancels + FULLY REFUNDS every other active subscription, and
// writes the user's plan/status FROM the canonical one. It is stateless
// (recomputed from live state each call), so it needs no stored subscription id
// and is robust to out-of-order / redelivered events. Caller must have already
// excluded admin-comped users (plan_source=admin) — those never take a webhook.
//
// Every write is conditional on the Stripe source row still being `obs`, the
// copy the caller read BEFORE this call fetched its evidence (the live list):
// if the reconcile sweep or another webhook wrote the row meanwhile, the list
// may be older than what is stored, so nothing more is written and the caller
// re-observes and retries (see ApplyStripeSourceIfUnchanged).
//
// Returns:
//   - (true, false, nil)  → reconciled; caller writes 200.
//   - (false, false, nil) → the Stripe list call failed; the evidence is
//     unknown and the caller answers 5xx so Stripe redelivers.
//   - (false, true, nil)  → the row moved under us; caller re-observes/retries.
//   - (false, _, err)     → a store write failed; caller 500s so Stripe retries.
func (s *Service) reconcileSubscriptions(ctx context.Context, u User, evCreated int64, obs SubscriptionSource, obsExists bool) (bool, bool, error) {
	subs, err := s.biller.ListActiveSubscriptions(ctx, u.StripeCustomerID)
	if err != nil {
		log.Printf("billing: reconcile list subs failed for user %s: %v (evidence unknown; answering 5xx for redelivery)", u.ID, err)
		return false, false, nil
	}
	now := s.Now().Unix()
	if len(subs) == 0 {
		// No live subscription remains → free (a cancellation, or all lapsed).
		clear := ""
		res, err := s.Store().ApplyStripeSourceIfUnchanged(ctx, StripeSourceWrite{
			UserID: u.ID, Observed: obs, ObservedExists: obsExists, Bind: &clear,
			ExpectUser: true, UserSubscriptionID: u.StripeSubscriptionID, UserPlanSource: u.PlanSource,
			Event: &SourceEvent{UserID: u.ID, Provider: ProviderStripe, PlanID: "free", Status: "canceled", EventAt: evCreated, Now: now},
		})
		if err != nil {
			return false, false, err
		}
		if !res.Unchanged {
			return false, true, nil
		}
		if res.Apply.Applied && u.ScheduledPlanID != "" {
			_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
		}
		return true, false, nil
	}
	// Canonical = earliest created (tie-break by id so the winner is deterministic).
	canonical := subs[0]
	for _, sub := range subs[1:] {
		if sub.Created < canonical.Created || (sub.Created == canonical.Created && sub.ID < canonical.ID) {
			canonical = sub
		}
	}
	// Adopting the canonical is also where ownership is enforced, so it must
	// happen BEFORE the destructive half below. A subscription that cannot be
	// bound — it belongs to another account, or the store is failing — makes the
	// whole reconciliation wrong: the plan written from it would be justified by
	// somebody else's subscription, and the cancel+refund loop would have
	// already reaped this customer's real ones on the strength of that choice.
	// 500 → Stripe redelivers, and the conflict stays visible in its dashboard
	// rather than being ACKed into silence.
	bind := canonical.ID
	bound, err := s.Store().ApplyStripeSourceIfUnchanged(ctx, StripeSourceWrite{
		UserID: u.ID, Observed: obs, ObservedExists: obsExists, Bind: &bind,
		ExpectUser: true, UserSubscriptionID: u.StripeSubscriptionID, UserPlanSource: u.PlanSource,
		Now: now,
	})
	if err != nil {
		log.Printf("billing: reconcile could not adopt canonical subscription %s for user %s: %v (no cancel/refund performed)", canonical.ID, u.ID, err)
		return false, false, err
	}
	if !bound.Unchanged {
		return false, true, nil // nothing destructive has happened yet
	}
	// Every duplicate becomes a durable cancellation/refund responsibility before
	// the provider is mutated. A failure is returned so Stripe retries; the
	// periodic worker also keeps going after the duplicate leaves the active list.
	for _, sub := range subs {
		if sub.ID == canonical.ID {
			continue
		}
		if err := s.reconcileDuplicateSubscription(ctx, u, canonical.ID, sub.ID); err != nil {
			return false, false, err
		}
		log.Printf("billing: reconciled duplicate subscription %s for user %s (kept earliest %s)", sub.ID, u.ID, canonical.ID)
	}
	// Drive plan/status from the canonical subscription (not this event's sub).
	// A plan lookup that FAILS is not "unmapped price → free": it is unknown,
	// and must not downgrade the payer.
	planID, cycle := "free", ""
	p, ok, perr := s.Store().PlanByStripePrice(ctx, canonical.PriceID)
	if perr != nil {
		return false, false, perr
	}
	if ok {
		planID = p.ID
		cycle = cycleOfPrice(p, canonical.PriceID)
	}
	res, err := s.Store().ApplyStripeSourceIfUnchanged(ctx, StripeSourceWrite{
		UserID: u.ID, Observed: bound.After, ObservedExists: bound.AfterExists,
		ExpectUser: true, UserSubscriptionID: canonical.ID, UserPlanSource: u.PlanSource,
		Event: &SourceEvent{UserID: u.ID, Provider: ProviderStripe, PlanID: planID, Status: canonical.Status,
			Cycle: cycle, PeriodEnd: canonical.CurrentPeriodEnd, EventAt: evCreated, Now: now},
	})
	if err != nil {
		return false, false, err
	}
	if !res.Unchanged {
		return false, true, nil // duplicates are reaped; the retry recomputes the plan
	}
	if res.Apply.Applied && u.ScheduledPlanID != "" && planID == u.ScheduledPlanID &&
		(u.ScheduledCycle == "" || cycle == u.ScheduledCycle) {
		_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
	}
	return true, false, nil
}

// ReconcileStripeSubscriptions is the periodic safety net for a MISSED
// customer.subscription.deleted webhook. Webhooks are the primary path, but
// Stripe gives up retrying a 500'd/undeliverable event after ~3 days; a lost
// cancellation would then leave a canceled user on a paid plan forever. This
// sweep lists each Stripe-paid user's active subscriptions and, when none
// remain, downgrades them to free — the same transition the deleted webhook
// makes. Best-effort: a per-user Stripe/store error is logged and retried next
// sweep. Wired to a ticker in main.go.
//
// A downgrade is money-moving in the customer's disfavour, so it is taken only
// on evidence that is complete AND current, per user, in this order:
//
//  1. Read the user's Stripe source row (the observation). A row that is no
//     longer on a paid tier has already been handled by a webhook; skip.
//  2. Ask Stripe for the customer's live subscriptions, AFTER the observation.
//     Any error — including a subscription list that could not be walked to
//     its end — is "unknown" and skips the user; it never means "none".
//  3. Write the downgrade conditionally on the row still being exactly the
//     observation (ApplyStripeReconcileDowngrade). A webhook applied at any
//     point after step 1 changes the row, and the downgrade is dropped: the
//     webhook's newer evidence wins and the next sweep re-evaluates.
//
// The write is stamped on Stripe's clock — the latest ended_at in that same
// list, floored at the observation's event clock — never on the local clock.
// That makes a late-delivered event from before the cancellation stale (it
// cannot re-grant a tier nobody is paying for), while every event Stripe
// creates after the list still applies (see ApplyStripeReconcileDowngrade).
//
// The stamp is defence in depth, not the guarantee. What keeps a delayed or
// concurrent webhook from re-granting after this downgrade is the webhook
// side: every subscription.created/updated and invoice event is re-read from
// Stripe AFTER the account's Stripe row is observed, and its write commits
// only if that row (and the users fields its decision used) is still
// unchanged (ApplyStripeSourceIfUnchanged); otherwise it re-observes and
// re-reads. So a webhook's evidence is always newer than whatever this sweep
// committed before it — including a replay in the very second a subscription
// ended, or an unpaid/paused subscription that has no ended_at (the stamp then
// falls back to the observed clock). unpaid and paused are non-live here
// exactly as they are on the webhook path.
func (s *Service) ReconcileStripeSubscriptions(ctx context.Context) {
	if s.biller == nil {
		return
	}
	users, err := s.Store().ListStripePaidUsers(ctx)
	if err != nil {
		log.Printf("billing: reconcile sweep list users: %v", err)
		return
	}
	for _, u := range users {
		observed, ok, err := s.Store().GetSubscriptionSource(ctx, u.ID, ProviderStripe)
		if err != nil {
			log.Printf("billing: reconcile sweep read Stripe state for %s: %v", u.ID, err)
			continue
		}
		if !ok || observed.PlanID == "" || observed.PlanID == freePlanID {
			continue // already downgraded since the candidate list was taken
		}
		evidence, err := s.biller.ListSubscriptionEvidence(ctx, u.StripeCustomerID)
		if err != nil {
			log.Printf("billing: reconcile sweep list subs for %s: %v", u.ID, err)
			continue // unknown — leave the plan untouched, retry next sweep
		}
		if len(evidence.Live) > 0 {
			continue // still has a live subscription
		}
		// Paid plan but no live subscription → a cancellation whose webhook we
		// never received. Downgrade to free, mirroring customer.subscription.deleted.
		now := s.Now().Unix()
		endedAt := evidence.LatestEndedAt
		if endedAt > now+maxReconcileEndedAtSkew {
			// A subscription cannot have ended in the future: evidence that
			// contradicts itself is unknown, so this user is skipped, not
			// downgraded on a guessed clock.
			log.Printf("billing: reconcile sweep skipping %s: implausible ended_at %d (now %d)", u.ID, endedAt, now)
			continue
		}
		applied, err := s.Store().ApplyStripeReconcileDowngrade(ctx, observed, endedAt, now)
		if err != nil {
			log.Printf("billing: reconcile sweep downgrade %s: %v", u.ID, err)
			continue
		}
		if !applied {
			log.Printf("billing: reconcile sweep left user %s unchanged: Stripe state moved while the sweep was checking it", u.ID)
			continue
		}
		if u.ScheduledPlanID != "" {
			_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
		}
		log.Printf("billing: reconcile sweep downgraded user %s to free (no active Stripe subscription, missed deletion webhook)", u.ID)
	}
}

// maxReconcileEndedAtSkew is how far past the local clock a Stripe ended_at
// may lie and still be believed (clock skew between us and Stripe). Beyond it
// the evidence is treated as unknown and the user is not downgraded.
const maxReconcileEndedAtSkew = 300

// subEventIsStale reports whether a subscription webhook event (identified by
// its Stripe event.created) is older than the last one already applied to this
// user, and if so ACKs it with 200 so Stripe stops retrying. Stripe does not
// guarantee delivery order and retries any event we 500 on for up to 3 days, so
// without this an out-of-order or re-delivered older event could revert newer
// state (e.g. a late `past_due`/`deleted` dropping a since-recovered user off
// paid, or a retried older `active` restoring a lapsed one). Returns true when
// the caller must stop because a response was already written (stale → 200, or a
// store error → 500, which lets Stripe retry). created<=0 disables the guard
// (no usable timestamp) so the event applies as before.
//
// The clock is STRIPE'S OWN, read from Stripe's source row. Comparing against a
// clock shared with another provider would make Apple's event timestamps censor
// Stripe's events (and vice versa) — the two streams are unrelated and their
// timestamps are not comparable. As before, this is only a fast-path ACK: the
// authoritative guard is inside the same transaction as the write (see
// applySourceTx).
func (s *Service) subEventIsStale(ctx context.Context, w http.ResponseWriter, userID string, created int64) bool {
	if created <= 0 {
		return false
	}
	last, err := s.Store().LastSourceEventAt(ctx, userID, ProviderStripe)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return true
	}
	if created < last {
		w.WriteHeader(http.StatusOK)
		return true
	}
	return false
}

// handleStripeWebhook is the SOLE authority that grants or revokes a paid
// plan: it never trusts the client-side checkout redirect, only a verified
// Stripe event. 404 when billing is unconfigured; 400 ONLY on a signature
// verification failure (no state is touched, and no verification detail is
// leaked to the caller); otherwise every recognized event is a convergent
// last-writer state-set, so re-delivery of the same event is a no-op, and the
// handler always returns 200 quickly once dispatched (500 only on a genuine
// store error).
//
// plan_source='admin' is never overridden by a webhook: a subscription event
// for an admin-comped user still records status/period-end (for visibility in
// the admin console) but leaves plan_id untouched — see the admin-source
// branches below.
func stripeRefundLifecycleStatus(ev WebhookEvent) string {
	if ev.Type == "refund.failed" || ev.Status == "failed" || ev.Status == "canceled" {
		return "failed"
	}
	return ev.Status
}

func (s *Service) handleStripeWebhook(w http.ResponseWriter, r *http.Request) {
	if s.biller == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBodyBytes))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ev, err := s.biller.VerifyWebhook(body, r.Header.Get("Stripe-Signature"), s.Now().Unix())
	if err != nil {
		if errors.Is(err, ErrWebhookWrongMode) {
			// Correctly signed but wrong mode (test event on a live deployment or
			// vice versa): ACK so Stripe stops retrying, but take no action.
			w.WriteHeader(http.StatusOK)
			return
		}
		// Bad signature: reject without acting, without leaking why.
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if ev.EventID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	claim, err := s.Store().ClaimStripeWebhookEvent(r.Context(), ev.EventID, ev.Type, s.Now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if claim.State == StripeWebhookProcessed {
		w.WriteHeader(http.StatusOK)
		return
	}
	if claim.State == StripeWebhookInFlight {
		http.Error(w, "retry later", http.StatusServiceUnavailable)
		return
	}
	responseWriter := w
	tw := newStripeWebhookWriter()
	defer func() {
		panicked := recover()
		if panicked != nil {
			tw = newStripeWebhookWriter()
			http.Error(tw, "server error", http.StatusInternalServerError)
		}
		processed := tw.status < http.StatusInternalServerError
		failure := ""
		if !processed {
			failure = "handler failed"
		}
		if err := s.Store().FinishStripeWebhookEvent(context.Background(), ev.EventID, claim.Generation, processed, failure, s.Now().Unix()); err != nil {
			log.Printf("billing: finish Stripe event %s: %v", ev.EventID, err)
			http.Error(responseWriter, "server error", http.StatusInternalServerError)
			return
		}
		tw.flushTo(responseWriter)
		// A recovered panic is deliberately not rethrown: Stripe receives a 5xx
		// only after the ledger durably records failed, and can retry the event.
	}()
	w = tw

	ctx := r.Context()
	if ev.Type == "invoice.paid" {
		duplicateJournal, duplicateStoreOK := s.Store().(interface {
			HasDuplicateRefundSubscription(context.Context, string) (bool, error)
			AppendCanonicalDuplicatePaidInvoice(context.Context, CanonicalStripePaidInvoice, int64) error
		})
		if !duplicateStoreOK {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		duplicateExists, duplicateLookupErr := duplicateJournal.HasDuplicateRefundSubscription(ctx, ev.SubscriptionID)
		if duplicateLookupErr != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if duplicateExists {
			client, clientOK := s.biller.(*stripeClient)
			if !clientOK || ev.InvoiceID == "" || ev.CustomerID == "" {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			canonicalDuplicateInvoice, canonicalDuplicateErr := client.canonicalPaidInvoice(ctx, ev.InvoiceID)
			if canonicalDuplicateErr != nil || canonicalDuplicateInvoice.CustomerID != ev.CustomerID || canonicalDuplicateInvoice.SubscriptionID != ev.SubscriptionID {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if err := duplicateJournal.AppendCanonicalDuplicatePaidInvoice(ctx, canonicalDuplicateInvoice, s.Now().Unix()); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
		// Payment evidence must reach the deletion journal before canonical
		// subscription refresh, user lookup or billing-authority acquisition. Any
		// of those later gates may legitimately ACK/return 5xx (missing old
		// subscription, purged user, Apple/admin authority), but none may make a
		// paid invoice disappear from an already-deleted subject's refund chain.
		if ev.InvoiceID == "" || ev.CustomerID == "" {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		resources := []BillingDeletionResource{{
			Kind: "invoice", ID: ev.InvoiceID, InvoiceID: ev.InvoiceID,
			PaymentIntentID: ev.PaymentIntentID, Status: "invoice.paid_webhook",
		}}
		if ev.PaymentIntentID != "" {
			resources = append(resources, BillingDeletionResource{
				Kind: "payment_intent", ID: ev.PaymentIntentID,
				PaymentIntentID: ev.PaymentIntentID, InvoiceID: ev.InvoiceID,
				Status: "invoice.paid_webhook",
			})
		}
		if ev.ChargeID != "" {
			resources = append(resources, BillingDeletionResource{
				Kind: "charge", ID: ev.ChargeID, PaymentIntentID: ev.PaymentIntentID,
				InvoiceID: ev.InvoiceID, Status: "invoice.paid_webhook",
			})
		}
		journal, ok := s.Store().(interface {
			AppendStripePaidInvoiceDeletionHazards(context.Context, string, []BillingDeletionResource) error
		})
		if !ok {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if err := journal.AppendStripePaidInvoiceDeletionHazards(ctx, ev.CustomerID, resources); errors.Is(err, ErrPaidInvoiceNeedsCanonicalEpoch) {
			client, clientOK := s.biller.(*stripeClient)
			canonicalJournal, storeOK := s.Store().(interface {
				AppendCanonicalStripePaidInvoiceDeletionHazards(context.Context, CanonicalStripePaidInvoice, []BillingDeletionResource) error
			})
			if !clientOK || !storeOK {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			invoice, canonicalErr := client.canonicalPaidInvoice(ctx, ev.InvoiceID)
			if canonicalErr != nil || invoice.CustomerID != ev.CustomerID {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if invoice.AmountPaid > 0 {
				invoiceResource := BillingDeletionResource{Kind: "invoice", ID: invoice.InvoiceID, InvoiceID: invoice.InvoiceID, Status: "canonical_invoice_paid"}
				if !invoiceHasOneExclusivePaymentIntent(invoice) {
					invoiceResource.Manual = true
					invoiceResource.Status = "canonical_invoice_payments_require_manual_reconciliation"
				}
				resources = []BillingDeletionResource{invoiceResource}
				for _, payment := range invoice.Payments {
					if payment.PaymentIntentID == "" || payment.ChargeID == "" {
						continue
					}
					resources = append(resources,
						BillingDeletionResource{Kind: "payment_intent", ID: payment.PaymentIntentID, PaymentIntentID: payment.PaymentIntentID, InvoiceID: invoice.InvoiceID, Status: "canonical_invoice_paid", SuccessAt: payment.PaidAt},
						BillingDeletionResource{Kind: "charge", ID: payment.ChargeID, PaymentIntentID: payment.PaymentIntentID, InvoiceID: invoice.InvoiceID, Status: "canonical_invoice_paid", SuccessAt: payment.PaidAt})
				}
				if canonicalJournal.AppendCanonicalStripePaidInvoiceDeletionHazards(ctx, invoice, resources) != nil {
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				}
			}
		} else if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	if ev.Type == "refund.created" || ev.Type == "refund.updated" || ev.Type == "refund.failed" {
		if recorder, ok := s.Store().(interface {
			RecordStripeDeletionRefundLifecycle(context.Context, string, string, string, string, string, int64) error
		}); ok {
			refundStatus := stripeRefundLifecycleStatus(ev)
			if err := recorder.RecordStripeDeletionRefundLifecycle(ctx, ev.EventID, ev.RefundID, ev.MetadataDeletionActionID, ev.PaymentIntentID, refundStatus, ev.Created); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
	}

	if strings.HasPrefix(ev.Type, "invoice.") && ev.SubscriptionID == "" {
		// An invoice without a subscription may be a one-off invoice or a Stripe
		// event shape we do not understand. It is verified and ledgered, but it is
		// not canonical subscription evidence and therefore cannot change access.
		w.WriteHeader(http.StatusOK)
		return
	}
	if (ev.Type == "charge.succeeded" || ev.Type == "payment_intent.succeeded") && ev.CustomerID != "" {
		if journal, ok := s.Store().(interface {
			AppendStripeCustomerDeletionHazards(context.Context, string, []BillingDeletionResource) error
		}); ok {
			resources := []BillingDeletionResource{{Kind: "payment_intent", ID: ev.PaymentIntentID, Status: "webhook", SuccessAt: ev.Created}, {Kind: "charge", ID: ev.ChargeID, Status: "webhook", SuccessAt: ev.Created}}
			if err := journal.AppendStripeCustomerDeletionHazards(ctx, ev.CustomerID, resources); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
	}
	refresh := ev.Type == "customer.subscription.created" || ev.Type == "customer.subscription.updated" ||
		ev.Type == "invoice.paid" || ev.Type == "invoice.payment_failed" || ev.Type == "invoice.payment_action_required"
	// early is the Stripe source row of the customer's account as it stood
	// BEFORE the canonical retrieve below. The subscription branch writes only
	// if that row is still unchanged at write time (see stripeObservation).
	var early stripeObservation
	if refresh {
		if s.canonicalRefreshEnabled() && ev.CustomerID != "" {
			if pre, ok, err := s.Store().GetUserByStripeCustomer(ctx, ev.CustomerID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			} else if ok {
				if early, err = s.observeStripeSource(ctx, pre.ID); err != nil {
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				}
			}
		}
		switch s.refreshSubscriptionEvent(ctx, &ev) {
		case refreshFailed:
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		case refreshGone:
			w.WriteHeader(http.StatusOK)
			return
		}
		ev.Type = "customer.subscription.updated"
	}
	checkoutPaid := ev.Type == "checkout.session.async_payment_succeeded" || (ev.Type == "checkout.session.completed" && ev.PaymentStatus == "paid")
	if checkoutPaid {
		client, ok := s.biller.(*stripeClient)
		if !ok {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		chain, err := client.canonicalCheckoutPaymentChain(ctx, ev.CheckoutSessionID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if ev.CustomerID != "" && chain.CustomerID != "" && ev.CustomerID != chain.CustomerID {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if ev.ClientRefUserID != "" && chain.UserID != "" && ev.ClientRefUserID != chain.UserID {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if ev.MetadataBillingAttemptID != "" && chain.BillingAttemptID != "" && ev.MetadataBillingAttemptID != chain.BillingAttemptID {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if ev.CustomerID == "" {
			ev.CustomerID = chain.CustomerID
		}
		if ev.ClientRefUserID == "" {
			ev.ClientRefUserID = chain.UserID
		}
		if ev.MetadataBillingAttemptID == "" {
			ev.MetadataBillingAttemptID = chain.BillingAttemptID
		}
		if ev.SubscriptionID == "" {
			ev.SubscriptionID = chain.SubscriptionID
		}
		ev.InvoiceID, ev.PaymentIntentID, ev.ChargeID = chain.InvoiceID, chain.PaymentIntentID, chain.ChargeID
	}
	switch ev.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired":
		// Plan assignment is deferred to the accompanying
		// customer.subscription.* event Stripe always sends alongside this
		// one; here we only bind the newly-created (or reused) customer id.
		// Payment facts are journaled before account/authority binding. A late
		// payment belongs to its captured deletion epoch even if the account has
		// since reactivated under a different current billing authority.
		successAt := int64(0)
		if checkoutPaid {
			successAt = ev.Created
		}
		if journal, ok := s.Store().(interface {
			AppendStripeCustomerDeletionHazards(context.Context, string, []BillingDeletionResource) error
		}); ok {
			if err := journal.AppendStripeCustomerDeletionHazards(ctx, ev.CustomerID, []BillingDeletionResource{{Kind: "invoice", ID: ev.InvoiceID, Status: "webhook"}, {Kind: "payment_intent", ID: ev.PaymentIntentID, Status: "webhook", SuccessAt: successAt}, {Kind: "charge", ID: ev.ChargeID, PaymentIntentID: ev.PaymentIntentID, Status: "webhook", SuccessAt: successAt}}); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
		if ev.CheckoutSessionID != "" {
			if journal, ok := s.Store().(interface {
				AppendStripeActiveAccountDeletionHazardForCustomer(context.Context, string, string, BillingDeletionResource) (bool, error)
			}); ok {
				recorded, err := journal.AppendStripeActiveAccountDeletionHazardForCustomer(ctx, ev.CustomerID, ev.ClientRefUserID, checkoutDeletionObservation(ev))
				if err != nil {
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				}
				if recorded {
					w.WriteHeader(http.StatusOK)
					return
				}
			}
		}
		if ev.ClientRefUserID != "" {
			if _, err := acquireStoreBillingAuthority(ctx, s.Store(), BillingAuthorityRequest{UserID: ev.ClientRefUserID, Provider: ProviderStripe, Now: s.Now().Unix()}); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			// CAS bind, not an unconditional overwrite: if the user already has a
			// customer, keep it. An unconditional write would let a second
			// customer's event flip the binding (duplicate-customer takeover of the
			// column); the reconcile path reaps duplicate subscriptions instead.
			if _, err := s.Store().SetUserStripeCustomerIfEmpty(ctx, ev.ClientRefUserID, ev.CustomerID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			// Which checkout events may skip the bind is decided by the event
			// TYPE together with an empty subscription, not by a generic "is
			// the subscription id empty" test. Stripe delivers
			// checkout.session.expired and .async_payment_failed carrying this
			// product's client reference and attempt metadata, but when the
			// event itself carries no subscription there is nothing to bind
			// yet: this event observed no subscription. So ACK the observation
			// and leave the attempt untouched, rather than treating it as a
			// failed bind; the previous unconditional bind returned 500 and
			// made Stripe retry an event it could never satisfy. A later event
			// on the same session (an async payment that succeeds after an
			// earlier failure) still binds through this same path once it
			// carries a subscription. checkout.session.completed and
			// .async_payment_succeeded assert a purchase, so a missing
			// subscription on those stays a loud failure. Either observation
			// that does carry a real subscription still binds normally.
			unbindableObservation := ev.SubscriptionID == "" &&
				(ev.Type == "checkout.session.expired" || ev.Type == "checkout.session.async_payment_failed")
			if ev.MetadataBillingAttemptID != "" && !unbindableObservation {
				binder, ok := s.Store().(interface {
					BindStripePurchaseSubscription(context.Context, string, string, string, string) error
				})
				if !ok || binder.BindStripePurchaseSubscription(ctx, ev.ClientRefUserID, ev.MetadataBillingAttemptID, ev.CheckoutSessionID, ev.SubscriptionID) != nil {
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				}
			}
		}
		w.WriteHeader(http.StatusOK)

	case "customer.subscription.created", "customer.subscription.updated":
		u, ok, err := s.Store().GetUserByStripeCustomer(ctx, ev.CustomerID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			// Unknown customer: either a stray/test-mode event, or a race
			// where this subscription event arrived before the
			// checkout.session.completed that normally does the bind —
			// Stripe does not guarantee delivery order. Our checkout always
			// stamps subscription_data[metadata][user_id], so fall back to
			// binding via that metadata before giving up.
			if ev.MetadataUserID == "" {
				w.WriteHeader(http.StatusOK)
				return
			}
			u, err = s.Store().GetUserByID(ctx, ev.MetadataUserID)
			if err != nil {
				if errors.Is(err, ErrNotFound) {
					// Metadata referenced a user that no longer exists —
					// nothing to assign a plan to.
					w.WriteHeader(http.StatusOK)
					return
				}
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if _, err := acquireStoreBillingAuthority(ctx, s.Store(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: s.Now().Unix()}); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			// Bind only after provider authority. An admin/Apple conflict must
			// not leave a Stripe customer half-attached to the account.
			if _, err := s.Store().SetUserStripeCustomerIfEmpty(ctx, ev.MetadataUserID, ev.CustomerID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		} else if _, err := acquireStoreBillingAuthority(ctx, s.Store(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: s.Now().Unix()}); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if ev.SubscriptionID != "" {
			if journal, ok := s.Store().(interface {
				AppendStripeDeletionHazard(context.Context, string, BillingDeletionResource) error
			}); ok {
				if err := journal.AppendStripeDeletionHazard(ctx, u.ID, BillingDeletionResource{Kind: "subscription", ID: ev.SubscriptionID, AttemptID: ev.MetadataBillingAttemptID, CustomerID: ev.CustomerID, Status: "webhook", ProviderCreatedAt: ev.Created}); err != nil {
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				}
			}
		}
		if journal, ok := s.Store().(interface {
			AppendStripeCustomerDeletionHazards(context.Context, string, []BillingDeletionResource) error
		}); ok {
			if err := journal.AppendStripeCustomerDeletionHazards(ctx, ev.CustomerID, []BillingDeletionResource{{Kind: "invoice", ID: ev.InvoiceID, Status: "webhook"}, {Kind: "payment_intent", ID: ev.PaymentIntentID, Status: "webhook"}, {Kind: "charge", ID: ev.ChargeID, Status: "webhook"}}); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
		// Ordering guard: drop an out-of-order / re-delivered event older than the
		// last one applied, so it cannot revert newer subscription state.
		if s.subEventIsStale(ctx, w, u.ID, ev.Created) {
			return
		}
		// Every write below is conditional on the Stripe source row being what
		// it was BEFORE this event's Stripe evidence was fetched. The early
		// observation qualifies only for the account it was taken for; any
		// other case (metadata-bound account, a lost race) observes afresh and
		// then re-fetches, so the evidence is always newer than the observation.
		obs := early
		for attempt := 0; ; attempt++ {
			if attempt >= maxStripeApplyAttempts {
				log.Printf("billing: Stripe state for user %s kept moving during event %s; leaving it for redelivery", u.ID, ev.EventID)
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if attempt > 0 || obs.userID != u.ID {
				var err error
				if obs, u, err = s.observeStripeAccount(ctx, u.ID); err != nil {
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				}
				switch s.refreshSubscriptionEvent(ctx, &ev) {
				case refreshFailed:
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				case refreshGone:
					w.WriteHeader(http.StatusOK)
					return
				}
			}
			switch s.applySubscriptionEvent(ctx, w, u, ev, obs) {
			case applyDone:
				return
			case applyRetry:
				continue
			}
		}

	case "customer.subscription.deleted":
		u, ok, err := s.Store().GetUserByStripeCustomer(ctx, ev.CustomerID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			w.WriteHeader(http.StatusOK)
			return
		}
		if s.subEventIsStale(ctx, w, u.ID, ev.Created) {
			return
		}
		if u.PlanSource == "admin" {
			// Admin comp wins: the projection records the cancellation for
			// visibility and keeps the comped plan, while Stripe's own row goes to
			// free/canceled so a later fallback is truthful.
			if err := s.applyStripeLifecycle(ctx, u.ID, "free", "", ev); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		// The binding check, the freshness check, the binding clear and the
		// free/canceled write are ONE conditional write, retried on a moved row:
		// clearing first and applying second let a deletion that turned out to
		// be stale erase the binding of a newer subscription that committed in
		// between, leaving a paid account with no canonical subscription.
		for attempt := 0; ; attempt++ {
			if attempt >= maxStripeApplyAttempts {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			obs, fresh, err := s.observeStripeAccount(ctx, u.ID)
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			u = fresh
			if obs.staleFor(ev.Created) {
				w.WriteHeader(http.StatusOK)
				return
			}
			// A DUPLICATE's deletion (a subscription we reaped) must NOT drop the
			// user: the canonical is still active. No Stripe call — compare ids.
			if u.StripeSubscriptionID != "" && ev.SubscriptionID != "" && ev.SubscriptionID != u.StripeSubscriptionID {
				w.WriteHeader(http.StatusOK)
				return
			}
			if u.PlanSource == "admin" {
				// The comp arrived meanwhile: re-run the handler's admin rule on
				// redelivery rather than clearing a binding under it.
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			// The canonical (or an unknown) subscription was canceled → free + clear it.
			clear := ""
			res, err := s.Store().ApplyStripeSourceIfUnchanged(ctx, StripeSourceWrite{
				UserID: u.ID, Observed: obs.row, ObservedExists: obs.exists, Bind: &clear,
				ExpectUser: true, UserSubscriptionID: u.StripeSubscriptionID, UserPlanSource: u.PlanSource,
				// The same event applyStripeLifecycle wrote before (the row keeps
				// recording which subscription ended; attempts converge).
				Event: &SourceEvent{UserID: u.ID, Provider: ProviderStripe, PlanID: "free", Status: ev.Status,
					PeriodEnd: ev.CurrentPeriodEnd, ExternalID: ev.SubscriptionID, EventAt: ev.Created,
					Now: s.Now().Unix(), BillingAttemptID: ev.MetadataBillingAttemptID, BillingProductID: ev.PriceID},
			})
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if !res.Unchanged {
				continue
			}
			if res.Apply.Applied && u.ScheduledPlanID != "" {
				_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
			}
			w.WriteHeader(http.StatusOK)
			return
		}

	case "charge.refunded", "refund.created", "refund.updated", "refund.failed":
		// Refund is an audit/payment event, not a subscription cancellation.
		w.WriteHeader(http.StatusOK)
	default:
		// Unrecognized event type: acknowledge so Stripe doesn't retry.
		w.WriteHeader(http.StatusOK)
	}
}

func checkoutDeletionObservation(ev WebhookEvent) BillingDeletionResource {
	// Webhooks report observations, not provider-safe deletion terminals. An
	// expired Session can retain a live recovery URL, and an asynchronous failure
	// can still reference payment objects that require canonical reconciliation.
	r := BillingDeletionResource{
		Kind: "checkout_session", ID: ev.CheckoutSessionID,
		AttemptID: ev.MetadataBillingAttemptID, CustomerID: ev.CustomerID,
		Status: ev.Type, ProviderCreatedAt: ev.Created,
	}
	if ev.Type == "checkout.session.async_payment_failed" {
		r.AsyncFailureAt = ev.Created
	}
	if ev.Type == "checkout.session.async_payment_succeeded" {
		r.AsyncSuccessAt = ev.Created
	}
	return r
}

// stripeObservation is a user's Stripe source row as read at one instant
// (exists=false: no row). userID="" means nothing was observed.
type stripeObservation struct {
	userID string
	row    SubscriptionSource
	exists bool
}

func (s *Service) observeStripeSource(ctx context.Context, userID string) (stripeObservation, error) {
	row, ok, err := s.Store().GetSubscriptionSource(ctx, userID, ProviderStripe)
	if err != nil {
		return stripeObservation{}, err
	}
	return stripeObservation{userID: userID, row: row, exists: ok}, nil
}

// observeStripeAccount reads the account's Stripe source row and THEN its
// users row, so the users fields a decision uses are never older than the
// observation (the conditional write re-checks both).
func (s *Service) observeStripeAccount(ctx context.Context, userID string) (stripeObservation, User, error) {
	obs, err := s.observeStripeSource(ctx, userID)
	if err != nil {
		return stripeObservation{}, User{}, err
	}
	stripeWebhookSeam("observed", userID)
	u, err := s.Store().GetUserByID(ctx, userID)
	if err != nil {
		return stripeObservation{}, User{}, err
	}
	return obs, u, nil
}

// staleFor reports whether an event created at `created` is older than the
// last Stripe event already applied to the observed row — the transactional
// replay rule (strictly older), checked BEFORE any bind or destructive dedup.
func (o stripeObservation) staleFor(created int64) bool {
	return o.exists && created > 0 && created < o.row.EventAt
}

// stripeWebhookSeam is a test seam: tests replace it to land concurrent
// writes at a named point of the webhook's read/decide/write sequence. It is
// a no-op in production.
var stripeWebhookSeam = func(point, userID string) {}

// maxStripeApplyAttempts bounds how often one webhook re-observes and
// re-fetches when its conditional write keeps losing to concurrent writers
// (several events for one new subscription arrive together). Past it the
// event is left to Stripe's own redelivery.
const maxStripeApplyAttempts = 3

func (s *Service) canonicalRefreshEnabled() bool {
	client, ok := s.biller.(*stripeClient)
	return ok && client.canonicalWebhookRefresh
}

type refreshOutcome int

const (
	refreshOK     refreshOutcome = iota
	refreshGone                  // ACK 200, apply nothing
	refreshFailed                // 500, apply nothing; Stripe redelivers
)

// refreshSubscriptionEvent replaces a subscription/invoice event's claims
// with Stripe's CURRENT subscription object. With refresh on the event's own
// payload is never the evidence: it may be a late retry or a dashboard resend
// describing a state Stripe has since left (a canceled, unpaid or paused
// subscription's old `active`). Evidence that is partial is therefore unknown
// (refreshFailed), never a reason to fall back to the payload:
//   - the object must be this subscription, for this event's customer, with a
//     documented status;
//   - an active/trialing object must name the price it pays for — without one
//     the tier would resolve to free and downgrade a payer.
//
// An event that names no subscription at all is refreshGone: it carries no
// canonical evidence, and no redelivery can change that, so it is ACKed and
// ignored exactly like the subscription-less invoice branch (a 5xx would only
// buy three days of futile retries). A retrieve 404 is refreshGone too.
func (s *Service) refreshSubscriptionEvent(ctx context.Context, ev *WebhookEvent) refreshOutcome {
	if !s.canonicalRefreshEnabled() {
		return refreshOK
	}
	client := s.biller.(*stripeClient)
	if ev.SubscriptionID == "" {
		log.Printf("billing: ignoring %s event %s: it names no subscription", ev.Type, ev.EventID)
		return refreshGone
	}
	info, missing, err := client.canonicalSubscription(ctx, ev.SubscriptionID)
	if err != nil {
		return refreshFailed
	}
	if missing {
		return refreshGone
	}
	unusable := info.ID != ev.SubscriptionID || !knownStripeSubStatus(info.Status) ||
		info.CustomerID == "" || (ev.CustomerID != "" && info.CustomerID != ev.CustomerID) ||
		((info.Status == "active" || info.Status == "trialing") && info.PriceID == "")
	if unusable {
		log.Printf("billing: canonical refresh of subscription %s returned an unusable object (id %q, customer %q, status %q, price %q)", ev.SubscriptionID, info.ID, info.CustomerID, info.Status, info.PriceID)
		return refreshFailed
	}
	ev.SubscriptionID, ev.CustomerID, ev.PriceID, ev.Status, ev.CurrentPeriodEnd = info.ID, info.CustomerID, info.PriceID, info.Status, info.CurrentPeriodEnd
	ev.MetadataBillingAttemptID = info.BillingAttemptID
	ev.MetadataUserID = info.MetadataUserID
	return refreshOK
}

type applyOutcome int

const (
	applyDone  applyOutcome = iota // response written
	applyRetry                     // the row moved: re-observe, re-fetch, retry
)

// applySubscriptionEvent decides and writes one (refreshed) subscription
// event for account u, conditional on obs. It writes the HTTP response itself
// unless it returns applyRetry.
func (s *Service) applySubscriptionEvent(ctx context.Context, w http.ResponseWriter, u User, ev WebhookEvent, obs stripeObservation) applyOutcome {
	// Freshness against the row this attempt observed, BEFORE any bind or
	// destructive dedup: on a retry a newer event may have landed, and an
	// event that has become stale must not reap or re-bind subscriptions
	// whose entitlement it can no longer write.
	if obs.staleFor(ev.Created) {
		w.WriteHeader(http.StatusOK)
		return applyDone
	}
	// Resolve what THIS event says Stripe is billing, before the admin branch:
	// an admin-comped account still has its Stripe subscription recorded on
	// Stripe's own source row, so if the comp is ever lifted the fallback is
	// real state rather than a guess.
	planID := "free"
	cycle := ""
	if ev.Status == "active" || ev.Status == "trialing" {
		if p, ok, err := s.Store().PlanByStripePrice(ctx, ev.PriceID); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return applyDone
		} else if ok {
			planID = p.ID
			cycle = cycleOfPrice(p, ev.PriceID)
		}
	}
	if ev.Status == "past_due" {
		// Keep the tier STRIPE was paying for, from the protected source row —
		// never users.plan_id, which is the effective projection (it may be an
		// Apple or admin tier) and may be older than the observation.
		planID, cycle = freePlanID, ""
		if obs.exists && obs.row.PlanID != "" {
			planID, cycle = obs.row.PlanID, obs.row.Cycle
		}
	}
	if u.PlanSource == "admin" {
		// Admin comp wins: the projection records status/end for visibility
		// and leaves plan_id alone (see resolveEffective's first rule), so a
		// webhook still cannot change a plan out from under an admin grant.
		// The dedup/reconcile path below is skipped for the same reason it
		// always was: reconcileSubscriptions cancels and refunds real
		// subscriptions, and a comped account is not its responsibility.
		if err := s.applyStripeLifecycle(ctx, u.ID, planID, cycle, ev); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return applyDone
		}
		w.WriteHeader(http.StatusOK)
		return applyDone
	}
	// Double-checkout dedup, done SURGICALLY so the common path makes no Stripe
	// call: only when a DIFFERENT subscription id than the recorded canonical
	// shows up (a second checkout opened a second subscription) do we reconcile
	// from live Stripe state — keep the earliest, cancel+refund the rest. An
	// event for the canonical (or the first-ever subscription) takes the normal
	// per-event path below.
	var bind *string
	externalID := ev.SubscriptionID
	if u.StripeSubscriptionID != "" && ev.SubscriptionID != "" && ev.SubscriptionID != u.StripeSubscriptionID {
		done, lost, err := s.reconcileSubscriptions(ctx, u, ev.Created, obs.row, obs.exists)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return applyDone
		}
		if lost {
			return applyRetry
		}
		if done {
			w.WriteHeader(http.StatusOK)
			return applyDone
		}
		// The live list failed. A non-canonical subscription's event cannot be
		// applied on its own: which subscription pays is exactly what the list
		// decides. Unknown → 5xx, Stripe redelivers.
		http.Error(w, "server error", http.StatusInternalServerError)
		return applyDone
	} else if u.StripeSubscriptionID == "" && ev.SubscriptionID != "" {
		// First subscription seen → adopt it as canonical (no Stripe call) —
		// but only a LIVE one. A canceled/unpaid/paused subscription pays for
		// nothing, and binding it would make it the account's canonical
		// subscription (e.g. a replayed event for the subscription the sweep
		// just unbound). Its state is still recorded, unbound.
		//
		// Adoption is where ownership is ENFORCED, so it fails closed and the
		// grant does not happen. A subscription already bound to another
		// account cannot be allowed to justify this account's tier: that is a
		// free paid plan, and one that can never be canceled or refunded
		// against the user holding it. 500 rather than a 200 ACK — retrying
		// will not resolve a genuine conflict, but it keeps the event visible
		// as a failing delivery in Stripe instead of silently discarding the
		// only signal that two accounts disagree about one subscription. The
		// reconcile sweep is the backstop once Stripe gives up retrying.
		if liveSubStatus(ev.Status) {
			id := ev.SubscriptionID
			bind = &id
		} else {
			externalID = ""
		}
	}
	res, err := s.Store().ApplyStripeSourceIfUnchanged(ctx, StripeSourceWrite{
		UserID: u.ID, Observed: obs.row, ObservedExists: obs.exists, Bind: bind,
		ExpectUser: true, UserSubscriptionID: u.StripeSubscriptionID, UserPlanSource: u.PlanSource,
		Event: &SourceEvent{
			UserID: u.ID, Provider: ProviderStripe, PlanID: planID, Status: ev.Status,
			Cycle: cycle, PeriodEnd: ev.CurrentPeriodEnd, ExternalID: externalID,
			EventAt: ev.Created, Now: s.Now().Unix(), BillingAttemptID: ev.MetadataBillingAttemptID,
			BillingProductID: ev.PriceID,
		},
	})
	if err != nil {
		if bind != nil && errors.Is(err, ErrExternalSubscriptionOwned) {
			log.Printf("billing: refusing to adopt subscription %s for user %s: it is already owned by another account", ev.SubscriptionID, u.ID)
		} else if bind != nil {
			log.Printf("billing: adopting canonical subscription %s for user %s failed: %v", ev.SubscriptionID, u.ID, err)
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return applyDone
	}
	if !res.Unchanged {
		return applyRetry
	}
	// A pending downgrade has landed once BOTH the tier and the cycle reach what
	// we scheduled — clear the UI hint. Matching the tier alone was wrong for a
	// same-tier cycle downgrade (yearly→monthly on one plan): scheduled_plan_id
	// equals the current tier, so the intermediate schedule-creation event
	// (price still the old cycle) matched and cleared the marker seconds after
	// it was set, wedging later in-app plan changes at 500. Requiring the cycle
	// to match too defers the clear to the real period-end transition. A ''
	// scheduled cycle is a legacy row → fall back to tier-only. Best-effort.
	if res.Apply.Applied && u.ScheduledPlanID != "" && planID == u.ScheduledPlanID &&
		(u.ScheduledCycle == "" || cycle == u.ScheduledCycle) {
		_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
	}
	w.WriteHeader(http.StatusOK)
	return applyDone
}

func (s *Service) applyStripeLifecycle(ctx context.Context, userID, planID, cycle string, ev WebhookEvent) error {
	_, err := s.Store().ApplyAuthorizedStripeLifecycle(ctx, SourceEvent{
		UserID: userID, Provider: ProviderStripe, PlanID: planID, Status: ev.Status,
		Cycle: cycle, PeriodEnd: ev.CurrentPeriodEnd, ExternalID: ev.SubscriptionID,
		EventAt: ev.Created, Now: s.Now().Unix(), BillingAttemptID: ev.MetadataBillingAttemptID,
		BillingProductID: ev.PriceID,
	})
	return err
}

type stripeWebhookWriter struct {
	header      http.Header
	status      int
	wroteHeader bool
	body        bytes.Buffer
}

func newStripeWebhookWriter() *stripeWebhookWriter {
	return &stripeWebhookWriter{header: make(http.Header), status: http.StatusOK}
}
func (w *stripeWebhookWriter) Header() http.Header { return w.header }
func (w *stripeWebhookWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
}
func (w *stripeWebhookWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.wroteHeader = true
		w.status = http.StatusOK
	}
	return w.body.Write(p)
}
func (w *stripeWebhookWriter) flushTo(dst http.ResponseWriter) {
	for key, values := range w.header {
		for _, value := range values {
			dst.Header().Add(key, value)
		}
	}
	dst.WriteHeader(w.status)
	_, _ = dst.Write(w.body.Bytes())
}
