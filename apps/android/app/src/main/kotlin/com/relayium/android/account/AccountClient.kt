package com.relayium.android.account

import com.relayium.protocol.Json
import com.relayium.protocol.PairCode

/**
 * Every account call this app makes, and exactly what each server answer means.
 *
 * ## Why the shapes are read strictly
 *
 * These responses decide who is signed in, whether an address is confirmed,
 * whether an account is mid-deletion, and whether six digits may be shown to a
 * stranger. Reading them leniently is how a client signs someone in on a
 * response that never said so — so an undocumented status is
 * [AccountFailure.Kind.SERVER] carrying the number, a documented status whose
 * body is not the documented shape is [AccountFailure.Kind.MALFORMED], and no
 * branch ever guesses.
 *
 * ## What it never does
 *
 * It does not persist anything, does not log, and holds no state: the token it
 * is handed for an authenticated call is a parameter, used for one request. The
 * password reaches the transport only inside a POST body — never a URL, never a
 * header, never a failure value. See [AccountRequest.toString].
 */
class AccountClient(private val transport: AccountTransport) {

    /**
     * `POST /api/auth/native/login`.
     *
     * HTTP 200 is TWO different answers — a session, or a frozen account's
     * notice — so the pending-deletion shape is tested first. A response that is
     * neither is malformed rather than "probably a session".
     */
    suspend fun login(
        email: String,
        password: String,
        deviceName: String,
    ): Result<LoginOutcome> {
        val body = Json.stringify(
            Json.obj(
                "email" to Json.of(email),
                "password" to Json.of(password),
                "deviceName" to Json.of(deviceName),
            ),
        )
        val answer = exchange(AccountRequest("POST", "api/auth/native/login", json = body))
            .getOrElse { return Result.failure(it) }
        return when (answer.status) {
            200 -> {
                val obj = answer.obj() ?: return malformed()
                obj.pendingDeletion()?.let { return Result.success(it) }
                // The `user` object must be present — its absence is the shape
                // of some OTHER 200 this client does not understand — and the
                // token must be one this app can actually put in a header. See
                // [Bearer]: a token with a newline in it is accepted by a
                // lenient reader, stored, and then throws out of the HTTP
                // client on the next request.
                val token = obj.obj("user")?.let { obj.str("token") } ?: return malformed()
                if (!Bearer.isValid(token)) return malformed()
                Result.success(LoginOutcome.Session(token))
            }
            401 -> fail(AccountFailure.Kind.INVALID_CREDENTIALS)
            403 -> {
                val obj = answer.obj() ?: return malformed()
                if (obj.str("error") != "email_unverified") return malformed()
                // The server's normalisation when it sent one, the typed address
                // otherwise — never an empty string, which would leave the
                // check-email screen naming no mailbox at all.
                val address = obj.str("email")?.takeIf { it.isNotEmpty() } ?: email
                Result.success(LoginOutcome.EmailUnverified(address))
            }
            429 -> fail(AccountFailure.Kind.RATE_LIMITED)
            else -> server(answer.status)
        }
    }

    /**
     * `POST /api/auth/register`.
     *
     * It returns an ADDRESS, not a token, and that is the endpoint's whole
     * shape: registration issues no session, because the account cannot sign in
     * until the link in the verification email has been opened. A caller that
     * expected a bearer here would be modelling a product that does not exist.
     */
    suspend fun register(
        email: String,
        password: String,
        displayName: String,
    ): Result<RegistrationOutcome> {
        val body = Json.stringify(
            Json.obj(
                "email" to Json.of(email),
                "password" to Json.of(password),
                "displayName" to Json.of(displayName),
            ),
        )
        val answer = exchange(AccountRequest("POST", "api/auth/register", json = body))
            .getOrElse { return Result.failure(it) }
        return when (answer.status) {
            200 -> {
                val obj = answer.obj() ?: return malformed()
                if (obj.str("status") != "verification_sent") return malformed()
                Result.success(
                    RegistrationOutcome(obj.str("email")?.takeIf { it.isNotEmpty() } ?: email),
                )
            }
            // Two documented refusals share 400, and a body that is neither —
            // the plain-text "bad request" a malformed JSON body earns — is not
            // one of them.
            400 -> when (answer.obj()?.str("error")) {
                "invalid_email" -> fail(AccountFailure.Kind.EMAIL_INVALID)
                "password too short" -> fail(AccountFailure.Kind.PASSWORD_TOO_SHORT)
                else -> server(400)
            }
            // Pending deletion first: it is the narrower fact, and the server
            // checks it ahead of the taken-email case for the same reason.
            409 -> when (answer.obj()?.str("error")) {
                "account_pending_deletion" -> fail(AccountFailure.Kind.ACCOUNT_PENDING_DELETION)
                "email already registered" -> fail(AccountFailure.Kind.EMAIL_TAKEN)
                else -> server(409)
            }
            429 -> fail(AccountFailure.Kind.RATE_LIMITED)
            else -> server(answer.status)
        }
    }

    /**
     * `POST /api/auth/email/resend`.
     *
     * The endpoint answers **200 unconditionally** — it will not say whether an
     * account exists, whether it is already verified, or whether its own
     * per-address throttle swallowed the request, because any of those answers
     * is an account-enumeration oracle. So success here means *the server
     * accepted the request* and nothing stronger.
     */
    suspend fun resendVerification(email: String): Result<Unit> =
        accepted("api/auth/email/resend", email)

    /**
     * `POST /api/auth/password/forgot`. Same unconditional 200, same meaning:
     * the request was accepted. The reset itself happens in the mailbox and
     * then in a browser — there is no in-app screen that can spend the token,
     * and building one would be a second implementation of a flow the website
     * already owns.
     */
    suspend fun requestPasswordReset(email: String): Result<Unit> =
        accepted("api/auth/password/forgot", email)

    private suspend fun accepted(path: String, email: String): Result<Unit> {
        val body = Json.stringify(Json.obj("email" to Json.of(email)))
        val answer = exchange(AccountRequest("POST", path, json = body))
            .getOrElse { return Result.failure(it) }
        return when (answer.status) {
            200 -> Result.success(Unit)
            429 -> fail(AccountFailure.Kind.RATE_LIMITED)
            else -> server(answer.status)
        }
    }

    /**
     * `POST /api/auth/logout`, revoking exactly the bearer presented.
     *
     * **200 and 401 are both terminal success.** A 401 means the credential is
     * already absent or invalid server-side, which is the state a sign-out is
     * trying to reach; treating it as a failure would leave the app holding a
     * dead token it refuses to let go of. Everything else — a transport failure,
     * a 500 — is a real failure and is reported as one, because the credential
     * may still be live and the caller must not silently forget it.
     */
    suspend fun logout(token: String): Result<Unit> {
        val answer = exchange(AccountRequest("POST", "api/auth/logout", bearer = token))
            .getOrElse { return Result.failure(it) }
        return when (answer.status) {
            200, 401 -> Result.success(Unit)
            429 -> fail(AccountFailure.Kind.RATE_LIMITED)
            else -> server(answer.status)
        }
    }

    /** `GET /api/me`. */
    suspend fun fetchMe(token: String): Result<AccountUser> {
        val answer = authedGet("api/me", token).getOrElse { return Result.failure(it) }
        val user = answer.obj("user") ?: return malformed()
        val id = user.str("id")?.takeIf { it.isNotEmpty() } ?: return malformed()
        val email = user.str("email") ?: return malformed()
        return Result.success(
            AccountUser(
                id = id,
                email = email,
                displayName = user.str("displayName").orEmpty(),
                emailVerified = user.bool("emailVerified") ?: return malformed(),
                planId = user.str("planId").orEmpty(),
                linkedMethods = user.arr("linkedMethods")
                    ?.mapNotNull { (it as? Json.Str)?.value }
                    .orEmpty(),
            ),
        )
    }

    /** `GET /api/me/usage`. */
    suspend fun fetchUsage(token: String): Result<AccountUsage> {
        val answer = authedGet("api/me/usage", token).getOrElse { return Result.failure(it) }
        val traffic = answer.obj("traffic") ?: return malformed()
        val storage = answer.obj("storage") ?: return malformed()
        val plan = answer.obj("plan") ?: return malformed()
        // Every number here is read with [counted], which refuses a NEGATIVE
        // value as well as a fractional or unrepresentable one. That refusal is
        // load-bearing rather than tidy: `Quota.unlimited` is `cap <= 0`, the
        // server's documented spelling of "no limit" (`nonNegCap`), so a
        // negative cap read leniently would render an account with a broken or
        // hostile quota response as having UNLIMITED traffic — the single most
        // misleading answer this screen can give. Refusing makes it a truthful
        // "could not be read" instead.
        return Result.success(
            AccountUsage(
                planName = plan.str("name").orEmpty(),
                resetsAt = answer.counted("resetsAt") ?: return malformed(),
                traffic = Quota(
                    used = traffic.counted("used") ?: return malformed(),
                    cap = traffic.counted("cap") ?: return malformed(),
                ),
                storage = Quota(
                    used = storage.counted("used") ?: return malformed(),
                    cap = storage.counted("cap") ?: return malformed(),
                ),
            ),
        )
    }

    /** `GET /api/devices`. Field names are the server's own PascalCase
     *  (`deviceView`), read exactly rather than case-folded. */
    suspend fun listDevices(token: String): Result<List<AccountDevice>> {
        val answer = authedGet("api/devices", token).getOrElse { return Result.failure(it) }
        val rows = answer.arr("devices") ?: return malformed()
        val out = ArrayList<AccountDevice>(rows.size)
        for (row in rows) {
            val device = row as? Json.Obj ?: return malformed()
            val id = device.str("ID")?.takeIf { it.isNotEmpty() } ?: return malformed()
            out.add(
                AccountDevice(
                    id = id,
                    name = device.str("Name").orEmpty(),
                    kind = device.str("Kind").orEmpty(),
                    createdAt = device.long("CreatedAt") ?: 0L,
                    lastSeenAt = device.long("LastSeenAt") ?: 0L,
                    current = device.bool("Current") ?: false,
                ),
            )
        }
        return Result.success(out)
    }

    /**
     * `DELETE /api/devices/{id}`.
     *
     * The id is CHECKED, not escaped. Every id the server issues is
     * `authx.NewID()` — 32 lowercase hex characters — so nothing legitimate is
     * near the edge of this rule, while an id carrying `/` or `..` would
     * compose a path whose dot segments a proxy may resolve, aiming a DELETE
     * the user authorised for one row at an unrelated endpoint. It is refused
     * BEFORE the request is built, so a rejected id costs no round trip.
     *
     * 404 is not an error: the row the user asked to remove is gone either way.
     * It is still reported as [DeviceDeletion.ALREADY_GONE] rather than
     * `DELETED`, because it is also what a failed read on the server looks like.
     */
    suspend fun deleteDevice(id: String, token: String): Result<DeviceDeletion> {
        if (!SERVER_ID.matches(id)) return fail(AccountFailure.Kind.MALFORMED)
        val answer = exchange(AccountRequest("DELETE", "api/devices/$id", bearer = token))
            .getOrElse { return Result.failure(it) }
        return when (answer.status) {
            200, 204 -> Result.success(DeviceDeletion.DELETED)
            404 -> Result.success(DeviceDeletion.ALREADY_GONE)
            401 -> fail(AccountFailure.Kind.INVALID_CREDENTIALS)
            429 -> fail(AccountFailure.Kind.RATE_LIMITED)
            else -> server(answer.status)
        }
    }

    /**
     * `POST /api/pair`, the mint.
     *
     * Requires the bearer: the code's owner pays for whatever is relayed
     * through it, so the server will not mint one anonymously. An empty token is
     * answered here rather than sent — the server could only say 401, and
     * offline the round trip would fail as a network error, which is the wrong
     * explanation entirely.
     *
     * The code is validated before it is returned: exactly six ASCII digits (the
     * server's alphabet — `signal.CodeLen`), and an `expiresAt` that has not
     * already passed. Both refusals are the same one the UI would have to make
     * anyway, made once, here, so no surface can show digits nothing will accept.
     */
    suspend fun mintPairCode(token: String, nowSeconds: Long): Result<MintedCode> {
        if (token.isEmpty()) return fail(AccountFailure.Kind.NOT_SIGNED_IN)
        val answer = exchange(AccountRequest("POST", "api/pair", bearer = token))
            .getOrElse { return Result.failure(it) }
        return when (answer.status) {
            200 -> {
                val obj = answer.obj() ?: return malformed()
                val code = obj.str("code") ?: return malformed()
                val expiresAt = obj.long("expiresAt") ?: return malformed()
                if (!SIX_DIGITS.matches(code)) return fail(AccountFailure.Kind.PAIR_CODE_REJECTED)
                if (expiresAt <= nowSeconds) return fail(AccountFailure.Kind.PAIR_CODE_REJECTED)
                Result.success(MintedCode(code, expiresAt))
            }
            401 -> fail(AccountFailure.Kind.NOT_SIGNED_IN)
            429 -> {
                // The documented, machine-readable refusal (`traffic_exhausted`)
                // is a different product answer from an ordinary rate limit:
                // one says "wait a moment", the other says "this account cannot
                // complete a cross-network transfer this month".
                if (answer.obj()?.str("error") == TRAFFIC_EXHAUSTED) {
                    fail(AccountFailure.Kind.PAIR_TRAFFIC_EXHAUSTED)
                } else {
                    fail(AccountFailure.Kind.RATE_LIMITED)
                }
            }
            503 -> fail(AccountFailure.Kind.PAIR_UNAVAILABLE)
            else -> server(answer.status)
        }
    }

    /**
     * `POST /api/cli/device/start`, the browser-approved sign-in.
     *
     * [trustedOrigin] is the app's own resolved origin, and the server's
     * `verification_uri` must be ON it. This is the load-bearing check of the
     * whole flow: that URL is where a human is asked to authorise a credential
     * for this device, and a response that could send them anywhere is a
     * ready-made phishing page. It is PARSED, never prefix-matched —
     * `https://relayium.com@evil.example/device` starts with the right
     * characters and its host is `evil.example`.
     */
    suspend fun startBrowserLogin(
        deviceName: String,
        trustedOrigin: String,
    ): Result<DeviceAuthStart> {
        val body = Json.stringify(Json.obj("device_name" to Json.of(deviceName)))
        val answer = exchange(AccountRequest("POST", "api/cli/device/start", json = body))
            .getOrElse { return Result.failure(it) }
        if (answer.status == 429) return fail(AccountFailure.Kind.RATE_LIMITED)
        if (answer.status != 200) return server(answer.status)
        val obj = answer.obj() ?: return malformed()
        val userCode = obj.str("user_code")?.takeIf { it.isNotEmpty() } ?: return malformed()
        val deviceCode = obj.str("device_code")?.takeIf { it.isNotEmpty() } ?: return malformed()
        val verification = obj.str("verification_uri") ?: return malformed()
        val interval = obj.long("interval") ?: return malformed()
        val expiresIn = obj.long("expires_in") ?: return malformed()
        val approval = approvalUrl(verification, userCode, trustedOrigin)
            ?: return fail(AccountFailure.Kind.UNTRUSTED_VERIFICATION_URL)
        // REFUSED, never coerced. The server's `interval` is a floor it
        // enforces — polling faster earns a 429 that reads to the user as a
        // failed login — so clamping a value DOWN to something this client
        // preferred would make the app disobey the instruction it just asked
        // for. Clamping up is no better: it would turn a nonsensical or hostile
        // response into a plausible-looking flow that then behaves in a way
        // nothing described. Both directions are a client inventing a protocol,
        // so a value outside what this build supports is malformed and the
        // sign-in does not start.
        //
        // The ceilings are what this surface can honestly sit through: a poll
        // gap over five minutes, or a request valid for more than an hour, is
        // not a screen a person waits on. An interval longer than the request
        // itself is refused too — it describes a flow that can never poll.
        if (interval !in 1L..MAX_POLL_INTERVAL_SECONDS) return malformed()
        if (expiresIn !in 1L..MAX_DEVICE_AUTH_SECONDS) return malformed()
        if (interval > expiresIn) return malformed()
        return Result.success(
            DeviceAuthStart(
                userCode = userCode,
                deviceCode = deviceCode,
                approvalUrl = approval,
                intervalSeconds = interval.toInt(),
                expiresInSeconds = expiresIn.toInt(),
            ),
        )
    }

    /**
     * `POST /api/cli/device/poll`.
     *
     * Every outcome is HTTP 200 with a `status` field, so the status code is not
     * the signal — a client that waited for a non-200 would poll until the code
     * expired and then report a timeout for a login that had succeeded. An
     * unrecognised `status` is MALFORMED and never optimistically retried:
     * guessing a future status as success signs someone in wrongly.
     */
    suspend fun pollBrowserLogin(deviceCode: String): Result<DevicePollOutcome> {
        val body = Json.stringify(Json.obj("device_code" to Json.of(deviceCode)))
        val answer = exchange(AccountRequest("POST", "api/cli/device/poll", json = body))
            .getOrElse { return Result.failure(it) }
        if (answer.status == 429) return fail(AccountFailure.Kind.RATE_LIMITED)
        if (answer.status != 200) return server(answer.status)
        val obj = answer.obj() ?: return malformed()
        return when (obj.str("status")) {
            "authorization_pending" -> Result.success(DevicePollOutcome.Pending)
            "denied" -> Result.success(DevicePollOutcome.Denied)
            "expired" -> Result.success(DevicePollOutcome.Expired)
            "ok" -> {
                // An empty token would land the session holding a bearer that
                // 401s on the very next request, and an unsendable one would
                // throw out of the HTTP client instead. Both are refused here,
                // on the same rule the password login uses.
                val token = obj.str("access_token") ?: return malformed()
                if (!Bearer.isValid(token)) return malformed()
                Result.success(DevicePollOutcome.Approved(token))
            }
            else -> malformed()
        }
    }

    // ── plumbing ────────────────────────────────────────────────────────────

    private suspend fun authedGet(path: String, token: String): Result<Json.Obj> {
        if (token.isEmpty()) return fail(AccountFailure.Kind.NOT_SIGNED_IN)
        val answer = exchange(AccountRequest("GET", path, bearer = token))
            .getOrElse { return Result.failure(it) }
        return when (answer.status) {
            200 -> answer.obj()?.let { Result.success(it) } ?: malformed()
            // The one and only signal that a stored token has gone bad.
            401 -> fail(AccountFailure.Kind.INVALID_CREDENTIALS)
            429 -> fail(AccountFailure.Kind.RATE_LIMITED)
            else -> server(answer.status)
        }
    }

    private suspend fun exchange(request: AccountRequest): Result<AccountResponse> =
        when (val result = transport.send(request)) {
            is TransportResult.Answered -> Result.success(result.response)
            is TransportResult.Failed -> Result.failure(AccountException(AccountFailure.of(result.why)))
        }

    private companion object {

        /** The server's own `signal.CodeLen` alphabet: six ASCII digits, leading
         *  zeros significant. `Char.isDigit()` is deliberately not used — it is
         *  true for Arabic-Indic digits the server does not accept. */
        val SIX_DIGITS = Regex("^[0-9]{6}$")

        /** The longest gap between polls this screen will sit through, and the
         *  longest a whole browser-approval request may last. See the refusal
         *  in [startBrowserLogin]. */
        const val MAX_POLL_INTERVAL_SECONDS = 300L
        const val MAX_DEVICE_AUTH_SECONDS = 3600L

        /** `authx.NewID()`: 16 random bytes, lowercase hex. */
        val SERVER_ID = Regex("^[0-9a-f]{32}$")

        /** `account.PairMintTrafficSpent`. An identifier, compared with `==`,
         *  never reworded. */
        const val TRAFFIC_EXHAUSTED = "traffic_exhausted"

        fun <T> fail(kind: AccountFailure.Kind): Result<T> =
            Result.failure(AccountException(AccountFailure(kind)))

        fun <T> server(status: Int): Result<T> =
            Result.failure(AccountException(AccountFailure(AccountFailure.Kind.SERVER, status)))

        fun <T> malformed(): Result<T> = fail(AccountFailure.Kind.MALFORMED)

        /**
         * `verification_uri` + `?code=` — but only when the page really is on
         * this app's own origin.
         *
         * The comparison is between PARSED origins, and the path is required to
         * be exactly `/device` (`account.registerDevicePageRoute`). Null means
         * refuse; there is no "close enough" answer for a page that authorises
         * credentials.
         */
        fun approvalUrl(raw: String, userCode: String, trustedOrigin: String): String? {
            val uri = try {
                java.net.URI(raw)
            } catch (_: java.net.URISyntaxException) {
                return null
            }
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            if (uri.userInfo != null || uri.query != null || uri.fragment != null) return null
            if (uri.path != "/device") return null
            val origin = buildString {
                append(scheme).append("://").append(host)
                if (uri.port != -1) append(':').append(uri.port)
            }
            if (!origin.equals(trustedOrigin, ignoreCase = true)) return null
            // The code is the server's own alphabet (letters, digits and one
            // dash); anything else would be a query this app composed out of a
            // value it never validated.
            if (!Regex("^[A-Z0-9-]{1,32}$").matches(userCode)) return null
            return "$origin/device?code=$userCode"
        }

        // ── strict readers ──────────────────────────────────────────────────

        fun AccountResponse.obj(): Json.Obj? = Json.parseOrNull(body) as? Json.Obj

        fun AccountResponse.obj(key: String): Json.Obj? = obj()?.obj(key)

        fun AccountResponse.arr(key: String): List<Json>? = obj()?.arr(key)

        fun AccountResponse.long(key: String): Long? = obj()?.long(key)

        fun AccountResponse.counted(key: String): Long? = obj()?.counted(key)

        fun Json.Obj.str(key: String): String? = (this[key] as? Json.Str)?.value

        fun Json.Obj.bool(key: String): Boolean? = (this[key] as? Json.Bool)?.value

        fun Json.Obj.obj(key: String): Json.Obj? = this[key] as? Json.Obj

        fun Json.Obj.arr(key: String): List<Json>? = (this[key] as? Json.Arr)?.items

        /**
         * A JSON number read as a whole count of bytes or seconds.
         *
         * JSON has one number type and the server writes int64s into it. A value
         * with a fraction, or one outside the range a double represents
         * EXACTLY, is REFUSED rather than rounded: these are quota bytes and
         * expiry instants, and a silently rounded one is a wrong number
         * rendered with the confidence of a right one.
         *
         * The bound is **strictly less than 2^53**, and the strictness is the
         * whole point. At 2^53 and above, consecutive integers stop being
         * distinguishable: the literal `9007199254740993` parses to exactly
         * `9007199254740992.0`, so a limit of "at most 2^53" accepts that
         * document and reports a cap the server never wrote. Refusing the whole
         * ambiguous range is the only answer that cannot be quietly wrong, and
         * no real quota, byte count or epoch second is anywhere near it.
         */
        fun Json.Obj.long(key: String): Long? {
            val value = (this[key] as? Json.Num)?.value ?: return null
            if (!value.isFinite()) return null
            if (value != Math.floor(value)) return null
            if (kotlin.math.abs(value) >= 9007199254740992.0) return null
            return value.toLong()
        }

        /** [long], additionally refusing a negative value: bytes used, a byte
         *  cap and a reset instant are all counts, and a negative one is a
         *  response this client cannot render truthfully. */
        fun Json.Obj.counted(key: String): Long? = long(key)?.takeIf { it >= 0L }

        /** The frozen-account answer, or null when this is not one. The
         *  `reactivateToken` beside it is deliberately not read — see
         *  [LoginOutcome.PendingDeletion]. */
        fun Json.Obj.pendingDeletion(): LoginOutcome.PendingDeletion? {
            if (str("status") != "pending_deletion") return null
            return LoginOutcome.PendingDeletion(counted("purgeAfter") ?: 0L)
        }
    }
}

/** The carrier that lets an [AccountFailure] travel in a `Result`. It has no
 *  message and no cause: everything a caller may act on is in [failure], and a
 *  message would be a place for server prose or a credential to end up. */
class AccountException(val failure: AccountFailure) : Exception(null, null) {
    override fun toString(): String = "AccountException(${failure.kind})"
}

/** The pairing code, once the mint has been validated. */
fun MintedCode.pairCode(): PairCode = PairCode(code)
