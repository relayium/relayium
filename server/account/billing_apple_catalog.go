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
	// StorageBytes and TrafficBytes are what the tier actually GRANTS, straight
	// off the `plans` row this mapping points at.
	//
	// They are here because a purchase screen that names a tier and a price and
	// nothing else asks the user to buy a word. The alternative — a client
	// carrying its own table of "Pro means 5 GB" — is the same defect the
	// product identifiers were moved to the server to fix, one step worse: a
	// deployment (self-hosted, or ours after a plan edit) can change a tier's
	// quota in the admin console, and a shipped binary that hard-coded the old
	// figure would state a quantity beside Apple's real price. There is one
	// authority for what a tier grants, it is the `plans` row, and this is it
	// travelling to the only surface that has to describe it.
	//
	// Normalized through nonNegCap, so 0 means UNLIMITED on the wire — the same
	// convention `/api/me/usage` already publishes for the same two figures, and
	// the reason internal negatives never reach a client.
	StorageBytes int64 `json:"storageBytes"`
	TrafficBytes int64 `json:"trafficBytes"`
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
	// or 'multiple' when more than one provider is live at once. 'apple' means
	// another Relayium App Store record owns it. '' when Allowed is true.
	BlockedBy string `json:"blockedBy"`
}

// appleCatalogPurchases is the DEPLOYMENT-WIDE gate: may this server sell App
// Store subscriptions to anybody at all right now.
//
// Kept apart from appleCatalogPurchase (singular) rather than folded into it,
// because the two answer different questions about different subjects and a
// client has to be able to say which one it is looking at. `purchase` is about
// THIS account — "your subscription is managed on relayium.com" — and its
// `blockedBy` vocabulary is a list of billing providers. A global pause belongs
// to none of them, and reporting it through that field would make every paused
// deployment tell every user that somebody else owns their subscription.
//
// A new FIELD rather than a changed one, for the client that is already
// shipped: build 6 decodes this response, has no case for this key, and ignores
// it. What stops build 6 selling is `products` being empty — the only thing it
// can start a purchase from — and this field is what lets an updated build say
// WHY the list is empty instead of "there is nothing to subscribe to".
type appleCatalogPurchases struct {
	Enabled bool `json:"enabled"`
	// Reason names why, in a closed vocabulary a client switches on: 'paused'
	// when an operator closed the gate, '' when Enabled is true. It is not a
	// sentence — the words belong to the surface that renders them, in the
	// user's own language.
	Reason string `json:"reason"`
}

// applePurchasesReasonPaused is the only non-empty Reason today: an operator
// closed the global gate.
const applePurchasesReasonPaused = "paused"

type appleCatalogResponse struct {
	// BundleID is the CONFIGURED value, echoed from this server's own allowlist
	// rather than from the request. A client that asked with a stray byte gets
	// back the identity the server actually resolved, and nothing an unauthorized
	// caller typed is ever reflected as an accepted app identity.
	BundleID string                `json:"bundleId"`
	Products []appleCatalogProduct `json:"products"`
	Purchase appleCatalogPurchase  `json:"purchase"`
	// Purchases is the global gate. Always emitted, including when it is open,
	// so a client can tell "this server has a gate and it is open" from "this
	// server predates the gate" without a version negotiation.
	Purchases appleCatalogPurchases `json:"purchases"`
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

	// The global gate, read BEFORE the catalog and applied by describing NO
	// product. It is the only thing in the billing package that reads this row —
	// see billing_apple_pause.go for why it may never be read on the intake
	// path — and it acts on `products` alone: the eligibility answer below stays
	// this account's true one, because a paused deployment still owes a Stripe
	// subscriber the sentence that says where their subscription lives.
	//
	// Zero products is what stops the ALREADY-SHIPPED build: a purchase can only
	// be started from an identifier this response named, and there are none. The
	// `purchases` field beside it is what lets an updated build say why.
	purchasesEnabled, err := s.applePurchasesEnabled(r.Context())
	if err != nil {
		// Never degraded to "enabled". This row is 0 only during an incident,
		// and a transient read failure that re-opened sales would re-open them
		// at exactly the wrong moment.
		log.Printf("billing: reading the apple purchase gate for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Non-nil even when empty, so the field encodes as `[]` rather than `null`:
	// a decoder that treats the two differently must not be able to tell a
	// paused deployment from a broken response.
	products := []appleCatalogProduct{}
	// Paused, nothing below this point is even READ. That is deliberate rather
	// than an optimisation: a broken catalog or plans table is one of the
	// reasons an operator reaches for the gate, and the emergency lever must
	// not depend on the read it is being used to work around.
	if purchasesEnabled {
		rows, err := s.Store().ListAppleProducts(r.Context())
		if err != nil {
			log.Printf("billing: listing the apple catalog for user %s failed: %v", u.ID, err)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// The tiers themselves, read once. ListPlans is the same method
		// /api/me/usage reads for the same reason: `plans` has single digits of
		// rows and every replacement store already implements it. What is taken
		// from it is the tier's declared RANK and what it GRANTS — the two facts
		// a purchase screen cannot make up for itself.
		plans, err := s.applePlanFacts(r.Context())
		if err != nil {
			log.Printf("billing: listing plans for the apple catalog for user %s failed: %v", u.ID, err)
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		for _, row := range rows {
			if row.BundleID != app.BundleID {
				continue
			}
			// The SAME predicate the admin console labels rows with. Anything but
			// `live` is a product a purchase would be refused for: a retired
			// mapping, a tier taken off sale, or a tier that is not there at all.
			if appleProductStatusOf(row) != appleProductLive {
				continue
			}
			plan := plans[row.PlanID]
			products = append(products, appleCatalogProduct{
				ProductID: row.ProductID,
				PlanID:    row.PlanID,
				PlanName:  row.PlanName,
				Cycle:     row.Cycle,
				SortOrder: plan.SortOrder,
				// nonNegCap, so the "unlimited" the enforcement layer spells as
				// a non-positive number reaches a client as the 0 it publishes
				// everywhere else. A client must not have to know that -1 and 0
				// are the same tier.
				StorageBytes: nonNegCap(plan.StorageBytes),
				TrafficBytes: nonNegCap(plan.TrafficBytes),
			})
		}
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

	purchase, err := s.appleCatalogEligibility(r.Context(), u, app.BundleID)
	if err != nil {
		// NOT degraded to "allowed". The same rule /api/me applies to
		// `entitlementProvider`: a failed lookup that defaulted open would put a
		// second subscription in front of somebody who already pays through a
		// provider this one cannot see.
		log.Printf("billing: resolving apple purchase eligibility for user %s failed: %v", u.ID, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	gate := appleCatalogPurchases{Enabled: purchasesEnabled}
	if !purchasesEnabled {
		gate.Reason = applePurchasesReasonPaused
	}
	httpx.WriteJSON(w, http.StatusOK, appleCatalogResponse{
		BundleID:  app.BundleID,
		Products:  products,
		Purchase:  purchase,
		Purchases: gate,
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

// applePlanFacts is plan id → the tier row, for the tiers this deployment has.
//
// The whole row rather than the one field the ordering needs, because the two
// callers of this map want different columns off the same read: the sort uses
// `sort_order`, and the product description uses `storage_bytes` /
// `traffic_bytes`. A second read for the second set of columns could observe a
// plan edit in between and describe a tier by one row while ranking it by
// another.
//
// A tier absent from the map yields the zero Plan. That is the correct answer
// for every field: rank 0 is the default rank of a deployment that never set
// sort_order, and 0 bytes is the wire spelling of "unlimited"... which is why
// an absent tier cannot actually reach here — `live` requires the tier to exist
// (appleProductStatusOf), and only live rows are described.
func (s *Service) applePlanFacts(ctx context.Context) (map[string]Plan, error) {
	plans, err := s.Store().ListPlans(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]Plan, len(plans))
	for _, p := range plans {
		byID[p.ID] = p
	}
	return byID, nil
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
func (s *Service) appleCatalogEligibility(ctx context.Context, u User, bundleID string) (appleCatalogPurchase, error) {
	live, err := s.Store().LiveEntitlementProviders(ctx, u.ID)
	if err != nil {
		return appleCatalogPurchase{}, err
	}
	owner := entitlementProviderWire(u, live)
	if owner == "" {
		return appleCatalogPurchase{Allowed: true}, nil
	}
	if owner == ProviderApple {
		source, ok, err := s.Store().GetSubscriptionSource(ctx, u.ID, ProviderApple)
		if err != nil {
			return appleCatalogPurchase{}, err
		}
		// A terminal notification can be lost after Apple's retry window. The
		// source then still says active even though its known paid-through instant
		// is past. That is not a second live charge: permit a new purchase so a
		// legitimate re-subscription can bind its fresh original transaction id.
		if ok && !source.stillBillingAt(s.now().Unix()) {
			return appleCatalogPurchase{Allowed: true}, nil
		}
		if ok && source.ExternalScope == bundleID {
			return appleCatalogPurchase{Allowed: true}, nil
		}
		// Empty is a migrated source whose app cannot be proven. Fail closed: an
		// unknown app scope is not permission to create a second Apple charge.
		return appleCatalogPurchase{Allowed: false, BlockedBy: ProviderApple}, nil
	}
	return appleCatalogPurchase{Allowed: false, BlockedBy: owner}, nil
}
