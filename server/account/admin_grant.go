package account

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Time-bounded administrator membership grants.
//
// # What this is, and what it deliberately is NOT
//
// A grant is an ENTITLEMENT OVERLAY: a record that an operator decided this
// account should be treated as a paid tier until an exact instant. It is not a
// billing source, not a subscription, and not an authority. Nothing here
// creates, changes, cancels, pauses, releases or hides a `billing_authorities`
// row, a `subscription_sources` row, an Apple purchase attempt, a Stripe
// customer/subscription identifier or a provider's plan. Provider events keep
// arriving, keep being persisted and keep reconciling underneath a live grant,
// and whatever they leave behind is what the account falls back to the moment
// the grant expires.
//
// That separation is the whole design. The pre-existing manual comp
// (SetUserPlanAdmin, plan_source='admin') is the OPPOSITE arrangement: it
// overwrites the users-row projection, so it outranks providers permanently and
// is refused outright whenever any provider authority exists — precisely because
// a comp written into the projection could mask a channel that is still charging
// the customer. A grant does not need that refusal, because it never touches the
// projection: the provider record stays exactly as authoritative as it was, and
// an operator can read it side by side with the grant.
//
// # Where a grant is stored
//
// Three additive, defaulted columns on `users`
// (admin_grant_plan_id / admin_grant_granted_at / admin_grant_expires_at), NOT a
// second projection and NOT a second table. Consequences, all of them wanted:
//
//   - Rollback is fail-closed. An older binary's explicit column lists never name
//     these columns, so it simply does not see the grant and the account reads as
//     whatever the provider projection says. A rollback can therefore only ever
//     REMOVE granted entitlement, never leave a permanent un-expirable one behind.
//   - Expiry needs no write, no sweep and no background job. The overlay is
//     re-evaluated against the clock on every read, so "reveal the provider
//     entitlement, or Free" at expiry is a property of the resolution rule rather
//     than of a job that might not have run.
//   - Account purge is automatic and intentional: the columns live on the users
//     row, so a hard delete removes the grant with the account and can never
//     leave an orphaned entitlement pointing at a recycled id.
//
// # Precedence — the documented tie rule
//
// A live grant is STRICTLY ADDITIVE: it can only ever raise the effective tier,
// never lower it. resolveGrantedPlanID takes the grant only when the granted tier
// outranks the tier the provider projection currently grants, by the same
// planRank comparison resolveEffective uses (sort_order, then price_monthly).
// On a TIE — equal rank, including the same tier on both sides — the PROVIDER
// PROJECTION STANDS. Two reasons, and both matter:
//
//   - It is the answer that cannot take paid access away. A 7-day "plus" grant
//     handed to an account that is paying for "max" must not downgrade a paying
//     customer for a week.
//   - It is total and order-independent. The result depends only on (grant,
//     projection, clock, plan table), never on which of a provider event and a
//     grant happened to land first.
//
// An unresolvable granted tier (no plans row) grants NOTHING — the same rule
// planRanksTx applies to a source row pointing at a missing plan.
const (
	// AdminGrantModeFromNow REPLACES any existing grant with one that runs from
	// this instant. It is deliberately a replacement rather than a maximum: it is
	// also the only correction an operator has for a mis-typed duration, so
	// re-granting 1 day from now must be able to SHORTEN a 1000-day grant.
	AdminGrantModeFromNow = "from_now"
	// AdminGrantModeExtend adds the duration on top of an existing UNEXPIRED
	// grant's expiry, so an operator renewing a comp does not silently discard
	// the time already granted. With no unexpired grant it is identical to
	// from-now (see adminGrantExpiry).
	AdminGrantModeExtend = "extend"
)

const (
	// adminGrantMinDays / adminGrantMaxDays bound the duration an operator may
	// type, INCLUSIVE at both ends. The ceiling is not a rounding of "about three
	// years": it is the point past which a mis-click stops being a comp and
	// becomes an indefinite free membership nobody remembers granting.
	adminGrantMinDays = 1
	adminGrantMaxDays = 1000
	adminGrantDaySecs = 86400
)

// ErrAdminGrantDuration is returned for any duration that is not a whole number
// of days inside [adminGrantMinDays, adminGrantMaxDays] — including 0, a
// negative value, a fractional or non-numeric value, and a value that overflows
// int64. One sentinel for all of them on purpose: they are all "the operator did
// not type a usable number of days", and the console's message names the whole
// accepted range rather than guessing which mistake was made.
var ErrAdminGrantDuration = errors.New("account: admin grant duration must be a whole number of days from 1 to 1000")

// ErrAdminGrantMode is returned for a mode that is neither from-now nor extend.
// Fail closed: an unrecognized mode must never fall back to one of the real ones.
var ErrAdminGrantMode = errors.New("account: unknown admin grant mode")

// ErrAdminGrantOverflow is returned when the computed expiry would not fit in
// int64. Unreachable through the console (the duration is capped and the base is
// a stored expiry), and still checked: a silent wrap would turn the longest
// possible grant into one that has already expired, or into a negative instant
// that every `expires_at > now` comparison reads as live forever.
var ErrAdminGrantOverflow = errors.New("account: admin grant expiry overflows")

// ErrAdminGrantPlan is returned when the requested tier is missing, retired, or
// the free tier. Granting Free is refused rather than accepted as a no-op: an
// operator who selected it meant to change something, and silently recording a
// grant that can never outrank anything would read back as "the comp is live".
var ErrAdminGrantPlan = errors.New("account: an admin grant needs an active paid plan")

// ErrAdminGrantUnsafeAccount is returned when the target account may not receive
// entitlement at all: it is pending deletion, or it is frozen by an open
// account-deletion billing hold. Both are states where the account's billing is
// mid-flight and granting would either be erased by the deletion or hand paid
// capacity to an account that is being torn down.
var ErrAdminGrantUnsafeAccount = errors.New("account: this account cannot receive an administrator grant")

// AdminGrant is one account's time-bounded administrator entitlement overlay.
// The zero value means "no grant on record", which is what every account that
// has never been granted reads as.
type AdminGrant struct {
	// PlanID is the granted tier (plans.id); '' = no grant recorded.
	PlanID string
	// GrantedAt is when the operator's confirmation applied (unix seconds).
	GrantedAt int64
	// ExpiresAt is the EXACT instant the grant stops applying (unix seconds),
	// EXCLUSIVE: the grant is live while now < ExpiresAt, so a grant and its
	// expiry can never both be true at the same second.
	ExpiresAt int64
}

// Active reports whether this grant is in force at now.
func (g AdminGrant) Active(now int64) bool {
	return g.PlanID != "" && g.ExpiresAt > now
}

// AdminGrant reads the overlay recorded on this user row.
//
// It is a method on User rather than a separate store read because the three
// columns travel with GetUserByID: entitlement resolution happens on a User that
// the caller already has, and an extra query per plan check would put a
// round-trip on the upload path for a field that is almost always empty.
func (u User) AdminGrant() AdminGrant {
	return AdminGrant{
		PlanID:    u.AdminGrantPlanID,
		GrantedAt: u.AdminGrantGrantedAt,
		ExpiresAt: u.AdminGrantExpiresAt,
	}
}

// parseAdminGrantDays accepts ONLY a base-10 whole number of days inside the
// inclusive bounds. Everything else — "", "0", "-1", "1.5", "1e3", "abc",
// "1001", and a value too large for int64 — is one refusal, and the refusal
// happens before any store call, so a rejected duration cannot mutate anything.
//
// strconv.ParseInt is doing three jobs here that a hand-rolled check would have
// to get right separately: it rejects a fractional value outright rather than
// truncating it, it reports int64 overflow as an error instead of wrapping, and
// it refuses anything that is not a decimal integer.
func parseAdminGrantDays(raw string) (int64, error) {
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return 0, ErrAdminGrantDuration
	}
	if n < adminGrantMinDays || n > adminGrantMaxDays {
		return 0, ErrAdminGrantDuration
	}
	return n, nil
}

// validAdminGrantMode reports whether mode is one of the two the console offers.
func validAdminGrantMode(mode string) bool {
	return mode == AdminGrantModeFromNow || mode == AdminGrantModeExtend
}

// adminGrantExpiry computes the exact instant a grant would end.
//
// This is the ONE definition of the arithmetic. The confirmation page's preview,
// the audit's "after" image and the transaction that actually writes the column
// all call it, so the operator cannot be shown one expiry and have another
// stored — see confirmNow for how the last two are additionally pinned to a
// single instant.
//
// extend anchors at max(now, current unexpired expiry), exactly as specified: an
// unexpired grant's remaining time is kept, and an ALREADY-EXPIRED grant is not
// resurrected — extending a lapsed grant is the same as granting from now, which
// is the only reading that cannot silently back-date entitlement into a window
// the account did not have it.
func adminGrantExpiry(mode string, days, now int64, cur AdminGrant) (int64, error) {
	if !validAdminGrantMode(mode) {
		return 0, ErrAdminGrantMode
	}
	if days < adminGrantMinDays || days > adminGrantMaxDays {
		return 0, ErrAdminGrantDuration
	}
	base := now
	if mode == AdminGrantModeExtend && cur.Active(now) {
		base = cur.ExpiresAt
	}
	span := days * adminGrantDaySecs // bounded by adminGrantMaxDays; cannot overflow
	if base > math.MaxInt64-span {
		return 0, ErrAdminGrantOverflow
	}
	return base + span, nil
}

// planRankOf lifts a plan row into the ordering resolveEffective already uses.
// A tier that could not be resolved ranks at zero, so a grant naming a missing
// plan can never outrank a real one.
func planRankOf(p Plan, found bool) planRank {
	if !found {
		return planRank{}
	}
	return planRank{sortOrder: p.SortOrder, priceMonthly: p.PriceMonthly, id: p.ID}
}

// effectivePlanID resolves the tier actually in force for u at this instant:
// the administrator grant when one is live AND outranks the provider projection,
// otherwise the projection itself.
//
// Read the fast path first — it is the one that runs on every upload. With no
// grant column set (every account that has never been granted) this returns
// u.PlanID with zero extra queries, so nothing on the enforcement path pays for
// a feature it is not using.
//
// Every failure direction resolves TOWARDS THE PROJECTION, never towards the
// grant: an unreadable or missing granted tier, or an unreadable current tier,
// leaves the account exactly where the provider record puts it. A grant is an
// operator's convenience; a projection is what somebody may be paying for.
func (s *Service) effectivePlanID(ctx context.Context, u User) string {
	g := u.AdminGrant()
	if !g.Active(s.Now().Unix()) {
		return u.PlanID
	}
	granted, ok, err := s.Store().GetPlan(ctx, g.PlanID)
	if err != nil || !ok {
		return u.PlanID
	}
	current, currentOK, err := s.Store().GetPlan(ctx, u.PlanID)
	if err != nil {
		return u.PlanID
	}
	if planRankOf(granted, true).higherThan(planRankOf(current, currentOK)) {
		return granted.ID
	}
	return u.PlanID
}

// adminGrantExpiryLabel renders an expiry for an operator: the exact UTC instant
// plus its raw unix value. Both, because the instant is what a human checks and
// the number is what an incident review greps for.
func adminGrantExpiryLabel(at int64) string {
	if at <= 0 {
		return "—"
	}
	return fmt.Sprintf("%s UTC (%d)", time.Unix(at, 0).UTC().Format("2006-01-02 15:04:05"), at)
}

// adminGrantExpiryPromise states, for the confirmation PAGE, exactly what the
// expiry will be computed from — because the page cannot honestly state what it
// will BE.
//
// The page is rendered when the operator submits the form; the write happens
// when they clear the second factor, an unbounded number of seconds later. An
// exact instant printed here would therefore be wrong by that delay, and wrong
// in the direction that matters: the operator would approve "expires 12:00:00"
// and the account would receive entitlement until 12:07:31. Neither available
// repair is acceptable — freezing this instant and writing it at confirmation
// hands over less than the N whole days that were asked for, and for extend it
// would anchor on a grant that may have lapsed in the meantime.
//
// So the promise the page makes is the arithmetic itself, which is true at every
// instant, including whichever one the operator eventually confirms at. The
// audit and the stored column then carry the exact resulting instant, computed
// once from confirmNow's frozen clock (see beforeImageFor).
//
// Both sentences name the fallback explicitly. "Extend" reads as "on top of what
// is already there", and an operator who does not know that a grant which lapses
// while they are reaching for their phone turns the action into a plain from-now
// grant would read the resulting expiry, days later, as a bug.
func adminGrantExpiryPromise(mode string, days int64) string {
	switch mode {
	case AdminGrantModeFromNow:
		return fmt.Sprintf("%d whole days from successful confirmation — "+
			"computed when you confirm, then recorded in the audit log. "+
			"This page cannot name the exact instant, because it is rendered before you confirm.", days)
	case AdminGrantModeExtend:
		// No apostrophe anywhere in this sentence, deliberately: the confirmation
		// page is html/template, which escapes one to &#39;, and a test asserting
		// the operator-facing wording would then have to assert the escaped form
		// instead of the sentence a human reads.
		return fmt.Sprintf("%d days added to the unexpired grant expiry on this account as it exists "+
			"when the confirmation applies; if no grant is unexpired at that moment, "+
			"%d whole days from successful confirmation — "+
			"computed when you confirm, then recorded in the audit log. "+
			"This page cannot name the exact instant, because it is rendered before you confirm.", days, days)
	}
	return mode
}

// adminGrantModeLabel spells out what each mode DOES, rather than echoing the
// wire value back at the operator. "from_now" in a confirmation diff does not
// say that it discards the grant already on the account; this does.
func adminGrantModeLabel(mode string) string {
	switch mode {
	case AdminGrantModeFromNow:
		return "from now (replaces any existing grant)"
	case AdminGrantModeExtend:
		return "extend (adds on top of the current unexpired grant)"
	}
	return mode
}

// providerCoexistenceNotice describes, in one operator-facing sentence, every
// provider fact that already exists on this account and will keep existing
// underneath the grant. "" means there is nothing on record.
//
// The wording rule this function exists to enforce: AN AUTHORITY IS NOT A
// SUBSCRIPTION. A `billing_authorities` row records that this account is bound
// to a provider channel — it does not, on its own, establish that anything is
// currently billing. Reporting "has an active subscription" from an authority
// row would tell an operator the opposite of what the recent production incident
// actually showed (an account projecting free, holding an Apple authority at
// epoch 1 and one still-dispatched attempt). So live paid access is asserted
// only from a source row that actually grants it, and the authority is reported
// separately, as what it is.
//
// "Actually grants it" is stillBillingAt, not grantsAccess, and the difference
// is the same overstatement one level down. grantsAccess reads only the tier and
// the status word, so a paid row whose terminal provider event never arrived —
// paid tier, still-'active' status, paid-through instant already behind us —
// reads as currently billing forever. Asserting that to an operator who is about
// to comp the account is exactly the false positive this notice exists to
// prevent, so the claim is narrowed by the service clock with the predicate the
// Apple paths already use. Its conservative directions are kept deliberately: a
// zero (unknown) paid-through instant, and a clock that reads as unusable, both
// leave the row asserted rather than silently downgrading a real subscription to
// "nothing live here". Either way the row itself is still reported under
// "subscription source rows" — narrowing the LIVE claim never hides the recorded
// provider state.
func (s *Service) providerCoexistenceNotice(ctx context.Context, userID string) (string, error) {
	authority, hasAuthority, err := s.Store().BillingAuthority(ctx, userID)
	if err != nil {
		return "", err
	}
	sources, err := s.Store().ListSubscriptionSources(ctx, userID)
	if err != nil {
		return "", err
	}
	now := s.Now().Unix()
	var live, recorded []string
	for _, src := range sources {
		recorded = append(recorded, src.Provider)
		if src.stillBillingAt(now) {
			live = append(live, src.Provider)
		}
	}
	sort.Strings(live)
	sort.Strings(recorded)
	if !hasAuthority && len(recorded) == 0 {
		return "", nil
	}

	var parts []string
	if hasAuthority {
		// Provider and epoch only. The bound App Store account token is a user
		// identifier and has no business on a console page or in an audit row.
		parts = append(parts, fmt.Sprintf("billing authority on record: %s (epoch %d)", authority.Provider, authority.Epoch))
	}
	if len(recorded) > 0 {
		parts = append(parts, "subscription source rows: "+strings.Join(recorded, ", "))
	}
	if len(live) > 0 {
		parts = append(parts, "currently granting paid access: "+strings.Join(live, ", "))
	} else {
		parts = append(parts, "no live paid subscription is confirmed by these records")
	}
	return "⚠ provider state coexists with this grant and is NOT changed by it — " +
		strings.Join(parts, "; ") +
		". The grant adds entitlement on top; it does not create, cancel, release or hide any provider authority, attempt or subscription.", nil
}
