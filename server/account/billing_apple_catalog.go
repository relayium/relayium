package account

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/relayium/relayium/httpx"
)

// GET /api/billing/apple/catalog — what a native client is allowed to sell.
//
// WHY THE CLIENT CANNOT SIMPLY KNOW. A StoreKit purchase starts from a product
// identifier, and the identifier has to come from somewhere. Compiling it into
// the app is the shape this endpoint exists to avoid: an app that carries its
// own catalog can be shipped pointing at a product the server has no mapping
// for, and the failure lands AFTER the customer has been charged — the money
// has moved, the transaction is unfinished, and the intake refuses it because
// `apple_products` says nothing about that product. A shipped binary cannot be
// corrected; a row can.
//
// So the catalog travels the other way, and it is the SAME catalog: this handler
// reads `apple_products` through the store method the admin console reads, and
// applies `appleProductStatusOf` — the predicate that console renders — rather
// than a second opinion about what "live" means. There is no second source and
// no second liveness rule to drift.
//
// WHAT IT DELIBERATELY IS NOT:
//
//   - **Not an authority on entitlement.** It says what may be OFFERED. What the
//     caller currently HOLDS is `/api/me`'s answer and stays there; nothing here
//     projects a plan, a status or a period end, so a client cannot render an
//     entitlement from a catalog response.
//   - **Not a price list.** A Mac App Store build must display Apple's own
//     localized price for the caller's storefront, which only StoreKit knows.
//     Relayium's web prices are in this database and are deliberately absent
//     here: rendering them beside an App Store product is a price Apple did not
//     agree to.
//   - **Not the admin view.** Retired mappings, mappings whose tier was withdrawn
//     and mappings pointing at a tier that is not there are the rows an OPERATOR
//     must see (see AppleProductRow) and exactly the rows a client must not: each
//     one is a product a purchase would be refused for.
//
// FAIL-CLOSED. With no verifier configured the deployment cannot accept a
// purchase at all, so it answers `503 verifier_unavailable` here for the same
// reason the intake does — advertising a product a deployment could never
// verify is how a customer pays for something that can never be applied. A row
// in `apple_products` cannot change that; the two truth sources stay separate.

// appleCatalogProduct is one purchasable App Store product, as the server sees
// it. `productId` is what StoreKit is asked to load; the rest is what the plan
// beside it may be CALLED on screen.
type appleCatalogProduct struct {
	ProductID string `json:"productId"`
	PlanID    string `json:"planId"`
	// PlanName is the tier's display name. Never '' here: a live row's tier
	// exists by construction (that is what `live` means), and a name is what a
	// purchase screen puts beside Apple's price.
	PlanName string `json:"planName"`
	Cycle    string `json:"cycle"` // 'monthly' | 'yearly'
	// SortOrder is the tier's own declared rank (plans.sort_order), passed
	// through so a client orders tiers the way this deployment orders them
	// rather than by whatever order product identifiers happen to sort in. It is
	// the same axis planRank treats as authoritative.
	SortOrder int64 `json:"sortOrder"`
}

// appleCatalogPurchase is the eligibility half: may this caller start an App
// Store purchase at all right now.
//
// It exists because the answer is a SERVER rule, and a client that guessed it
// would guess it wrong in the expensive direction. A user whose entitlement is
// already paid for through Stripe — or comped by an operator — must not be
// offered a second subscription through a provider that cannot see the first:
// the two would both bill, and the effective projection would grant no more
// than the higher one already did. It is the same rule the web billing surface
// applies before a fresh checkout.
type appleCatalogPurchase struct {
	Allowed bool `json:"allowed"`
	// BlockedBy names WHO owns the live entitlement when Allowed is false, in the
	// same vocabulary `/api/me`'s `entitlementProvider` uses: 'stripe', 'admin',
	// or 'multiple' when more than one provider is live at once. '' when Allowed
	// is true. Never 'apple' — an App Store subscription that is the SOLE live
	// entitlement stays purchasable, because a change of tier inside the
	// subscription group is how the App Store models it.
	BlockedBy string `json:"blockedBy"`
}

type appleCatalogResponse struct {
	// BundleID is the CONFIGURED value, echoed from this server's own allowlist
	// rather than from the request. A client that asked with a stray byte gets
	// back the identity the server actually resolved, and nothing an unauthorized
	// caller typed is ever reflected as an accepted app identity.
	BundleID string                `json:"bundleId"`
	Products []appleCatalogProduct `json:"products"`
	Purchase appleCatalogPurchase  `json:"purchase"`
}

// handleAppleCatalog answers the effective live catalog for ONE configured app.
//
// The order of the guards is the whole security argument:
//
//  1. no verifier → 503, before anything is read. An unconfigured deployment
//     describes no products, whatever its database holds.
//  2. exactly one well-formed `bundleId` → 400 otherwise. A repeated parameter
//     is refused rather than resolved by a first/last convention, because the two
//     conventions disagree and the disagreement decides which app's catalog is
//     returned.
//  3. the bundle must be in the VERIFIER's allowlist → 400. This is the step that
//     keeps the selector from widening app identity: a client may narrow the
//     answer to one of the apps this deployment is configured for, and there is
//     no value it can send that makes the server describe an app it is not.
//  4. only rows whose status is `live` are described.
func (s *Service) handleAppleCatalog(w http.ResponseWriter, r *http.Request, u User) {
	// Per-account, and read by the client immediately before a purchase decision,
	// so no cache — shared or local — may ever answer in the server's place. Set
	// before the first exit so every refusal carries it too: a cached 400 or 503
	// would outlive the configuration change that repairs it.
	w.Header().Set("Cache-Control", "private, no-store")
	verifier := s.appleTx
	if verifier == nil {
		writeAppleTransactionError(w, http.StatusServiceUnavailable, "verifier_unavailable")
		return
	}
	bundleID, err := appleCatalogBundleParam(r.URL.Query())
	if err != nil {
		writeAppleTransactionError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	app, ok := verifier.ConfiguredApp(bundleID)
	if !ok {
		// Named separately from `invalid_request` because it is the one refusal a
		// correct client can provoke by being the wrong BUILD — a macOS binary
		// asking a deployment configured only for iOS. It says nothing about which
		// bundles are configured, only that this one is not.
		writeAppleTransactionError(w, http.StatusBadRequest, "unknown_bundle")
		return
	}

	rows, err := s.Store().ListAppleProducts(r.Context())
	if err != nil {
		log.Printf("billing: listing the apple catalog for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// The tier's rank, read once for the tiers actually referenced. ListPlans is
	// the same method /api/me/usage reads for the same reason: `plans` has single
	// digits of rows and every replacement store already implements it.
	ranks, err := s.applePlanSortOrders(r.Context())
	if err != nil {
		log.Printf("billing: listing plans for the apple catalog for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	products := make([]appleCatalogProduct, 0, len(rows))
	for _, row := range rows {
		if row.BundleID != app.BundleID {
			continue
		}
		// The SAME predicate the admin console labels rows with. Anything but
		// `live` is a product a purchase would be refused for: a retired mapping,
		// a tier taken off sale, or a tier that is not there at all.
		if appleProductStatusOf(row) != appleProductLive {
			continue
		}
		products = append(products, appleCatalogProduct{
			ProductID: row.ProductID,
			PlanID:    row.PlanID,
			PlanName:  row.PlanName,
			Cycle:     row.Cycle,
			SortOrder: ranks[row.PlanID],
		})
	}
	// Deterministic, and ordered the way a purchase screen wants to read: cheapest
	// tier first by the deployment's own rank, monthly before yearly inside a
	// tier, then the product id so the order is total. ListAppleProducts is
	// already stable; this makes the ORDER meaningful rather than merely repeatable.
	sort.Slice(products, func(i, j int) bool {
		a, b := products[i], products[j]
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
		if a.PlanID != b.PlanID {
			return a.PlanID < b.PlanID
		}
		if a.Cycle != b.Cycle {
			// 'monthly' < 'yearly' alphabetically, which is also the order a
			// purchase screen offers them in.
			return a.Cycle < b.Cycle
		}
		return a.ProductID < b.ProductID
	})

	purchase, err := s.appleCatalogEligibility(r.Context(), u)
	if err != nil {
		// NOT degraded to "allowed". The same rule /api/me applies to
		// `entitlementProvider`: a failed lookup that defaulted open would put a
		// second subscription in front of somebody who already pays through a
		// provider this one cannot see.
		log.Printf("billing: resolving apple purchase eligibility for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, appleCatalogResponse{
		BundleID: app.BundleID,
		Products: products,
		Purchase: purchase,
	})
}

// errAppleCatalogBundleParam is every way the selector can be unusable. One
// error, because the handler answers all of them with one code: telling a
// caller WHICH rule its parameter broke is a tool for shaping the next attempt,
// and this parameter has exactly one correct form.
var errAppleCatalogBundleParam = errors.New("account: apple catalog needs exactly one well-formed bundleId")

// appleCatalogBundleParam reads the ONE `bundleId` this request may carry.
//
// Everything it refuses is a request whose meaning is ambiguous rather than
// merely unusual:
//
//   - absent, or present more than once. `url.Values.Get` would answer with the
//     first of two, which is a convention — and the opposite convention is just
//     as defensible, so a request that relies on either is one whose answer
//     depends on the reader.
//   - empty, or carrying leading/trailing space. The comparison downstream is
//     exact against a configured identifier; accepting a value that has to be
//     normalized first means the string compared is not the string sent.
//   - longer than the catalog's own key bound. A row keyed longer than that
//     cannot exist (UpsertAppleProduct refuses one) and no transaction naming it
//     could be verified, so the only thing a long value can do here is become a
//     large comparison.
func appleCatalogBundleParam(query url.Values) (string, error) {
	values, ok := query["bundleId"]
	if !ok || len(values) != 1 {
		return "", errAppleCatalogBundleParam
	}
	bundleID := values[0]
	if bundleID == "" || len(bundleID) > appleProductKeyMaxLen {
		return "", errAppleCatalogBundleParam
	}
	if bundleID != strings.TrimSpace(bundleID) {
		return "", errAppleCatalogBundleParam
	}
	return bundleID, nil
}

// applePlanSortOrders is plan id → declared rank, for the tiers this deployment
// has. A tier absent from the map yields 0, which is also the default rank of a
// deployment that never set sort_order.
func (s *Service) applePlanSortOrders(ctx context.Context) (map[string]int64, error) {
	plans, err := s.Store().ListPlans(ctx)
	if err != nil {
		return nil, err
	}
	ranks := make(map[string]int64, len(plans))
	for _, p := range plans {
		ranks[p.ID] = p.SortOrder
	}
	return ranks, nil
}

// appleCatalogEligibility answers "may this account start an App Store purchase".
//
// It is the SAME projection `/api/me` reports as `entitlementProvider` —
// literally the same function over the same two facts — so the purchase screen
// and the account screen cannot disagree about who owns the entitlement.
//
// A purchase may start only when that projection says the entitlement is
// nobody's ('' — a free account) or Apple's ALONE. Changing tier inside a
// subscription group is itself an App Store purchase, and refusing it would
// leave an Apple subscriber with no way to upgrade from the app that sold it
// to them. Everything else blocks, named so the client can say WHERE the
// subscription is managed:
//
//   - an admin comp blocks even beside a live Apple subscription. The grant —
//     not any purchase — is what the account renders, so selling an upgrade
//     against it would charge for a tier the projection may never show.
//   - exactly one live non-Apple provider blocks as itself ('stripe').
//   - more than one live provider blocks as 'multiple', Apple among them or
//     not: the account is already double-billed, and selling it a further
//     subscription can only deepen that.
func (s *Service) appleCatalogEligibility(ctx context.Context, u User) (appleCatalogPurchase, error) {
	live, err := s.Store().LiveEntitlementProviders(ctx, u.ID)
	if err != nil {
		return appleCatalogPurchase{}, err
	}
	owner := entitlementProviderWire(u, live)
	if owner == "" || owner == ProviderApple {
		return appleCatalogPurchase{Allowed: true}, nil
	}
	return appleCatalogPurchase{Allowed: false, BlockedBy: owner}, nil
}
