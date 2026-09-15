package com.relayium.android.cloud

import com.relayium.protocol.Json
import com.relayium.protocol.stored.ChunkEncryptor
import com.relayium.protocol.stored.MANIFEST_MAX_SAFE_INTEGER
import com.relayium.protocol.stored.PlaintextSource
import com.relayium.protocol.stored.StoreDecryptor
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.StoredWireException
import com.relayium.protocol.stored.cipherSize
import com.relayium.protocol.stored.decryptManifestRaw
import com.relayium.protocol.stored.encryptManifest
import com.relayium.protocol.stored.uploadHeader
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink

/** What a stored upload is being asked to create. */
class StoredUploadPlan(
    val key: ByteArray,
    val manifest: StoredManifest,
    val sources: List<PlaintextSource>,
    val burnAfterRead: Boolean,
    val ttlSeconds: Int,
) {
    /** No key, no names: this value reaches coroutine failure text and test
     *  output, and the key alone is the whole file. */
    override fun toString(): String =
        "StoredUploadPlan(files=${sources.size}, burn=$burnAfterRead, ttl=$ttlSeconds)"
}

/** What the server created. */
data class StoredUploadResult(val id: String, val expiresAt: Long)

/**
 * What an uploaded object IS, which decides who may ever read it.
 *
 * A closed set rather than a caller-supplied string: the value goes into the
 * `purpose` query the server authorizes on, and a free-typed one is how a
 * device delivery ends up created as a public capability-link object. The two
 * members are the two the server understands (`account/taskobject.go`).
 */
enum class StoredUploadPurpose(val wire: String) {
    /** The ordinary capability-link object: public meta/blob, listed, burnable. */
    SHARE("share"),

    /**
     * Ciphertext that exists only to be delivered to one of the account's own
     * devices through the Device Inbox queue. Never public, never listed, and
     * unlimited-until-TTL by server rule — see [CloudClient.initUpload].
     */
    DEVICE_TASK("device_task"),
}

/** A resumable session and the append size the server issued with it. The size
 *  belongs to the SESSION: a later process must persist it rather than guess
 *  today's default. */
data class ResumableSession(val uploadId: String, val chunkSize: Int)

/**
 * The server's authoritative committed offset, and whether it answered 409.
 *
 * Both statuses carry the same fact — how much framed ciphertext the blob holds
 * — and a caller must act on the number rather than on its own idea of what it
 * just sent. [conflict] is kept only because the two are worth telling apart in
 * a no-progress guard, never because they mean different offsets.
 */
data class UploadOffset(val received: Long, val conflict: Boolean)

/** One row of `GET /api/files`, field for field. */
data class StoredFileRow(
    val id: String,
    val size: Long,
    val createdAt: Long,
    val expiresAt: Long,
    val burnAfterRead: Boolean,
    /** A boolean the server derives from its own timestamp column — not a
     *  date. */
    val downloaded: Boolean,
    val downloadCount: Long,
)

/** What a stored object says about itself, before any ciphertext is fetched. */
data class StoredFileMeta(
    val encManifest: ByteArray,
    val size: Long,
    val burnAfterRead: Boolean,
    val expiresAt: Long,
) {
    override fun equals(other: Any?): Boolean =
        other is StoredFileMeta && encManifest.contentEquals(other.encManifest) &&
            size == other.size && burnAfterRead == other.burnAfterRead && expiresAt == other.expiresAt

    override fun hashCode(): Int = encManifest.contentHashCode()
}

/** A classified failure, carried without a message that could hold a secret. */
class CloudException(val failure: CloudFailure) :
    RuntimeException("relayium cloud: ${failure.kind}")

/**
 * The stored-transfer transport: upload under an account, read anonymously.
 *
 * ## Two clients, because there are two trust positions
 *
 * **Authenticated, own origin, no redirects.** `POST /api/files` carries a
 * bearer, so it follows nothing: a redirect would forward the credential to
 * whatever host answered.
 *
 * **Anonymous, redirect-following.** A blob read carries no bearer, no cookie
 * and no key, and it MUST follow redirects — see [BlobRedirect] for why refusing
 * them would break every download of a file on a fleet node. Each hop is
 * rebuilt from scratch here rather than delegated to OkHttp's follower, so the
 * headers on a redirected request are exactly the two below and cannot inherit
 * anything from the request that was redirected.
 *
 * Metadata is anonymous but stays own-origin: the server answers it directly,
 * and there is no deployment in which it redirects.
 */
class CloudClient(
    private val origin: String,
    private val userAgent: String,
    private val authed: OkHttpClient = authedClient(),
    private val anonymous: OkHttpClient = anonymousClient(),
    /**
     * Where the blocking work happens. Every call below writes a file to a
     * socket or reads one back with `execute()`, on the calling thread — so the
     * dispatcher is part of the contract rather than the caller's problem, and
     * a model that forgot to switch would otherwise put a whole upload on the
     * main thread.
     */
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    private val base: HttpUrl = origin.toHttpUrl()

    // ── upload ──────────────────────────────────────────────────────────────

    /**
     * Stream one stored object to the server.
     *
     * The body is produced as it is written: the manifest header, then framed
     * ciphertext pulled from [StoredUploadPlan.sources] one chunk at a time. A
     * file never exists in the heap, which is what makes an upload bounded by
     * [com.relayium.protocol.stored.STORE_CHUNK_SIZE] rather than by the
     * selection's size.
     *
     * `Content-Length` is computed exactly rather than left to chunked encoding.
     * The server's quota pre-check reads it to refuse an over-quota upload
     * BEFORE the bytes cross the network, and a chunked request skips that gate
     * and gets refused after paying for the whole transfer.
     *
     * ## The caller owns the sources, including on cancellation
     *
     * This method reads [StoredUploadPlan.sources] and does not close them. That
     * is deliberate — it does not own them, and a transport that closed a
     * caller's descriptors would be closing them at a moment the caller cannot
     * predict — but it puts a real obligation on the caller, and one that is
     * easy to get wrong:
     *
     * **cancelling this call is not enough to release a source.** Cancellation
     * closes the socket, but the body writer may be blocked inside
     * `PlaintextSource.read` — a document provider is another process — and it
     * stays blocked until that read returns. A caller must therefore close its
     * sources from somewhere that is not the blocked reader, off the main
     * thread, whether or not the upload was cancelled, and must make closing
     * idempotent because the encoder closes them too.
     * [CloudUploadModel] does exactly that, and any future caller — a resumable
     * upload, a Device Inbox delivery — owes the same.
     */
    suspend fun upload(
        plan: StoredUploadPlan,
        token: String,
        onProgress: (sent: Long, total: Long) -> Unit,
    ): StoredUploadResult = withContext(io) {
        // The manifest and the sources must agree BEFORE a byte is sent.
        //
        // `Content-Length` is computed from the MANIFEST, while the encoder
        // checks what it reads against each SOURCE's own size — so a document
        // that changed between being picked and being opened produces a body
        // that disagrees with its own declared length. The transport then
        // reports that as a broken connection, which is both wrong and
        // unactionable: nothing is wrong with the network, the file changed.
        // Refusing here names it correctly and costs no upload.
        if (plan.sources.size != plan.manifest.files.size ||
            plan.sources.zip(plan.manifest.files).any { (source, file) -> source.size != file.size }
        ) {
            throw CloudException(CloudFailure(CloudFailure.Kind.SOURCE_FAILED))
        }
        val encManifest = wireFailure { encryptManifest(plan.key, plan.manifest) }
        val streamBytes = wireFailure { cipherSize(plan.manifest.files.map { it.size }) }
        val body = StoredUploadBody(encManifest, plan, streamBytes, onProgress)

        val url = base.newBuilder()
            .addPathSegments("api/files")
            .addQueryParameter("burnAfterRead", if (plan.burnAfterRead) "1" else "0")
            .addQueryParameter("ttl", plan.ttlSeconds.toString())
            .build()
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        val call = authed.newCall(request)
        val (status, text) = try {
            withCancellation(call) {
                call.execute().use { response ->
                    response.code to (response.body.byteString(MAX_JSON_BYTES) ?: "")
                }
            }
        } catch (e: IOException) {
            // A cancelled upload is a cancellation, not a network failure: the
            // socket error below is one this code caused on purpose.
            coroutineContext.ensureActive()
            // A failure raised by the plan's own sources — a file that shrank
            // under us — is that failure, not "the network broke".
            throw CloudException(body.wireFailure ?: transportFailure(e))
        }

        if (status != 200) throw CloudException(uploadFailure(status, text))
        val parsed = Json.parseOrNull(text) as? Json.Obj
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val id = (parsed["id"] as? Json.Str)?.value?.let { StoredObjectId.accepted(it) }
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val expiresAt = parsed.whole("expiresAt")
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        StoredUploadResult(id, expiresAt)
    }

    // ── resumable upload ────────────────────────────────────────────────────

    /**
     * Open a resumable session: `POST /api/uploads`.
     *
     * The body is the init header — `uint32BE(len) || encManifest` — and the
     * server stores it SEPARATELY from the blob. Every offset below therefore
     * counts framed file ciphertext from zero and never includes this header.
     *
     * Retention rides on the QUERY, exactly as it does for the single-shot
     * route, and the purpose is stated rather than left to the server's
     * backfill: a defaulted purpose is one refactor away from publishing
     * something that was never meant to be a public object. `size` is advisory
     * — the server never re-checks it — so it buys an early quota refusal and
     * nothing else.
     *
     * [purpose] defaults to [StoredUploadPurpose.SHARE], so every existing
     * caller sends exactly the query it sent before. A
     * [StoredUploadPurpose.DEVICE_TASK] object must be unlimited-until-TTL: the
     * queue refuses a limited one, and the server refuses the combination
     * outright rather than rewriting it. That refusal is repeated HERE, before
     * a socket is opened, because it costs a round trip to learn it remotely
     * and because a caller that asked for both wanted two different objects.
     */
    suspend fun initUpload(
        header: ByteArray,
        burnAfterRead: Boolean,
        ttlSeconds: Int,
        payloadTotal: Long,
        token: String,
        purpose: StoredUploadPurpose = StoredUploadPurpose.SHARE,
    ): ResumableSession = withContext(io) {
        if (purpose == StoredUploadPurpose.DEVICE_TASK && burnAfterRead) {
            throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        }
        val url = base.newBuilder()
            .addPathSegments("api/uploads")
            .addQueryParameter("purpose", purpose.wire)
            .addQueryParameter("burnAfterRead", if (burnAfterRead) "1" else "0")
            .addQueryParameter("ttl", ttlSeconds.toString())
            .addQueryParameter("size", payloadTotal.toString())
            .build()
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .post(header.toRequestBody(OCTETS))
            .build()
        val (status, text) = execute(authed.newCall(request))
        if (status != 200) throw CloudException(uploadFailure(status, text))
        val parsed = Json.parseOrNull(text) as? Json.Obj
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val id = (parsed["uploadId"] as? Json.Str)?.value?.let { StoredObjectId.accepted(it) }
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        // The id is composed into every path below, so it is refused here rather
        // than at three call sites.
        val issued = parsed.whole("chunkSize")
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        // 0 means "use the protocol default", as the Web and Swift ports read
        // it. Anything above the ceiling is refused, never clamped: the value
        // sizes a buffer, and quietly shrinking a server's answer would hide a
        // disagreement about chunk boundaries.
        val chunk = if (issued == 0L) PendingUploadStore.DEFAULT_CHUNK_SIZE.toLong() else issued
        if (chunk <= 0 || chunk > PendingUploadStore.MAX_CHUNK_SIZE) {
            throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        }
        ResumableSession(id, chunk.toInt())
    }

    /**
     * Append one range: `PATCH /api/uploads/{id}`.
     *
     * `Content-Range: bytes <from>-<inclusiveEnd>/<payloadTotal>`. Both answers
     * the caller must act on carry the server's authoritative offset — 200 when
     * the range started at or below what it holds, 409 when it started past it —
     * and the server silently caps how much ONE append may commit, so a 200 may
     * acknowledge less than was sent. The caller replays from the offset it is
     * given; it never assumes its own range landed whole.
     */
    suspend fun patchChunk(
        uploadId: String,
        body: ByteArray,
        length: Int,
        from: Long,
        payloadTotal: Long,
        token: String,
        onSent: (Long) -> Unit,
    ): UploadOffset = withContext(io) {
        require(length > 0 && length <= body.size) { "an empty append has no Content-Range" }
        val safe = StoredObjectId.accepted(uploadId)
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val request = Request.Builder()
            .url(base.newBuilder().addPathSegments("api/uploads/$safe").build())
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .header("Content-Range", "bytes $from-${from + length - 1}/$payloadTotal")
            .patch(ProgressBody(body, length, onSent))
            .build()
        val (status, text) = execute(authed.newCall(request))
        when (status) {
            200, 409 -> Unit
            404 -> throw CloudException(CloudFailure(CloudFailure.Kind.UPLOAD_SESSION_GONE))
            else -> throw CloudException(uploadFailure(status, text))
        }
        val parsed = Json.parseOrNull(text) as? Json.Obj
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val received = parsed.whole("received")
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        UploadOffset(received, conflict = status == 409)
    }

    /**
     * `POST /api/files?purpose=device_task` — one request, one object, for a
     * delivery whose ciphertext is EMPTY.
     *
     * ## Why the resumable route cannot carry this
     *
     * There, the object's bytes are the frame stream alone: the sealed manifest
     * travels at `init` and the blob is materialised by the first append. A
     * delivery whose only file is empty produces no frames, so no append is ever
     * issued, the blob is never created, and finalize publishes a task pointing
     * at nothing — the receiver then reports `stored_object_unavailable`.
     *
     * The single-shot body is `uint32BE(len) || encManifest || frames`, so even
     * with no frames it is never empty and the object always exists. That is the
     * whole reason this exists, and it is why it is deliberately limited to the
     * zero case rather than offered as a general alternative.
     *
     * ## Why it takes SEALED bytes and not a plan
     *
     * [upload] builds and encrypts a `StoredManifest` of its own. A Device Inbox
     * delivery's manifest is already sealed, in the Inbox's own v3 form, and is
     * OPAQUE to the server — re-encrypting it here would produce a different
     * document than the one the job committed to and the receiver expects. So
     * this takes the header exactly as `uploadHeader(encManifest)` produced it
     * and changes nothing about it.
     *
     * ## Retention is stated, never defaulted
     *
     * `purpose` is explicit. The server refuses a task-purpose upload that also
     * asks to burn or caps downloads, and a purpose left unset would publish
     * this as a SHARE — an object whose life is its TTL *and its download
     * count*, which is not what a device task is. Nothing here can produce that
     * by omission.
     */
    suspend fun uploadEmptyTaskObject(
        header: ByteArray,
        ttlSeconds: Int,
        token: String,
    ): StoredUploadResult = withContext(io) {
        val url = base.newBuilder()
            .addPathSegments("api/files")
            .addQueryParameter("purpose", StoredUploadPurpose.DEVICE_TASK.wire)
            .addQueryParameter("ttl", ttlSeconds.toString())
            .build()
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .post(header.toRequestBody(OCTETS))
            .build()
        val (status, text) = execute(authed.newCall(request))
        if (status != 200) throw CloudException(uploadFailure(status, text))
        // The same shape the share route answers, read the same way: a refusal
        // to guess is what keeps a malformed answer from becoming an object id
        // this device would then record as delivered.
        val parsed = Json.parseOrNull(text) as? Json.Obj
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val id = (parsed["id"] as? Json.Str)?.value?.let { StoredObjectId.accepted(it) }
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val expiresAt = parsed.whole("expiresAt")
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        StoredUploadResult(id, expiresAt)
    }

    /** `GET /api/uploads/{id}` — where to resume from. 404 means the session is
     *  gone: reaped while idle, or already terminal. */
    suspend fun uploadOffset(uploadId: String, token: String): Long = withContext(io) {
        val safe = StoredObjectId.accepted(uploadId)
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val request = Request.Builder()
            .url(base.newBuilder().addPathSegments("api/uploads/$safe").build())
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .build()
        val (status, text) = execute(authed.newCall(request))
        when (status) {
            200 -> Unit
            404 -> throw CloudException(CloudFailure(CloudFailure.Kind.UPLOAD_SESSION_GONE))
            else -> throw CloudException(uploadFailure(status, text))
        }
        (Json.parseOrNull(text) as? Json.Obj)?.whole("received")
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
    }

    /**
     * `POST /api/uploads/{id}/finalize`.
     *
     * The server does NOT verify that the expected bytes all arrived — it
     * commits whatever the blob holds — so completeness is the client's own
     * gate and is checked before this is called.
     *
     * 409 is a session already claimed, and it carries no object id: it cannot
     * prove this upload published, and it cannot license a fresh session either.
     * The caller keeps that uncertainty rather than resolving it here.
     */
    suspend fun finalizeUpload(uploadId: String, token: String): StoredUploadResult =
        withContext(io) {
            val safe = StoredObjectId.accepted(uploadId)
                ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
            val request = Request.Builder()
                .url(base.newBuilder().addPathSegments("api/uploads/$safe/finalize").build())
                .header("Accept", "application/json")
                .header("User-Agent", userAgent)
                .header("Authorization", "Bearer $token")
                .post(ByteArray(0).toRequestBody(OCTETS))
                .build()
            val (status, text) = execute(authed.newCall(request))
            when (status) {
                200 -> Unit
                409 -> throw CloudException(CloudFailure(CloudFailure.Kind.ALREADY_FINALIZED))
                404 -> throw CloudException(CloudFailure(CloudFailure.Kind.UPLOAD_SESSION_GONE))
                else -> throw CloudException(uploadFailure(status, text))
            }
            val parsed = Json.parseOrNull(text) as? Json.Obj
                ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
            val id = (parsed["id"] as? Json.Str)?.value?.let { StoredObjectId.accepted(it) }
                ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
            val expiresAt = parsed.whole("expiresAt")
                ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
            StoredUploadResult(id, expiresAt)
        }

    // ── history ─────────────────────────────────────────────────────────────

    /**
     * `GET /api/files` — the account's shares, as the SERVER describes them.
     *
     * Unpaged server-side, so the response is bounded here twice: by bytes,
     * because a body over the transport ceiling is refused rather than
     * truncated, and by rows. Both refusals are reported as
     * [CloudFailure.Kind.HISTORY_TOO_LARGE] rather than as a partial list — a
     * list that silently stopped would offer a delete button over an incomplete
     * picture of what the account holds.
     *
     * Types are read as the server writes them: `downloaded` is a BOOLEAN it
     * derives from a timestamp column, and the two dates are Unix seconds.
     */
    suspend fun listFiles(token: String): List<StoredFileRow> = withContext(io) {
        val request = Request.Builder()
            .url(base.newBuilder().addPathSegments("api/files").build())
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .build()
        val (status, text, oversize) = executeBounded(authed.newCall(request))
        if (oversize) throw CloudException(CloudFailure(CloudFailure.Kind.HISTORY_TOO_LARGE))
        if (status != 200) throw CloudException(uploadFailure(status, text))
        val parsed = Json.parseOrNull(text) as? Json.Obj
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val items = (parsed["files"] as? Json.Arr)?.items
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        if (items.size > MAX_HISTORY_ROWS) {
            throw CloudException(CloudFailure(CloudFailure.Kind.HISTORY_TOO_LARGE))
        }
        items.map { item ->
            val row = item as? Json.Obj
                ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
            val id = (row["id"] as? Json.Str)?.value?.let { StoredObjectId.accepted(it) }
                ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
            StoredFileRow(
                id = id,
                size = row.whole("size") ?: malformed(),
                createdAt = row.whole("createdAt") ?: malformed(),
                expiresAt = row.whole("expiresAt") ?: malformed(),
                burnAfterRead = (row["burnAfterRead"] as? Json.Bool)?.value ?: malformed(),
                downloaded = (row["downloaded"] as? Json.Bool)?.value ?: malformed(),
                downloadCount = row.whole("downloadCount") ?: malformed(),
            )
        }
    }

    /**
     * `DELETE /api/files/{id}`.
     *
     * A 404 is deliberately ambiguous on the server: missing, owned by somebody
     * else, or not a share all answer alike. It is surfaced as
     * [CloudFailure.Kind.NOT_FOUND] and must never be reported as a successful
     * deletion — this client did not cause it and cannot know that it happened.
     */
    suspend fun deleteFile(id: String, token: String): Unit = withContext(io) {
        val safe = StoredObjectId.accepted(id)
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.LINK_INVALID))
        val request = Request.Builder()
            .url(base.newBuilder().addPathSegments("api/files/$safe").build())
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .header("Authorization", "Bearer $token")
            .delete()
            .build()
        val (status, text) = execute(authed.newCall(request))
        when (status) {
            200 -> Unit
            404 -> throw CloudException(CloudFailure(CloudFailure.Kind.NOT_FOUND))
            else -> throw CloudException(uploadFailure(status, text))
        }
    }

    private fun malformed(): Nothing = throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))

    /** One authenticated JSON round trip, cancellable for its whole lifetime. */
    private suspend fun execute(call: Call): Pair<Int, String> {
        val (status, text, oversize) = executeBounded(call)
        if (oversize) throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        return status to text
    }

    private suspend fun executeBounded(call: Call): Triple<Int, String, Boolean> = try {
        withCancellation(call) {
            call.execute().use { response ->
                val body = response.body.byteString(MAX_JSON_BYTES)
                Triple(response.code, body ?: "", body == null)
            }
        }
    } catch (e: IOException) {
        coroutineContext.ensureActive()
        throw CloudException(transportFailure(e))
    }

    // ── download ────────────────────────────────────────────────────────────

    /** `GET /api/files/<id>/meta`, anonymous and own-origin. */
    suspend fun fetchMeta(id: String): StoredFileMeta = withContext(io) {
        val safe = StoredObjectId.accepted(id)
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.LINK_INVALID))
        val request = Request.Builder()
            .url(base.newBuilder().addPathSegments("api/files/$safe/meta").build())
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .build()
        val call = anonymous.newCall(request)
        val (status, text) = try {
            withCancellation(call) {
                call.execute().use { response ->
                    response.code to (response.body.byteString(MAX_JSON_BYTES) ?: "")
                }
            }
        } catch (e: IOException) {
            coroutineContext.ensureActive()
            throw CloudException(transportFailure(e))
        }
        when (status) {
            200 -> Unit
            404 -> throw CloudException(CloudFailure(CloudFailure.Kind.NOT_FOUND))
            429 -> throw CloudException(CloudFailure(CloudFailure.Kind.DOWNLOAD_LIMITED))
            // Everything else is the service, not the link. A reader holds a
            // link and a key and must be told that neither was even evaluated.
            else -> throw CloudException(
                CloudFailure(CloudFailure.Kind.DOWNLOAD_UNAVAILABLE, status),
            )
        }
        val parsed = Json.parseOrNull(text) as? Json.Obj
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val encoded = (parsed["encManifest"] as? Json.Str)?.value
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val manifest = try {
            Base64.getDecoder().decode(encoded)
        } catch (_: IllegalArgumentException) {
            throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        }
        // Every field is REQUIRED and strictly admitted. A missing or
        // wrong-typed one is a malformed response, never a default: defaulting
        // `burnAfterRead` to false would tell the user a one-shot file can be
        // fetched again, and defaulting `expiresAt` to 0 would invent an expiry
        // this server never stated.
        val size = parsed.whole("size")
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val expiresAt = parsed.whole("expiresAt")
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        val burn = (parsed["burnAfterRead"] as? Json.Bool)?.value
            ?: throw CloudException(CloudFailure(CloudFailure.Kind.MALFORMED))
        StoredFileMeta(manifest, size, burn, expiresAt)
    }

    /**
     * Read the ciphertext and hand back authenticated plaintext chunks,
     * resuming a transport interruption from the last AUTHENTICATED frame
     * boundary.
     *
     * [onChunk] receives plaintext in stream order, and the manifest sizes say
     * where one file ends and the next begins — the stream itself has no
     * separator. It is called on the calling coroutine's thread, and a throw
     * from it aborts the download terminally; see [BlobDownload].
     *
     * [onRecovery] reports the recovery WINDOW — true when an interrupted read
     * is waiting to be resumed, false when a resumed read has been validated and
     * is delivering again. It is state for a surface to render, never progress:
     * the byte counters keep their own meaning throughout.
     *
     * The expected total comes from [manifest], so a stream truncated on a frame
     * boundary — every delivered frame perfectly authentic — is still refused.
     */
    suspend fun downloadBlob(
        link: StoredLink,
        manifest: StoredManifest,
        onRecovery: (Boolean) -> Unit = {},
        onChunk: (ByteArray) -> Unit,
    ): Unit = withContext(io) {
        BlobDownload(link, manifest, onRecovery, onChunk).run()
    }

    /**
     * One stored download, across however many requests it takes — which is one
     * unless the transport breaks and the server has said a resume is safe.
     *
     * ## Why this is not simply "retry the GET"
     *
     * A stored blob is framed AEAD ciphertext being fed to a single
     * [StoreDecryptor] whose sequence number, plaintext total and consumed
     * offset describe everything already delivered. Re-issuing the whole request
     * would feed those bytes a second time and every frame after them would
     * decode as rubbish; issuing a `Range` without checking what came back would
     * do the same thing whenever a server answered it with a full body. So the
     * recovery is defined by four rules, each of which refuses rather than
     * guesses:
     *
     *  1. **Resume only where the server said it is supported.** The capability
     *     is read from the first body's own `Accept-Ranges: bytes` and declared
     *     length, never assumed. That one header is also, exactly, the rule that
     *     a burn or download-limited object is never re-requested: central sends
     *     it only for objects with no download limit and deliberately ignores
     *     `Range` on the others, because a resume is several stateless GETs its
     *     burn accounting cannot reconcile (`server/account/files.go`). A client
     *     that guessed here would spend somebody's one-shot download on a retry.
     *  2. **Resume from [StoreDecryptor.consumedCipher] and nothing else.** It
     *     advances past a frame only once that frame has authenticated, so the
     *     offset can neither re-feed a partial frame nor skip a whole one. The
     *     buffered tail of the interrupted frame is dropped with
     *     [StoreDecryptor.resetBuffer] at that point and only at that point.
     *  3. **A continuation must prove it is one.** Exactly 206, with a
     *     `Content-Range` whose start is the offset asked for, whose end is the
     *     last byte, and whose total is the SAME total the first response
     *     committed to. A 200, a shifted start, a changed total or a length that
     *     disagrees is refused — never appended to what is already written.
     *  4. **Only a transport interruption is recoverable.** Authentication,
     *     decryption, the sink, a refused redirect, 404, 429 and every other
     *     classified answer are terminal exactly as before. Retrying any of them
     *     would be replaying a request the server has already answered.
     *
     * ## The sink is the one-way door
     *
     * [StoreDecryptor.push] returns whole frames and has ALREADY advanced
     * `consumedCipher` past them before [onChunk] sees the first one. So a sink
     * that throws leaves the offset ahead of what was actually written, and a
     * resume from it would silently skip plaintext the user never received.
     * There is no recovery from that which is not data loss, so a sink failure
     * ends the download and can never be retried — [sinkFailed] is checked by
     * [mayRetry] rather than left to the exception type, so a sink that one day
     * throws an `IOException` is still not mistaken for a network drop.
     *
     * ## What it does not widen
     *
     * A resume re-enters at the SAME `/api/files/<id>/blob` route the first
     * attempt used, with one header added, and every hop is re-validated by the
     * unchanged [BlobRedirect] policy. It does not re-target a node URL directly
     * — a fleet/BYO redirect carries a single-use token, so central is where a
     * fresh one comes from — and it adds no credential: the request is anonymous
     * before and after, and the key never leaves this device.
     */
    private inner class BlobDownload(
        private val link: StoredLink,
        manifest: StoredManifest,
        private val onRecovery: (Boolean) -> Unit,
        private val onChunk: (ByteArray) -> Unit,
    ) {

        /** The manifest's plaintext total: the completeness proof, unchanged. */
        private val expected = manifest.files.sumOf { it.size }

        /** ONE decryptor for the whole download, across every attempt. */
        private val decryptor = StoreDecryptor(link.key)

        /**
         * The ciphertext total the first body-serving response committed to,
         * set only when that response ALSO declared `Accept-Ranges: bytes`.
         *
         * Null means this download is a single GET: no resume is attempted, no
         * request is replayed, and the behaviour is exactly what it was before
         * recovery existed.
         */
        private var resumableTotal: Long? = null

        /**
         * [onChunk] threw. The download is over; see the class note.
         *
         * A SECOND fence, not the primary one: [SinkFailure] already carries a
         * callback's exception past the transport's `IOException` handling, so
         * a sink error cannot reach the retry decision at all. This flag means
         * that even if it somehow did, [mayRetry] still refuses. Two fences,
         * because the failure this prevents is silent: a resume from an offset
         * the sink never received skips plaintext without anything looking
         * wrong.
         */
        private var sinkFailed = false

        /**
         * Ciphertext bytes this download has RECEIVED, whether or not they have
         * authenticated yet.
         *
         * Distinct from [StoreDecryptor.consumedCipher], and the distinction is
         * the one that decides whether a stream may be retried at all. A body
         * whose final frame is cryptographically truncated — the length prefix
         * promises bytes the object does not contain — delivers every byte the
         * server advertised while leaving `consumedCipher` short of the total,
         * because the dangling tail never authenticates. Retrying that is
         * re-fetching a body that will fail identically every time.
         *
         * So completeness at the TRANSPORT layer is measured here, and integrity
         * is left to `end`: all advertised bytes arrived means the answer is
         * final, and fewer arrived means the connection stopped early and a
         * resume may continue it.
         */
        private var rawReceived = 0L

        /** The coroutine this download runs in, captured so the plaintext drain
         *  below can be a cancellation point. See [readHop]. */
        private var context: kotlin.coroutines.CoroutineContext = kotlin.coroutines.EmptyCoroutineContext

        /** The transport failure the current recovery is recovering from, kept
         *  so an unrecoverable answer can be reported as what actually went
         *  wrong rather than as whatever the resume attempt looked like. */
        private var interruption: CloudFailure? = null

        private var attempts = 0

        suspend fun run() {
            context = coroutineContext
            var recovering = false
            while (true) {
                coroutineContext.ensureActive()
                val start = decryptor.consumedCipher
                val failure = try {
                    attempt(start, recovering)
                    null
                } catch (e: Interrupted) {
                    e.failure
                }
                recovering = false
                // Everything the server committed to has arrived. `end` is the
                // authority on whether it is the right file, so a transport
                // error raised after the last byte must not turn a complete,
                // authenticated download into a reported failure.
                if (allAdvertisedBytesArrived()) break
                // No declared total to fall short of: this was a single GET and
                // it ended. Whatever it delivered, `end` decides.
                if (failure == null && resumableTotal == null) break
                interruption = failure ?: interruption
                if (!mayRetry()) {
                    // The transfer was interrupted and could not be continued.
                    // Reported as the transport failure it was — including for
                    // a clean short read, which is a connection that stopped
                    // early rather than ciphertext that failed to authenticate.
                    // `DAMAGED` is reserved for the integrity verdict `end`
                    // gives below, and saying it here would send a user to look
                    // at a file when the thing that broke was the network.
                    //
                    // Reaching here always means the transfer stopped short: a
                    // complete one broke out above, and a capability-less
                    // download is complete by definition because there is no
                    // declared total to fall short of.
                    throw CloudException(
                        interruption ?: CloudFailure(CloudFailure.Kind.NETWORK),
                    )
                }
                // EVERY retry, including one that restarts at zero.
                //
                // The buffered tail of an interrupted frame has not
                // authenticated and cannot be kept across a re-read: a resume
                // prepends it to bytes that already contain it, and a
                // zero-offset restart — which is what a drop before the FIRST
                // complete frame produces, since there is no boundary to resume
                // from — prepends it to the whole body. Gating this on a
                // non-zero offset left exactly that case corrupting an
                // otherwise valid download.
                decryptor.resetBuffer()
                attempts += 1
                recovering = true
                onRecovery(true)
                backoff(attempts)
            }
            // Unchanged, and still the only thing that may declare this
            // complete: a boundary-aligned truncation leaves every delivered
            // frame authentic, so the manifest's total is what tells "the file
            // ended" from "someone stopped it early".
            wireFailure { decryptor.end(expected) }
        }

        /**
         * Whether every ciphertext byte the server committed to has arrived.
         *
         * Measured on RECEIVED bytes, not authenticated ones — see
         * [rawReceived]. False when no total was declared, because there is then
         * nothing to have arrived in full; that case is handled separately.
         */
        private fun allAdvertisedBytesArrived(): Boolean {
            val total = resumableTotal ?: return false
            return rawReceived >= total
        }

        /**
         * Whether another request may be issued.
         *
         * Three independent gates, and the download stops if any refuses: the
         * server declared a resume safe, the sink is still intact, and the
         * global attempt budget is not spent. Global rather than per-offset on
         * purpose — a per-offset counter would let a connection that breaks
         * every few frames run indefinitely.
         */
        private fun mayRetry(): Boolean {
            val total = resumableTotal ?: return false
            if (sinkFailed || attempts >= MAX_RESUME_ATTEMPTS) return false
            // There is no tail left to ask for. `Range: bytes=<total>-` is
            // outside the object, which central refuses as unsatisfiable — and
            // a request that cannot succeed is not a recovery.
            return decryptor.consumedCipher < total
        }

        /** Cancellable by construction: a user who leaves during the wait
         *  unwinds here rather than after the next request has been issued. */
        private suspend fun backoff(attempt: Int) {
            val step = RESUME_BACKOFF_MS shl (attempt - 1)
            kotlinx.coroutines.delay(step.coerceAtMost(RESUME_BACKOFF_MAX_MS))
        }

        /** One request and its redirect chain, start to finish. */
        private suspend fun attempt(start: Long, recovering: Boolean) {
            var url = base.newBuilder().addPathSegments("api/files/${link.id}/blob").build()
            var hop = 0
            while (true) {
                coroutineContext.ensureActive()
                val builder = Request.Builder()
                    .url(url)
                    .header("Accept", "application/octet-stream")
                    .header("User-Agent", userAgent)
                    // Native clients opt into the BYO own-node redirect; the
                    // fleet one happens with or without this header.
                    .header("X-Relayium-Direct-Download", "1")
                    // The body is AEAD ciphertext: there is nothing in it to
                    // compress, and a transfer encoding would break the one
                    // thing a resume depends on — that a byte counted here is a
                    // byte at that offset in the object. Stated rather than
                    // left to OkHttp's transparent gzip, which would otherwise
                    // negotiate an encoding and strip the declared length.
                    .header("Accept-Encoding", "identity")
                // The one open-ended shape central accepts, and the one the
                // CLI already speaks. It rides every hop, which is what lets a
                // redirected node answer the continuation.
                if (start > 0) builder.header("Range", "bytes=$start-")
                val call = anonymous.newCall(builder.build())
                // One hop, start to finish, inside one cancellation scope: the
                // headers AND the body, because a stalled download is blocked in
                // the body read and that is what has to be interruptible.
                val next = try {
                    withCancellation(call) {
                        call.execute().use { response ->
                            readHop(response, url, hop, start, recovering)
                        }
                    }
                } catch (e: SinkFailure) {
                    // The CALLER's failure, rethrown exactly as it was thrown.
                    // It is unwrapped here, before the `IOException` arm below,
                    // because a sink that throws an `IOException` is not a
                    // network drop and must not be classified — or retried — as
                    // one. See [SinkFailure].
                    throw e.thrown
                } catch (e: IOException) {
                    // A cancelled transfer unwinds as a cancellation, never as a
                    // network failure this app caused on purpose.
                    coroutineContext.ensureActive()
                    throw Interrupted(transportFailure(e))
                }
                if (next == null) return
                url = next
                hop += 1
            }
        }

        /**
         * One response: either a validated redirect to follow, or null once this
         * response's body has been streamed through [onChunk].
         */
        private fun readHop(
            response: okhttp3.Response,
            url: HttpUrl,
            hop: Int,
            start: Long,
            recovering: Boolean,
        ): HttpUrl? {
            if (response.code in 300..399) {
                return when (val verdict = BlobRedirect.next(url, response.header("Location"), base, hop)) {
                    is BlobRedirect.Verdict.Follow -> verdict.url
                    is BlobRedirect.Verdict.Refuse ->
                        throw CloudException(CloudFailure(CloudFailure.Kind.UNTRUSTED_REDIRECT))
                }
            }
            when (response.code) {
                200, 206 -> Unit
                404 -> throw CloudException(CloudFailure(CloudFailure.Kind.NOT_FOUND))
                429 -> throw CloudException(CloudFailure(CloudFailure.Kind.DOWNLOAD_LIMITED))
                else -> throw CloudException(
                    CloudFailure(CloudFailure.Kind.DOWNLOAD_UNAVAILABLE, response.code),
                )
            }
            if (start == 0L) {
                if (response.code != 200) unusable(response)
                // A retry that restarts at zero — which is what a drop before
                // the first complete frame produces — must still be answering
                // about the SAME object. The capability is validated against
                // what the first response committed to rather than replaced by
                // whatever this one says, because an object that changed size
                // between two requests is not one this download can finish.
                val known = resumableTotal
                if (known == null) rememberResumeCapability(response)
                else if (response.body.contentLength() != known || encoded(response)) unusable(response)
                if (recovering) onRecovery(false)
            } else {
                val total = resumableTotal
                if (response.code != 206 || total == null || !continues(response, start, total)) {
                    // Not a continuation of what is already written. Nothing is
                    // fed from it — splicing a fresh body into the middle of an
                    // authenticated stream is the one mistake this whole class
                    // exists to make impossible.
                    unusable(response)
                }
                if (recovering) onRecovery(false)
            }
            rawReceived = start
            val limit = resumableTotal
            val source = response.body.source()
            val buffer = ByteArray(READ_BUFFER_BYTES)
            while (true) {
                val read = source.read(buffer)
                if (read == -1) return null
                // BEFORE anything is decrypted or written. A server sending more
                // than it committed to is not one whose extra bytes should reach
                // a decryptor, let alone a document in the user's folder.
                if (limit != null && rawReceived + read > limit) {
                    throw CloudException(
                        CloudFailure(CloudFailure.Kind.DOWNLOAD_UNAVAILABLE, response.code),
                    )
                }
                rawReceived += read
                for (chunk in wireFailure { decryptor.push(buffer.copyOf(read)) }) {
                    // One network read can complete more than one frame, and
                    // the drain between them blocks on nothing — so without
                    // this a cancelled download would keep handing plaintext to
                    // a sink the user has already left, until the next socket
                    // read noticed. Cancellation is checked per chunk instead.
                    context.ensureActive()
                    try {
                        onChunk(chunk)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        // Cancellation is not a sink failure and is not
                        // classified: it unwinds as itself.
                        throw e
                    } catch (t: Throwable) {
                        // `consumedCipher` has already advanced past this frame,
                        // so no resume from here could be honest. See the class
                        // note.
                        sinkFailed = true
                        throw SinkFailure(t)
                    }
                }
            }
        }

        /**
         * This response cannot be used to continue the download.
         *
         * A typed service answer carrying the status, rather than the
         * interruption that led here: "the server answered 200 to a Range
         * request" or "it is now describing a different object" is a fact about
         * the SERVICE, and the status code is the only diagnostic a report of it
         * would otherwise have. It never feeds a byte, and it is never retried —
         * repeating a request the server has already answered this way would
         * produce the same answer.
         */
        private fun unusable(response: okhttp3.Response): Nothing = throw CloudException(
            CloudFailure(CloudFailure.Kind.DOWNLOAD_UNAVAILABLE, response.code),
        )

        /** Any content coding other than identity. A body that arrived encoded
         *  has a wire length that is not an offset into the object. */
        private fun encoded(response: okhttp3.Response): Boolean {
            val coding = response.header("Content-Encoding")?.trim() ?: return false
            return !coding.equals("identity", ignoreCase = true)
        }

        /**
         * Read the server's own statement that a resume is supported, and the
         * total it commits to.
         *
         * Both or neither: a length with no `Accept-Ranges` is a server that may
         * answer a `Range` with a full body, and `Accept-Ranges` with no length
         * gives nothing to compare a continuation against.
         */
        private fun rememberResumeCapability(response: okhttp3.Response) {
            val accepts = response.header("Accept-Ranges")
                ?.split(',')
                ?.any { it.trim().equals("bytes", ignoreCase = true) } == true
            if (!accepts || encoded(response)) return
            val declared = response.body.contentLength()
            if (declared <= 0) return
            resumableTotal = declared
        }

        /**
         * Whether this 206 really continues the stream, by its own headers.
         *
         * `Content-Range` is required and parsed exactly: a server that answered
         * a different offset, or that is now describing an object of a different
         * size, is not continuing this download.
         *
         * The declared length must be present and exactly the remainder. An
         * unknown length is refused rather than tolerated: without it there is
         * no independent statement of how much is coming, so the body-overrun
         * check in [readHop] would have nothing to bound and a chunked answer
         * could run past the object while every header still looked right.
         */
        private fun continues(response: okhttp3.Response, start: Long, total: Long): Boolean {
            if (encoded(response)) return false
            val match = CONTENT_RANGE.matchEntire(response.header("Content-Range")?.trim().orEmpty())
                ?: return false
            val (first, last, whole) = match.destructured
            if (first.toLongOrNull() != start) return false
            if (whole.toLongOrNull() != total) return false
            if (last.toLongOrNull() != total - 1) return false
            return response.body.contentLength() == total - start
        }
    }

    /** A transport interruption that a resume may be able to continue past.
     *  Internal to [BlobDownload]; never seen by a caller. */
    private class Interrupted(val failure: CloudFailure) : RuntimeException(null, null)

    /**
     * Whatever the caller's `onChunk` threw, carried across this file's own
     * `IOException` handling so it can never be reclassified as a transport
     * failure — and therefore never resumed.
     *
     * The distinction is load-bearing rather than tidy. `readHop` runs the sink
     * callback INSIDE the body read, so a sink that raises an `IOException` —
     * which a sink writing to a document provider genuinely can — would
     * otherwise be caught by the arm that means "the network dropped", reported
     * as a network failure the user cannot act on, and, now that recovery
     * exists, retried from an offset the sink never received. Wrapping makes
     * the two impossible to confuse; the exception reaches the caller exactly
     * as it was thrown.
     */
    private class SinkFailure(val thrown: Throwable) : RuntimeException(null, null)

    /**
     * Run one call's ENTIRE lifetime with the coroutine's cancellation bound to
     * it.
     *
     * Switching to an IO dispatcher is not cancellation. A coroutine cancelled
     * while `execute()` is blocked in a socket read — or in the body write of a
     * large upload, where the write deadline is deliberately infinite — stays
     * blocked until the peer or a timeout ends it, so the thread and the
     * transfer both keep running after the user has left the screen.
     * `Call.cancel()` closes the socket, which is what turns the block into an
     * `IOException` this code can unwind.
     *
     * The watcher is a CHILD coroutine suspended in `awaitCancellation`, not a
     * completion handler: a job that is cancelled while its body sits in
     * uninterruptible blocking code does not COMPLETE until that body returns,
     * so a completion handler would fire only after the wait it was supposed to
     * cut short. Cancellation, by contrast, reaches a suspended child at once.
     *
     * Two details that are load-bearing rather than stylistic:
     *
     * * **[CoroutineStart.UNDISPATCHED].** A watcher merely `launch`ed is
     *   scheduled, not started. Cancelling the scope before that schedule runs
     *   cancels the child WITHOUT ever entering its body — so the `finally`
     *   never executes and the call is never cancelled, which is precisely the
     *   case this exists for. Starting undispatched runs it synchronously up to
     *   `awaitCancellation`, so the cleanup is registered before any blocking
     *   work begins.
     * * **[Dispatchers.Default] for the resumption.** The thread that must be
     *   rescued is the one blocked in the socket, so the cancellation must not
     *   need it — nor a saturated IO pool — to run.
     *
     * The caller must be FINISHED with [call] when [body] returns: the watcher
     * is cancelled on the way out, which cancels the call. Every caller below
     * consumes or abandons its response inside the block.
     */
    private suspend fun <T> withCancellation(call: Call, body: () -> T): T = coroutineScope {
        val watcher = launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            // Already cancelled? Then no request is issued at all, rather than
            // one that is started and immediately torn down.
            ensureActive()
            body()
        } finally {
            watcher.cancel()
        }
    }

    // ── failure classification ──────────────────────────────────────────────

    private fun uploadFailure(status: Int, body: String): CloudFailure = when (status) {
        400 -> CloudFailure(CloudFailure.Kind.REJECTED)
        401 -> CloudFailure(CloudFailure.Kind.UNAUTHORIZED)
        413 -> CloudFailure(CloudFailure.Kind.STORAGE_LIMIT)
        429 -> tooManyRequests(body)
        503 -> CloudFailure(CloudFailure.Kind.STORAGE_UNAVAILABLE)
        507 -> CloudFailure(CloudFailure.Kind.SERVER_FULL)
        else -> CloudFailure(CloudFailure.Kind.SERVER, status)
    }

    /**
     * The three 429s an upload can meet, told apart by the only discriminator
     * the server offers.
     *
     * Matching on server prose is a weak contract, so it fails SAFE: anything
     * unrecognised is [CloudFailure.Kind.RATE_LIMITED], which says "try again"
     * — true for all three — rather than asserting a quota story and offering an
     * upgrade that would not help.
     */
    private fun tooManyRequests(body: String): CloudFailure {
        val text = body.lowercase()
        return when {
            text.contains("daily quota") -> CloudFailure(CloudFailure.Kind.DAILY_QUOTA)
            text.contains("monthly traffic") -> CloudFailure(CloudFailure.Kind.MONTHLY_TRAFFIC)
            else -> CloudFailure(CloudFailure.Kind.RATE_LIMITED)
        }
    }

    private fun transportFailure(e: IOException): CloudFailure = when {
        e is java.net.SocketTimeoutException -> CloudFailure(CloudFailure.Kind.TIMEOUT)
        e is java.io.InterruptedIOException &&
            e.message?.contains("timeout", ignoreCase = true) == true ->
            CloudFailure(CloudFailure.Kind.TIMEOUT)

        else -> CloudFailure(CloudFailure.Kind.NETWORK)
    }

    companion object {

        /** A metadata or result document. Anything larger is not one. */
        private const val MAX_JSON_BYTES = 256 * 1024L

        /** A second, independent bound on the account's unpaged file list. The
         *  byte ceiling above already refuses a huge body; this refuses a body
         *  that fits and still describes more rows than a phone can usefully
         *  present or a user can reason about. */
        const val MAX_HISTORY_ROWS = 1000

        private const val READ_BUFFER_BYTES = 64 * 1024

        /**
         * How many times one download may be resumed, in total.
         *
         * Global rather than per-offset: a link that breaks every few frames
         * must end as a reported failure rather than as a request loop. Five
         * requests in all, which matches what `InboxReceiver` allows one
         * delivery.
         */
        private const val MAX_RESUME_ATTEMPTS = 4

        /** First wait before a resume; doubled per attempt, capped below. */
        private const val RESUME_BACKOFF_MS = 250L
        private const val RESUME_BACKOFF_MAX_MS = 2_000L

        /** `bytes <first>-<last>/<total>`, and nothing looser: a `*` total or a
         *  multipart answer is not a continuation this client can verify. */
        private val CONTENT_RANGE = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$")

        private val OCTETS = "application/octet-stream".toMediaType()

        /** Carries a bearer, so it follows nothing. */
        fun authedClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            // No write deadline and no call ceiling: this body is a file, and a
            // large upload on a slow uplink is legitimately long. The read and
            // connect deadlines still bound a server that never answers.
            .writeTimeout(0, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()

        /**
         * Anonymous. Redirects are followed by [CloudClient] itself, one
         * validated hop at a time — never by OkHttp, whose follower would carry
         * this request's headers to the new host.
         */
        fun anonymousClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()

        /** Turn a wire refusal into a classified cloud failure. */
        internal inline fun <T> wireFailure(body: () -> T): T = try {
            body()
        } catch (e: StoredWireException) {
            throw CloudException(
                when (e.reason) {
                    StoredWireException.Reason.INVALID_KEY ->
                        CloudFailure(CloudFailure.Kind.LINK_INVALID)

                    StoredWireException.Reason.INVALID_MANIFEST ->
                        CloudFailure(CloudFailure.Kind.MALFORMED)

                    else -> CloudFailure(CloudFailure.Kind.DAMAGED)
                },
            )
        }
    }
}

/**
 * The upload body, produced as it is written.
 *
 * `uint32BE(len(encManifest)) || encManifest || frames…`, the layout
 * `docs/protocol/relayium-stored-wire-v1.md` fixes and the Web writes.
 *
 * One-shot: it reads forward from real file descriptors and cannot be replayed,
 * so OkHttp must never retry it. Saying so is not optional — a silent second
 * attempt would re-read sources already at EOF and send a body that disagrees
 * with its own `Content-Length`.
 */
private class StoredUploadBody(
    private val header: ByteArray,
    private val plan: StoredUploadPlan,
    private val streamBytes: Long,
    private val onProgress: (Long, Long) -> Unit,
) : RequestBody() {

    /** Set when the SOURCES failed rather than the network, so the caller can
     *  report which one actually happened. */
    @Volatile
    var wireFailure: CloudFailure? = null
        private set

    private val total = 4L + header.size + streamBytes

    override fun contentType() = "application/octet-stream".toMediaType()

    override fun contentLength() = total

    override fun isOneShot() = true

    private fun sourceFailure(e: Throwable): CloudFailure = when {
        // A cancelled upload closes its sources out from under this reader, so
        // the throw that follows is one the app caused. It must not be reported
        // as a file the user should go and check.
        e is kotlinx.coroutines.CancellationException -> CloudFailure(CloudFailure.Kind.CANCELLED)
        e is StoredWireException && e.reason != StoredWireException.Reason.LENGTH_MISMATCH ->
            CloudFailure(CloudFailure.Kind.DAMAGED)

        else -> CloudFailure(CloudFailure.Kind.SOURCE_FAILED)
    }

    override fun writeTo(sink: BufferedSink) {
        sink.write(uploadHeader(header))
        var sent = 4L + header.size
        onProgress(sent, total)
        val encryptor = ChunkEncryptor(plan.key, plan.sources)
        try {
            while (true) {
                val frame = try {
                    encryptor.next() ?: break
                } catch (e: Throwable) {
                    // A document provider can raise anything — IOException,
                    // SecurityException, a provider-specific error — and a
                    // source that changed size raises a wire mismatch. All of
                    // them are the FILE failing, not the network, and the two
                    // are worth telling apart because the user's next action
                    // differs. The exception itself is dropped rather than
                    // carried: its message is a provider's, about a path.
                    wireFailure = sourceFailure(e)
                    throw IOException("upload source failed")
                }
                sink.write(frame)
                sent += frame.size
                onProgress(sent, total)
            }
            try {
                encryptor.finish()
            } catch (e: Throwable) {
                wireFailure = sourceFailure(e)
                throw IOException("upload source failed")
            }
        } finally {
            encryptor.close()
        }
    }
}

/** Read at most [limit] bytes of a response body as UTF-8, or null if it is
 *  longer — refused rather than truncated, so a partial document never reaches
 *  the parser looking whole. */
private fun okhttp3.ResponseBody.byteString(limit: Long): String? {
    if (contentLength() > limit) return null
    val source = source()
    if (source.request(limit + 1)) return null
    return source.readByteArray().toString(Charsets.UTF_8)
}

/**
 * A whole, non-negative number the server stated, or null.
 *
 * Strict on purpose: JSON numbers arrive as doubles, and `toLong()` would turn
 * `1.9` into `1`, `-1` into a negative expiry and `1e300` into
 * `Long.MAX_VALUE`. Each of those is a fact about a stored object — when it
 * expires, how large it is — that the client would then state to the user as
 * though the server had said it.
 */
private fun Json.Obj.whole(key: String): Long? {
    val value = (this[key] as? Json.Num)?.value ?: return null
    if (value.isNaN() || value != Math.floor(value)) return null
    if (value < 0 || value > MANIFEST_MAX_SAFE_INTEGER.toDouble()) return null
    return value.toLong()
}


/**
 * A fixed byte range, written in slices so progress follows the bytes rather
 * than the chunk boundary.
 *
 * Replayable: the array is the caller's immutable spool page and is not
 * consumed, so OkHttp retrying this body would send the same bytes. It is still
 * declared one-shot, because a silent retry would double-count progress the
 * caller is using to decide whether the transfer is advancing.
 */
private class ProgressBody(
    private val bytes: ByteArray,
    private val length: Int,
    private val onSent: (Long) -> Unit,
) : RequestBody() {

    override fun contentType() = "application/octet-stream".toMediaType()

    override fun contentLength() = length.toLong()

    override fun isOneShot() = true

    override fun writeTo(sink: BufferedSink) {
        var written = 0
        while (written < length) {
            val step = minOf(SLICE_BYTES, length - written)
            sink.write(bytes, written, step)
            written += step
            onSent(written.toLong())
        }
    }

    private companion object {
        const val SLICE_BYTES = 64 * 1024
    }
}
