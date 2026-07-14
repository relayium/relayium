package account

import (
	"encoding/json"
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
	url, err := s.biller.CreatePortalSession(r.Context(), u.StripeCustomerID, s.cfg.BaseURL)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
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
