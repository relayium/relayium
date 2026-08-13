package account

import "strings"

// The identity of ONE App Store subscription, in a deployment that accepts more
// than one signed environment at a time.
//
// WHY THIS EXISTS. Apple's `originalTransactionId` is the subscription's
// identity across every renewal, and it is what `subscription_sources.external_id`
// records. It is unique WITHIN an environment and says nothing across them:
// Sandbox and Production are two separate stores that number their transactions
// independently, so the same digits can name a real paid subscription in one and
// a free App Review purchase in the other. A deployment that verifies both — the
// one TestFlight and App Review require, because a reviewer's purchase is always
// Sandbox — therefore cannot use those digits alone as an ownership key. Doing so
// would let a Sandbox purchase resolve to the Production subscription's owner:
// steal it, drain its deferred notifications, or revoke what somebody paid for.
//
// THE QUALIFICATION, and its two halves:
//
//	Production: <originalTransactionId>          (byte-for-byte unchanged)
//	Sandbox:    sandbox:<originalTransactionId>
//
// Production is deliberately NOT re-spelled. Every id already recorded by a
// single-environment deployment is a Production id, and a scheme that renamed
// them would orphan every existing binding — the entitlement would stay granted
// while the subscription that pays for it became unreachable to every lookup,
// refund and reconcile. So the qualification is additive: it changes the
// namespace that has no rows in it.
//
// The namespace is UNFORGEABLE because the separator cannot occur inside an
// Apple id: parseAppleTransactionPayload refuses any transaction whose
// transactionId or originalTransactionId contains it (see the appleMaxIDLen
// checks). Without that refusal a Sandbox purchase could present the literal
// originalTransactionId `sandbox:2000000000000001` and land on the qualified key
// of another Sandbox subscription — or, the other direction, a Production id
// spelled with the prefix could impersonate a Sandbox one. The rejection is what
// turns a naming convention into a partition.
const (
	// appleExternalIDSeparator divides the namespace from the id. It is refused
	// inside any Apple-supplied transaction id, which is what makes the two
	// namespaces disjoint rather than merely distinct-looking.
	appleExternalIDSeparator = ":"
	// appleSandboxExternalPrefix qualifies a Sandbox subscription. Lower case and
	// fixed: it is a namespace this server chose, not a value Apple ever sends.
	appleSandboxExternalPrefix = "sandbox" + appleExternalIDSeparator
)

// appleSupportedEnvironment reports whether env is one of Apple's two signed
// environment spellings, exactly as they appear in a payload. Case-sensitive on
// purpose: "sandbox" is not a spelling Apple emits, and accepting it would mean
// the configured closed set and the verified payload were compared under
// different rules.
func appleSupportedEnvironment(env string) bool {
	return env == appleEnvSandbox || env == appleEnvProduction
}

// appleSubscriptionKey is one subscription's full identity: Apple's
// originalTransactionId plus the signed environment it belongs to.
//
// Both halves are required. A key with either half missing produces no external
// id at all rather than a partial one, because a partial key is exactly the
// cross-environment collision this type exists to prevent.
type appleSubscriptionKey struct {
	OriginalTransactionID string
	Environment           string
}

// appleSubscriptionKeyOf reads the key out of a VERIFIED transaction. There is
// no constructor from anything else: both fields must have come through a JWS
// that verified and an environment the verifier's configured set contains.
func appleSubscriptionKeyOf(tx VerifiedAppleTransaction) appleSubscriptionKey {
	return appleSubscriptionKey{
		OriginalTransactionID: tx.OriginalTransactionID,
		Environment:           tx.Environment,
	}
}

// externalID renders the key as the provider-scoped subscription id that
// subscription_sources records and every ownership lookup resolves through.
//
// The boolean is not a formality. An empty environment is what a ledger row
// written before this column existed carries, and there is no honest way to
// guess which store it came from — guessing "Production" would let a replayed
// Sandbox event reach a paid binding, and guessing "Sandbox" would strand a real
// one. Callers must treat false as "this row cannot be replayed", never as an
// empty id: SourceEvent.ExternalID reads "" as PRESERVE THE RECORDED BINDING,
// so a silent fallthrough would apply an entitlement against whatever id the
// user's row already held.
func (k appleSubscriptionKey) externalID() (string, bool) {
	if k.OriginalTransactionID == "" ||
		strings.Contains(k.OriginalTransactionID, appleExternalIDSeparator) {
		return "", false
	}
	switch k.Environment {
	case appleEnvProduction:
		return k.OriginalTransactionID, true
	case appleEnvSandbox:
		return appleSandboxExternalPrefix + k.OriginalTransactionID, true
	}
	return "", false
}

// appleExternalIDIsSandbox reports whether a recorded external subscription id
// sits in the Sandbox namespace.
//
// Written against the STORED id rather than an environment field so it answers
// for rows this process did not write, including one bound by another instance.
// The caller must also establish that the row belongs to ProviderApple; this
// string helper alone cannot distinguish another provider that happens to use
// the same prefix.
func appleExternalIDIsSandbox(externalID string) bool {
	return strings.HasPrefix(externalID, appleSandboxExternalPrefix)
}
