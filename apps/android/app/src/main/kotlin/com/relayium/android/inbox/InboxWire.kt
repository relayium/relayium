package com.relayium.android.inbox

import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxPresence
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxTaskErrorCode
import com.relayium.protocol.inbox.InboxTaskState

/**
 * The Device Inbox wire shapes, decoded STRICTLY.
 *
 * The server speaks Go's default capitalization on these routes — `ID`,
 * `State`, `Presence` — because the subtree is carried inside `GET /api/devices`,
 * which shipped that way before any client asked for lowerCamel. Requests are
 * lowerCamel. Both spellings are written out here rather than case-folded, so
 * the one contract stays readable at the one place it is decided.
 *
 * WHY EVERY READER BELOW IS HAND-WRITTEN. A permissive decoder is how a closed
 * protocol set stops being closed: a `String` field accepts any value at all,
 * and a number read through `toLong()` silently accepts `1.5` and `1e30`. Every
 * reader here refuses instead:
 *
 *  * a state, presence, policy or error token that is not a member of its set
 *    is a refusal, never a default — an unknown state must not resolve to
 *    `queued` and an unknown policy must not resolve to `off`, because both
 *    would be this build inventing a fact about the server;
 *  * a boolean must be a JSON boolean. `"true"` and `1` are refused: this is
 *    how `CanReceive` and `Committed` are carried, and a truthy string is a
 *    different claim from a true;
 *  * an integer must be exactly integral and inside the range JSON can carry
 *    without loss, and the ones with a meaningful floor are bounded here rather
 *    than at each call site.
 *
 * NOTHING REMOTE IS ECHOED. [InboxApiException] carries a status and a
 * machine-readable token from a bounded prefix; there is no field on it, and no
 * constructor, through which a response body, a file name or key material could
 * travel.
 */

/** Why a document was refused. Closed, and carried without any remote text. */
enum class InboxWireReason {
    /** The body was not a JSON object of the expected shape. */
    MALFORMED,

    /** A required field was absent. */
    MISSING_FIELD,

    /** A field was present with the wrong JSON type. */
    WRONG_TYPE,

    /** A number was fractional, out of range, or below its floor. */
    OUT_OF_RANGE,

    /** A closed-set token this build does not know. */
    UNKNOWN_VALUE,

    /** An identifier that must not become a URL path component. */
    INVALID_IDENTIFIER,

    /**
     * The server answered about a DIFFERENT thing than was asked about.
     *
     * Separate from [MALFORMED] because the document is well-formed: it simply
     * names another device, another task, another stored object or another key
     * generation. Accepting one would mean acting on a delivery the caller never
     * requested, so it is refused at the boundary rather than reconciled.
     */
    IDENTITY_MISMATCH,
}

/**
 * A refused document.
 *
 * The message names the reason and the FIELD, never the value: a value here is
 * remote input on a path that ends in a test report or a crash log.
 */
class InboxWireException(val reason: InboxWireReason, val field: String) :
    RuntimeException("relayium inbox wire: $reason ($field)")

/**
 * A rejection central returned.
 *
 * [rejection] is set only for the tokens this build must BRANCH on; anything
 * else keeps its status and a null rejection, so an unrecognised token can never
 * be mistaken for a known one. The raw body is not carried at all.
 */
class InboxApiException(
    val status: Int,
    val rejection: com.relayium.protocol.inbox.InboxRejection?,
) : RuntimeException("relayium inbox api: $status ${rejection?.wire ?: "-"}")

/** The transport could not complete the exchange. No cause is carried: an
 *  OkHttp/IO message quotes the URL, which holds a device id. */
class InboxTransportException(val kind: Kind) :
    RuntimeException("relayium inbox transport: $kind") {

    enum class Kind {
        /** DNS, connect, TLS, reset — or a redirect, which is refused. */
        NETWORK,

        /** A connect/read deadline elapsed. */
        TIMEOUT,

        /** The response exceeded the bounded read. Refused, never truncated. */
        TOO_LARGE,

        /** The request could not be formed, so nothing was sent. */
        REQUEST_REJECTED,
    }
}

// ── identifiers ─────────────────────────────────────────────────────────────

/**
 * A server-minted id that is safe to become one URL path component or one file
 * name.
 *
 * CHECKED, not escaped, and the reasoning is `AccountClient.deleteDevice`'s:
 * every id central issues is 32 lowercase hex characters, so nothing legitimate
 * is near the edge — while an id carrying `/` or `..` composes a path whose dot
 * segments a proxy may resolve, aiming an authenticated request at an endpoint
 * the user never asked for. It is applied to REMOTE ids too, deliberately: this
 * converts a remote string into a path, and that conversion must not depend on a
 * remote invariant staying true.
 */
object InboxId {

    private val SHAPE = Regex("^[a-zA-Z0-9_-]{1,64}$")

    fun isValid(id: String): Boolean = SHAPE.matches(id)

    fun checked(id: String, field: String): String {
        if (!isValid(id)) throw InboxWireException(InboxWireReason.INVALID_IDENTIFIER, field)
        return id
    }
}

// ── strict readers ──────────────────────────────────────────────────────────

internal object Wire {

    fun obj(value: Json?, field: String): Json.Obj =
        value as? Json.Obj ?: throw fail(value, field)

    /**
     * An object the server may legitimately omit, and NOTHING else.
     *
     * Absent and explicit `null` both mean "there is none" — a device that never
     * enrolled, an enrolment with no active key. Any other type is a refusal.
     *
     * The distinction is load-bearing rather than pedantic: reading a
     * wrong-typed value as absent would turn a malformed reply into a confident
     * "this device holds no key", which is the input to key health and to the
     * explicit repair path. The app would then offer to repair custody that is
     * not actually broken, or rotate over ciphertext already queued to a key
     * that does exist.
     */
    fun optionalObj(source: Json.Obj, field: String): Json.Obj? =
        when (val value = source[field]) {
            null, is Json.Null -> null
            is Json.Obj -> value
            else -> throw InboxWireException(InboxWireReason.WRONG_TYPE, field)
        }

    fun arr(source: Json.Obj, field: String): List<Json> =
        (source[field] as? Json.Arr)?.items ?: throw fail(source[field], field)

    fun str(source: Json.Obj, field: String): String =
        (source[field] as? Json.Str)?.value ?: throw fail(source[field], field)

    /** A non-empty string. Distinct from [str] because an empty `ID` is a
     *  malformed row, while an empty `ErrorCode` is the normal "nothing wrong". */
    fun requiredStr(source: Json.Obj, field: String): String =
        str(source, field).ifEmpty { throw InboxWireException(InboxWireReason.MISSING_FIELD, field) }

    fun id(source: Json.Obj, field: String): String =
        InboxId.checked(requiredStr(source, field), field)

    /** A JSON boolean, and only that. */
    fun bool(source: Json.Obj, field: String): Boolean =
        (source[field] as? Json.Bool)?.value ?: throw fail(source[field], field)

    /**
     * An exactly-integral number within JSON's lossless range.
     *
     * `Double.toLong()` truncates, so a fractional value would silently become a
     * neighbouring integer and `1e30` would clamp to `Long.MAX_VALUE`. Both are
     * refused: these numbers are sizes, offsets, generations and deadlines, and
     * a silently altered one is a wrong decision rather than a wrong display.
     */
    fun long(source: Json.Obj, field: String, min: Long = 0L): Long {
        val raw = (source[field] as? Json.Num)?.value ?: throw fail(source[field], field)
        if (!raw.isFinite() || raw != Math.floor(raw) ||
            Math.abs(raw) > MAX_SAFE_INTEGER.toDouble()
        ) {
            throw InboxWireException(InboxWireReason.OUT_OF_RANGE, field)
        }
        val value = raw.toLong()
        if (value < min) throw InboxWireException(InboxWireReason.OUT_OF_RANGE, field)
        return value
    }

    fun int(source: Json.Obj, field: String, min: Long = 0L, max: Long = Int.MAX_VALUE.toLong()): Int {
        val value = long(source, field, min)
        if (value > max) throw InboxWireException(InboxWireReason.OUT_OF_RANGE, field)
        return value.toInt()
    }

    fun strings(source: Json.Obj, field: String): List<String> =
        arr(source, field).map { (it as? Json.Str)?.value ?: throw fail(it, field) }

    /** A closed-set token. `null` from the set's own reader is UNKNOWN_VALUE,
     *  which is a refusal — never a fallback member. */
    fun <T> closed(source: Json.Obj, field: String, read: (String) -> T?): T =
        read(str(source, field))
            ?: throw InboxWireException(InboxWireReason.UNKNOWN_VALUE, field)

    private fun fail(value: Json?, field: String) = InboxWireException(
        if (value == null) InboxWireReason.MISSING_FIELD else InboxWireReason.WRONG_TYPE,
        field,
    )

    /** The largest integer a JSON double carries exactly. */
    const val MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991L
}

/**
 * A `Content-Range` this build is willing to act on.
 *
 * The server writes exactly one shape — `bytes <start>-<end>/<total>`, with a
 * real total, because it knows the object's size — so that is the only shape
 * accepted. A lenient parser is a real hazard here rather than an untidy one: it
 * is what turns `bytes 32-garbage`, or a bare `bytes 32`, into a confident
 * "this stream begins at 32", and the consequence is the wrong region of an
 * object spliced into the middle of an authenticated stream, where every frame
 * still verifies because every frame is genuinely the sender's.
 *
 * The three ordering rules are checked rather than assumed: `start <= end`,
 * `end < total`, and every value non-negative and inside the lossless integer
 * range. An unknown total (`*`) is refused too — this protocol's server never
 * sends one, and accepting it would mean accepting a stream whose end this build
 * cannot bound.
 */
data class InboxContentRange(val start: Long, val endInclusive: Long, val total: Long) {

    /** How many bytes this answer claims to carry. */
    val length: Long get() = endInclusive - start + 1

    companion object {
        /** The parsed header, or null when it is absent or in any way malformed. */
        fun of(header: String?): InboxContentRange? {
            val value = header?.trim() ?: return null
            if (!value.startsWith(PREFIX)) return null
            val spec = value.removePrefix(PREFIX)
            // Exactly one '-' and exactly one '/', in that order. Anything else
            // is not this header.
            val slash = spec.indexOf('/')
            if (slash < 0 || spec.indexOf('/', slash + 1) >= 0) return null
            val span = spec.substring(0, slash)
            val dash = span.indexOf('-')
            if (dash <= 0 || span.indexOf('-', dash + 1) >= 0) return null
            val start = whole(span.substring(0, dash)) ?: return null
            val end = whole(span.substring(dash + 1)) ?: return null
            val total = whole(spec.substring(slash + 1)) ?: return null
            if (start > end || end >= total) return null
            return InboxContentRange(start, end, total)
        }

        private const val PREFIX = "bytes "

        /**
         * A non-negative decimal integer and nothing else.
         *
         * `toLongOrNull` already refuses `12garbage`, but it accepts a leading
         * `+` and a `-`, and it overflows to null rather than to a wrong number —
         * so the digit check is what makes "non-negative decimal" the actual
         * rule instead of "whatever Kotlin's parser tolerates".
         */
        private fun whole(text: String): Long? {
            if (text.isEmpty() || text.length > 19) return null
            if (!text.all { it in '0'..'9' }) return null
            return text.toLongOrNull()?.takeIf { it <= Wire.MAX_SAFE_INTEGER }
        }
    }
}

// ── documents ───────────────────────────────────────────────────────────────

/**
 * One entry of a device's public-key history.
 *
 * There is no private-key field, by construction: central never receives one, so
 * no shape that could carry one exists on this side either.
 */
data class InboxKeyRow(
    val id: String,
    val algorithm: String,
    val publicKey: String,
    val generation: Long,
    val createdAt: Long,
    val supersededAt: Long,
    val revokedAt: Long,
) {
    /**
     * Whether new tasks are sealed to this key. Superseded and revoked are
     * different states on purpose: a superseded key still opens tasks queued
     * before the rotation, a revoked one never opens anything again.
     */
    val isActive: Boolean get() = supersededAt == 0L && revokedAt == 0L

    companion object {
        fun read(source: Json.Obj): InboxKeyRow = InboxKeyRow(
            id = Wire.id(source, "ID"),
            algorithm = Wire.str(source, "Algorithm"),
            publicKey = Wire.str(source, "PublicKey"),
            // A generation is 1-based on the server; 0 would make "which key is
            // newer" unanswerable.
            generation = Wire.long(source, "Generation", min = 1),
            createdAt = Wire.long(source, "CreatedAt"),
            supersededAt = Wire.long(source, "SupersededAt"),
            revokedAt = Wire.long(source, "RevokedAt"),
        )
    }
}

/** The enrolment central holds for a device. */
data class InboxEnrolmentView(
    val presence: InboxPresence,
    val lastHeartbeatAt: Long,
    val presenceExpiresAt: Long,
    val heartbeatIntervalSeconds: Int,
    val protocolVersion: Int,
    val capabilities: List<String>,
    val receiveCapability: String,
    val autoAccept: InboxAutoAccept,
    val receiveDirReady: Boolean,
    val revoked: Boolean,
    val canReceive: Boolean,
    val registeredAt: Long,
    val key: InboxKeyRow?,
) {
    companion object {
        fun read(source: Json.Obj): InboxEnrolmentView = InboxEnrolmentView(
            presence = Wire.closed(source, "Presence", InboxPresence::fromWire),
            lastHeartbeatAt = Wire.long(source, "LastHeartbeatAt"),
            presenceExpiresAt = Wire.long(source, "PresenceExpiresAt"),
            heartbeatIntervalSeconds = Wire.int(source, "HeartbeatIntervalSeconds", min = 1),
            protocolVersion = Wire.int(source, "ProtocolVersion"),
            capabilities = Wire.strings(source, "Capabilities"),
            receiveCapability = Wire.str(source, "ReceiveCapability"),
            autoAccept = Wire.closed(source, "AutoAccept", InboxAutoAccept::fromWire),
            receiveDirReady = Wire.bool(source, "ReceiveDirReady"),
            revoked = Wire.bool(source, "Revoked"),
            canReceive = Wire.bool(source, "CanReceive"),
            registeredAt = Wire.long(source, "RegisteredAt"),
            // Null for an enrolment with no active key, which is a legitimate
            // row. A wrong-typed value is NOT that, and is refused.
            key = Wire.optionalObj(source, "Key")?.let(InboxKeyRow::read),
        )
    }
}

/**
 * One row of `GET /api/devices`.
 *
 * [isCurrent] is how this app learns which device it IS. The id is minted
 * server-side when a login is approved, so the honest way to find it is to ask
 * which row the presented bearer authenticates as — never the first row and
 * never an id this build chose.
 */
data class InboxDeviceRow(
    val id: String,
    val name: String,
    val kind: String,
    val isCurrent: Boolean,
    val inbox: InboxEnrolmentView?,
) {
    companion object {
        fun read(source: Json.Obj): InboxDeviceRow = InboxDeviceRow(
            id = Wire.id(source, "ID"),
            name = Wire.str(source, "Name"),
            kind = Wire.str(source, "Kind"),
            isCurrent = Wire.bool(source, "Current"),
            // Absent or null for a device that never enrolled — every browser
            // row, and any build predating the feature. A wrong-typed value is
            // refused rather than read as "not enrolled".
            inbox = Wire.optionalObj(source, "Inbox")?.let(InboxEnrolmentView::read),
        )
    }
}

/** The account-visible view of one queued delivery. */
data class InboxTaskRow(
    val id: String,
    val targetDeviceId: String,
    /** Server-derived, authenticated sending installation. Routing metadata,
     *  never request-body authority. */
    val sourceDeviceId: String,
    val idempotencyKey: String,
    val storedFileId: String,
    val state: InboxTaskState,
    val errorCode: InboxTaskErrorCode,
    val ciphertextBytes: Long,
    val wrapAlgorithm: String,
    val targetKeyId: String,
    val targetKeyGeneration: Long,
    val attempts: Long,
    val leaseExpiresAt: Long,
    val expiresAt: Long,
    val savedAt: Long,
    val isTerminal: Boolean,
) {
    companion object {
        fun read(source: Json.Obj): InboxTaskRow {
            val state = Wire.closed(source, "State", InboxTaskState::fromWire)
            return InboxTaskRow(
                id = Wire.id(source, "ID"),
                targetDeviceId = Wire.id(source, "TargetDeviceID"),
                sourceDeviceId = Wire.str(source, "SourceDeviceID"),
                idempotencyKey = Wire.str(source, "IdempotencyKey"),
                storedFileId = Wire.str(source, "StoredFileID"),
                state = state,
                errorCode = Wire.closed(source, "ErrorCode", InboxTaskErrorCode::fromWire),
                ciphertextBytes = Wire.long(source, "CiphertextBytes"),
                wrapAlgorithm = Wire.str(source, "WrapAlgorithm"),
                targetKeyId = Wire.str(source, "TargetKeyID"),
                targetKeyGeneration = Wire.long(source, "TargetKeyGeneration"),
                attempts = Wire.long(source, "Attempts"),
                leaseExpiresAt = Wire.long(source, "LeaseExpiresAt"),
                expiresAt = Wire.long(source, "ExpiresAt"),
                savedAt = Wire.long(source, "SavedAt"),
                // Central's own flag OR the state's. Never a disagreement that
                // prefers the flag: a `saved` row arriving with `Terminal:false`
                // is still terminal, because the STATE is what the transition
                // table is written against.
                isTerminal = Wire.bool(source, "Terminal") || state.isTerminal,
            )
        }
    }
}

/**
 * The claim response: a task plus the material only the target device may hold.
 *
 * None of the three extra fields is written to disk or logged. The sealed key
 * and the manifest ARE the delivery; the claim token is a bearer for advancing
 * exactly this task under exactly this lease.
 */
class InboxDelivery(
    val task: InboxTaskRow,
    /** Standard base64, matching `GET /api/files/{id}/meta`. */
    val encManifest: String,
    /** Raw base64url, exactly `InboxProtocol.SEALED_BOX_BYTES` decoded. */
    val wrappedKey: String,
    val claimToken: String,
) {
    /** Redacted: this value holds a sealed key and a lease bearer, and the
     *  places a value gets printed are exactly the ones that must not. */
    override fun toString(): String = "InboxDelivery(task=${task.id})"

    companion object {
        fun read(source: Json.Obj): InboxDelivery = InboxDelivery(
            task = InboxTaskRow.read(source),
            encManifest = Wire.requiredStr(source, "EncManifest"),
            wrappedKey = Wire.requiredStr(source, "WrappedKey"),
            claimToken = Wire.requiredStr(source, "ClaimToken"),
        )
    }
}

/**
 * What the two sides agreed at enrolment.
 *
 * A client that cannot satisfy the negotiated version, capability or algorithm
 * must stop rather than guess, which is why all three are echoed at the top
 * level and read here.
 */
data class InboxEnrolResult(
    val inbox: InboxEnrolmentView,
    val protocolVersion: Int,
    val receiveCapability: String,
    val keyAlgorithm: String,
) {
    companion object {
        fun read(source: Json.Obj): InboxEnrolResult = InboxEnrolResult(
            inbox = InboxEnrolmentView.read(Wire.obj(source["inbox"], "inbox")),
            protocolVersion = Wire.int(source, "protocolVersion", min = 1),
            receiveCapability = Wire.str(source, "receiveCapability"),
            keyAlgorithm = Wire.str(source, "keyAlgorithm"),
        )
    }
}

/** The presence central recorded and the cadence it expects. The device follows
 *  the advertised interval rather than a compiled-in guess that could drift. */
data class InboxHeartbeatResult(
    val presence: InboxPresence,
    val presenceExpiresAt: Long,
    val heartbeatIntervalSeconds: Int,
) {
    companion object {
        fun read(source: Json.Obj): InboxHeartbeatResult = InboxHeartbeatResult(
            presence = Wire.closed(source, "presence", InboxPresence::fromWire),
            presenceExpiresAt = Wire.long(source, "presenceExpiresAt"),
            heartbeatIntervalSeconds = Wire.int(source, "heartbeatIntervalSeconds", min = 1),
        )
    }
}

/** What a claim leased, and how long central says the lease lasts. */
data class InboxClaimResult(val deliveries: List<InboxDelivery>, val leaseSeconds: Int)

/**
 * What a create returned.
 *
 * [created] is not cosmetic: central answers 201 for a new task and 200 for a
 * converged retry, which is the only thing that distinguishes a first attempt
 * from a repeat under the same idempotency key.
 */
data class InboxTaskCreation(val task: InboxTaskRow, val created: Boolean)

/**
 * One validated create body, and the ONLY thing that becomes one.
 *
 * A type rather than six loose arguments so the refusals are assertable without
 * a transport, and so no call site can build a request that skipped them. Every
 * field is checked here to the same rule central applies.
 *
 * There is no `kind`, no `name`, no `path`, no `text` and no content key on it,
 * and there must never be: content kind lives inside the authenticated encrypted
 * manifest precisely so central cannot read, index or log a message. The
 * server's strict decoder makes such a field a 400 rather than one it ignores
 * today and might honour later.
 */
class InboxSendRequest(
    val idempotencyKey: String,
    val storedFileId: String,
    val wrappedKey: String,
    val targetKeyId: String,
    val targetKeyGeneration: Long,
    val wrapAlgorithm: String = InboxProtocol.KEY_ALGORITHM,
) {
    init {
        require(isValidIdempotencyKey(idempotencyKey)) { "malformed idempotency key" }
        InboxId.checked(storedFileId, "storedFileId")
        InboxId.checked(targetKeyId, "targetKeyId")
        require(wrapAlgorithm == InboxProtocol.KEY_ALGORITHM) { "unsupported wrap algorithm" }
        // The same shape check central makes, so a malformed box fails before
        // the ciphertext is uploaded rather than after.
        require(
            wrappedKey.length <= InboxProtocol.MAX_WRAPPED_KEY_TEXT_LENGTH &&
                runCatching {
                    com.relayium.protocol.inbox.InboxKeyMaterial
                        .decode(wrappedKey, InboxProtocol.SEALED_BOX_BYTES)
                }.isSuccess,
        ) { "malformed wrapped key" }
        require(targetKeyGeneration > 0) { "key generation must be positive" }
    }

    /**
     * The request body, spelled out as a literal rather than encoded from the
     * type, so a field added here does not silently become a field on the wire.
     */
    fun payload(): Json.Obj = Json.obj(
        "idempotencyKey" to Json.of(idempotencyKey),
        "storedFileId" to Json.of(storedFileId),
        // Which protocol the sealed manifest was written to. An integer, and
        // still no kind, no name, no text.
        "protocolVersion" to Json.of(InboxProtocol.TASK_PROTOCOL_VERSION),
        "wrapAlgorithm" to Json.of(wrapAlgorithm),
        "wrappedKey" to Json.of(wrappedKey),
        "targetKeyId" to Json.of(targetKeyId),
        "targetKeyGeneration" to Json.of(targetKeyGeneration),
    )

    /** No wrapped key, no ids beyond the task's own: this reaches failure text. */
    override fun toString(): String = "InboxSendRequest(target=$targetKeyId)"

    companion object {
        /**
         * Printable ASCII with neither space nor DEL, byte for byte what central
         * accepts. Written against UTF-8 BYTES so a multi-byte scalar cannot
         * pass a per-character length check and then exceed the server's
         * per-byte bound.
         */
        fun isValidIdempotencyKey(key: String): Boolean {
            val bytes = key.toByteArray(Charsets.UTF_8)
            if (bytes.isEmpty() || bytes.size > InboxProtocol.MAX_IDEMPOTENCY_KEY_LENGTH) {
                return false
            }
            return bytes.all { it > 0x20 && it <= 0x7e }
        }
    }
}
