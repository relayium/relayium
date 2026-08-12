package account

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
)

// Provider-neutral subscription state.
//
// Relayium can be paid for through more than one billing provider, and those
// providers are INDEPENDENT ordered event streams: Stripe's webhook and (in a
// later batch) Apple's App Store notifications know nothing about each other
// and arrive in whatever order the network gives us. Modelling that as one
// `users.plan_source` plus one shared event clock loses information the moment
// there is a second provider — an Apple expiry would erase a still-live Stripe
// subscription, and a Stripe redelivery would rewind Apple's clock.
//
// So each (user, provider) pair owns a row of its own truth — plan, status,
// cycle, period end, external subscription id, and its OWN replay clock — and
// the user's `plan_id`/`subscription_status`/`subscription_end`/`plan_source`/
// `billing_cycle` columns become the EFFECTIVE PROJECTION derived from them.
// Enforcement, the admin console and every existing client keep reading that
// projection exactly as before; nothing outside this file needs to know that
// there is now more than one contributing source.
const (
	// ProviderStripe is the web/card provider; the mature adapter.
	ProviderStripe = "stripe"
	// ProviderApple is the App Store provider. No purchase path exists yet —
	// this batch builds the state model the StoreKit batch will write into.
	ProviderApple = "apple"
	// SourceAdmin is not a provider: it is a manual comp recorded directly on
	// the users row, and it outranks every provider. It never appears as a
	// subscription_sources row, because there is no external subscription
	// behind it to replay, cancel or refund.
	SourceAdmin = "admin"
	// ProviderMultiple is reported to clients when more than one provider is
	// live at once. It is deliberately VISIBLE rather than collapsed into
	// whichever provider happens to win: paying twice is a real (and
	// refundable) situation the user must be able to see, and hiding it behind
	// one provider's management UI would strand the other subscription.
	ProviderMultiple = "multiple"
)

// freePlanID is the tier every account falls back to. A source sitting on it
// grants nothing, whatever its status says.
const freePlanID = "free"

// knownProvider reports whether p is a real billing provider (and therefore
// owns a subscription_sources row). SourceAdmin deliberately is not one.
func knownProvider(p string) bool {
	return p == ProviderStripe || p == ProviderApple
}

// SubscriptionSource is one provider's view of one user's subscription.
type SubscriptionSource struct {
	UserID   string
	Provider string
	// PlanID is the tier THIS provider is currently paying for ('free' = none).
	PlanID string
	// Status is the provider's own status vocabulary, normalized to the Stripe
	// spellings liveSubStatus understands ('active', 'trialing', 'past_due',
	// 'canceled', ...). '' = nothing recorded yet.
	Status string
	// Cycle is 'monthly'|'yearly', or '' when this provider's event could not
	// resolve one. '' means UNKNOWN and must never be treated as a third cycle
	// — see the billing_cycle column comment.
	Cycle string
	// PeriodEnd is the current paid-through instant (unix seconds); 0 = unknown.
	PeriodEnd int64
	// ExternalID is the provider's canonical subscription identifier (a Stripe
	// subscription id; later, an Apple original transaction id). Unique across
	// users per provider — one external subscription has exactly one owner.
	ExternalID string
	// EventAt is THIS provider's replay/order clock (the event's own emission
	// timestamp). It is compared only against the same provider's previous
	// value, never against another provider's.
	EventAt   int64
	UpdatedAt int64
}

// grantsAccess reports whether this source is currently paying for a paid tier.
// Both halves matter: a live status on the free tier (an unmapped price, a
// past_due that dropped the tier) grants nothing, and a paid tier with a dead
// status is a lapsed subscription.
func (s SubscriptionSource) grantsAccess() bool {
	return s.PlanID != "" && s.PlanID != freePlanID && liveSubStatus(s.Status)
}

// SourceEvent is one provider event applied to one user's source row.
type SourceEvent struct {
	UserID   string
	Provider string
	PlanID   string
	Status   string
	// Cycle: '' LEAVES the stored cycle alone rather than blanking it, the same
	// rule SetUserSubscription has always applied to billing_cycle. A
	// cancellation carries no resolvable price, and must not erase a cycle we
	// already knew.
	Cycle     string
	PeriodEnd int64
	// ExternalID is the provider's canonical subscription identifier carried BY
	// this event. It is bound in the same transaction that applies the state,
	// which is the only arrangement in which "this user holds this tier" and
	// "this subscription pays for it" cannot disagree: an adapter that bound
	// separately would have a window where a granted tier has no recorded owner,
	// and a crash inside it leaves a subscription nobody can reconcile or refund.
	//
	// '' means OMITTED and PRESERVES whatever id is already recorded — most
	// events (a status change, a renewal) carry no id, and blanking it on those
	// would silently drop the ownership record. Clearing a binding is done
	// explicitly through BindExternalSubscription, not by omission.
	//
	// An id owned by a DIFFERENT user fails the whole apply with
	// ErrExternalSubscriptionOwned; nothing is written.
	ExternalID string
	// EventAt is the provider's own clock for this event. 0 disables the replay
	// guard (a caller with no usable timestamp), matching the existing webhook
	// behaviour for events that carry no `created`.
	EventAt int64
	// Now is the wall clock used for quota segmentation and the row's
	// updated_at, threaded in rather than read from time.Now() so tests and the
	// service clock agree.
	Now int64
}

// EffectiveEntitlement is what the users-row projection will be set to.
type EffectiveEntitlement struct {
	PlanID string
	Status string
	// Cycle '' means "leave the stored billing_cycle alone" (see SourceEvent).
	Cycle     string
	PeriodEnd int64
	// Source is what plan_source becomes: a provider name, or SourceAdmin.
	Source string
	// LiveProviders are the providers currently granting paid access, sorted.
	// Two entries is the double-billing state clients must surface.
	LiveProviders []string
}

// SubscriptionApply reports what one ApplySubscriptionSource call did.
type SubscriptionApply struct {
	// Applied is false when the event was dropped as stale for its provider —
	// neither the source row nor the projection changed.
	Applied bool
	// Effective is the projection now in force (the CURRENT one when the event
	// was dropped, not a hypothetical).
	Effective EffectiveEntitlement
}

// AppleProduct maps one App Store product to a Relayium tier.
//
// It is keyed by BUNDLE IDENTITY as well as product id because Relayium ships
// two apps — the Mac App Store build and the iOS build — under DIFFERENT bundle
// ids, and Apple's product ids are namespaced per app. The same tier is
// therefore two distinct products, and two `apple_product_monthly/yearly`
// columns on `plans` could only ever hold one of them. Nothing seeds this
// table: it is inert until real product records exist.
type AppleProduct struct {
	BundleID  string
	ProductID string
	PlanID    string
	Cycle     string // 'monthly' | 'yearly'
	// Active is the MAPPING's own switch, not the tier's. Both have to be on for
	// the mapping to resolve — a tier retired after this row was written leaves
	// Active true, and AppleProductPlan is where that is caught.
	Active    bool
	UpdatedAt int64
}

// planRank orders tiers for "which live subscription grants the most".
//
// sort_order is the authoritative axis: it is the plans table's own declared
// tier order, and it is what /api/me/usage already uses to decide whether a
// user is on the top tier. price_monthly breaks ties beneath it, because a
// deployment that never set sort_order (every row 0) still has meaningful
// prices; the id is the final tie-break so the comparison is total and stable.
//
// resolveChange (Stripe upgrade-vs-downgrade) deliberately keeps its own
// price-first rule: that decision is about proration and money, not about which
// entitlement is larger.
type planRank struct {
	sortOrder    int64
	priceMonthly int64
	id           string
}

// higherThan reports a strict "grants more than".
func (r planRank) higherThan(o planRank) bool {
	if r.sortOrder != o.sortOrder {
		return r.sortOrder > o.sortOrder
	}
	if r.priceMonthly != o.priceMonthly {
		return r.priceMonthly > o.priceMonthly
	}
	return false
}

// sameRankAs is the tie the deterministic tie-break below has to resolve.
func (r planRank) sameRankAs(o planRank) bool {
	return !r.higherThan(o) && !o.higherThan(r)
}

// resolveEffective derives the users-row projection from every source row.
//
// The rules, in order:
//
//  1. An admin comp wins outright. The comped plan_id is preserved untouched;
//     the triggering provider's status/period-end are still recorded so the
//     admin console can see what the provider is doing, and the provider's own
//     row keeps tracking underneath — so if the comp is ever lifted the
//     fallback is real state rather than a guess. (This is exactly what the
//     Stripe webhook's admin branch did before, expressed once for every
//     provider instead of once per call site.)
//  2. Otherwise every LIVE PAID source contributes, and the HIGHEST tier among
//     them wins. Access therefore never drops because some other provider's
//     event arrived or expired — only because the winning source itself did.
//  3. With no live paid source at all, the projection follows the triggering
//     source. That is what makes a Stripe-only deployment behave exactly as it
//     always has: a cancellation writes free/canceled/stripe, an active event
//     on an unmapped price writes free/active/stripe.
//
// Ties (the same tier on two providers) resolve to the LONGER paid-through
// date, then to the alphabetically first provider. Both halves are needed: the
// first is the answer that never shortens access, and the second makes the
// outcome independent of the order the two events happened to arrive in.
func resolveEffective(adminPlanID string, trigger SubscriptionSource, sources []SubscriptionSource, ranks map[string]planRank) EffectiveEntitlement {
	live := make([]SubscriptionSource, 0, len(sources))
	for _, s := range sources {
		if s.grantsAccess() {
			live = append(live, s)
		}
	}
	sort.Slice(live, func(i, j int) bool { return live[i].Provider < live[j].Provider })
	providers := make([]string, 0, len(live))
	for _, s := range live {
		providers = append(providers, s.Provider)
	}

	if adminPlanID != "" {
		return EffectiveEntitlement{
			PlanID:    adminPlanID,
			Status:    trigger.Status,
			Cycle:     "", // an admin comp has no billing cycle of its own
			PeriodEnd: trigger.PeriodEnd,
			Source:    SourceAdmin,
			// Reported so a client can still see that a provider is billing an
			// admin-comped account — the anomaly must not be invisible.
			LiveProviders: providers,
		}
	}

	if len(live) == 0 {
		return EffectiveEntitlement{
			PlanID:        trigger.PlanID,
			Status:        trigger.Status,
			Cycle:         trigger.Cycle,
			PeriodEnd:     trigger.PeriodEnd,
			Source:        trigger.Provider,
			LiveProviders: providers,
		}
	}

	winner := live[0]
	for _, cand := range live[1:] {
		cr, wr := ranks[cand.PlanID], ranks[winner.PlanID]
		switch {
		case cr.higherThan(wr):
			winner = cand
		case cr.sameRankAs(wr) && cand.PeriodEnd > winner.PeriodEnd:
			winner = cand
		}
	}
	return EffectiveEntitlement{
		PlanID:        winner.PlanID,
		Status:        winner.Status,
		Cycle:         winner.Cycle,
		PeriodEnd:     winner.PeriodEnd,
		Source:        winner.Provider,
		LiveProviders: providers,
	}
}

// entitlementProviderWire is the value clients see as `entitlementProvider`.
//
// It is DERIVED at read time from the user row plus the live source rows rather
// than stored as a sixth projected column: a second stored copy of the same
// fact is a second thing to keep in step, and this one is read on exactly two
// endpoints. ” means "no paid provider", which is also what an older server
// (and any client that has never heard of the field) supplies by default.
func entitlementProviderWire(u User, live []string) string {
	if u.PlanSource == SourceAdmin {
		return SourceAdmin
	}
	switch len(live) {
	case 0:
		return ""
	case 1:
		return live[0]
	default:
		return ProviderMultiple
	}
}

// newAppAccountToken mints the opaque identifier the App Store purchase flow
// will carry as `appAccountToken`.
//
// Apple requires an RFC 4122 UUID there and will reject anything else, so this
// is a real version-4 UUID over 16 crypto/rand bytes — not a hash of the user
// id or the email. That matters beyond format compliance: the value travels
// through Apple's systems and back in signed transaction payloads, so it must
// carry no account information of its own. It is an ATTRIBUTION key, never an
// authorization one; possession of it grants nothing.
func newAppAccountToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}

// validAppAccountToken checks the RFC 4122 v4 shape. Used to keep a malformed
// value out of the column (and, later, to reject a notification's token
// out of hand) rather than as any kind of authentication.
func validAppAccountToken(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdef", c) {
				return false
			}
		}
	}
	// Version 4, RFC 4122 variant.
	return s[14] == '4' && strings.ContainsRune("89ab", rune(s[19]))
}
