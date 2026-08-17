package account

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

// App Store Server Notifications V2: the verification half.
//
// Apple POSTs one compact JWS — `signedPayload` — to a URL configured in App
// Store Connect. Inside its payload sits ANOTHER compact JWS,
// `data.signedTransactionInfo`, and it is the inner one that carries the
// transaction an entitlement can be derived from.
//
// TWO ENVELOPES, TWO INDEPENDENT VERIFICATIONS. The outer signature proves that
// Apple sent this envelope. It proves nothing whatsoever about the string
// sitting in one of its fields, and a verifier that decoded the inner JWS
// because the outer one verified would accept an unsigned, attacker-authored
// transaction wrapped in a genuine envelope. So the inner JWS goes through the
// SAME chain/signature verification again, with its own size bound, and is
// trusted only on its own evidence.
//
// WHAT A NOTIFICATION IS NOT ALLOWED TO DECIDE. Not one entitlement fact comes
// from the envelope:
//
//   - `notificationType` and `subtype` are Apple's description of what happened.
//     They are recorded for operators and never read by any decision here. A
//     DID_RENEW that carries an expired transaction must not renew anything, and
//     a REFUND whose transaction has no revocationDate must not revoke anything;
//     believing the label over the signed transaction would make the label the
//     security boundary.
//   - `signedDate` selects the instant the certificate chain is validated at and
//     nothing else (see appleCandidateSignedDate). It is deliberately NOT the
//     replay clock: appleEventClock derives that from the transaction's own
//     purchaseDate, so an envelope re-signed today cannot outrank a newer
//     generation.
//   - `data.signedRenewalInfo` is independently verified and projected only as
//     renewal intent, billing-retry and bounded-grace state. It never supplies
//     a paid-through date by itself. Access still comes from the transaction,
//     with grace bounded by Apple's signed grace-period expiry.
//   - `data.status` is Apple's own subscription status enum. Same reason: it is
//     a summary of the transaction, and the transaction is present.
//
// So the entitlement path through a notification is exactly the entitlement
// path through the authenticated intake — appleSourceEvent over a
// VerifiedAppleTransaction — and this file's whole job is to produce that
// transaction, honestly, or to produce a refusal.

const (
	// appleMaxNotificationJWSBytes bounds the OUTER envelope.
	//
	// Deliberately much larger than appleMaxJWSBytes and deliberately a separate
	// constant. The envelope's payload contains two complete JWS documents
	// (transaction and renewal info), each carrying its own three-certificate
	// chain, and the envelope carries a third chain in its own header — so a real
	// notification is several times the size of a real transaction. One shared
	// bound would have to be the larger of the two, which would quietly grant a
	// transaction submitter four times the parser exposure they need.
	appleMaxNotificationJWSBytes = 64 << 10
	// appleMaxNotificationFieldLen bounds the envelope's short descriptive
	// strings (notificationType, subtype, version). They are stored and shown to
	// operators, never matched against anything, so the only property that
	// matters is that an oversized value cannot reach the database or a log.
	appleMaxNotificationFieldLen = 64
	// appleUUIDLen is the canonical 8-4-4-4-12 hyphenated form.
	appleUUIDLen = 36
)

// VerifiedAppleNotification is the ONLY projection of a notification anything
// downstream may read. Like VerifiedAppleTransaction there is no constructor
// that produces one without a verified signature behind every field.
type VerifiedAppleNotification struct {
	// UUID is Apple's `notificationUUID`, lower-cased. It is this delivery's
	// identity and the idempotency key; see the apple_notifications ledger.
	UUID string
	// Type and Subtype are DIAGNOSTIC ONLY — recorded so an operator can read the
	// ledger, never consulted by an entitlement decision. See the file comment.
	Type    string
	Subtype string
	// Version is Apple's payload version string, bounded and recorded. It is not
	// gated on: this route is reachable only by a JWS Apple signed, and refusing
	// an unrecognised version string would turn Apple's own schema evolution into
	// a total outage on a field that decides nothing.
	Version string
	// SignedDateMS is the envelope's own signing instant. Chain-validation input
	// and operator context; never an ordering clock.
	SignedDateMS int64
	// BundleID and Environment come from Apple's selected identity carrier, and
	// have already been matched against the configured app and, when present, the
	// nested transaction.
	BundleID    string
	Environment string
	AppAppleID  int64

	// HasTransaction is false for a notification that carries no
	// `data.signedTransactionInfo` at all — a summary-shaped RENEWAL_EXTENSION,
	// or a future notification type about something other than one transaction.
	// There is no entitlement to derive, and guessing one from the type is
	// exactly what this boundary refuses to do.
	HasTransaction bool
	// Transaction is the INDEPENDENTLY verified nested transaction. Meaningful
	// only when HasTransaction.
	Transaction VerifiedAppleTransaction
	Renewal     VerifiedAppleRenewalInfo
	HasRenewal  bool
	// Supported reports whether Transaction is a shape this server grants for —
	// an auto-renewable subscription the account holder purchased themselves
	// (appleSubscriptionShape). False is NOT a refusal: the payload is fully
	// verified and genuinely Apple's, it simply describes something this
	// entitlement model does not represent. The handler decides what to do with
	// it, and the one thing it may not do is silently drop it.
	Supported bool
}

// VerifyNotification verifies one App Store Server Notification V2 envelope and
// the transaction nested inside it.
//
// An error means REFUSE: the payload is not something Apple signed for an app
// this server is configured for. Anything else — including a verified
// notification this server has no entitlement rules for — comes back as a
// value, because "verified but not ours to act on" and "not verified" must not
// be the same answer to the caller.
func (v *AppleTransactionVerifier) VerifyNotification(signedPayload string, serverNow time.Time) (VerifiedAppleNotification, error) {
	if v == nil {
		// An unconfigured deployment. The caller turns this into a retryable 503;
		// what it must never turn into is an accepted notification.
		return VerifiedAppleNotification{}, rejectApple("verifier_absent")
	}
	payload, err := verifyAppleCompactJWS(signedPayload, v.roots, serverNow, appleMaxNotificationJWSBytes)
	if err != nil {
		return VerifiedAppleNotification{}, err
	}
	env, err := parseAppleNotificationEnvelope(payload)
	if err != nil {
		return VerifiedAppleNotification{}, err
	}

	out := VerifiedAppleNotification{
		UUID: env.UUID, Type: env.Type, Subtype: env.Subtype,
		Version: env.Version, SignedDateMS: env.SignedDateMS,
		BundleID: env.BundleID, Environment: env.Environment, AppAppleID: env.AppAppleID,
	}

	// THE ENVELOPE'S OWN IDENTITY, checked before anything nested is looked at
	// and checked even when nothing is nested. A notification for somebody else's
	// app is refused outright rather than recorded as an inert ledger row: Apple
	// signs every developer's notifications with the same chain, so the envelope
	// verifying proves only that SOME app's notification arrived here.
	if err := v.checkAppleNotificationApp(env); err != nil {
		return VerifiedAppleNotification{}, err
	}
	if env.SignedTransactionInfo == "" {
		// Nothing to derive an entitlement from, and no type-based guess is
		// permitted. Returned as a verified notification so the caller records it
		// and acknowledges it, rather than refusing a genuine Apple delivery
		// forever.
		return out, nil
	}

	// THE NESTED TRANSACTION, verified from scratch: its own chain to the same
	// configured roots, its own signature, its own payload parse, its own
	// app/environment identity. The envelope vouches for none of it.
	tx, err := v.verifyTransactionIdentity(env.SignedTransactionInfo, serverNow)
	if err != nil {
		return VerifiedAppleNotification{}, err
	}
	// CROSS-LAYER AGREEMENT. Both layers verified independently; that leaves the
	// case where each is individually genuine but they describe DIFFERENT things
	// — a real envelope for app A carrying a real transaction from app B. Both
	// signatures are valid and both apps are configured, so configuration cannot
	// catch it and only this comparison can. Relayium ships two apps, so it is a
	// reachable substitution rather than a theoretical one: without this, a macOS
	// purchase could be presented inside an iOS notification.
	//
	// BOTH halves do work now. bundleId always did. environment became
	// load-bearing the moment a deployment could configure both: the two layers
	// are each pinned to a SET rather than to a single value, so a Production
	// envelope carrying a genuine Sandbox transaction passes both membership
	// checks and only this comparison refuses it. Exact equality, not membership
	// — one notification describes one event in one store, and the environment
	// decides which subscription the nested transaction may touch
	// (appleSubscriptionKey). Getting it from the wrong layer would be an
	// entitlement written into the other store's namespace.
	//
	// appAppleId deliberately gets NO cross-layer comparison. Both layers are
	// pinned to the same configured app's numeric id — the envelope in
	// checkAppleNotificationApp, the transaction in verifyTransactionIdentity —
	// which
	// is strictly stronger than pinning them to each other, and a comparison
	// between two values already equal to the same constant could never fire.
	if tx.BundleID != env.BundleID || tx.Environment != env.Environment {
		return VerifiedAppleNotification{}, rejectApple("notification_layer_mismatch")
	}

	out.HasTransaction = true
	out.Transaction = tx
	if env.SignedRenewalInfo != "" {
		renewal, err := v.VerifyRenewalInfo(env.SignedRenewalInfo, tx, serverNow)
		if err != nil {
			return VerifiedAppleNotification{}, err
		}
		out.Renewal = renewal
		out.HasRenewal = true
	}
	// Verified either way; Supported only decides what the handler does with it.
	out.Supported = appleSubscriptionShape(tx) == nil
	return out, nil
}

// checkAppleNotificationApp requires the envelope's `data` object to name one
// CONFIGURED app, in this deployment's configured environment.
//
// This is the cross-layer configured-app check, and it is the reason a genuine
// notification for another developer's app cannot be replayed at this endpoint.
// Apple signs every developer's notifications with the same certificate chain,
// so "the signature verifies" narrows the sender to Apple and not to us.
//
// The appAppleId rule is per-DELIVERY, not per-deployment, and it only ever
// tightens:
//
//   - a PRODUCTION envelope must carry the configured App Store record's numeric
//     id and match it. Apple documents the field on the production `data` object,
//     and the configuration cannot be built without it once Production is
//     accepted, so there is always something to compare against;
//   - a SANDBOX envelope does not use it as an identity constraint. This matches
//     Apple's official server verifier, whose Sandbox mode checks bundleId but
//     deliberately ignores appAppleId whether the payload omits or supplies it.
//     Bundle identifiers are globally unique, and imposing an undocumented
//     Sandbox comparison would risk refusing a genuine delivery permanently.
//
// Reading the environment from the (already verified, already set-checked)
// envelope rather than from the deployment is what makes this correct for a
// deployment that accepts both: a Production delivery gets the Production rule
// even while Sandbox is also configured.
func (v *AppleTransactionVerifier) checkAppleNotificationApp(env appleNotificationEnvelope) error {
	if !v.acceptsEnvironment(env.Environment) {
		return rejectApple("environment")
	}
	app, ok := v.apps[env.BundleID]
	if !ok {
		return rejectApple("bundle")
	}
	// Production: required and matched. NewAppleTransactionVerifier guarantees
	// app.AppAppleID is non-zero here, so an absent envelope id (0) is a refusal
	// rather than a comparison against nothing.
	if env.Environment == appleEnvProduction {
		if env.AppAppleID != app.AppAppleID {
			return rejectApple("app_apple_id")
		}
	}
	return nil
}

// appleNotificationEnvelope is the decoded outer payload, reduced to the fields
// this server reads. Everything else Apple sends is deliberately not modelled:
// unknown keys are TOLERATED here (unlike the configuration file and the
// request body), because Apple adds fields to this schema without warning and a
// strict decode would turn every such addition into a total delivery outage.
// The duplicate-key and single-document guarantees still hold — they come from
// appleStrictJSONObject inside the JWS verification.
type appleNotificationEnvelope struct {
	UUID                  string
	Type                  string
	Subtype               string
	Version               string
	SignedDateMS          int64
	BundleID              string
	Environment           string
	AppAppleID            int64
	SignedTransactionInfo string
	SignedRenewalInfo     string
}

type appleNotificationIdentity struct {
	BundleID    string
	Environment string
	AppAppleID  json.Number
	ExternalID  string
}

func parseAppleNotificationEnvelope(raw []byte) (appleNotificationEnvelope, error) {
	var p struct {
		NotificationType string      `json:"notificationType"`
		Subtype          string      `json:"subtype"`
		NotificationUUID string      `json:"notificationUUID"`
		Version          string      `json:"version"`
		SignedDate       json.Number `json:"signedDate"`
		// Pointer so an ABSENT `data` is distinguishable from an empty one. Both
		// are handled the same way, but the distinction is what keeps a future
		// `"data": {}` from being read as "there was no data object".
		Data *struct {
			BundleID              string      `json:"bundleId"`
			Environment           string      `json:"environment"`
			AppAppleID            json.Number `json:"appAppleId"`
			SignedTransactionInfo string      `json:"signedTransactionInfo"`
			SignedRenewalInfo     string      `json:"signedRenewalInfo"`
		} `json:"data"`
		Summary *struct {
			BundleID    string      `json:"bundleId"`
			Environment string      `json:"environment"`
			AppAppleID  json.Number `json:"appAppleId"`
		} `json:"summary"`
		ExternalPurchaseToken *struct {
			BundleID           string      `json:"bundleId"`
			AppAppleID         json.Number `json:"appAppleId"`
			ExternalPurchaseID string      `json:"externalPurchaseId"`
		} `json:"externalPurchaseToken"`
		AppData *struct {
			BundleID    string      `json:"bundleId"`
			Environment string      `json:"environment"`
			AppAppleID  json.Number `json:"appAppleId"`
		} `json:"appData"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return appleNotificationEnvelope{}, rejectApple("notification_json")
	}

	env := appleNotificationEnvelope{
		UUID: strings.ToLower(p.NotificationUUID),
		Type: p.NotificationType, Subtype: p.Subtype, Version: p.Version,
	}
	// The idempotency key, and therefore a primary key in this server's database.
	// Its shape is checked BEFORE it can be written anywhere.
	if !validAppleNotificationUUID(env.UUID) {
		return appleNotificationEnvelope{}, rejectApple("notification_uuid")
	}
	// Bounded because they are stored and rendered, not because their content is
	// trusted. Apple's own values are short constants; anything long enough to
	// matter is not one.
	if len(env.Type) > appleMaxNotificationFieldLen ||
		len(env.Subtype) > appleMaxNotificationFieldLen ||
		len(env.Version) > appleMaxNotificationFieldLen {
		return appleNotificationEnvelope{}, rejectApple("notification_fields")
	}
	var err error
	if env.SignedDateMS, err = appleMillis(p.SignedDate, "signed_date"); err != nil {
		return appleNotificationEnvelope{}, err
	}
	// verifyAppleCompactJWS has already refused an absent, zero, non-integral or
	// future signedDate — it needed one to validate the chain at. Re-read here so
	// the recorded value is derived from the trusted parse rather than carried
	// across from the pre-trust probe.
	if env.SignedDateMS <= 0 {
		return appleNotificationEnvelope{}, rejectApple("signed_date")
	}

	// Apple's official verifier derives app identity from the first populated
	// carrier in this order: data, summary, externalPurchaseToken, appData. The
	// latter three carry no subscription transaction, but they still need their
	// app identity verified before this server can safely acknowledge them.
	var identity appleNotificationIdentity
	switch {
	case p.Data != nil:
		identity = appleNotificationIdentity{BundleID: p.Data.BundleID, Environment: p.Data.Environment, AppAppleID: p.Data.AppAppleID}
		env.SignedTransactionInfo = p.Data.SignedTransactionInfo
		env.SignedRenewalInfo = p.Data.SignedRenewalInfo
	case p.Summary != nil:
		identity = appleNotificationIdentity{BundleID: p.Summary.BundleID, Environment: p.Summary.Environment, AppAppleID: p.Summary.AppAppleID}
	case p.ExternalPurchaseToken != nil:
		identity = appleNotificationIdentity{BundleID: p.ExternalPurchaseToken.BundleID, AppAppleID: p.ExternalPurchaseToken.AppAppleID, ExternalID: p.ExternalPurchaseToken.ExternalPurchaseID}
		if strings.HasPrefix(identity.ExternalID, "SANDBOX") {
			identity.Environment = appleEnvSandbox
		} else {
			identity.Environment = appleEnvProduction
		}
	case p.AppData != nil:
		identity = appleNotificationIdentity{BundleID: p.AppData.BundleID, Environment: p.AppData.Environment, AppAppleID: p.AppData.AppAppleID}
	default:
		// A signed envelope with no recognized identity carrier cannot be tied to
		// one configured app, so it must not occupy this deployment's ledger.
		return appleNotificationEnvelope{}, rejectApple("notification_data")
	}
	env.BundleID = identity.BundleID
	env.Environment = identity.Environment
	if env.BundleID == "" || len(env.BundleID) > appleMaxProductIDLen {
		return appleNotificationEnvelope{}, rejectApple("notification_bundle")
	}
	if env.AppAppleID, err = appleInt(identity.AppAppleID, "app_apple_id"); err != nil {
		return appleNotificationEnvelope{}, err
	}
	if env.AppAppleID < 0 {
		return appleNotificationEnvelope{}, rejectApple("app_apple_id")
	}
	// Not trimmed, for the same reason the intake does not trim: the compact
	// serialization has no whitespace in it, so a value carrying some is
	// malformed rather than untidy — and normalizing it would mean the bytes
	// verified are not the bytes Apple signed into this envelope.
	if env.SignedTransactionInfo != strings.TrimSpace(env.SignedTransactionInfo) {
		return appleNotificationEnvelope{}, rejectApple("notification_transaction_info")
	}
	if env.SignedRenewalInfo != strings.TrimSpace(env.SignedRenewalInfo) {
		return appleNotificationEnvelope{}, rejectApple("notification_renewal_info")
	}
	return env, nil
}

// validAppleNotificationUUID checks the canonical hyphenated UUID shape.
//
// Deliberately NOT validAppAccountToken: that one additionally pins version 4
// and the RFC 4122 variant, which is correct for a token THIS server mints and
// wrong for one Apple mints. Apple documents notificationUUID as a UUID and
// promises no version; pinning one would refuse every real delivery the day
// Apple's generator changed, and the property actually needed here is only that
// a database key is a bounded, canonical, unambiguous string.
func validAppleNotificationUUID(s string) bool {
	if len(s) != appleUUIDLen {
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
	return true
}
