package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// POST /api/apple/notifications — App Store Server Notifications V2.
//
// Unauthenticated in the ordinary sense, exactly like the Stripe webhook beside
// it: Apple has no Relayium session and no CSRF token to present. What
// authenticates a delivery is the signature on the payload itself, verified
// against trust roots THIS deployment configured. Mounted on routeMux without
// risk because CSRFGuard only refuses a state-changing request whose Origin
// header is PRESENT and mismatched, and Apple's POST carries none.
//
// # What the answer means
//
// Apple retries a non-2xx delivery on a fixed schedule and then stops. That
// makes the status code a data-retention decision, not a formality, and it is
// chosen by exactly one rule: 2xx ONLY when the outcome is durable.
//
//	200  the ledger row reached a terminal state, or the event was durably
//	     preserved for replay. Nothing is left to redo.
//	400  the payload is not something Apple signed for an app this deployment
//	     is configured for. Refusing is the whole point; there is nothing to
//	     preserve and nothing a retry would fix.
//	500  a storage or ownership failure. The ledger row is deliberately left
//	     non-terminal so the retry redoes the work.
//	503  this deployment has no verifier. Retryable, because the correct fix is
//	     configuration and a delivery must survive it.
//
// The one thing never done here is to answer 200 for a verified, actionable
// notification that changed nothing and was not written down. That is the
// silent-loss case: Apple will not send it again, and the subscription it
// described would keep granting (or keep not granting) forever.
//
// # What is NOT trusted
//
// See apple_notification.go. In one line: the envelope decides which app and
// which delivery, and the independently verified nested transaction decides
// everything about the entitlement.

// appleNotificationBodyLimit bounds the request body.
//
// Separate from, and larger than, appleMaxNotificationJWSBytes: this is the
// JSON wrapper around the JWS, and bounding the two together would mean either
// refusing an envelope whose base64 sits near the JWS limit or letting the JSON
// parser see more than the verifier ever would. The JWS bound is what protects
// the parsers; this one just stops an unbounded read.
const appleNotificationBodyLimit = 256 << 10

// handleAppleNotification verifies one delivery and applies whatever the
// transaction inside it proves — never what the notification says happened.
func (s *Service) handleAppleNotification(w http.ResponseWriter, r *http.Request) {
	verifier := s.appleTx
	if verifier == nil {
		// Retryable on purpose. An unconfigured deployment that answered 200 would
		// have Apple discard deliveries it will never send again; 503 keeps them
		// coming until the verifier exists.
		http.Error(w, "verifier unavailable", http.StatusServiceUnavailable)
		return
	}
	signed, ok := readAppleNotificationBody(w, r)
	if !ok {
		return
	}

	now := s.now()
	n, err := verifier.VerifyNotification(signed, now)
	if err != nil {
		// The code names the rule that refused it. No part of the payload, the
		// certificates or the account token reaches this line — see appleRejection.
		log.Printf("apple notifications: delivery refused (%s)", appleRejectionCode(err))
		http.Error(w, "invalid notification", http.StatusBadRequest)
		return
	}

	status, state, reason := s.applyAppleNotification(r.Context(), n, now)
	// One line per delivery, carrying the notificationUUID an operator can look
	// up in App Store Connect and in the ledger — and carrying no transaction id,
	// no attribution token and no payload. Everything else about the delivery is
	// a row they can read by that UUID.
	log.Printf("apple notifications: %s (uuid %s, type %q, %s)", state, n.UUID, n.Type, reason)
	if status == http.StatusOK {
		w.WriteHeader(http.StatusOK)
		return
	}
	http.Error(w, "notification not processed", status)
}

// readAppleNotificationBody extracts `signedPayload`, or writes the refusal.
//
// Unknown fields are TOLERATED here, unlike the authenticated intake next door.
// That endpoint's body is written by Relayium's own client, so an unknown key
// there is either a bug or a smuggled second assertion. This body is written by
// Apple, and refusing it for carrying a field Apple added would be a
// self-inflicted outage on a document whose only trusted content is a signature.
func readAppleNotificationBody(w http.ResponseWriter, r *http.Request) (string, bool) {
	var in struct {
		SignedPayload string `json:"signedPayload"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, appleNotificationBodyLimit))
	if err != nil || appleStrictJSONObject(raw) != nil {
		log.Printf("apple notifications: delivery refused (body)")
		http.Error(w, "invalid request", http.StatusBadRequest)
		return "", false
	}
	// Unknown keys remain forward-compatible, but duplicate keys are ambiguous:
	// encoding/json would silently choose the last signedPayload. The same strict
	// structural pass used for Apple's signed documents therefore runs before the
	// typed decode, while still imposing no schema on future fields.
	if err := json.Unmarshal(raw, &in); err != nil {
		log.Printf("apple notifications: delivery refused (body)")
		http.Error(w, "invalid request", http.StatusBadRequest)
		return "", false
	}
	// NOT trimmed: the bytes verified must be the bytes sent. A compact
	// serialization contains no whitespace, so one that arrives padded is
	// malformed rather than untidy.
	if in.SignedPayload == "" || strings.TrimSpace(in.SignedPayload) != in.SignedPayload {
		log.Printf("apple notifications: delivery refused (signed_payload)")
		http.Error(w, "invalid request", http.StatusBadRequest)
		return "", false
	}
	return in.SignedPayload, true
}

// applyAppleNotification is the whole outcome decision for one VERIFIED
// notification. It returns the HTTP status to answer with, the ledger state
// reached, and a fixed reason code for the log.
//
// The order below is the order the facts become knowable, and each step can
// only ever move to a state that is honest about what was durably recorded.
func (s *Service) applyAppleNotification(ctx context.Context, n VerifiedAppleNotification, now time.Time) (int, string, string) {
	// 1. CLAIM. The row is written before anything is applied — and it is only a
	//    claim, so an interrupted apply is redone rather than skipped. See
	//    sqlite_apple_notification.go for why "record, then treat as done" loses
	//    data permanently.
	rec := AppleNotificationRecord{UUID: n.UUID, Type: n.Type, ReceivedAt: now.Unix(), Supported: n.Supported}
	if n.HasTransaction {
		rec.Projection = appleNotificationProjection(n.Transaction)
	}
	current, fresh, err := s.Store().ClaimAppleNotification(ctx, rec)
	if err != nil {
		log.Printf("apple notifications: claiming %s failed: %v", n.UUID, err)
		return http.StatusInternalServerError, "unclaimed", "storage"
	}
	if !fresh && appleNotificationTerminal(current.State) {
		// A redelivery of finished work. This is the ONLY short-circuit, and it is
		// reachable only from a state that means the work is over.
		return http.StatusOK, current.State, "duplicate"
	}
	if !fresh {
		// The first verified body for a notificationUUID is authoritative. A later
		// delivery must replay the durable projection already claimed, not fields
		// from a second body that happens to reuse the UUID. This also makes two
		// concurrent deliveries deterministic: whichever INSERT wins supplies the
		// event both requests converge on.
		n.HasTransaction = current.Projection.OriginalTransactionID != ""
		n.Supported = current.Supported
		if n.HasTransaction {
			n.Transaction = current.Projection.transaction()
		}
	}

	// 2. IS THERE ANYTHING TO ACT ON? A notification with no signed transaction
	//    carries no entitlement fact, and the notification TYPE is not permitted
	//    to supply one. Terminal, and recorded rather than dropped.
	if !n.HasTransaction {
		return s.finishAppleNotification(ctx, n.UUID, appleNotificationIgnored, "no_transaction", now)
	}
	// 3. IS IT A SHAPE THIS SERVER MODELS? A consumable, a non-renewing purchase
	//    or a family-shared subscription is fully verified and genuinely Apple's,
	//    and this entitlement model has no representation for it. Guessing one
	//    from the notification type is exactly what must not happen, so the row is
	//    preserved in its own state and never drained.
	if !n.Supported {
		return s.finishAppleNotification(ctx, n.UUID, appleNotificationUnsupported, "unsupported_shape", now)
	}
	tx := n.Transaction
	// 3b. CAN THIS SUBSCRIPTION BE IDENTIFIED? Every verified delivery names its
	//     environment, so this is unreachable for a payload just verified. It is
	//     reachable for a REDELIVERY that replays a projection recorded before the
	//     environment column existed (step 1 above), and there the answer must not
	//     be a guess: without the store, originalTransactionId names two possible
	//     subscriptions and one of them is somebody's paid one. Kept pending —
	//     durable, non-terminal, and named in the log — rather than resolved as
	//     "no owner", which would be a different and less honest reason.
	if !appleSupportedEnvironment(tx.Environment) {
		return s.finishAppleNotification(ctx, n.UUID, appleNotificationPending, "unknown_environment", now)
	}

	// 4. WHOSE SUBSCRIPTION IS THIS? Two independent keys, and they must agree.
	owner, resolved, err := s.resolveAppleNotificationOwner(ctx, tx)
	if err != nil {
		if errors.Is(err, ErrExternalSubscriptionOwned) {
			// Apple's record and ours disagree about who holds this subscription.
			// Nothing is granted, the projection is preserved, and the delivery is
			// deliberately FAILED so it stays visible in App Store Connect's
			// notification history — the same choice the Stripe adapter makes when
			// it refuses to adopt a subscription another account owns.
			s.recordAppleNotificationState(ctx, n.UUID, appleNotificationConflict, now)
			return http.StatusInternalServerError, appleNotificationConflict, "ownership_conflict"
		}
		log.Printf("apple notifications: resolving the owner of %s failed: %v", n.UUID, err)
		return http.StatusInternalServerError, current.State, "storage"
	}
	if !resolved {
		// Unknown attribution. Almost always Apple's notification simply beating
		// the purchasing client's own intake call. It may NOT grant, and it may not
		// be discarded either: the verified projection is durable and
		// reconcileApplePendingNotifications replays it the moment an owner exists.
		return s.finishAppleNotification(ctx, n.UUID, appleNotificationPending, "unknown_owner", now)
	}
	var renewalState AppleRenewalState
	if n.HasRenewal {
		renewalState = appleRenewalState(owner, tx, n.Renewal, now)
		if stored, ok, err := s.Store().GetAppleRenewalState(ctx, owner); err != nil {
			return http.StatusInternalServerError, current.State, "storage"
		} else if preferred, use := preferDurableAppleRenewal(stored, ok, renewalState, tx); use {
			// A same-generation notification may arrive out of order. Project from
			// the newest durable signed renewal fact; the atomic write below will
			// reject the older incoming renewal while applying the source event.
			renewalState = preferred
		}
	} else if stored, ok, err := s.Store().GetAppleRenewalState(ctx, owner); err != nil {
		return http.StatusInternalServerError, current.State, "storage"
	} else if ok && appleRenewalMatchesTransaction(stored, tx) {
		renewalState = stored
	}

	// 5. WHICH TIER? Only for a transaction that still grants — see
	//    appleNotificationProduct for why a refund must not depend on the catalog.
	product, mapped, err := s.appleNotificationProduct(ctx, tx, now)
	if err != nil {
		log.Printf("apple notifications: resolving the product for %s failed: %v", n.UUID, err)
		return http.StatusInternalServerError, current.State, "storage"
	}
	if !mapped {
		// A live purchase for a product no catalog row maps. The money has moved
		// and there is no safe tier to guess, so it is preserved for replay after
		// an operator adds the mapping rather than refused and forgotten.
		return s.finishAppleNotification(ctx, n.UUID, appleNotificationPending, "product_unmapped", now)
	}

	// 6. APPLY, through the same atomic path the authenticated intake uses. The
	//    event clock comes from the transaction's own purchaseDate, so a late
	//    delivery of an older generation is dropped by the store rather than by
	//    anything here.
	event := appleSourceEvent(owner, tx, product, now)
	if renewalState.UserID != "" {
		event = appleSourceEventWithRenewal(owner, tx, product, renewalState, now)
	}
	var applyErr error
	if n.HasRenewal {
		atomic, ok := s.Store().(interface {
			ApplyAppleLifecycle(context.Context, SourceEvent, AppleRenewalState) (SubscriptionApply, error)
		})
		if !ok {
			return http.StatusInternalServerError, current.State, "storage"
		}
		_, applyErr = atomic.ApplyAppleLifecycle(ctx, event, renewalState)
	} else {
		_, applyErr = s.Store().ApplySubscriptionSource(ctx, event)
	}
	if applyErr != nil {
		if errors.Is(applyErr, ErrExternalSubscriptionOwned) {
			s.recordAppleNotificationState(ctx, n.UUID, appleNotificationConflict, now)
			return http.StatusInternalServerError, appleNotificationConflict, "ownership_conflict"
		}
		if errors.Is(applyErr, ErrAppleSubscriptionConflict) {
			// Permanent until the existing live subscription lapses or an operator
			// resolves the paid conflict. Keep it visible as a conflict and answer
			// non-2xx so Apple's retry can re-evaluate the invariant after that state
			// changes; a local retry loop would only spin in the meantime.
			s.recordAppleNotificationState(ctx, n.UUID, appleNotificationConflict, now)
			return http.StatusInternalServerError, appleNotificationConflict, "apple_subscription_conflict"
		}
		log.Printf("apple notifications: applying %s failed: %v", n.UUID, applyErr)
		// Left non-terminal on purpose: the retry redoes the apply.
		return http.StatusInternalServerError, current.State, "storage"
	}

	// 7. RECORD THE COMPLETION. If this fails the answer is 500 and the row stays
	//    non-terminal, so Apple's retry applies the same event again — which is a
	//    no-op, because an equal event clock is not older than itself. Losing the
	//    completion record costs a repeated apply; losing the apply would cost an
	//    entitlement.
	if err := s.Store().SetAppleNotificationState(ctx, n.UUID, appleNotificationApplied, now.Unix()); err != nil {
		log.Printf("apple notifications: recording %s as applied failed: %v", n.UUID, err)
		return http.StatusInternalServerError, current.State, "storage_after_apply"
	}
	// Any EARLIER delivery for this subscription that was deferred for want of an
	// owner can now be replayed. Best effort: this delivery is already durably
	// applied, and a failure here leaves those rows exactly where they were.
	s.reconcileApplePendingNotifications(ctx, owner, appleSubscriptionKeyOf(tx), now)
	return http.StatusOK, appleNotificationApplied, "applied"
}

func appleRenewalMatchesTransaction(r AppleRenewalState, tx VerifiedAppleTransaction) bool {
	externalID, ok := appleSubscriptionKeyOf(tx).externalID()
	return ok && r.UserID != "" && r.ExternalID == externalID && r.BundleID == tx.BundleID
}

func preferDurableAppleRenewal(stored AppleRenewalState, exists bool, incoming AppleRenewalState, tx VerifiedAppleTransaction) (AppleRenewalState, bool) {
	if exists && appleRenewalMatchesTransaction(stored, tx) && stored.EventAt >= incoming.EventAt {
		return stored, true
	}
	return AppleRenewalState{}, false
}

// finishAppleNotification records a non-applied outcome and answers 200.
//
// Every state reachable through here is one where nothing needs to be redone:
// either the work is over (ignored, unsupported) or the event is durably
// preserved for a later replay (pending). A storage failure is the one thing
// that turns it into a retry, because then it is NOT recorded.
func (s *Service) finishAppleNotification(ctx context.Context, uuid, state, reason string, now time.Time) (int, string, string) {
	if err := s.Store().SetAppleNotificationState(ctx, uuid, state, now.Unix()); err != nil {
		log.Printf("apple notifications: recording %s as %s failed: %v", uuid, state, err)
		return http.StatusInternalServerError, appleNotificationReceived, "storage"
	}
	return http.StatusOK, state, reason
}

// recordAppleNotificationState writes a state whose HTTP answer is already
// decided. The write is still checked and logged: a conflict that could not be
// recorded is a conflict nobody will find later.
func (s *Service) recordAppleNotificationState(ctx context.Context, uuid, state string, now time.Time) {
	if err := s.Store().SetAppleNotificationState(ctx, uuid, state, now.Unix()); err != nil {
		log.Printf("apple notifications: recording %s as %s failed: %v", uuid, state, err)
	}
}

// resolveAppleNotificationOwner answers which Relayium account this
// subscription belongs to, from two INDEPENDENT keys.
//
//   - the external subscription binding (originalTransactionId), which is the
//     authority: it is what the entitlement is recorded against, and it survives
//     every renewal;
//   - the attribution token the purchase carried, which is how a subscription
//     acquires its first owner.
//
// Both present and DISAGREEING is ErrExternalSubscriptionOwned: Apple says this
// subscription's purchase was attributed to account A while this server has it
// bound to account B, and there is no version of "pick one" that is not a free
// paid plan for somebody. The binding wins nothing here — the caller refuses.
//
// Either one alone is enough. The binding alone covers every renewal of a
// subscription whose transactions no longer carry a usable token; the token
// alone covers the first notification for a purchase this server has not seen a
// transaction for yet. Neither resolving is "unknown", not "refuse": the
// notification is real and gets preserved.
func (s *Service) resolveAppleNotificationOwner(ctx context.Context, tx VerifiedAppleTransaction) (string, bool, error) {
	// The binding is looked up under the ENVIRONMENT-QUALIFIED id. Under the bare
	// originalTransactionId a Sandbox notification would resolve to the owner of
	// the Production subscription that happens to carry the same digits — and
	// then grant, revoke or conflict on somebody else's paid subscription. An
	// unqualifiable identity resolves to nothing rather than to a wider match.
	externalID, ok := appleSubscriptionKeyOf(tx).externalID()
	if !ok {
		return "", false, nil
	}
	boundOwner, bound, err := s.Store().UserByExternalSubscription(ctx, ProviderApple, externalID)
	if err != nil {
		return "", false, err
	}
	tokenOwner := ""
	if tx.AppAccountToken != "" {
		// A well-formed token nobody holds resolves to nothing. Possession
		// authorizes nothing either way — this is a lookup, not a credential check,
		// and unlike the authenticated intake there is no caller to compare it
		// against.
		u, found, err := s.Store().UserByAppleAccountToken(ctx, tx.AppAccountToken)
		if err != nil {
			return "", false, err
		}
		if found {
			tokenOwner = u.ID
		}
	}
	switch {
	case bound && tokenOwner != "" && boundOwner != tokenOwner:
		return "", false, ErrExternalSubscriptionOwned
	case bound:
		return boundOwner, true, nil
	case tokenOwner != "":
		return tokenOwner, true, nil
	}
	return "", false, nil
}

// appleNotificationProduct resolves the tier a STILL-GRANTING transaction pays
// for, and deliberately does not need one otherwise.
//
// A refund, an upgrade-replacement or an elapsed period all drop the source to
// the free tier (see appleSourceEvent), and none of them reads the product
// mapping. Requiring a catalog row for those would mean an operator who retired
// a mapping had thereby disabled REVOCATION for every subscription still using
// it — access would keep being granted because the event that ends it could not
// be resolved. Ending access must never depend on the catalog; only starting it
// does.
func (s *Service) appleNotificationProduct(ctx context.Context, tx VerifiedAppleTransaction, now time.Time) (AppleProduct, bool, error) {
	if !appleTransactionGrants(tx, now) {
		return AppleProduct{}, true, nil
	}
	return s.Store().AppleProductPlan(ctx, tx.BundleID, tx.ProductID)
}

// reconcileApplePendingNotifications replays the deferred notifications for one
// external subscription now that its owner is known.
//
// Called after an entitlement has been recorded for that subscription — from
// this endpoint and from the authenticated intake — because that is the moment
// an unattributable notification becomes attributable. It is BEST EFFORT by
// design: every row it cannot finish stays exactly where it was, still durable
// and still drainable next time.
//
// Ordering is not this function's problem. Each replay goes through
// ApplySubscriptionSource with the clock derived from its own transaction, so a
// pending row describing an older generation is dropped by the store even
// though it is being applied later in wall-clock time.
//
// ENVIRONMENT IS PART OF THE KEY. The stored rows are looked up by the raw
// originalTransactionId — that is what the column and its partial index hold —
// and partitioned here, so a Sandbox drain can never consume the deferred
// deliveries of the Production subscription with the same digits, or the other
// way round. Two skips come out of that partition and they are different facts:
//
//   - a row from the OTHER store is not this subscription's row at all. It stays
//     pending for its own drain, and there is nothing to report;
//   - a row with NO recorded environment predates that column. Which store it
//     came from is unknowable, and both guesses are unsafe — "Production" would
//     let an old Sandbox event reach a paid binding, "Sandbox" would strand a
//     real one — so it is skipped and LOGGED. Silence would make an undrainable
//     row indistinguishable from an absent one.
func (s *Service) reconcileApplePendingNotifications(ctx context.Context, userID string, key appleSubscriptionKey, now time.Time) {
	if userID == "" || key.OriginalTransactionID == "" || !appleSupportedEnvironment(key.Environment) {
		return
	}
	pending, err := s.Store().PendingAppleNotificationsFor(ctx, key.OriginalTransactionID)
	if err != nil {
		log.Printf("apple notifications: listing deferred deliveries failed: %v", err)
		return
	}
	for _, rec := range pending {
		if rec.Projection.Environment == "" {
			// One line per undrainable row, carrying only the UUID an operator can
			// look up. These exist only in a database that recorded pending rows
			// before the environment column, and they need a human decision.
			log.Printf("apple notifications: skipped deferred %s (unknown environment)", rec.UUID)
			continue
		}
		if rec.Projection.Environment != key.Environment {
			continue
		}
		tx := rec.Projection.transaction()
		product, mapped, err := s.appleNotificationProduct(ctx, tx, now)
		if err != nil {
			log.Printf("apple notifications: resolving the product for deferred %s failed: %v", rec.UUID, err)
			continue
		}
		if !mapped {
			// Still unmapped. The row stays pending; adding the catalog mapping and
			// letting the next delivery arrive is the recovery.
			continue
		}
		event := appleSourceEvent(userID, tx, product, now)
		if stored, ok, err := s.Store().GetAppleRenewalState(ctx, userID); err != nil {
			log.Printf("apple notifications: reading renewal for deferred %s failed: %v", rec.UUID, err)
			continue
		} else if ok && appleRenewalMatchesTransaction(stored, tx) {
			// An expired transaction normally needs no catalog lookup, but a
			// verified grace period restores its paid tier. Resolve that tier from
			// the durable renewal identity rather than writing active-with-no-plan.
			if !appleTransactionIsTerminal(tx) && stored.graceActive(now) && product.PlanID == "" {
				product, mapped, err = s.Store().AppleProductPlan(ctx, tx.BundleID, stored.CurrentProductID)
				if err != nil {
					log.Printf("apple notifications: resolving the grace product for deferred %s failed: %v", rec.UUID, err)
					continue
				}
				if !mapped {
					continue
				}
			}
			event = appleSourceEventWithRenewal(userID, tx, product, stored, now)
		}
		if _, err := s.Store().ApplySubscriptionSource(ctx, event); err != nil {
			log.Printf("apple notifications: replaying deferred %s failed: %v", rec.UUID, err)
			continue
		}
		if err := s.Store().SetAppleNotificationState(ctx, rec.UUID, appleNotificationApplied, now.Unix()); err != nil {
			log.Printf("apple notifications: recording deferred %s as applied failed: %v", rec.UUID, err)
			continue
		}
		log.Printf("apple notifications: applied (uuid %s, deferred_replay)", rec.UUID)
	}
}
