package account

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// The operator-managed App Store product catalog.
//
// WHAT THIS TABLE DECIDES. `apple_products` is the only thing that turns a
// verified App Store purchase into a Relayium tier. By the time a row here is
// read the money has already moved — the purchase is signed by Apple and the
// customer has been charged — while the transaction is still UNfinished on the
// device: the app finishes it only once this server accepts the submission (or
// idempotently converges on a state that already accounts for it), which is
// strictly after this row is read. The native purchase flow is built around
// that rule — it reaches the store's finish through a single submit-and-finish
// path, inside the accepted arm only — so anything this server refuses is left
// with the store to redeliver.
//
// That asymmetry is what makes a WRONG row worse than a missing one, and it is
// the reason for every guard below:
//
//   - No row (or a retired one) means the intake refuses, so the store keeps
//     redelivering the transaction. Adding the right row here IS the repair, and
//     the next redelivery lands.
//   - A row pointing at the wrong tier is accepted. The device then finishes the
//     transaction, redelivery stops, and what is left is a customer who paid for
//     one tier and holds another — with no automatic path back.
//
// That is why the write goes through CSRFGuard + RequireStepUp (confirmation
// page, second factor, audit entry) and why every path here ends in the ONE
// validated store method, UpsertAppleProduct.
//
// WHAT IT DOES NOT DECIDE. A row here cannot switch purchase verification on.
// The verifier is built from an operator-supplied configuration FILE at startup
// (server/apple_store.go); with no such file the intake endpoint answers
// 503 `verifier_unavailable` no matter what this table contains. The two truth
// sources are deliberately separate — config says "this deployment can verify
// Apple signatures at all", the database says "this product means this tier" —
// and nothing in this file may collapse them. See
// docs/apple-product-catalog.md for the supported activation order.

// appleProductStatus is the operator-facing state of one catalog row: what it
// would do if a purchase for it arrived right now.
//
// PRECEDENCE IS THE WHOLE DESIGN HERE, because a row can be in more than one of
// these conditions at once and the column shows one label:
//
//	retired       — the MAPPING's own switch is off. It wins over everything
//	                below, and that is not information hiding: an inactive
//	                mapping grants nothing regardless of its tier, so its tier's
//	                state cannot break anything. It is also the CORRECT resting
//	                state after retiring a mapping whose tier was withdrawn —
//	                labelling that healthy end state "tier not on sale" would
//	                flag the fix as the fault.
//	plan_missing  — active mapping, no such tier. Should be unreachable (the
//	                foreign key), shown anyway; see AppleProductRow.PlanFound.
//	plan_inactive — active mapping, tier exists but is not on sale. THIS IS THE
//	                ROW THAT LOOKS FINE AND IS NOT: AppleProductPlan re-checks
//	                the tier at read time, so a purchase for this product is
//	                refused today even though nobody edited the mapping.
//	live           — active mapping, tier on sale. A purchase resolves.
const (
	appleProductLive         = "live"
	appleProductRetired      = "retired"
	appleProductPlanMissing  = "plan_missing"
	appleProductPlanInactive = "plan_inactive"
)

func appleProductStatusOf(r AppleProductRow) string {
	switch {
	case !r.Active:
		return appleProductRetired
	case !r.PlanFound:
		return appleProductPlanMissing
	case !r.PlanActive:
		return appleProductPlanInactive
	default:
		return appleProductLive
	}
}

// appleProductView is one catalog row prepared for the admin template.
type appleProductView struct {
	BundleID  string
	ProductID string
	PlanID    string
	// PlanName is the tier's display name, "" when the tier is missing. The
	// template falls back to PlanID, so a broken row still names what it points
	// at rather than rendering a blank cell.
	PlanName  string
	Cycle     string
	Active    bool
	UpdatedAt int64
	// PlanFound is carried SEPARATELY from Status even though Status can imply
	// it, because the row form needs it when Status cannot say so. A tier
	// dropdown built only from the tiers that exist has no option matching a
	// missing one, and a browser then pre-selects the FIRST tier — so an
	// operator opening a broken row to retire it would silently repoint it at
	// whichever tier happens to sort first. The template renders the row's own
	// value as an explicit option when this is false. Status is not enough
	// because a RETIRED row whose tier is also missing reads "retired" (see the
	// precedence note above) and would hit exactly the same trap.
	PlanFound bool
	// Status is one of the four constants above, resolved once in Go rather
	// than as template conditionals: it is the column an operator acts on, and
	// its precedence rules are worth a unit test, which a chain of {{if}}s is
	// not.
	Status string
}

func appleProductViews(rows []AppleProductRow) []appleProductView {
	out := make([]appleProductView, 0, len(rows))
	for _, r := range rows {
		out = append(out, appleProductView{
			BundleID: r.BundleID, ProductID: r.ProductID,
			PlanID: r.PlanID, PlanName: r.PlanName,
			Cycle: r.Cycle, Active: r.Active, UpdatedAt: r.UpdatedAt,
			PlanFound: r.PlanFound,
			Status:    appleProductStatusOf(r),
		})
	}
	return out
}

// appleProductTarget is the audit/confirmation-page target for one mapping.
// Built from the TRIMMED key, so the row named in the log is the row written.
func appleProductTarget(p AppleProduct) string {
	return "apple-product:" + p.BundleID + "/" + p.ProductID
}

// appleProductImage flattens a mapping to the fields an operator can change,
// keyed by database column name (same convention as planImage/settingsImage).
//
// updated_at is deliberately ABSENT. It is not an operator-chosen field — the
// handler stamps it from the server clock at apply time — and the confirmation
// page renders strictly before that moment, so any value shown here would be a
// prediction. A diff row promising "updated_at: 1000 -> 1700000000" that the
// write then contradicts is worse than no row at all, on the one page whose
// entire purpose is that what it shows is what happens. The keys are in the row
// anyway (they identify it, they cannot change without addressing a different
// row), so what is left is exactly the set of values the write decides.
func appleProductImage(p AppleProduct) map[string]any {
	return map[string]any{
		"plan_id": p.PlanID,
		"cycle":   p.Cycle,
		"active":  p.Active,
	}
}

// appleProductCycles is the cycle vocabulary, in the order the edit form's
// dropdown offers them. Derived from the same two literals UpsertAppleProduct
// accepts; anything else is a third billing period the entitlement projection
// has no rules for.
var appleProductCycles = []string{"monthly", "yearly"}

// parseAppleProductForm turns a catalog-edit form into the AppleProduct that
// would be written.
//
// ONE PARSER, TWO CALLERS, and that is a requirement rather than a convenience:
// beforeImageFor builds the confirmation page's "after" image and the audit's
// change list from it, and handleAdminUpsertAppleProduct builds the actual
// write from it. A second parallel implementation would drift, and the drift is
// invisible — the page would show values that are not the ones written, and the
// audit log would record a change that did not happen. Same reasoning as
// parsePlanForm / parseSettingsForm above it.
//
// The trimming here MIRRORS UpsertAppleProduct's own. It is not defence in
// depth for its own sake: the confirmation target, the audit target, the
// before-image lookup key and the row the store finally writes must all be the
// same string, and the store trims. Validating a value the store would then
// change is how a confirmation page ends up describing a different row.
//
// UpdatedAt is NOT read from the form and is left zero here — the handler
// stamps it from the server clock. A client-supplied timestamp on a table that
// records when an operator last touched a money mapping is a field that can be
// backdated by whoever submits the form.
func parseAppleProductForm(form url.Values) (AppleProduct, error) {
	p := AppleProduct{
		BundleID:  strings.TrimSpace(form.Get("bundle_id")),
		ProductID: strings.TrimSpace(form.Get("product_id")),
		PlanID:    strings.TrimSpace(form.Get("plan_id")),
		Cycle:     strings.TrimSpace(form.Get("cycle")),
		Active:    form.Get("active") == "1",
	}
	if p.BundleID == "" || p.ProductID == "" {
		return AppleProduct{}, errors.New("apple product needs a bundle id and a product id")
	}
	// Length, checked AFTER trimming and against the verifier's own bound (see
	// appleProductKeyMaxLen). Refused here rather than only in the store because
	// the confirmation page must not describe a write that will be refused — and
	// because the row this would create is the specific kind the console exists
	// to prevent: well-formed, plausible on the dashboard, and unreachable by any
	// transaction the verifier will ever accept.
	//
	// A pre-existing over-long row (hand-written into the database, since no
	// write path here can produce one) therefore cannot be edited through the
	// console. That is the correct trade: such a row grants nothing to anyone
	// already, so the only edit it needs is the one the console refuses anyway.
	if len(p.BundleID) > appleProductKeyMaxLen || len(p.ProductID) > appleProductKeyMaxLen {
		return AppleProduct{}, fmt.Errorf(
			"apple product bundle id and product id must each be at most %d bytes "+
				"(longer than the purchase verifier accepts, so no purchase could ever reach the row)",
			appleProductKeyMaxLen)
	}
	if p.PlanID == "" {
		return AppleProduct{}, errors.New("apple product needs a plan id")
	}
	// Checked here as well as in the store because this value is rendered on the
	// confirmation page: an operator must not be shown, and asked to confirm, a
	// cycle that the write will then refuse.
	if p.Cycle != "monthly" && p.Cycle != "yearly" {
		return AppleProduct{}, fmt.Errorf("apple product cycle must be monthly or yearly, got %q", p.Cycle)
	}
	return p, nil
}

// handleAdminUpsertAppleProduct writes one catalog row. It is reached ONLY
// through HandleAdminConfirm (POST /admin/apple-products is wrapped in
// RequireStepUp), so by the time it runs the operator has seen the exact diff
// and satisfied a second factor.
//
// Every write in this file goes through Store.UpsertAppleProduct. Its
// validation — trimmed non-empty keys within the verifier's length bound, a real
// cycle, and an active mapping's tier having to exist and be on sale — is the
// fail-closed boundary this console must not be able to route around, so nothing
// here writes SQL and nothing here relaxes a rule.
func (s *Service) handleAdminUpsertAppleProduct(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	p, err := parseAppleProductForm(r.Form)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// The tier check is repeated here ONLY to turn the store's fail-closed
	// refusal into a specific 400 the operator can act on; UpsertAppleProduct
	// re-runs it and remains the authority. Two consequences worth stating:
	//
	//   - It is skipped for a RETIREMENT (Active=false), exactly as the store
	//     skips it. The mapping most in need of retiring is the one whose tier
	//     was just taken off sale; requiring an active tier to switch a mapping
	//     off would leave a live App Store product wired to a dead tier with no
	//     way to reach it from the console. This is a deliberate asymmetry, not
	//     a missing check — a retirement grants nothing to anyone.
	//   - It is a check-then-write, so a tier deactivated in the gap between the
	//     two loses the nice message and gets the store's refusal as a 500
	//     instead. That TOCTOU is not closed here: closing it means holding the
	//     plans row and the catalog row in one transaction, which is a change to
	//     UpsertAppleProduct's contract rather than to this console. The
	//     outcome is already correct in every case — the write is refused —
	//     because the authority is the store's check, not this one.
	if p.Active {
		plan, ok, err := s.Store().GetPlan(r.Context(), p.PlanID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "unknown plan: a live mapping must point at a tier that exists",
				http.StatusBadRequest)
			return
		}
		if !plan.Active {
			http.Error(w, "inactive plan: a live mapping must point at a tier that is on sale "+
				"(retire the mapping instead, or put the tier back on sale first)",
				http.StatusBadRequest)
			return
		}
	}
	// Server-stamped, never form-supplied: this column is the record of when an
	// operator last touched the mapping.
	p.UpdatedAt = s.Now().Unix()
	if err := s.Store().UpsertAppleProduct(r.Context(), p); err != nil {
		// The store's own validation has already been mirrored above, so a
		// refusal reaching here is either the TOCTOU race described there or a
		// storage failure. Neither is something the operator can fix by editing
		// the form, and neither may be reported as success — HandleAdminConfirm
		// reads this status and skips the audit entry, so a rejected write is
		// not logged as an applied one.
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin/users", http.StatusFound)
}
