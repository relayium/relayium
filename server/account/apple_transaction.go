package account

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// The App Store transaction trust boundary: what a VERIFIED signature is
// allowed to mean.
//
// Cryptography is the first half (apple_jws.go) and by itself proves only that
// Apple signed something. The second half is here: the transaction must belong
// to an app THIS server is configured for, in the environment THIS server is
// configured for, and it must carry the fields an entitlement decision needs.
// Nothing in this file consults the network, an App Store credential or a
// client's opinion.

const (
	// Apple's two environment spellings, exactly as they appear in a signed
	// payload. There is no third: an unrecognised value is a payload we cannot
	// place, not a new environment to accommodate.
	appleEnvSandbox    = "Sandbox"
	appleEnvProduction = "Production"

	// The only product type this boundary grants for. A consumable or
	// non-renewing purchase has no period to project onto a subscription tier.
	appleAutoRenewableType = "Auto-Renewable Subscription"
	// inAppOwnershipType for a purchase the account holder made themselves. It is
	// REQUIRED, not merely checked when present: FAMILY_SHARED is a real Apple
	// state this intake does not model, and an absent field is exactly the case
	// where "assume it was purchased" would grant one.
	appleOwnershipPurchased = "PURCHASED"

	// appleMaxMillis is 9999-12-31T23:59:59Z in milliseconds — the outer bound
	// for anything Apple calls a date. Beyond it the value is not a clock
	// reading, and the seconds conversion below stops being meaningful.
	appleMaxMillis = 253402300799000
	// Identifier bounds. Apple's transaction ids are ~16 digits and product ids
	// are short reverse-DNS strings; these keep an oversized value out of the
	// database rather than describing Apple's format.
	//
	// appleMaxProductIDLen is also the product CATALOG's key bound — appleProductKeyMaxLen
	// is defined as this value, so the admin console cannot write a mapping whose
	// key this check would refuse to accept a purchase for. Raising it stays safe
	// in that direction (the catalog widens with it); lowering it can orphan rows
	// that already exist.
	appleMaxIDLen        = 64
	appleMaxProductIDLen = 200
)

// AppleAppConfig is one Relayium app as App Store Connect knows it.
//
// Both fields are per-APP, not per-account: the macOS and iOS builds ship
// different bundle ids and are separate App Store records, so they are two
// entries here and never one merged identity.
type AppleAppConfig struct {
	// BundleID is the app's bundle identifier, compared exactly against the
	// verified payload's bundleId.
	BundleID string
	// AppAppleID is the app's numeric App Store id ("Apple ID" in App Store
	// Connect). Required in production; see AppleTransactionVerifier.Verify for
	// what it can and cannot check.
	AppAppleID int64
}

// AppleStoreConfig is everything the transaction verifier is allowed to know.
// It is injected, never discovered: absent configuration leaves the endpoint
// answering "unavailable" rather than trusting a default.
type AppleStoreConfig struct {
	// Environments is the server's own answer to "which App Stores is this
	// deployment talking to" — a CLOSED SET drawn from Sandbox and Production.
	// It is NOT read from the payload, because a payload that names its own
	// environment can name either.
	//
	// One element is the ordinary deployment and the only shape that existed
	// before: a legacy `"environment": "Sandbox"` file is exactly a one-element
	// set. Two elements is the TestFlight/App Review case — a reviewer's purchase
	// is always Sandbox and a customer's is always Production, and one deployment
	// must accept both without letting either reach the other's subscriptions
	// (see apple_identity.go).
	Environments []string
	// Apps is the allowlist of bundle identities.
	Apps []AppleAppConfig
	// RootCertsPEM holds the Apple root CA(s) that anchor the signing chain, as
	// PEM. Explicit trust anchors, not the host root store and not the last
	// element of the JWS's own x5c.
	RootCertsPEM []byte
}

// AppleTransactionVerifier turns a submitted compact JWS into a trusted
// transaction, or into a refusal. It is immutable after construction and safe
// for concurrent use.
type AppleTransactionVerifier struct {
	// envs is the configured closed set. Membership is the whole rule: there is
	// no "any" mode and no fallback that retries a refused payload against the
	// other environment.
	envs map[string]struct{}
	// envList is the same set in configuration order, for the boot log and for
	// error messages. Never consulted by a decision.
	envList []string
	apps    map[string]AppleAppConfig
	roots   *x509.CertPool
}

// NewAppleTransactionVerifier validates the configuration and builds the
// verifier. It fails rather than degrading: half a trust boundary is worse than
// none, because the endpoint in front of it would start returning 200.
func NewAppleTransactionVerifier(cfg AppleStoreConfig) (*AppleTransactionVerifier, error) {
	envs, envList, err := appleEnvironmentSet(cfg.Environments)
	if err != nil {
		return nil, err
	}
	if len(cfg.Apps) == 0 {
		return nil, errors.New("account: apple store needs at least one configured app")
	}
	// Whether Production is ACCEPTED, not whether it is the only thing accepted.
	// A dual-environment deployment verifies real money, so it owes the same
	// answer to "which App Store record is this" that a Production-only one does.
	_, acceptsProduction := envs[appleEnvProduction]
	apps := make(map[string]AppleAppConfig, len(cfg.Apps))
	for _, app := range cfg.Apps {
		bundle := strings.TrimSpace(app.BundleID)
		if bundle == "" {
			return nil, errors.New("account: apple store app needs a bundle id")
		}
		if _, dup := apps[bundle]; dup {
			return nil, fmt.Errorf("account: apple store app %q is configured twice", bundle)
		}
		if app.AppAppleID < 0 {
			return nil, fmt.Errorf("account: apple store app %q has a negative appAppleId", bundle)
		}
		// Production must be able to say which App Store record it means, so the
		// day a payload carries an appAppleId there is something to compare it
		// with. Sandbox has no such record.
		//
		// A deployment that accepts Production AND Sandbox owes this too, and for
		// a sharper reason than a Production-only one: its Production envelopes
		// carry an appAppleId that must be matched, and leaving the configured
		// value at 0 would make that comparison compare against nothing. The
		// requirement is therefore on ACCEPTANCE of Production, not on exclusivity.
		if acceptsProduction && app.AppAppleID == 0 {
			return nil, fmt.Errorf("account: production apple store app %q needs its appAppleId", bundle)
		}
		apps[bundle] = AppleAppConfig{BundleID: bundle, AppAppleID: app.AppAppleID}
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(cfg.RootCertsPEM) {
		return nil, errors.New("account: apple store trust roots are missing or unparsable")
	}
	return &AppleTransactionVerifier{envs: envs, envList: envList, apps: apps, roots: roots}, nil
}

// appleEnvironmentSet validates the configured environments into a closed set.
//
// The rules are all refusals to build a verifier, because every one of them
// describes a deployment that would be verifying against something other than
// what its author wrote down:
//
//   - EMPTY is not "accept whatever arrives". There is no Any mode here; a
//     deployment states which App Stores it is talking to or it does not verify.
//   - Only Apple's own two spellings, exactly. "sandbox" and " Production " are
//     the shapes a hand-edited file produces, and a case-insensitive match would
//     make the configured set and the signed payload comparable under two
//     different rules. Surrounding whitespace IS trimmed, which is what the
//     single-environment reader always did.
//   - A DUPLICATE is refused rather than deduplicated. It is a one-element set
//     written twice, and silently collapsing it hides the edit that meant to add
//     the other environment and repeated this one.
//   - TWO is the maximum, which is the whole set. The bound is stated rather
//     than implied by the value check so the intent survives a future spelling.
func appleEnvironmentSet(configured []string) (map[string]struct{}, []string, error) {
	if len(configured) == 0 {
		return nil, nil, fmt.Errorf("account: apple store needs at least one environment (%q and/or %q)",
			appleEnvProduction, appleEnvSandbox)
	}
	if len(configured) > 2 {
		return nil, nil, fmt.Errorf("account: apple store lists %d environments (max 2: %q and %q)",
			len(configured), appleEnvProduction, appleEnvSandbox)
	}
	envs := make(map[string]struct{}, len(configured))
	list := make([]string, 0, len(configured))
	for _, raw := range configured {
		env := strings.TrimSpace(raw)
		if !appleSupportedEnvironment(env) {
			// The offending value is named: with a two-element set, "one of these is
			// wrong" is not something an operator can act on. Configuration values
			// are public material and already appear in startup errors.
			return nil, nil, fmt.Errorf("account: apple store environment %q must be %q or %q",
				raw, appleEnvSandbox, appleEnvProduction)
		}
		if _, dup := envs[env]; dup {
			return nil, nil, fmt.Errorf("account: apple store environment %q is configured twice", env)
		}
		envs[env] = struct{}{}
		list = append(list, env)
	}
	return envs, list, nil
}

// Environments reports the configured closed set, in configuration order. It is
// operator-facing only — the boot log states which App Stores a deployment is
// now verifying — and no decision reads it. A nil verifier configures nothing.
func (v *AppleTransactionVerifier) Environments() []string {
	if v == nil {
		return nil
	}
	return append([]string(nil), v.envList...)
}

// acceptsEnvironment reports whether a VERIFIED payload's own environment is one
// this deployment configured. Membership in a closed set, with no fallback: a
// payload from the other store is refused outright rather than retried under a
// different rule.
func (v *AppleTransactionVerifier) acceptsEnvironment(env string) bool {
	_, ok := v.envs[env]
	return ok
}

// ConfiguredApp resolves one bundle identifier against the verifier's OWN
// allowlist, returning the configured entry.
//
// It exists so a caller can ask "is this an app this deployment is configured
// for" WITHOUT a signed payload — the catalog read API is the only such caller,
// and it needs the question answered before it will describe anything. The
// answer is the configured value rather than the caller's string, so nothing
// downstream can echo an attacker-shaped identifier back as though the server
// had accepted it.
//
// It grants nothing. A true answer means only that the bundle is one this
// server would ACCEPT a signed transaction for; every entitlement still goes
// through Verify and the catalog, and a nil verifier answers false, which is
// what keeps an unconfigured deployment fail-closed.
func (v *AppleTransactionVerifier) ConfiguredApp(bundleID string) (AppleAppConfig, bool) {
	if v == nil {
		return AppleAppConfig{}, false
	}
	app, ok := v.apps[bundleID]
	return app, ok
}

// VerifiedAppleTransaction is the ONLY projection of a transaction anything
// downstream may read. Every field in it came out of a payload whose signature
// chained to a configured root; there is no constructor that produces one
// without that.
type VerifiedAppleTransaction struct {
	BundleID              string
	ProductID             string
	TransactionID         string
	OriginalTransactionID string
	// AppAccountToken is the server-issued attribution UUID, normalized to lower
	// case. It says which account the purchase CLAIMS to belong to; the store
	// decides whether that claim is the submitter's to make.
	AppAccountToken string
	Environment     string
	Type            string
	OwnershipType   string
	// IsUpgraded is Apple's "this transaction was replaced by an upgrade". It is
	// optional in the payload: ABSENT means false, and any present value that is
	// not a JSON boolean — `null` included — is a refusal rather than a
	// truthiness guess. See appleOptionalBool.
	IsUpgraded bool
	AppAppleID int64
	// Apple's timestamps, kept in their native milliseconds. They are converted
	// once, deliberately, where a seconds value is actually needed.
	PurchaseDateMS   int64
	ExpiresDateMS    int64
	RevocationDateMS int64
	SignedDateMS     int64
}

// Verify checks one compact JWS and returns the trusted transaction.
//
// `serverNow` is the explicit receipt time, threaded in rather than read from
// time.Now() inside the verifier so the service clock, the tests and the audit
// trail all agree. It is what bounds a future-dated signedDate; the certificate
// chain is validated at that signedDate instead (appleCandidateSignedDate), and
// the expiry decision belongs to the caller (appleSourceEvent), which has the
// product mapping the decision also depends on.
func (v *AppleTransactionVerifier) Verify(signedTransaction string, serverNow time.Time) (VerifiedAppleTransaction, error) {
	tx, err := v.verifyTransactionIdentity(signedTransaction, serverNow)
	if err != nil {
		return VerifiedAppleTransaction{}, err
	}
	// ATTRIBUTION IS REQUIRED HERE, and only here. This is the submission path:
	// its entire ownership decision is "the token in the payload resolves to the
	// authenticated caller", so a transaction carrying no token has nothing that
	// decision could be made from and is refused with the same code a malformed
	// one has always produced. The notification path has a second, independent
	// key (the recorded originalTransactionId binding) and therefore does not
	// need this one — see resolveAppleNotificationOwner.
	if tx.AppAccountToken == "" {
		return VerifiedAppleTransaction{}, rejectApple("app_account_token")
	}
	if err := appleSubscriptionShape(tx); err != nil {
		return VerifiedAppleTransaction{}, err
	}
	return tx, nil
}

// verifyTransactionIdentity is everything Verify does EXCEPT the subscription
// narrowing: the signature, the chain, the payload parse, and the identity of
// the app and environment the transaction claims to belong to.
//
// It is split out for the notification path, and for one reason only. On the
// authenticated intake there is exactly one useful answer to a transaction this
// server does not model — refuse it, because a client submitting a consumable
// or a family-shared purchase to a subscription endpoint has nothing to be
// granted. A notification is not a submission: Apple is telling us something
// happened, and "this is not a shape we grant for" is a different fact from
// "this did not come from Apple". Collapsing them would make the notification
// handler unable to tell a forged payload (refuse, never acknowledge) from a
// genuine event about a subscription we may well own (acknowledge, but record —
// see applyAppleNotification).
//
// Everything below the split is unchanged and stays in one place, so the two
// callers cannot drift into two trust boundaries.
func (v *AppleTransactionVerifier) verifyTransactionIdentity(signedTransaction string, serverNow time.Time) (VerifiedAppleTransaction, error) {
	if v == nil {
		// An unconfigured deployment. The caller turns this into 503; what it must
		// never turn into is an accepted transaction.
		return VerifiedAppleTransaction{}, rejectApple("verifier_absent")
	}
	payload, err := verifyAppleCompactJWS(signedTransaction, v.roots, serverNow, appleMaxJWSBytes)
	if err != nil {
		return VerifiedAppleTransaction{}, err
	}
	tx, err := parseAppleTransactionPayload(payload)
	if err != nil {
		return VerifiedAppleTransaction{}, err
	}
	// Environment first: a sandbox purchase is free, and accepting one in a
	// deployment that did not ask for sandbox would make every paid tier free.
	//
	// A deployment that DID ask for both is not thereby accepting a free paid
	// tier: the environment stays part of the subscription's identity all the way
	// through (appleSubscriptionKey), so a Sandbox transaction can only ever
	// grant on a Sandbox subscription of its own.
	if !v.acceptsEnvironment(tx.Environment) {
		return VerifiedAppleTransaction{}, rejectApple("environment")
	}
	app, ok := v.apps[tx.BundleID]
	if !ok {
		return VerifiedAppleTransaction{}, rejectApple("bundle")
	}
	// appAppleId, honestly.
	//
	// Apple documents it on the App Store Server Notifications V2 `data` object
	// (production only) and on the app transaction — NOT on
	// JWSTransactionDecodedPayload, which is what a StoreKit client submits. So
	// this comparison is written to fire whenever Apple DOES supply the field,
	// while the required production configuration above makes the value exist
	// before any notification path can be wired to it. A payload that supplies an
	// id we cannot match (any id at all in a sandbox deployment, which declares
	// none) is refused rather than accepted unchecked: it did not come from an
	// app this server is configured for.
	//
	// The notification path does NOT rely on this being reachable: it compares
	// the envelope's own appAppleId against the same configured app explicitly
	// (see appleNotificationCrossLayerIdentity), because that is the field Apple
	// actually populates and it is the one an attacker would aim at.
	if tx.AppAppleID != 0 && tx.AppAppleID != app.AppAppleID {
		return VerifiedAppleTransaction{}, rejectApple("app_apple_id")
	}
	return tx, nil
}

// appleSubscriptionShape is the narrowing to what this server grants for: an
// auto-renewable subscription the account holder bought themselves.
//
// Separated from the identity checks so a caller can ask the two questions
// independently, and returning the SAME rejection codes it always did so the
// intake's behaviour is byte-for-byte what it was.
func appleSubscriptionShape(tx VerifiedAppleTransaction) error {
	if tx.Type != appleAutoRenewableType {
		return rejectApple("type")
	}
	if tx.OwnershipType != appleOwnershipPurchased {
		return rejectApple("ownership")
	}
	return nil
}

// parseAppleTransactionPayload reads the verified payload. Absent, malformed
// and impossible values are refusals, never zero values that later code has to
// remember to re-check.
func parseAppleTransactionPayload(raw []byte) (VerifiedAppleTransaction, error) {
	// json.Number for every timestamp: it keeps the literal Apple sent, so a
	// float, an overflowing integer and a quoted number are all distinguishable
	// from a millisecond count instead of silently becoming one.
	var p struct {
		TransactionID         string `json:"transactionId"`
		OriginalTransactionID string `json:"originalTransactionId"`
		BundleID              string `json:"bundleId"`
		ProductID             string `json:"productId"`
		Type                  string `json:"type"`
		InAppOwnershipType    string `json:"inAppOwnershipType"`
		Environment           string `json:"environment"`
		AppAccountToken       string `json:"appAccountToken"`
		// RawMessage, not *bool: decoding JSON `null` into a pointer yields nil,
		// which is indistinguishable from an absent field — and `null` is not the
		// documented optional-absent form, it is a present value of the wrong type.
		IsUpgraded     json.RawMessage `json:"isUpgraded"`
		AppAppleID     json.Number     `json:"appAppleId"`
		PurchaseDate   json.Number     `json:"purchaseDate"`
		ExpiresDate    json.Number     `json:"expiresDate"`
		RevocationDate json.Number     `json:"revocationDate"`
		SignedDate     json.Number     `json:"signedDate"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return VerifiedAppleTransaction{}, rejectApple("payload_json")
	}

	isUpgraded, err := appleOptionalBool(p.IsUpgraded, "is_upgraded")
	if err != nil {
		return VerifiedAppleTransaction{}, err
	}

	tx := VerifiedAppleTransaction{
		BundleID:      p.BundleID,
		ProductID:     p.ProductID,
		TransactionID: p.TransactionID, OriginalTransactionID: p.OriginalTransactionID,
		Environment: p.Environment, Type: p.Type, OwnershipType: p.InAppOwnershipType,
		IsUpgraded: isUpgraded,
		// Apple's UUIDs may arrive in either case; RFC 4122 hex is
		// case-insensitive, and the stored token is lower case.
		AppAccountToken: strings.ToLower(p.AppAccountToken),
	}
	if tx.TransactionID == "" || len(tx.TransactionID) > appleMaxIDLen ||
		tx.OriginalTransactionID == "" || len(tx.OriginalTransactionID) > appleMaxIDLen {
		return VerifiedAppleTransaction{}, rejectApple("transaction_ids")
	}
	// The separator that divides the environment namespace from the id
	// (apple_identity.go) may not occur INSIDE an id. Apple's transaction ids are
	// digits, so this refuses nothing real — and it is what makes the Sandbox
	// namespace a partition rather than a naming convention: without it, a
	// Sandbox subscription could present `sandbox:2000000000000001` and be
	// qualified into another Sandbox subscription's external id, or a Production
	// one could spell itself into the Sandbox namespace. Checked on BOTH ids: the
	// original is the one that becomes the external id today, and a transactionId
	// carrying the separator is the same malformed value one field over.
	if strings.Contains(tx.TransactionID, appleExternalIDSeparator) ||
		strings.Contains(tx.OriginalTransactionID, appleExternalIDSeparator) {
		return VerifiedAppleTransaction{}, rejectApple("transaction_ids")
	}
	if tx.BundleID == "" || len(tx.BundleID) > appleMaxProductIDLen ||
		tx.ProductID == "" || len(tx.ProductID) > appleMaxProductIDLen {
		return VerifiedAppleTransaction{}, rejectApple("product_ids")
	}
	// Shape only, and only when there is one. Whether this token is the
	// submitter's is the store's answer, and possession of it authorizes nothing
	// either way.
	//
	// ABSENT is not refused HERE, and the distinction matters on exactly one
	// path. A purchase made outside Relayium's own StoreKit flow carries no
	// appAccountToken at all, and Apple still sends notifications about it. On
	// the authenticated intake that transaction is useless — there is no
	// attribution to compare the caller against — and Verify refuses it with this
	// same code. On the notification path it is a real event about a real
	// subscription, one this server may already own by originalTransactionId, and
	// refusing it outright would mean Apple retries a few times and then drops
	// the only notice we will ever get. So absence becomes "unattributed" for the
	// caller to resolve, while a present-but-malformed value stays a refusal
	// everywhere: that one is a claim, and a malformed claim is not a missing one.
	if tx.AppAccountToken != "" && !validAppAccountToken(tx.AppAccountToken) {
		return VerifiedAppleTransaction{}, rejectApple("app_account_token")
	}

	if tx.AppAppleID, err = appleInt(p.AppAppleID, "app_apple_id"); err != nil {
		return VerifiedAppleTransaction{}, err
	}
	if tx.AppAppleID < 0 {
		return VerifiedAppleTransaction{}, rejectApple("app_apple_id")
	}
	if tx.PurchaseDateMS, err = appleMillis(p.PurchaseDate, "purchase_date"); err != nil {
		return VerifiedAppleTransaction{}, err
	}
	if tx.ExpiresDateMS, err = appleMillis(p.ExpiresDate, "expires_date"); err != nil {
		return VerifiedAppleTransaction{}, err
	}
	if tx.RevocationDateMS, err = appleMillis(p.RevocationDate, "revocation_date"); err != nil {
		return VerifiedAppleTransaction{}, err
	}
	// Re-read here rather than carried over from appleCandidateSignedDate: this
	// is the same field of the same verified bytes, and reading it once more
	// keeps the trusted projection derived entirely from the trusted parse.
	if tx.SignedDateMS, err = appleMillis(p.SignedDate, "signed_date"); err != nil {
		return VerifiedAppleTransaction{}, err
	}
	// purchaseDate is the base of the ordering clock (see appleEventClock) and
	// expiresDate is the access window; a subscription transaction without both
	// is not one this boundary can decide anything from.
	if tx.PurchaseDateMS <= 0 {
		return VerifiedAppleTransaction{}, rejectApple("purchase_date")
	}
	if tx.ExpiresDateMS <= 0 {
		return VerifiedAppleTransaction{}, rejectApple("expires_date")
	}
	return tx, nil
}

// appleOptionalBool reads a field Apple documents as an optional boolean.
//
// ABSENT is the only thing that means "false by default": the field is simply
// not there, which is what Apple's own "optional" means. A field that IS there
// must be a JSON boolean — `null`, `"true"`, `1` and `[]` are present values of
// the wrong type, and treating any of them as absence would let a payload turn
// a flag that decides whether a transaction still grants into a default.
//
// json.RawMessage carries the value's exact bytes, so the two boolean literals
// are the whole accepted set; the payload has already been through
// appleStrictJSONObject, so those bytes are one unambiguous JSON value.
func appleOptionalBool(raw json.RawMessage, code string) (bool, error) {
	if len(raw) == 0 {
		return false, nil
	}
	switch string(bytes.TrimSpace(raw)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, rejectApple(code)
}

// appleMillis converts one of Apple's millisecond timestamps. "" means the
// field was absent and yields 0 — the caller decides whether that is allowed.
// A negative or absurd value is a refusal: it would otherwise become a date in
// the database that no later comparison can make sense of.
func appleMillis(n json.Number, code string) (int64, error) {
	ms, err := appleInt(n, code)
	if err != nil {
		return 0, err
	}
	if ms < 0 || ms > appleMaxMillis {
		return 0, rejectApple(code)
	}
	return ms, nil
}

// appleInt parses an integral JSON number. ParseInt is what refuses "1.5",
// "1e3" and anything wider than int64 — none of which is a value Apple emits,
// and all of which would otherwise be rounded into one by a float decode.
func appleInt(n json.Number, code string) (int64, error) {
	s := n.String()
	if s == "" {
		return 0, nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, rejectApple(code)
	}
	return v, nil
}

// appleSeconds converts a bounded millisecond timestamp to the unix seconds the
// subscription model stores. Truncation toward the past is deliberate: a period
// end must never be rounded UP into access nobody paid for.
func appleSeconds(ms int64) int64 { return ms / 1000 }
