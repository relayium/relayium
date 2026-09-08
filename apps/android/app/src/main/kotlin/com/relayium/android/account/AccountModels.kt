package com.relayium.android.account

/**
 * Why an account operation did not succeed, as a CLASSIFICATION the UI maps to
 * localised copy.
 *
 * Deliberately not a message. Server prose is not localised, is written for a
 * different audience, and — for the endpoints here — is sometimes a bare
 * `http.Error` string that would read as gibberish in a Chinese UI. So the wire
 * is read for the codes it documents (`email_unverified`, `invalid_email`,
 * `traffic_exhausted`, …) and everything else becomes [Kind.SERVER] carrying
 * the numeric [status] — a bounded diagnostic a user can quote in a bug report
 * without any of it being attacker-chosen text rendered in the app.
 */
data class AccountFailure(val kind: Kind, val status: Int = 0) {

    enum class Kind {
        /** Nothing reached the server. */
        NETWORK,
        TIMEOUT,
        /** The response was larger than this client will buffer. */
        RESPONSE_TOO_LARGE,
        /** The server answered something this client cannot read. Includes a
         *  status the endpoint documents whose BODY is not the documented
         *  shape: guessing there is how a client signs someone in wrongly. */
        MALFORMED,
        /** A status this endpoint does not document; [status] carries which. */
        SERVER,
        RATE_LIMITED,

        /** Email/password rejected, or a bearer the server no longer honours. */
        INVALID_CREDENTIALS,
        /** The request needed an account and had none. */
        NOT_SIGNED_IN,

        EMAIL_INVALID,
        PASSWORD_TOO_SHORT,
        EMAIL_TAKEN,
        /** Registration refused: an account on this address is mid-grace-period. */
        ACCOUNT_PENDING_DELETION,

        /** The human refused the browser approval. */
        DEVICE_DENIED,
        /** The device-code request ran out of time. */
        DEVICE_EXPIRED,
        /**
         * The server named a verification page that is not on this app's own
         * origin. Refused rather than opened: that URL is where a human is
         * asked to authorise a credential, and sending them to a host chosen
         * by the response is the whole phishing surface of this flow.
         */
        UNTRUSTED_VERIFICATION_URL,

        /** This account's monthly traffic allowance is spent, so a cross-network
         *  code would name a rendezvous it cannot complete (`traffic_exhausted`). */
        PAIR_TRAFFIC_EXHAUSTED,
        /** The registry could not mint right now (503) — worth retrying. */
        PAIR_UNAVAILABLE,
        /** The server answered a code this client will not show: not exactly six
         *  ASCII digits, or already expired on arrival. */
        PAIR_CODE_REJECTED,

        /**
         * The credential this device holds cannot be used at all — it is not a
         * value that can be put in an `Authorization` header. Distinct from
         * [INVALID_CREDENTIALS], which is the SERVER refusing a well-formed
         * token; nothing was sent here. Both have the same recovery (drop it
         * and sign in again), and neither may ever carry the value itself.
         */
        CREDENTIAL_UNUSABLE,

    }

    companion object {
        fun of(failure: TransportResult.Failure): AccountFailure = AccountFailure(
            when (failure) {
                TransportResult.Failure.NETWORK -> Kind.NETWORK
                TransportResult.Failure.TIMEOUT -> Kind.TIMEOUT
                TransportResult.Failure.TOO_LARGE -> Kind.RESPONSE_TOO_LARGE
                TransportResult.Failure.NOT_TEXT -> Kind.MALFORMED
                TransportResult.Failure.REQUEST_REJECTED -> Kind.CREDENTIAL_UNUSABLE
            },
        )
    }
}

/**
 * The account, as `/api/me` describes it.
 *
 * A SUBSET of that response on purpose: this app renders an identity and a
 * plan, and it has no billing controls at all — no checkout, no cancellation,
 * no provider management — so the subscription/provider fields that exist to
 * decide which billing button to show are deliberately not carried. What is
 * here is what is displayed, and the server stays the authority for all of it.
 */
data class AccountUser(
    val id: String,
    val email: String,
    val displayName: String,
    val emailVerified: Boolean,
    /** The EFFECTIVE tier id the server computed. Rendered as the server's own
     *  plan name from `/api/me/usage`, never re-derived here. */
    val planId: String,
    /** How this account can sign in: `password` plus any linked provider. */
    val linkedMethods: List<String>,
)

/** One quota: bytes used against a cap, where **0 means unlimited** — the
 *  server's documented spelling (`nonNegCap`), not an empty allowance. */
data class Quota(val used: Long, val cap: Long) {
    val unlimited: Boolean get() = cap <= 0L
}

/** This month's position against this account's quotas, as `/api/me/usage`
 *  reports it. Every number is the server's; none is computed here. */
data class AccountUsage(
    val planName: String,
    val resetsAt: Long,
    val traffic: Quota,
    val storage: Quota,
)

/** One row of `/api/devices`. */
data class AccountDevice(
    val id: String,
    val name: String,
    val kind: String,
    val createdAt: Long,
    val lastSeenAt: Long,
    /** The server marked this row as the one THIS bearer is bound to. */
    val current: Boolean,
)

/** What a native sign-in produced. Three outcomes, because the server has three
 *  and collapsing any two of them would be a claim about the account that is
 *  not true. */
sealed interface LoginOutcome {
    /**
     * A bearer.
     *
     * `toString` is redacted: this value IS the credential, and a data class
     * that prints its fields puts it into every assertion message, log line and
     * crash report that ever stringifies the outcome.
     */
    data class Session(val token: String) : LoginOutcome {
        override fun toString(): String = "Session(token=<redacted>)"
    }

    /** Correct credentials, but the address has never been confirmed. No
     *  session exists and none can until the emailed link is opened. */
    data class EmailUnverified(val email: String) : LoginOutcome

    /**
     * Correct credentials, but the account is inside its deletion grace period.
     * HTTP 200 and NOT a session.
     *
     * The server also returns a `reactivateToken` here. It is deliberately NOT
     * carried: it is the one value that can undo a deletion, this app has no
     * screen that can spend it (reactivation is a browser flow), and a token
     * this type held would end up in a state object, a saved instance bundle or
     * a diagnostic. The user reactivates from the link that was emailed when
     * the deletion was requested.
     */
    data class PendingDeletion(val purgeAfter: Long) : LoginOutcome
}

/** Registration issues no credential; the address is the whole answer. */
data class RegistrationOutcome(val email: String)

/** A freshly minted pairing code and the second it stops working. */
data class MintedCode(val code: String, val expiresAt: Long)

/** The browser-approval request: what the human types, where they type it, and
 *  the opaque code this app polls with. */
data class DeviceAuthStart(
    val userCode: String,
    /** Never shown to the human and never logged: it is the credential the poll
     *  presents. */
    val deviceCode: String,
    /** Already validated against this app's own origin — see
     *  [AccountFailure.Kind.UNTRUSTED_VERIFICATION_URL] — and already carrying
     *  `?code=`, so approving is one tap rather than a transcription. */
    val approvalUrl: String,
    val intervalSeconds: Int,
    val expiresInSeconds: Int,
) {
    /**
     * Redacted around [deviceCode], which is the credential the poll presents:
     * whoever holds it collects the bearer the human approves. The user code
     * and the approval URL are the opposite — they are meant to be read aloud
     * and opened — so they stay visible, which is what makes this printable at
     * all.
     */
    override fun toString(): String =
        "DeviceAuthStart(userCode=$userCode, approvalUrl=$approvalUrl, deviceCode=<redacted>, " +
            "intervalSeconds=$intervalSeconds, expiresInSeconds=$expiresInSeconds)"
}

/** One answer from the device-code poll. Every one of them is HTTP 200 with a
 *  `status` field, so the status code is not the signal. */
sealed interface DevicePollOutcome {
    data object Pending : DevicePollOutcome
    data object Denied : DevicePollOutcome
    data object Expired : DevicePollOutcome
    /** Redacted for the same reason [LoginOutcome.Session] is: this is the
     *  bearer, handed out by the server exactly once. */
    data class Approved(val token: String) : DevicePollOutcome {
        override fun toString(): String = "Approved(token=<redacted>)"
    }
}

/** The outcome of removing a device row. */
enum class DeviceDeletion {
    /** The server removed it. */
    DELETED,

    /** The server reported nothing there. Almost always true, but it is also
     *  what a failed read on the server looks like, so it is not reported as a
     *  confirmed removal. */
    ALREADY_GONE,
}
