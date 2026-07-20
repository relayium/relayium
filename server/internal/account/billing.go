package account

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
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
	var in struct {
		PlanID string `json:"planId"`
		Cycle  string `json:"cycle"` // "monthly" | "yearly"
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	plan, ok, err := s.store.GetPlan(r.Context(), in.PlanID)
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
	case "yearly":
		priceID = plan.StripePriceYearlyID
	default:
		priceID = plan.StripePriceMonthlyID
	}
	if priceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "plan not purchasable"})
		return
	}
	url, err := s.biller.CreateCheckoutSession(r.Context(), CheckoutInput{
		PriceID:         priceID,
		CustomerID:      u.StripeCustomerID,
		CustomerEmail:   u.Email,
		ClientRefUserID: u.ID,
		SuccessURL:      s.cfg.BaseURL + "/?billing=success",
		CancelURL:       s.cfg.BaseURL + "/?billing=cancel",
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

// handleBillingPortal opens a Stripe Billing Portal session for the signed-in
// user to manage an existing subscription. 404 when billing is unconfigured
// or the user has no Stripe customer yet (never checked out).
func (s *Service) handleBillingPortal(w http.ResponseWriter, r *http.Request, u User) {
	if s.biller == nil || u.StripeCustomerID == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// return_url is set per session and overrides the "Redirect link" configured
	// in the Stripe dashboard, so that field is dead config — change this line,
	// not the dashboard. /me rather than the home page: the user arrived from
	// there and expects to land back on their plan state.
	url, err := s.biller.CreatePortalSession(r.Context(), u.StripeCustomerID, s.cfg.BaseURL+"/me")
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
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
	var in struct {
		PlanID string `json:"planId"`
		Cycle  string `json:"cycle"` // "monthly" | "yearly"
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Only a live Stripe-sourced subscription can be changed in place. Free users
	// (no customer) and admin-comped accounts (plan_source=admin, which the
	// webhook must never override) fall through to a clear 409.
	if u.StripeCustomerID == "" || u.PlanSource != "stripe" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no_active_subscription"})
		return
	}
	plan, ok, err := s.store.GetPlan(r.Context(), in.PlanID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if plan.ID == u.PlanID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "already_on_plan"})
		return
	}
	// Already scheduled to downgrade to exactly this tier — nothing to do.
	if plan.ID == u.ScheduledPlanID {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "effective": "period_end"})
		return
	}
	var priceID string
	switch in.Cycle {
	case "yearly":
		priceID = plan.StripePriceYearlyID
	default:
		priceID = plan.StripePriceMonthlyID
	}
	if priceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "plan not purchasable"})
		return
	}

	// If a downgrade is already pending, its Stripe schedule manages the
	// subscription and blocks a fresh change — release it first so this new
	// upgrade/downgrade can apply cleanly.
	if u.ScheduledPlanID != "" {
		if err := s.biller.ReleaseSchedule(r.Context(), u.StripeCustomerID); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}

	// Upgrade vs downgrade decides timing. Tier direction is ranked by monthly
	// price (stable regardless of the chosen cycle): a higher tier is an upgrade
	// (apply now, prorated), a lower tier is a downgrade (defer to period end so
	// the customer keeps what they paid for — no refund, no proration credit).
	// If the current plan can't be resolved, treat it as an upgrade (apply now).
	downgrade := false
	if cur, ok, err := s.store.GetPlan(r.Context(), u.PlanID); err == nil && ok {
		downgrade = plan.PriceMonthly < cur.PriceMonthly
	}

	var opErr error
	effective := "now"
	scheduledPlan := "" // what the pricing UI should show as "pending downgrade"
	if downgrade {
		opErr = s.biller.ScheduleDowngrade(r.Context(), u.StripeCustomerID, priceID)
		effective = "period_end"
		scheduledPlan = plan.ID
	} else {
		opErr = s.biller.ChangeSubscriptionPlan(r.Context(), u.StripeCustomerID, priceID)
	}
	if opErr != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Record (or clear) the pending-downgrade hint. Best-effort: the Stripe op
	// already succeeded, so don't fail the request if this write hiccups.
	_ = s.store.SetScheduledPlan(r.Context(), u.ID, scheduledPlan)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "effective": effective})
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
	if u.StripeCustomerID == "" || u.PlanSource != "stripe" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no_active_subscription"})
		return
	}
	if u.ScheduledPlanID == "" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "none"})
		return
	}
	if err := s.biller.ReleaseSchedule(r.Context(), u.StripeCustomerID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	_ = s.store.SetScheduledPlan(r.Context(), u.ID, "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
	plans, err := s.store.ListPlans(r.Context())
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
	writeJSON(w, http.StatusOK, out)
}

// maxWebhookBodyBytes caps the raw Stripe webhook payload we'll read before
// giving up; real Stripe event payloads are a few KB, so 1 MiB is generous
// headroom while still bounding memory against a malicious/broken sender.
const maxWebhookBodyBytes = 1 << 20

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
	ev, err := s.biller.VerifyWebhook(body, r.Header.Get("Stripe-Signature"), s.now().Unix())
	if err != nil {
		// Bad signature: reject without acting, without leaking why.
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	switch ev.Type {
	case "checkout.session.completed":
		// Plan assignment is deferred to the accompanying
		// customer.subscription.* event Stripe always sends alongside this
		// one; here we only bind the newly-created (or reused) customer id.
		if ev.ClientRefUserID != "" {
			if err := s.store.SetUserStripeCustomer(ctx, ev.ClientRefUserID, ev.CustomerID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(http.StatusOK)

	case "customer.subscription.created", "customer.subscription.updated":
		u, ok, err := s.store.GetUserByStripeCustomer(ctx, ev.CustomerID)
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
			if err := s.store.SetUserStripeCustomer(ctx, ev.MetadataUserID, ev.CustomerID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			u, err = s.store.GetUserByID(ctx, ev.MetadataUserID)
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
		}
		if u.PlanSource == "admin" {
			// Admin comp wins: record status/end for visibility, but never
			// let a webhook change plan_id out from under an admin grant.
			if err := s.store.SetUserSubscription(ctx, u.ID, u.PlanID, ev.Status, ev.CurrentPeriodEnd, "admin", s.now().Unix()); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		planID := "free"
		if ev.Status == "active" || ev.Status == "trialing" {
			if p, ok, err := s.store.PlanByStripePrice(ctx, ev.PriceID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			} else if ok {
				planID = p.ID
			}
		}
		if err := s.store.SetUserSubscription(ctx, u.ID, planID, ev.Status, ev.CurrentPeriodEnd, "stripe", s.now().Unix()); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// A pending downgrade has landed once plan_id actually reaches the tier we
		// scheduled it to — clear the UI hint. (Creating the schedule fires an
		// earlier updated event whose price is still the higher tier, so this only
		// matches at the real period-end transition.) Best-effort.
		if u.ScheduledPlanID != "" && planID == u.ScheduledPlanID {
			_ = s.store.SetScheduledPlan(ctx, u.ID, "")
		}
		w.WriteHeader(http.StatusOK)

	case "customer.subscription.deleted":
		u, ok, err := s.store.GetUserByStripeCustomer(ctx, ev.CustomerID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			w.WriteHeader(http.StatusOK)
			return
		}
		planID, source := "free", "stripe"
		if u.PlanSource == "admin" {
			planID, source = u.PlanID, "admin"
		}
		if err := s.store.SetUserSubscription(ctx, u.ID, planID, "canceled", ev.CurrentPeriodEnd, source, s.now().Unix()); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// Subscription gone → any pending scheduled change is moot. Best-effort.
		if u.ScheduledPlanID != "" {
			_ = s.store.SetScheduledPlan(ctx, u.ID, "")
		}
		w.WriteHeader(http.StatusOK)

	default:
		// Unrecognized event type: acknowledge so Stripe doesn't retry.
		w.WriteHeader(http.StatusOK)
	}
}
