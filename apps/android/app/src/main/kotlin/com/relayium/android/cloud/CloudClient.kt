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
     * route, and `purpose=share` is stated rather than left to the server's
     * backfill: a defaulted purpose is one refactor away from publishing
     * something that was never meant to be a public object. `size` is advisory
     * — the server never re-checks it — so it buys an early quota refusal and
     * nothing else.
     */
    suspend fun initUpload(
        header: ByteArray,
        burnAfterRead: Boolean,
        ttlSeconds: Int,
        payloadTotal: Long,
        token: String,
    ): ResumableSession = withContext(io) {
        val url = base.newBuilder()
            .addPathSegments("api/uploads")
            .addQueryParameter("purpose", "share")
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
     * Read the ciphertext and hand back authenticated plaintext chunks.
     *
     * [onChunk] receives plaintext in stream order, and the manifest sizes say
     * where one file ends and the next begins — the stream itself has no
     * separator. It is called on the calling coroutine's thread, and a throw
     * from it aborts the download.
     *
     * The expected total comes from [manifest], so a stream truncated on a frame
     * boundary — every delivered frame perfectly authentic — is still refused.
     */
    suspend fun downloadBlob(
        link: StoredLink,
        manifest: StoredManifest,
        onChunk: (ByteArray) -> Unit,
    ): Unit = withContext(io) {
        val expected = manifest.files.sumOf { it.size }
        val decryptor = StoreDecryptor(link.key)
        var url = base.newBuilder().addPathSegments("api/files/${link.id}/blob").build()
        var hop = 0

        while (true) {
            val request = Request.Builder()
                .url(url)
                .header("Accept", "application/octet-stream")
                .header("User-Agent", userAgent)
                // Native clients opt into the BYO own-node redirect; the fleet
                // one happens with or without this header.
                .header("X-Relayium-Direct-Download", "1")
                .build()
            val call = anonymous.newCall(request)
            // One hop, start to finish, inside one cancellation scope: the
            // headers AND the body, because a stalled download is blocked in
            // the body read and that is what has to be interruptible.
            val next = try {
                withCancellation(call) {
                    call.execute().use { response ->
                        readHop(response, url, hop, decryptor, onChunk)
                    }
                }
            } catch (e: IOException) {
                // A cancelled transfer unwinds as a cancellation, never as a
                // network failure this app caused on purpose.
                coroutineContext.ensureActive()
                throw CloudException(transportFailure(e))
            }
            if (next == null) break
            url = next
            hop += 1
        }
        wireFailure { decryptor.end(expected) }
    }

    /**
     * One response: either a validated redirect to follow, or null once the
     * whole body has been streamed through [onChunk].
     */
    private fun readHop(
        response: okhttp3.Response,
        url: HttpUrl,
        hop: Int,
        decryptor: StoreDecryptor,
        onChunk: (ByteArray) -> Unit,
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
        val source = response.body.source()
        val buffer = ByteArray(READ_BUFFER_BYTES)
        while (true) {
            val read = source.read(buffer)
            if (read == -1) return null
            for (chunk in wireFailure { decryptor.push(buffer.copyOf(read)) }) onChunk(chunk)
        }
    }

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
