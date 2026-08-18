package account

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
)

// The global Apple NEW-PURCHASE gate: one switch that stops this deployment
// offering App Store products to anybody, and nothing else.
//
// WHY IT EXISTS. A shipped App Store binary cannot be corrected. When something
// is wrong with what a purchase would resolve to — a mis-mapped product, a tier
// priced wrong in App Store Connect, an entitlement bug found after review —
// the only lever an operator has that acts on ALREADY-INSTALLED builds is the
// server's answer to "what may this build sell". Removing the catalog rows one
// by one is that lever today, and it is the wrong shape for an emergency: it is
// several confirmed writes, it destroys the mapping an accepted-but-unfinished
// transaction still needs to resolve, and putting it back is a second round of
// the same edits. This is one switch, it changes no mapping, and flipping it
// back restores exactly the previous catalog.
//
// WHAT IT MUST NEVER TOUCH, and this is the whole safety argument:
//
//   - `POST /api/billing/apple/transaction`. A customer Apple has ALREADY
//     charged may be mid-flight when the gate closes — the transaction is
//     signed, the money has moved, and the device is holding it unfinished. The
//     intake refusing it would leave a paid customer with no entitlement and
//     the only automatic repair (store redelivery) pointed at a server that
//     will refuse it again.
//   - `Transaction.updates`, restores, renewals and App Store server
//     notifications. Every one of those is an already-paid fact arriving late;
//     none of them is a NEW purchase, and the gate is about new purchases.
//   - the entitlement projection. Pausing sales does not cancel anybody.
//
// So the gate is read at exactly TWO new-purchase entry points:
// handleAppleCatalog, which names what a client may offer, and
// handleApplePurchaseDispatch, which grants the one permission that may precede
// StoreKit. There is deliberately no check in transaction intake: adding one
// there is how "stop selling" turns into "stop honouring what was sold".
// TestAppleGatePausedStillAppliesAValidTransaction is the regression that fails
// if the gate ever reaches that paid-fact path.
//
// WHY THE SETTINGS TABLE. It is the deployment's existing durable key/value
// store: one row, written by a single UPSERT (atomic — there is no
// read-modify-write here, the form carries the absolute state it wants), read
// live on every request, and shared by every instance behind the load balancer.
// A process-local flag would come back on at the next restart and disagree
// between instances, which for an emergency brake is the failure that matters.
//
// It is deliberately NOT part of `Settings`/`ResolveSettings`. Those are the
// stored-transfer limits an operator edits as a batch on one form; this is a
// one-click emergency action with its own route, its own confirmation page and
// its own audit action, and merging it into that form would mean an unrelated
// settings save could carry it along.

// SettingApplePurchasesEnabled is the gate's row. Exact 1 means purchases may be
// offered. Zero, absence and every other value mean paused. It is not seeded:
// deploying code and explicitly opening a money-moving surface are separate
// operations, so a fresh or partially migrated deployment fails closed.
const SettingApplePurchasesEnabled = "apple_purchases_enabled"

// applePurchaseGateTarget is the audit/confirmation-page target. One global
// switch, so one constant target rather than an id built from a request.
const applePurchaseGateTarget = "apple-purchases"

// applePurchasesEnabled reports whether new App Store purchases may be offered.
//
// A store error is RETURNED rather than defaulted, unlike settingOr's read of
// the transfer limits. The two defaults are not comparable: falling back to the
// env value for `max_file_size` costs a wrong limit for one request, while
// falling back to "enabled" here would re-open sales for as long as a database
// blip lasts — during an incident, which is the only time this row is ever 0.
// The caller turns the error into a 500, so a deployment that cannot read the
// gate describes no products at all.
func (s *Service) applePurchasesEnabled(ctx context.Context) (bool, error) {
	v, ok, err := s.Store().GetSetting(ctx, SettingApplePurchasesEnabled)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}
	return v == 1, nil
}

// applePurchaseGateImage is the confirmation-page / audit image of the gate,
// keyed by the setting key itself — the same convention settingsImage uses, so
// the field named in the log is the row that was written.
func applePurchaseGateImage(enabled bool) map[string]any {
	return map[string]any{SettingApplePurchasesEnabled: enabled}
}

// errApplePurchaseGateForm is the one way the form can be unusable.
var errApplePurchaseGateForm = errors.New(
	`apple purchase gate needs enabled=1 (resume) or enabled=0 (pause)`)

// parseApplePurchaseGateForm reads the ABSOLUTE state the operator asked for.
//
// Not a toggle, and that is deliberate. A "flip it" action decides what to
// write from what it read a moment ago, so two operators reacting to the same
// incident — or one operator double-submitting a confirmation page — can leave
// sales ON believing they turned them off. Each button posts the state it
// means, so re-applying it is a no-op rather than a reversal.
//
// Only "0" and "1" are accepted, checked after trimming. An unchecked checkbox
// submits no value at all, which is exactly the shape that would make an absent
// field mean "pause"; there is no checkbox here for that reason, and an absent
// or unrecognised value is refused rather than read as either state.
//
// A REPEATED field is refused rather than resolved, for the same reason
// appleCatalogBundleParam refuses one: `url.Values.Get` answers with the first
// of two, the opposite convention is just as defensible, and a request whose
// meaning depends on which reader it meets must not decide whether this
// deployment is selling.
func parseApplePurchaseGateForm(form url.Values) (bool, error) {
	values, ok := form["enabled"]
	if !ok || len(values) != 1 {
		return false, errApplePurchaseGateForm
	}
	switch strings.TrimSpace(values[0]) {
	case "1":
		return true, nil
	case "0":
		return false, nil
	default:
		return false, errApplePurchaseGateForm
	}
}

// handleAdminApplePurchases writes the gate. Reached ONLY through
// HandleAdminConfirm (the route is wrapped in RequireStepUp), so by the time it
// runs the operator has seen the exact before/after and satisfied a second
// factor.
//
// It is behind step-up for the same reason the product catalog is, in both
// directions: pausing stops every App Store sale this deployment can make, and
// RESUMING re-opens them — which, if the pause was in response to a mis-mapped
// product, is the click that starts charging customers for the wrong tier
// again. Neither direction is a change one mis-click should be able to make.
func (s *Service) handleAdminApplePurchases(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	enabled, err := parseApplePurchaseGateForm(r.Form)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	value := int64(0)
	if enabled {
		value = 1
	}
	// One UPSERT: the row moves from whatever it held to the requested state in
	// a single statement, with no window in which it holds neither. Nothing is
	// read first, so there is no read-modify-write to lose a concurrent write.
	if err := s.Store().SetSetting(r.Context(), SettingApplePurchasesEnabled, value, s.Now().Unix()); err != nil {
		// HandleAdminConfirm reads this status and skips the audit entry, so a
		// failed write is never logged as an applied one.
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// applePurchaseGateView is the dashboard panel's state: the live value, and
// whether it could be read at all.
//
// Err is carried separately for the same reason AppleProductsErr is: "paused"
// and "could not read" must not render as the same thing. The panel offers no
// control while the read failed — an operator cannot be asked to confirm a
// change away from a state nobody could determine.
type applePurchaseGateView struct {
	Enabled bool
	Err     bool
}

// applePurchaseGatePanel resolves the panel's state for one dashboard render.
func (s *Service) applePurchaseGatePanel(ctx context.Context) applePurchaseGateView {
	enabled, err := s.applePurchasesEnabled(ctx)
	if err != nil {
		log.Printf("admin: reading the apple purchase gate failed: %v", err)
		return applePurchaseGateView{Err: true}
	}
	return applePurchaseGateView{Enabled: enabled}
}
