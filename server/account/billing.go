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

// clearCanonicalSubscription drops the recorded canonical subscription id on a
// path that is about to write the user to free anyway.
//
// This is the one SetUserStripeSubscription call whose failure is genuinely
// proportionate to log rather than propagate. Clearing can never hit the
// ownership check (an empty id claims nothing), so the only failure left is the
// store itself — and the very next statement on every one of these paths writes
// to that same store, which is what turns a real outage into the 500 that makes
// Stripe redeliver. What is left behind meanwhile is a stale canonical id on a
// free account: it grants nothing, and the next event for any subscription
// either takes the normal path or re-runs reconciliation, both of which
// converge. Refusing to downgrade over it would be the worse trade — a canceled
// subscriber left on a paid tier.
func (s *Service) clearCanonicalSubscription(ctx context.Context, userID string) {
	if err := s.Store().SetUserStripeSubscription(ctx, userID, ""); err != nil {
		log.Printf("billing: clearing the canonical subscription id for user %s failed: %v (the downgrade still applies)", userID, err)
	}
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
// Returns:
//   - (true, nil)  → reconciled; caller writes 200.
//   - (false, nil) → the Stripe list call failed; caller falls back to the
//     single-event path rather than dropping the webhook.
//   - (false, err) → a store write failed; caller 500s so Stripe retries.
func (s *Service) reconcileSubscriptions(ctx context.Context, u User, evCreated int64) (bool, error) {
	subs, err := s.biller.ListActiveSubscriptions(ctx, u.StripeCustomerID)
	if err != nil {
		log.Printf("billing: reconcile list subs failed for user %s: %v (falling back to per-event)", u.ID, err)
		return false, nil
	}
	if len(subs) == 0 {
		// No live subscription remains → free (a cancellation, or all lapsed).
		s.clearCanonicalSubscription(ctx, u.ID)
		if err := s.Store().SetUserSubscription(ctx, u.ID, "free", "canceled", 0, "stripe", "", s.Now().Unix(), evCreated); err != nil {
			return false, err
		}
		if u.ScheduledPlanID != "" {
			_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
		}
		return true, nil
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
	if err := s.Store().SetUserStripeSubscription(ctx, u.ID, canonical.ID); err != nil {
		log.Printf("billing: reconcile could not adopt canonical subscription %s for user %s: %v (no cancel/refund performed)", canonical.ID, u.ID, err)
		return false, err
	}
	// Cancel + fully refund every OTHER active subscription — the duplicates a
	// double-checkout opened. Best-effort per sub: a failure is logged and the next
	// event (idempotently) re-runs this; the duplicate is at least visible in the
	// single customer's Portal meanwhile.
	for _, sub := range subs {
		if sub.ID == canonical.ID {
			continue
		}
		if cerr := s.biller.CancelSubscription(ctx, sub.ID, true); cerr != nil {
			log.Printf("billing: cancel+refund duplicate sub %s for user %s failed: %v", sub.ID, u.ID, cerr)
		} else {
			log.Printf("billing: canceled+refunded duplicate subscription %s for user %s (kept earliest %s)", sub.ID, u.ID, canonical.ID)
		}
	}
	// Drive plan/status from the canonical subscription (not this event's sub).
	planID, cycle := "free", ""
	if p, ok, perr := s.Store().PlanByStripePrice(ctx, canonical.PriceID); perr == nil && ok {
		planID = p.ID
		cycle = cycleOfPrice(p, canonical.PriceID)
	}
	if err := s.Store().SetUserSubscription(ctx, u.ID, planID, canonical.Status, canonical.CurrentPeriodEnd, "stripe", cycle, s.Now().Unix(), evCreated); err != nil {
		return false, err
	}
	if u.ScheduledPlanID != "" && planID == u.ScheduledPlanID &&
		(u.ScheduledCycle == "" || cycle == u.ScheduledCycle) {
		_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
	}
	return true, nil
}

// ReconcileStripeSubscriptions is the periodic safety net for a MISSED
// customer.subscription.deleted webhook. Webhooks are the primary path, but
// Stripe gives up retrying a 500'd/undeliverable event after ~3 days; a lost
// cancellation would then leave a canceled user on a paid plan forever. This
// sweep lists each Stripe-paid user's active subscriptions and, when none
// remain, downgrades them to free — the same transition the deleted webhook
// makes. The live Stripe query is authoritative, so a user who re-subscribed
// between cancellation and this sweep still shows an active sub and is left
// alone. Best-effort: a per-user Stripe/store error is logged and retried next
// sweep. Wired to a ticker in main.go.
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
		subs, err := s.biller.ListActiveSubscriptions(ctx, u.StripeCustomerID)
		if err != nil {
			log.Printf("billing: reconcile sweep list subs for %s: %v", u.ID, err)
			continue // transient — leave the plan untouched, retry next sweep
		}
		if len(subs) > 0 {
			continue // still has a live subscription
		}
		// Paid plan but no live subscription → a cancellation whose webhook we
		// never received. Downgrade to free, mirroring customer.subscription.deleted.
		now := s.Now().Unix()
		s.clearCanonicalSubscription(ctx, u.ID)
		if err := s.Store().SetUserSubscription(ctx, u.ID, "free", "canceled", 0, "stripe", "", now, now); err != nil {
			log.Printf("billing: reconcile sweep downgrade %s: %v", u.ID, err)
			continue
		}
		if u.ScheduledPlanID != "" {
			_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
		}
		log.Printf("billing: reconcile sweep downgraded user %s to free (no active Stripe subscription, missed deletion webhook)", u.ID)
	}
}

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
	if ev.Type == "refund.failed" {
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
	if refresh {
		if client, ok := s.biller.(*stripeClient); ok {
			info, missing, err := client.canonicalSubscription(ctx, ev.SubscriptionID)
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if missing {
				w.WriteHeader(http.StatusOK)
				return
			}
			if info.ID != "" {
				ev.SubscriptionID, ev.PriceID, ev.Status, ev.CurrentPeriodEnd = info.ID, info.PriceID, info.Status, info.CurrentPeriodEnd
				ev.MetadataBillingAttemptID = info.BillingAttemptID
				ev.MetadataUserID = info.MetadataUserID
			}
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
			if ev.MetadataBillingAttemptID != "" {
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
		// Resolve what THIS event says Stripe is billing, before the admin branch:
		// an admin-comped account still has its Stripe subscription recorded on
		// Stripe's own source row, so if the comp is ever lifted the fallback is
		// real state rather than a guess.
		planID := "free"
		cycle := ""
		if ev.Status == "active" || ev.Status == "trialing" {
			if p, ok, err := s.Store().PlanByStripePrice(ctx, ev.PriceID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			} else if ok {
				planID = p.ID
				cycle = cycleOfPrice(p, ev.PriceID)
			}
		}
		if ev.Status == "past_due" {
			planID, cycle = u.PlanID, u.BillingCycle
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
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		// Double-checkout dedup, done SURGICALLY so the common path makes no Stripe
		// call: only when a DIFFERENT subscription id than the recorded canonical
		// shows up (a second checkout opened a second subscription) do we reconcile
		// from live Stripe state — keep the earliest, cancel+refund the rest. An
		// event for the canonical (or the first-ever subscription) takes the normal
		// per-event path below.
		if u.StripeSubscriptionID != "" && ev.SubscriptionID != "" && ev.SubscriptionID != u.StripeSubscriptionID {
			if done, err := s.reconcileSubscriptions(ctx, u, ev.Created); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			} else if done {
				w.WriteHeader(http.StatusOK)
				return
			}
			// Fall through to per-event logic if the Stripe list failed.
		} else if u.StripeSubscriptionID == "" && ev.SubscriptionID != "" {
			// First subscription seen → adopt it as canonical (no Stripe call).
			//
			// Adoption is where ownership is ENFORCED, so it fails closed and the
			// grant below does not happen. A subscription already bound to another
			// account cannot be allowed to justify this account's tier: that is a
			// free paid plan, and one that can never be canceled or refunded
			// against the user holding it. 500 rather than a 200 ACK — retrying
			// will not resolve a genuine conflict, but it keeps the event visible
			// as a failing delivery in Stripe instead of silently discarding the
			// only signal that two accounts disagree about one subscription. The
			// reconcile sweep is the backstop once Stripe gives up retrying.
			if err := s.Store().SetUserStripeSubscription(ctx, u.ID, ev.SubscriptionID); err != nil {
				if errors.Is(err, ErrExternalSubscriptionOwned) {
					log.Printf("billing: refusing to adopt subscription %s for user %s: it is already owned by another account", ev.SubscriptionID, u.ID)
				} else {
					log.Printf("billing: adopting canonical subscription %s for user %s failed: %v", ev.SubscriptionID, u.ID, err)
				}
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
		if err := s.applyStripeLifecycle(ctx, u.ID, planID, cycle, ev); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// A pending downgrade has landed once BOTH the tier and the cycle reach what
		// we scheduled — clear the UI hint. Matching the tier alone was wrong for a
		// same-tier cycle downgrade (yearly→monthly on one plan): scheduled_plan_id
		// equals the current tier, so the intermediate schedule-creation event
		// (price still the old cycle) matched and cleared the marker seconds after
		// it was set, wedging later in-app plan changes at 500. Requiring the cycle
		// to match too defers the clear to the real period-end transition. A ''
		// scheduled cycle is a legacy row → fall back to tier-only. Best-effort.
		if u.ScheduledPlanID != "" && planID == u.ScheduledPlanID &&
			(u.ScheduledCycle == "" || cycle == u.ScheduledCycle) {
			_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
		}
		w.WriteHeader(http.StatusOK)

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
		// A DUPLICATE's deletion (a subscription we reaped) must NOT drop the user:
		// the canonical is still active. No Stripe call — just compare ids.
		if u.StripeSubscriptionID != "" && ev.SubscriptionID != "" && ev.SubscriptionID != u.StripeSubscriptionID {
			w.WriteHeader(http.StatusOK)
			return
		}
		// The canonical (or an unknown) subscription was canceled → free + clear it.
		s.clearCanonicalSubscription(ctx, u.ID)
		if err := s.applyStripeLifecycle(ctx, u.ID, "free", "", ev); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if u.ScheduledPlanID != "" {
			_ = s.Store().SetScheduledPlan(ctx, u.ID, "", "")
		}
		w.WriteHeader(http.StatusOK)

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
