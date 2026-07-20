package account

import (
	"context"
	"testing"
)

// TestPlanStripePriceIDsRoundTrip verifies UpsertPlan/GetPlan carry the new
// per-cycle Stripe Price id columns through the planCols/scanPlan extension.
func TestPlanStripePriceIDsRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	p := Plan{
		ID: "pro", Name: "Pro", StorageBytes: 1 << 30, TrafficBytes: 1 << 30,
		RetentionSecs: 86400, PriceMonthly: 999, PriceYearly: 9999,
		Active: true, UpdatedAt: 1,
		StripePriceMonthlyID: "price_monthly_1", StripePriceYearlyID: "price_yearly_1",
	}
	if err := s.UpsertPlan(ctx, p); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}
	got, ok, err := s.GetPlan(ctx, "pro")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if !ok {
		t.Fatalf("GetPlan: not found")
	}
	if got.StripePriceMonthlyID != "price_monthly_1" || got.StripePriceYearlyID != "price_yearly_1" {
		t.Fatalf("price ids not round-tripped: %+v", got)
	}

	// Overwrite via a second UpsertPlan (ON CONFLICT path) to exercise the
	// UPDATE SET clause for the two new columns too.
	p.StripePriceMonthlyID = "price_monthly_2"
	p.StripePriceYearlyID = "price_yearly_2"
	if err := s.UpsertPlan(ctx, p); err != nil {
		t.Fatalf("UpsertPlan (update): %v", err)
	}
	got, _, err = s.GetPlan(ctx, "pro")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if got.StripePriceMonthlyID != "price_monthly_2" || got.StripePriceYearlyID != "price_yearly_2" {
		t.Fatalf("price ids not updated on conflict: %+v", got)
	}
}

// TestSetUserStripeCustomerAndLookup verifies binding a user to a Stripe
// customer id and looking them back up by it.
func TestSetUserStripeCustomerAndLookup(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	u, err := s.UpsertUserByEmail(ctx, "cust@example.com", "Cust")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	if err := s.SetUserStripeCustomer(ctx, u.ID, "cus_123"); err != nil {
		t.Fatalf("SetUserStripeCustomer: %v", err)
	}

	got, ok, err := s.GetUserByStripeCustomer(ctx, "cus_123")
	if err != nil {
		t.Fatalf("GetUserByStripeCustomer: %v", err)
	}
	if !ok {
		t.Fatalf("GetUserByStripeCustomer: not found")
	}
	if got.ID != u.ID {
		t.Fatalf("wrong user: got %s want %s", got.ID, u.ID)
	}
	if got.StripeCustomerID != "cus_123" {
		t.Fatalf("StripeCustomerID not set: %+v", got)
	}
}

// TestGetUserByStripeCustomerEmptyNotFound guards against the empty-string
// default on every pre-existing row: looking up "" must never match one of
// them, else the first row created would satisfy any unbound webhook lookup.
func TestGetUserByStripeCustomerEmptyNotFound(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// A user with no Stripe customer set (stripe_customer_id defaults to '').
	if _, err := s.UpsertUserByEmail(ctx, "nocust@example.com", "NoCust"); err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}

	_, ok, err := s.GetUserByStripeCustomer(ctx, "")
	if err != nil {
		t.Fatalf("GetUserByStripeCustomer(\"\"): %v", err)
	}
	if ok {
		t.Fatalf("GetUserByStripeCustomer(\"\") matched a default-'' row, want not-found")
	}

	// A genuinely unknown, non-empty customer id must also miss.
	_, ok, err = s.GetUserByStripeCustomer(ctx, "cus_does_not_exist")
	if err != nil {
		t.Fatalf("GetUserByStripeCustomer(unknown): %v", err)
	}
	if ok {
		t.Fatalf("GetUserByStripeCustomer(unknown) unexpectedly found a user")
	}
}

// TestSetUserSubscriptionSetsAllFields verifies the single UPDATE sets
// plan_id, subscription_status, subscription_end, and plan_source together.
func TestSetUserSubscriptionSetsAllFields(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	u, err := s.UpsertUserByEmail(ctx, "sub@example.com", "Sub")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	if err := s.SetUserSubscription(ctx, u.ID, "pro", "active", 1234567890, "stripe", "", 1); err != nil {
		t.Fatalf("SetUserSubscription: %v", err)
	}

	got, err := s.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.PlanID != "pro" {
		t.Fatalf("PlanID = %q, want pro", got.PlanID)
	}
	if got.SubscriptionStatus != "active" {
		t.Fatalf("SubscriptionStatus = %q, want active", got.SubscriptionStatus)
	}
	if got.SubscriptionEnd != 1234567890 {
		t.Fatalf("SubscriptionEnd = %d, want 1234567890", got.SubscriptionEnd)
	}
	if got.PlanSource != "stripe" {
		t.Fatalf("PlanSource = %q, want stripe", got.PlanSource)
	}
}

// TestPlanByStripePriceMatchesMonthlyOrYearly verifies the OR match against
// either price-id column, and that unrelated plans don't match.
func TestPlanByStripePriceMatchesMonthlyOrYearly(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	pro := Plan{
		ID: "pro", Name: "Pro", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1,
		Active: true, UpdatedAt: 1,
		StripePriceMonthlyID: "price_pro_monthly", StripePriceYearlyID: "price_pro_yearly",
	}
	if err := s.UpsertPlan(ctx, pro); err != nil {
		t.Fatalf("UpsertPlan pro: %v", err)
	}
	// A second plan with unrelated price ids, to prove we don't just always
	// return the first row.
	other := Plan{
		ID: "biz", Name: "Biz", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1,
		Active: true, UpdatedAt: 1,
		StripePriceMonthlyID: "price_biz_monthly", StripePriceYearlyID: "price_biz_yearly",
	}
	if err := s.UpsertPlan(ctx, other); err != nil {
		t.Fatalf("UpsertPlan biz: %v", err)
	}

	got, ok, err := s.PlanByStripePrice(ctx, "price_pro_monthly")
	if err != nil {
		t.Fatalf("PlanByStripePrice(monthly): %v", err)
	}
	if !ok || got.ID != "pro" {
		t.Fatalf("PlanByStripePrice(monthly) = %+v, ok=%v; want pro", got, ok)
	}

	got, ok, err = s.PlanByStripePrice(ctx, "price_pro_yearly")
	if err != nil {
		t.Fatalf("PlanByStripePrice(yearly): %v", err)
	}
	if !ok || got.ID != "pro" {
		t.Fatalf("PlanByStripePrice(yearly) = %+v, ok=%v; want pro", got, ok)
	}
}

// TestPlanByStripePriceEmptyNotFound guards against the empty-string default
// on every plan row (free tier and any unmapped plan default to ”).
func TestPlanByStripePriceEmptyNotFound(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// free plan has no price ids set (defaults to '').
	if err := s.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatalf("UpsertPlan free: %v", err)
	}

	_, ok, err := s.PlanByStripePrice(ctx, "")
	if err != nil {
		t.Fatalf("PlanByStripePrice(\"\"): %v", err)
	}
	if ok {
		t.Fatalf("PlanByStripePrice(\"\") matched a default-'' row, want not-found")
	}
}

// TestSetUserPlanAdminSetsSource verifies the admin plan-assignment path
// records plan_source='admin', distinguishing it from the Stripe webhook path.
func TestSetUserPlanAdminSetsSource(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	u, err := s.UpsertUserByEmail(ctx, "admin-assigned@example.com", "AdminAssigned")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	if err := s.SetUserPlanAdmin(ctx, u.ID, "pro", 1); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}

	got, err := s.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.PlanID != "pro" {
		t.Fatalf("PlanID = %q, want pro", got.PlanID)
	}
	if got.PlanSource != "admin" {
		t.Fatalf("PlanSource = %q, want admin", got.PlanSource)
	}
}

// TestSetUserPlanAdminClearsStaleSubscription verifies that assigning a plan
// via the admin console clears any subscription_status/subscription_end left
// over from a prior Stripe subscription, since the manual comp supersedes it.
func TestSetUserPlanAdminClearsStaleSubscription(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	u, err := s.UpsertUserByEmail(ctx, "admin-clears-sub@example.com", "AdminClearsSub")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	if err := s.SetUserSubscription(ctx, u.ID, "pro", "active", 9999999999, "stripe", "", 1); err != nil {
		t.Fatalf("SetUserSubscription: %v", err)
	}
	if err := s.SetUserPlanAdmin(ctx, u.ID, "plus", 2); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}

	got, err := s.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.PlanID != "plus" {
		t.Fatalf("PlanID = %q, want plus", got.PlanID)
	}
	if got.PlanSource != "admin" {
		t.Fatalf("PlanSource = %q, want admin", got.PlanSource)
	}
	if got.SubscriptionStatus != "" {
		t.Fatalf("SubscriptionStatus = %q, want cleared to empty", got.SubscriptionStatus)
	}
	if got.SubscriptionEnd != 0 {
		t.Fatalf("SubscriptionEnd = %d, want cleared to 0", got.SubscriptionEnd)
	}
}
