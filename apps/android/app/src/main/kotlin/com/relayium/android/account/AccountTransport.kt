package com.relayium.android.account

/**
 * One HTTP exchange against this app's own backend origin.
 *
 * A request type rather than a URL: [path] is joined to the resolved origin by
 * the transport, so no caller can aim an authenticated request at a host of its
 * own choosing, and the bearer travels in a HEADER — never in a query string,
 * where it would land in every proxy and access log between here and the
 * server.
 */
data class AccountRequest(
    val method: String,
    /** Relative to the backend origin, WITHOUT a leading slash. */
    val path: String,
    /** A JSON document, or null for a bodyless request. */
    val json: String? = null,
    /** The bearer to present, or null for an anonymous call. */
    val bearer: String? = null,
) {
    init {
        require(!path.startsWith("/")) { "path is joined to the origin; it must not start with /" }
        require(!path.contains("..")) { "path must not contain dot segments" }
    }

    /**
     * A rendering that is safe to put in a diagnostic. It names the method and
     * the path and NOTHING else: [json] carries passwords and [bearer] is a
     * credential, so the default `toString` a data class would generate is
     * exactly the thing that must never reach a log or a crash report.
     */
    override fun toString(): String = "AccountRequest($method $path)"
}

/**
 * What came back. [body] is the COMPLETE body — never a prefix; see the bounded
 * read in [OkHttpAccountTransport].
 *
 * The generated `toString` is REPLACED, for the same reason
 * [AccountRequest]'s is: a login response body contains a bearer, and a device
 * poll's contains one too. A data class prints its fields, and the places a
 * value gets printed are exactly the ones that must never hold a credential —
 * an assertion message from a failing test, a crash report, a stray log line.
 * The status is the only part that is safe and the only part worth having.
 */
data class AccountResponse(val status: Int, val body: String) {
    override fun toString(): String = "AccountResponse(status=$status, body=<redacted>)"
}

/**
 * The outcome of an exchange, with the transport's own failures kept separate
 * from anything the server said. A caller that could not tell them apart would
 * have to render "the server rejected you" for a flight-mode phone.
 */
sealed interface TransportResult {

    data class Answered(val response: AccountResponse) : TransportResult

    data class Failed(val why: Failure) : TransportResult

    enum class Failure {
        /** DNS, connection refused, TLS failure, reset — or a redirect, which
         *  this transport refuses rather than follows (see below). */
        NETWORK,

        /** A connect/read/call deadline elapsed. */
        TIMEOUT,

        /** The body exceeded [MAX_BODY_BYTES]. Rejected, not truncated. */
        TOO_LARGE,

        /** The bytes are not valid UTF-8. */
        NOT_TEXT,

        /**
         * The request could not be FORMED, so nothing was sent.
         *
         * In practice this is a credential that cannot go in a header — OkHttp
         * refuses a header value containing a newline or any other character
         * outside the printable ASCII range, and it refuses by throwing. A
         * bearer is attacker-influenced input (it is whatever the server's
         * response said), so that throw is reachable from the wire and would
         * otherwise be an uncaught exception on whatever dispatcher the call
         * was made from. It is classified here instead, and the exception
         * itself is dropped rather than wrapped: its message quotes the
         * offending header value, which is the credential.
         */
        REQUEST_REJECTED,
    }

    companion object {
        /**
         * The ceiling on any account response body.
         *
         * Generous for what these endpoints actually return (the largest is a
         * device list) and small enough that a hostile or broken origin cannot
         * make the app buffer a stream. A truncated prefix is never used: a
         * prefix of a JSON document is either invalid — in which case only the
         * error message changes — or a SHORTER VALID document saying something
         * the server never wrote, which for an account response could mean a
         * different plan, a different address or a different device list.
         */
        const val MAX_BODY_BYTES: Int = 256 * 1024
    }
}

/**
 * The seam the account client consumes.
 *
 * A `fun interface` rather than the concrete OkHttp implementation so every
 * interesting behaviour of the client and the session — a malformed body, a
 * response that lands after the user signed out, an oversized document — is
 * reachable from a plain JVM test with no socket at all. The real transport is
 * still exercised end to end against a loopback server by `AccountClientTest`;
 * this exists so the *state machines* above it do not need one.
 */
fun interface AccountTransport {
    suspend fun send(request: AccountRequest): TransportResult
}
