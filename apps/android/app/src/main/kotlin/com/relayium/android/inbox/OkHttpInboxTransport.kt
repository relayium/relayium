package com.relayium.android.inbox

import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import com.relayium.protocol.inbox.InboxTaskState
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * The Device Inbox transport over the app's own backend origin.
 *
 * ## What the shape of this file is protecting
 *
 * **One origin, no redirects — and not as a default a caller can undo.** Every
 * call here carries the device bearer, and the blob route additionally carries
 * the claim token, so a followed redirect would hand both to whatever host
 * answered. An injected [OkHttpClient] is therefore never used as given: it is
 * re-derived through [harden], which forces redirects off and the cookie jar
 * empty regardless of what was passed. A test may inject timeouts or a
 * dispatcher; it cannot weaken the property this file exists for.
 *
 * **The claim token is a header, never a URL.** It is a bearer for advancing one
 * task under one lease, and a query string lands in every proxy and access log
 * between here and the server.
 *
 * **Nothing remote is echoed.** A rejection contributes its status and the
 * machine-readable `error` token read from a BOUNDED prefix; the body itself is
 * never carried further, and [InboxApiException] has no field that could hold
 * one.
 *
 * **The server must answer about what was asked.** A well-formed document naming
 * another device, another task or another key generation is refused at this
 * boundary — see [requireTargets] and [createTask]. Reconciling one here would
 * mean the layers above acted on a delivery nobody requested.
 *
 * ## Cancellation and socket ownership
 *
 * Two different lifetimes, and conflating them is a real bug rather than a
 * tidiness point:
 *
 *  * a JSON exchange is consumed WHOLE inside its own block, so a watcher that
 *    cancels the call on the way out is correct — the body is already read;
 *  * a ciphertext body is consumed by the caller's own code, which is why
 *    [withBlob] takes that code as a BLOCK rather than returning an open
 *    stream. The watcher then spans the whole consumption, and `use` closes the
 *    body on every exit path. Returning a handle instead would split one
 *    lifetime across two owners, and each way of patching that split leaves its
 *    own hole — a cancellation between acquiring the response and delivering it
 *    leaks a socket; a lifetime tied to the caller's completion cannot fire
 *    while the caller is blocked reading; a lifetime tied to a child of the
 *    caller stops the caller completing at all if the handle is dropped. The
 *    block form makes all three unrepresentable.
 */
class OkHttpInboxTransport private constructor(
    origin: String,
    private val userAgent: String,
    private val token: String,
    private val deviceId: String?,
    client: OkHttpClient,
    private val io: CoroutineDispatcher,
) : InboxDeviceTransport, InboxSenderTransport {

    private val base: HttpUrl = origin.toHttpUrl()

    /** Never the injected instance. See the type comment. */
    private val client: OkHttpClient = harden(client)

    companion object {
        /**
         * The receiver half, bound to ONE device id.
         *
         * The id is checked at construction because it is composed into every
         * path below. Pairing the credential and the id in one object is what
         * stops a caller resolving one device's row and then acting on
         * another's — and [currentDevice] additionally proves the two agree.
         */
        fun forDevice(
            origin: String,
            userAgent: String,
            token: String,
            deviceId: String,
            client: OkHttpClient = defaultClient(),
            io: CoroutineDispatcher = Dispatchers.IO,
        ): OkHttpInboxTransport = OkHttpInboxTransport(
            origin, userAgent, token,
            InboxId.checked(deviceId, "deviceId"), client, io,
        )

        /** The sender half, which holds no device identity at all. */
        fun forAccount(
            origin: String,
            userAgent: String,
            token: String,
            client: OkHttpClient = defaultClient(),
            io: CoroutineDispatcher = Dispatchers.IO,
        ): OkHttpInboxTransport =
            OkHttpInboxTransport(origin, userAgent, token, null, client, io)

        /**
         * No whole-call deadline: it would bound the streaming ciphertext body
         * too, killing any delivery slower than the cap mid-stream. The connect
         * and read deadlines still bound a server that never answers.
         */
        fun defaultClient(): OkHttpClient = harden(
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .build(),
        )

        /**
         * Force the properties this transport's safety rests on, whatever the
         * caller configured.
         *
         * Applied to an injected client as well as to the default one, because
         * "the default is safe" is not the same claim as "no client this type
         * uses can be unsafe" — and only the second one is true of a seam that
         * accepts an instance from outside.
         */
        internal fun harden(client: OkHttpClient): OkHttpClient = client.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            // A silent replay of a request that carried a claim token is a
            // second lease assertion this code did not make.
            .retryOnConnectionFailure(false)
            // These calls authenticate with a bearer. A cookie jar would attach
            // account-wide session state to a device-self route, which is
            // exactly the authorization confusion the server's two halves avoid.
            .cookieJar(CookieJar.NO_COOKIES)
            .build()

        /**
         * How much of a rejection body is read before it is parsed. Remote input
         * on a path that ends in a diagnostic, so it is bounded and never echoed
         * verbatim.
         */
        const val MAX_ERROR_BODY: Long = 4L * 1024

        /** Every ordinary response here is a small JSON document; the one large
         *  body in this protocol is the blob, which is streamed instead. */
        const val MAX_JSON_BODY: Long = 256L * 1024

        private val JSON = "application/json".toMediaType()
    }

    private fun device(): String =
        deviceId ?: error("this transport holds no device identity")

    // ── device discovery ────────────────────────────────────────────────────

    /**
     * The device row this bearer authenticates as.
     *
     * Exactly one row may be current: a cookie caller marks none, and this
     * client only ever sends a bearer. Zero and two are both refused rather than
     * resolved, because "pick the first" is the mistake this method exists to
     * prevent.
     *
     * When this transport was built for a device, the answer must ALSO be that
     * device. A disagreement means the credential and the id were paired
     * wrongly — a re-login that minted a new row, a restored install — and every
     * path below would then enrol, key and claim under an identity that is not
     * the one the caller thinks it holds.
     */
    override suspend fun currentDevice(): InboxDeviceRow {
        val current = devices().filter { it.isCurrent }
        if (current.size != 1) {
            throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "Current")
        }
        val row = current.single()
        if (deviceId != null && row.id != deviceId) {
            throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "Current.ID")
        }
        return row
    }

    override suspend fun devices(): List<InboxDeviceRow> {
        val body = getJson(base.newBuilder().addPathSegments("api/devices").build())
        return Wire.arr(body, "devices").map { InboxDeviceRow.read(Wire.obj(it, "devices[]")) }
    }

    // ── enrolment and keys ──────────────────────────────────────────────────

    override suspend fun enrol(request: InboxEnrolRequest): InboxEnrolResult {
        val payload = Json.obj(
            "platform" to Json.of(request.platform),
            "appVersion" to Json.of(request.appVersion),
            "protocolVersions" to Json.arr(request.protocolVersions.map { Json.of(it) }),
            "capabilities" to Json.arr(request.capabilities.map { Json.of(it) }),
            "autoAccept" to Json.of(request.autoAccept.wire),
            "receiveDirReady" to Json.of(request.receiveDirReady),
        )
        return InboxEnrolResult.read(sendJson("PUT", devicePath("inbox"), payload))
    }

    override suspend fun registerKey(
        algorithm: String,
        publicKey: String,
        previousKeyId: String?,
    ): InboxKeyRow {
        val entries = LinkedHashMap<String, Json>()
        entries["algorithm"] = Json.of(algorithm)
        entries["publicKey"] = Json.of(publicKey)
        // Omitted rather than sent empty when there is no previous key: the
        // server reads an absent field as "I have no key yet" and refuses it if
        // one exists, which is the compare-and-swap.
        if (!previousKeyId.isNullOrEmpty()) {
            entries["previousKeyId"] = Json.of(InboxId.checked(previousKeyId, "previousKeyId"))
        }
        val body = sendJson("POST", devicePath("inbox/keys"), Json.Obj(entries))
        val key = InboxKeyRow.read(Wire.obj(body["key"], "key"))
        // Central must have registered the key that was SENT. Binding a local
        // private key to a server id for a different public key is the one
        // mistake that makes every task sealed to it undecryptable forever.
        if (key.publicKey != publicKey || key.algorithm != algorithm) {
            throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "key.PublicKey")
        }
        return key
    }

    override suspend fun listKeys(): List<InboxKeyRow> {
        val body = getJson(devicePath("inbox/keys"))
        return Wire.arr(body, "keys").map { InboxKeyRow.read(Wire.obj(it, "keys[]")) }
    }

    // ── presence ────────────────────────────────────────────────────────────

    override suspend fun heartbeat(receiveDirReady: Boolean): InboxHeartbeatResult =
        InboxHeartbeatResult.read(
            sendJson(
                "POST", devicePath("inbox/heartbeat"),
                Json.obj("receiveDirReady" to Json.of(receiveDirReady)),
            ),
        )

    override suspend fun goOffline() {
        sendJson("POST", devicePath("inbox/offline"), Json.obj())
    }

    // ── queue ───────────────────────────────────────────────────────────────

    override suspend fun pending(limit: Int): List<InboxTaskRow> {
        var url = devicePath("inbox/pending")
        if (limit > 0) {
            url = url.newBuilder().addQueryParameter("limit", limit.toString()).build()
        }
        val body = getJson(url)
        return Wire.arr(body, "tasks")
            .map { requireTargets(InboxTaskRow.read(Wire.obj(it, "tasks[]")), device()) }
    }

    override suspend fun claim(max: Int): InboxClaimResult {
        val body = sendJson(
            "POST", devicePath("inbox/claim"),
            Json.obj("max" to Json.of(max)),
        )
        val deliveries = Wire.arr(body, "tasks").map {
            val delivery = InboxDelivery.read(Wire.obj(it, "tasks[]"))
            requireTargets(delivery.task, device())
            delivery
        }
        return InboxClaimResult(
            deliveries = deliveries,
            // Absent means "use the compiled default"; a present value must be
            // sane, because it decides how often a working delivery renews.
            leaseSeconds = if (body["leaseSeconds"] == null) {
                InboxProtocol.DEFAULT_LEASE_SECONDS
            } else {
                Wire.int(body, "leaseSeconds", min = 1)
            },
        )
    }

    /**
     * Open the task's ciphertext and consume it inside one scope.
     *
     * The response is opened, handed to [consume], and closed on every exit
     * path, with the cancellation watcher spanning the whole block. Nothing is
     * handed back, so there is no window in which an acquired socket has no
     * owner — the failure that a returned-handle design keeps reintroducing in
     * a different place.
     */
    override suspend fun <T> withBlob(
        taskId: String,
        claimToken: String,
        offset: Long,
        consume: suspend (InboxBlobStream) -> T,
    ): T {
        require(offset >= 0) { "a negative resume offset is not an offset" }
        require(claimToken.isNotEmpty()) { "the blob route is claim-gated" }
        val builder = Request.Builder()
            .url(taskPath(taskId, "blob"))
            .header("Accept", "application/octet-stream")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            // Header only. In a URL it would reach every proxy log on the way.
            .header(InboxProtocol.CLAIM_TOKEN_HEADER, claimToken)
        if (offset > 0) builder.header("Range", "bytes=$offset-")
        val call = newCall(builder.build())

        return withContext(io) {
            try {
                withCancellation(call) {
                    // `use` is what makes every exit path — a normal return, a
                    // throw from `consume`, a cancellation landing while the
                    // reader is blocked — close the body exactly once.
                    call.execute().use { response ->
                        if (!response.isSuccessful) {
                            // Drained rather than abandoned: a rejection body is
                            // small and carries the machine-readable token, and
                            // leaving it unread strands the connection for the
                            // retry that follows.
                            throw InboxApiException(response.code, errorToken(response))
                        }
                        // A partial answer is checked BEFORE a byte reaches a
                        // decryptor. A 206 whose range is malformed, or whose
                        // start is not the offset that was asked for, would
                        // otherwise splice the wrong region of the object into
                        // the middle of an authenticated stream.
                        val range = InboxContentRange.of(response.header("Content-Range"))
                        if (response.code == 206) {
                            if (range == null) {
                                throw InboxWireException(
                                    InboxWireReason.MALFORMED, "Content-Range",
                                )
                            }
                            if (range.start != offset) {
                                throw InboxWireException(
                                    InboxWireReason.IDENTITY_MISMATCH, "Content-Range",
                                )
                            }
                        }
                        consume(OkHttpBlobStream(response, range))
                    }
                }
            } catch (e: IOException) {
                coroutineContext.ensureActive()
                throw transportFailure(e)
            }
        }
    }

    override suspend fun report(
        taskId: String,
        claimToken: String,
        state: InboxTaskState,
        errorCode: InboxDeviceErrorCode,
        committed: Boolean,
    ): InboxTaskRow {
        // All three refusals happen HERE, before a request exists, because each
        // would be this device asserting something it must not. Central refuses
        // them as well; refusing locally means a bug in this client cannot even
        // attempt the claim.
        require(state.isDeviceReportable) { "state is not device-reportable" }
        require(state != InboxTaskState.SAVED || committed) {
            "saved requires an explicit commit assertion"
        }
        require(claimToken.isNotEmpty()) { "a report without a claim token is not a report" }
        val body = sendJson(
            "POST", taskPath(taskId, "report"),
            Json.obj(
                "claimToken" to Json.of(claimToken),
                "state" to Json.of(state.wire),
                "errorCode" to Json.of(errorCode.wire),
                "committed" to Json.of(committed),
            ),
        )
        return requireTask(Wire.obj(body["task"], "task"), taskId, device())
    }

    override suspend fun accept(taskId: String, accept: Boolean): InboxTaskRow {
        val body = sendJson(
            "POST", taskPath(taskId, "accept"),
            Json.obj("accept" to Json.of(accept)),
        )
        return requireTask(Wire.obj(body["task"], "task"), taskId, device())
    }

    override suspend fun clearInbox() {
        exchange("DELETE", devicePath("inbox"), null)
    }

    // ── sender ──────────────────────────────────────────────────────────────

    /**
     * Queue one delivery, and accept the answer only if it is about THIS send.
     *
     * Two independent checks, because a create is the one call whose answer
     * grants authority to stop retrying:
     *
     *  * the STATUS is exactly 201 (central minted a task now) or 200 (a retry
     *    under the same idempotency key converged on one that already exists),
     *    and `created` must agree with it. Anything else — a 202, a 200 with
     *    `created:true` — is a server this build does not understand, and
     *    treating it as success would let an unacknowledged send be recorded as
     *    delivered;
     *  * the returned task must name the same target device, idempotency key,
     *    stored object, key id and key generation that were sent. Central's
     *    convergence is keyed on `(user, idempotencyKey)`, so a mismatch here is
     *    a task describing a DIFFERENT delivery — exactly what must not be
     *    recorded as this job's outcome.
     */
    override suspend fun createTask(
        targetDeviceId: String,
        request: InboxSendRequest,
    ): InboxTaskCreation {
        val target = InboxId.checked(targetDeviceId, "targetDeviceId")
        val url = targetPath(target, "inbox/tasks")
        val (status, body) = exchange("POST", url, request.payload())
        if (status != 200 && status != 201) {
            throw InboxWireException(InboxWireReason.MALFORMED, "status")
        }
        val created = Wire.bool(body, "created")
        if ((status == 201) != created) {
            throw InboxWireException(InboxWireReason.MALFORMED, "created")
        }
        val task = requireTargets(InboxTaskRow.read(Wire.obj(body["task"], "task")), target)
        if (task.idempotencyKey != request.idempotencyKey ||
            task.storedFileId != request.storedFileId ||
            task.targetKeyId != request.targetKeyId ||
            task.targetKeyGeneration != request.targetKeyGeneration ||
            task.wrapAlgorithm != request.wrapAlgorithm
        ) {
            throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "task")
        }
        return InboxTaskCreation(task, created)
    }

    override suspend fun task(targetDeviceId: String, taskId: String): InboxTaskRow {
        val target = InboxId.checked(targetDeviceId, "targetDeviceId")
        val body = getJson(
            targetPath(target, "inbox/tasks")
                .newBuilder().addPathSegment(InboxId.checked(taskId, "taskId")).build(),
        )
        return requireTask(Wire.obj(body["task"], "task"), taskId, target)
    }

    override suspend fun tasks(targetDeviceId: String, limit: Int): List<InboxTaskRow> {
        val target = InboxId.checked(targetDeviceId, "targetDeviceId")
        var url = targetPath(target, "inbox/tasks")
        if (limit > 0) {
            url = url.newBuilder().addQueryParameter("limit", limit.toString()).build()
        }
        val body = getJson(url)
        return Wire.arr(body, "tasks")
            .map { requireTargets(InboxTaskRow.read(Wire.obj(it, "tasks[]")), target) }
    }

    override suspend fun cancelTask(targetDeviceId: String, taskId: String) {
        exchange(
            "DELETE",
            targetPath(InboxId.checked(targetDeviceId, "targetDeviceId"), "inbox/tasks")
                .newBuilder().addPathSegment(InboxId.checked(taskId, "taskId")).build(),
            null,
        )
    }

    // ── answer identity ─────────────────────────────────────────────────────

    /** The row must describe a delivery to the device that was addressed. */
    private fun requireTargets(task: InboxTaskRow, deviceId: String): InboxTaskRow {
        if (task.targetDeviceId != deviceId) {
            throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "TargetDeviceID")
        }
        return task
    }

    /** …and, on a single-task route, to be the task that was addressed. */
    private fun requireTask(source: Json.Obj, taskId: String, deviceId: String): InboxTaskRow {
        val task = requireTargets(InboxTaskRow.read(source), deviceId)
        if (task.id != taskId) {
            throw InboxWireException(InboxWireReason.IDENTITY_MISMATCH, "ID")
        }
        return task
    }

    // ── paths ───────────────────────────────────────────────────────────────

    private fun devicePath(suffix: String): HttpUrl = targetPath(device(), suffix)

    /**
     * A target device id becomes a path component, so it goes through the same
     * refusal a stored-object id does. `addPathSegment` does not encode `/` or
     * `.` out of existence for a proxy that normalises dot segments.
     */
    private fun targetPath(deviceId: String, suffix: String): HttpUrl {
        val builder = base.newBuilder()
            .addPathSegments("api/devices")
            .addPathSegment(InboxId.checked(deviceId, "deviceId"))
        for (segment in suffix.split('/')) builder.addPathSegment(segment)
        return builder.build()
    }

    /** A task id is a REMOTE string becoming a path, which is exactly why it is
     *  checked: the conversion must not depend on a remote invariant holding. */
    private fun taskPath(taskId: String, suffix: String): HttpUrl =
        devicePath("inbox/tasks").newBuilder()
            .addPathSegment(InboxId.checked(taskId, "taskId"))
            .addPathSegment(suffix)
            .build()

    // ── exchange ────────────────────────────────────────────────────────────

    private suspend fun getJson(url: HttpUrl): Json.Obj = exchange("GET", url, null).second

    private suspend fun sendJson(method: String, url: HttpUrl, payload: Json.Obj): Json.Obj =
        exchange(method, url, payload).second

    private fun newCall(request: Request): Call = try {
        client.newCall(request)
    } catch (_: IllegalArgumentException) {
        // A header value OkHttp refuses — in practice a bearer carrying a
        // character outside printable ASCII. The exception is DROPPED rather
        // than wrapped: its message quotes the offending value, which is the
        // credential.
        throw InboxTransportException(InboxTransportException.Kind.REQUEST_REJECTED)
    }

    private suspend fun exchange(
        method: String,
        url: HttpUrl,
        payload: Json.Obj?,
    ): Pair<Int, Json.Obj> = withContext(io) {
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
        val body = payload?.let { Json.stringify(it).toRequestBody(JSON) }
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> if (body == null) builder.delete() else builder.delete(body)
            else -> builder.method(method, body ?: emptyJsonBody())
        }
        val call = newCall(builder.build())
        // The whole body is consumed INSIDE the block, so cancelling the call on
        // the way out is correct here — unlike on the streaming blob route.
        val (status, text, tooLarge) = try {
            withCancellation(call) {
                call.execute().use { response ->
                    val read = response.body.bounded(MAX_JSON_BODY)
                    Triple(response.code, read ?: "", read == null)
                }
            }
        } catch (e: IOException) {
            coroutineContext.ensureActive()
            throw transportFailure(e)
        }
        // Refused, never truncated: a prefix of a JSON document is either
        // invalid or a SHORTER VALID document saying something the server never
        // wrote — a different task state, a different device list.
        if (tooLarge) throw InboxTransportException(InboxTransportException.Kind.TOO_LARGE)
        if (status !in 200..299) {
            throw InboxApiException(status, InboxRejection.fromWire(errorTokenIn(text)))
        }
        val parsed = Json.parseOrNull(text)
        // A 200 carrying no document is legitimate on the routes that answer
        // `{"status":"ok"}`; a caller that needs a field reads it and gets
        // MISSING_FIELD, which is the truthful refusal.
        status to (parsed as? Json.Obj ?: Json.obj())
    }

    private fun errorToken(response: Response): InboxRejection? {
        val text = response.body.bounded(MAX_ERROR_BODY) ?: return null
        return InboxRejection.fromWire(errorTokenIn(text))
    }

    /** The `error` token of a rejection body, or "" — never the body itself. */
    private fun errorTokenIn(text: String): String =
        ((Json.parseOrNull(text) as? Json.Obj)?.get("error") as? Json.Str)?.value ?: ""

    private fun transportFailure(e: IOException): InboxTransportException = when (e) {
        is SocketTimeoutException, is InterruptedIOException ->
            InboxTransportException(InboxTransportException.Kind.TIMEOUT)
        else -> InboxTransportException(InboxTransportException.Kind.NETWORK)
    }

    /**
     * Run [body] with a watcher that cancels the call when the coroutine is
     * cancelled, including while the response body is still being read.
     *
     * Correct wherever the body is consumed INSIDE [body] — which, since
     * [withBlob] takes its consumer as a block, is every route here including
     * the streaming one. What must never happen is the opposite shape: a body
     * that outlives this call.
     */
    private suspend fun <T> withCancellation(call: Call, body: suspend () -> T): T = coroutineScope {
        val watcher = launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            // Already cancelled? Then no request is issued at all, rather than
            // one started and immediately torn down.
            ensureActive()
            body()
        } finally {
            watcher.cancel()
        }
    }

    private fun emptyJsonBody() = "{}".toRequestBody(JSON)
}

/**
 * A read view over a response body that is owned by the enclosing
 * `withBlob` block.
 *
 * Holds no cancellation state and no close path of its own, because it owns
 * neither: the block opened the response and the block closes it. That is the
 * point of the callback form — this type cannot outlive its socket, so there is
 * nothing here to get wrong.
 */
private class OkHttpBlobStream(
    response: Response,
    private val range: InboxContentRange?,
) : InboxBlobStream {

    override val status: Int = response.code

    override val isPartial: Boolean = response.code == 206

    override val rangeStart: Long = range?.start ?: -1

    private val source = response.body.source()

    override fun read(into: ByteArray): Int = source.read(into)
}

/** A bounded whole-body read, or null when the body exceeds [limit]. */
private fun okhttp3.ResponseBody.bounded(limit: Long): String? {
    if (contentLength() > limit) return null
    val source = source()
    if (source.request(limit + 1)) return null
    return source.readByteArray().toString(Charsets.UTF_8)
}
