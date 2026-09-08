package com.relayium.protocol.inbox

/**
 * The `inbox/3` protocol vocabulary, as this device must speak it.
 *
 * The Kotlin sibling of `apps/RelayiumKit/Sources/RelayiumKit/DeviceInbox/InboxProtocol.swift`
 * and of `server/internal/inbox/{inbox,task}.go` — the same closed sets, the
 * same bounds, the same spelling rules. Data and pure functions only: no
 * networking, no storage, no Android, so the vocabulary is asserted without any
 * of them.
 *
 * **Everything here fails closed.** Every closed set is an enum whose `fromWire`
 * returns null for a token this build does not know, and every caller turns that
 * null into a refusal rather than into a default. A state, an error code, a
 * policy or a presence value this build cannot name describes a central
 * behaviour it cannot honour, and guessing is how a receiver ends up telling a
 * sender a delivery is fine when it does not know what the delivery is doing.
 *
 * **This module announces nothing yet.** There is deliberately no "capabilities
 * this build announces" constant: a capability token is a claim about behaviour
 * that ships, and no Android build receives an Inbox task today. The tokens are
 * named so a later app slice can announce exactly the ones it implements, and so
 * the refusals can be asserted by name now.
 */
object InboxProtocol {

    // ── versions ────────────────────────────────────────────────────────────

    /**
     * Protocol versions this build speaks. A fixed list rather than a range:
     * adding one has to be a deliberate edit that forces a look at whether the
     * behaviour behind it is implemented here.
     *
     * v1 and v2 are absent, not lower-preference. The owner waived
     * old-protocol compatibility on 2026-08-17, so there is no dual stack and
     * no downgrade: a central that speaks only v1/v2 is one this build refuses
     * to enrol with.
     */
    val VERSIONS: List<Int> = listOf(3)

    const val MIN_PROTOCOL_VERSION = 3
    const val MAX_PROTOCOL_VERSION = 3

    /**
     * The version a SENDER declares on `POST …/inbox/tasks` — the protocol the
     * manifest sealed inside that task's ciphertext was written to. Separate
     * from [VERSIONS] because it is a different claim: [VERSIONS] is what this
     * build can READ, this is what it just WROTE.
     */
    const val TASK_PROTOCOL_VERSION = 3

    /** Central's bound on the announced version list. */
    const val MAX_PROTOCOL_VERSIONS = 16

    fun isSupportedVersion(version: Int): Boolean = version in VERSIONS

    /**
     * The HIGHEST version both sides speak, or null.
     *
     * Highest-common rather than lowest-common, and an empty intersection is
     * null rather than [MIN_PROTOCOL_VERSION]: a peer that did not claim a
     * version must never be treated as speaking it.
     */
    fun negotiateProtocolVersion(offered: List<Int>): Int? {
        if (offered.isEmpty() || offered.size > MAX_PROTOCOL_VERSIONS) return null
        return offered.filter(::isSupportedVersion).maxOrNull()
    }

    /**
     * Central's own check on the version a sender declares at create, applied
     * locally so a send that central would refuse is abandoned before its
     * ciphertext is uploaded and bound to a task.
     *
     * 0 — the zero value of an omitted field — is outside the range and so is
     * refused with everything else.
     */
    fun isValidTaskProtocolVersion(version: Int): Boolean =
        version in MIN_PROTOCOL_VERSION..MAX_PROTOCOL_VERSION

    // ── key material ────────────────────────────────────────────────────────

    /** The one wrap algorithm this protocol version defines. */
    const val KEY_ALGORITHM = "x25519-sealedbox-v1"

    const val PUBLIC_KEY_BYTES = 32
    const val SECRET_KEY_BYTES = 32

    /** The AES-256-GCM key a delivery's frames are sealed with. */
    const val CONTENT_KEY_BYTES = 32

    const val POLY1305_TAG_BYTES = 16

    /**
     * The EXACT raw length of a wrapped key, written in LAYOUT order: a
     * `crypto_box_seal` of the 32-byte content key is the 32-byte ephemeral
     * public key, then the 16-byte Poly1305 tag, then 32 bytes of ciphertext.
     *
     * Checked exactly rather than as an upper bound — what is wrapped is fixed
     * by this protocol version, so any other length is a peer sealing something
     * else, and a change to what is sealed has to be a new algorithm token
     * rather than a silently longer blob.
     */
    const val SEALED_BOX_BYTES = PUBLIC_KEY_BYTES + POLY1305_TAG_BYTES + CONTENT_KEY_BYTES

    /**
     * Central's bound on the base64 TEXT of any wrapped key. Deliberately much
     * larger than [SEALED_BOX_BYTES] needs, because it bounds the column for a
     * future algorithm; this build still checks the exact length above.
     */
    const val MAX_WRAPPED_KEY_TEXT_LENGTH = 512

    // ── queue mechanics ─────────────────────────────────────────────────────

    /**
     * Header carrying the one-time claim token on ciphertext reads and progress
     * reports. A header rather than a query parameter so it cannot reach a
     * proxy log or a browser history.
     */
    const val CLAIM_TOKEN_HEADER = "X-Relayium-Inbox-Claim"

    /**
     * Central's lease TTL and heartbeat cadence, used only as the fallback when
     * a response does not name one. The value central returns always wins: a
     * server that shortens its lease must be followed, not contradicted.
     */
    const val DEFAULT_LEASE_SECONDS = 300
    const val DEFAULT_HEARTBEAT_SECONDS = 30

    /**
     * How long a heartbeat keeps a device online. A multiple of the cadence, so
     * a device that misses two in a row (a GC pause, a blip) is not yet
     * declared offline.
     */
    const val PRESENCE_TTL_SECONDS = 90

    /**
     * One claim leases ONE task, because deliveries are worked sequentially and
     * their sizes are unbounded until TTL. Claiming a second before the first
     * finishes could let the second task's lease expire without ever starting
     * it (WORKFLOW-LEARNINGS, 2026-08-09).
     */
    const val CLAIM_BATCH = 1

    /** Central's ceiling on one claim, which [CLAIM_BATCH] stays far under. */
    const val MAX_CLAIM_BATCH = 32

    /** Central's per-device ceiling on unfinished rows. */
    const val MAX_PENDING_TASKS_PER_DEVICE = 256

    /** Central's bound on the sender-chosen creation key. */
    const val MAX_IDEMPOTENCY_KEY_LENGTH = 128

    // ── what a device may announce ──────────────────────────────────────────

    const val MAX_CAPABILITIES = 32
    const val MAX_CAPABILITY_LENGTH = 64
    const val MAX_PLATFORM_LENGTH = 32
    const val MAX_APP_VERSION_LENGTH = 64

    /**
     * `<segment>(.<segment>)*.v<N>`: lowercase alphanumeric segments and a
     * mandatory trailing version with no leading zero, matching central's
     * `validCapabilityToken`.
     *
     * The version suffix is mandatory so no unversioned token can exist to be
     * redefined later, and `v0`/`v01` are both refused so one capability has one
     * spelling.
     */
    fun isValidCapabilityToken(token: String): Boolean {
        if (token.isEmpty() || token.length > MAX_CAPABILITY_LENGTH) return false
        val segments = token.split('.')
        if (segments.size < 2) return false
        for (segment in segments.dropLast(1)) {
            if (segment.isEmpty()) return false
            if (!segment.all { it in 'a'..'z' || it in '0'..'9' }) return false
        }
        val version = segments.last()
        if (version.length < 2 || version[0] != 'v') return false
        val digits = version.substring(1)
        if (digits[0] == '0') return false
        return digits.all { it in '0'..'9' }
    }

    /**
     * The announced set in central's canonical stored form — deduplicated and
     * sorted — or null if it breaks a bound or carries a malformed token.
     *
     * Syntactically valid but UNKNOWN tokens are KEPT on purpose: this is the
     * form central stores and relays verbatim, and dropping one locally would
     * hide a capability from a sender that does understand it.
     */
    fun canonicalCapabilities(capabilities: List<String>): List<String>? {
        if (capabilities.size > MAX_CAPABILITIES) return null
        if (!capabilities.all(::isValidCapabilityToken)) return null
        return capabilities.distinct().sorted()
    }

    /**
     * The platform and app-version labels are display/diagnostic metadata, so
     * the rule is a length and printable-ASCII bound rather than an allowlist
     * central would have to keep current.
     */
    fun isValidPlatform(platform: String): Boolean =
        platform.length <= MAX_PLATFORM_LENGTH && isPrintableAscii(platform)

    fun isValidAppVersion(version: String): Boolean =
        version.length <= MAX_APP_VERSION_LENGTH && isPrintableAscii(version)

    private fun isPrintableAscii(text: String): Boolean = text.all { it.code in 0x20..0x7e }
}

/**
 * Capability tokens the Device Inbox protocol defines.
 *
 * A token is a promise about a SURFACE, not about a platform, so nothing here
 * is announced by merely linking this module — see the note on [InboxProtocol].
 */
object InboxCapability {
    /**
     * Historical. Named so the refusal can be asserted by name; never
     * announced by this build and never negotiable against a v3 central.
     */
    const val RECEIVE_V1 = "inbox.receive.v1"
    const val RECEIVE_V2 = "inbox.receive.v2"

    /**
     * Required of every receiving device: claim, unwrap, decode a v3 manifest,
     * verify, commit atomically. Central refuses registration without it.
     */
    const val RECEIVE_V3 = "inbox.receive.v3"

    /**
     * "This receiver presents a text delivery as text." Announced only by a
     * build that actually does, because a sender reads it to decide whether
     * offering a text send to this device would be honest. A receiver that
     * writes a message to a `.txt` file must not announce it — the whole value
     * of the token is that its absence is truthful.
     */
    const val TEXT_V1 = "inbox.text.v1"

    /** The device implements the default-off automatic receive policy (PRD §8). */
    const val AUTO_ACCEPT_V1 = "inbox.autoaccept.v1"

    /** The device resumes an interrupted download from a complete frame boundary. */
    const val RESUME_V1 = "inbox.resume.v1"

    /** The one capability central negotiates; everything else it relays. */
    const val REQUIRED_RECEIVE = RECEIVE_V3
}

/**
 * The automatic-receive policy a device announces (PRD §8).
 *
 * `OFF` is the default and the schema default, so no row can come into
 * existence already permitted to write to a user's disk. An absent value means
 * "unspecified" and resolves to `OFF` — see [fromWire].
 */
enum class InboxAutoAccept(val wire: String) {
    OFF("off"),
    ASK("ask"),
    AUTO("auto"),
    ;

    companion object {
        /** The empty string is central's "unspecified", which is `OFF`. */
        fun fromWire(value: String): InboxAutoAccept? =
            if (value.isEmpty()) OFF else entries.firstOrNull { it.wire == value }
    }
}

/**
 * Presence, as central derives it. There are exactly two values and neither is
 * "unknown": a device central has not heard from is offline, which is the
 * truthful thing to tell a sender.
 */
enum class InboxPresence(val wire: String) {
    ONLINE("online"),
    OFFLINE("offline"),
    ;

    companion object {
        fun fromWire(value: String): InboxPresence? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The closed server-visible task state set (PRD §10 items 3-12).
 *
 * `encrypting` and `uploading` are deliberately absent: they are sender-local,
 * central cannot observe either, and a receiver that could name one would be
 * asserting something about a machine it is not. They are named in
 * [InboxSenderLocalState] so the refusal stays truthful when a client sends the
 * PRD's own vocabulary.
 */
enum class InboxTaskState(val wire: String) {
    QUEUED("queued"),
    NOTIFIED("notified"),
    DOWNLOADING("downloading"),
    VERIFYING("verifying"),
    SAVED("saved"),
    ATTENTION_REQUIRED("attention_required"),
    EXPIRED("expired"),
    REVOKED("revoked"),
    FAILED_RETRYABLE("failed_retryable"),
    FAILED_TERMINAL("failed_terminal"),
    ;

    /** States that can never transition again. */
    val isTerminal: Boolean
        get() = this == SAVED || this == EXPIRED || this == REVOKED || this == FAILED_TERMINAL

    /**
     * What a target device may assert about a task it holds a lease on.
     *
     * Narrower than central's transition table on purpose: `expired` and
     * `revoked` are central's judgements about time and authorization, and
     * `queued`/`notified` are central's scheduling — a device that could report
     * `queued` could reset its own backoff.
     *
     * The transition table itself is deliberately NOT mirrored here. It is
     * central's authority over rows this device does not own, and a second copy
     * would be a second thing to keep in sync that no local decision consults.
     */
    val isDeviceReportable: Boolean
        get() = when (this) {
            DOWNLOADING, VERIFYING, SAVED, ATTENTION_REQUIRED, FAILED_RETRYABLE, FAILED_TERMINAL ->
                true
            QUEUED, NOTIFIED, EXPIRED, REVOKED -> false
        }

    companion object {
        fun fromWire(value: String): InboxTaskState? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The sender-local phases (PRD §10 items 1-2), named so they can be refused BY
 * NAME rather than as unknown strings. They are real product states that belong
 * to the sending client's own UI; central has no way to observe either.
 */
object InboxSenderLocalState {
    const val ENCRYPTING = "encrypting"
    const val UPLOADING = "uploading"

    fun isSenderLocal(value: String): Boolean = value == ENCRYPTING || value == UPLOADING
}

/**
 * The closed set of error codes a DEVICE may submit.
 *
 * There is no free-text member, which is the whole design: a file name or a
 * path cannot reach central even when this device is explaining exactly why
 * saving failed.
 */
enum class InboxDeviceErrorCode(val wire: String) {
    /** Nothing has gone wrong yet; the wire token is the empty string. */
    NONE(""),
    DOWNLOAD_FAILED("download_failed"),
    DECRYPT_FAILED("decrypt_failed"),
    VERIFY_FAILED("verify_failed"),
    DISK_FULL("disk_full"),
    PERMISSION_DENIED("permission_denied"),
    DIRECTORY_UNAVAILABLE("directory_unavailable"),
    NAME_CONFLICT("name_conflict"),
    USER_DECLINED("user_declined"),
    UNSUPPORTED("unsupported"),
    INTERNAL("internal"),
    ;

    companion object {
        fun fromWire(value: String): InboxDeviceErrorCode? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The error codes CENTRAL writes and a device may never submit.
 *
 * Kept as a named set rather than as absent strings so a report path refuses one
 * explicitly instead of letting it fall through as "unknown": a device that
 * could submit `lease_expired` could forge central's own account of events.
 */
enum class InboxCentralErrorCode(val wire: String) {
    LEASE_EXPIRED("lease_expired"),
    ATTEMPTS_EXHAUSTED("attempts_exhausted"),
    KEY_REVOKED("key_revoked"),
    STORED_OBJECT_UNAVAILABLE("stored_object_unavailable"),
    ;

    companion object {
        fun fromWire(value: String): InboxCentralErrorCode? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * Every error token this build understands on a task row, from either author.
 *
 * A task READ BACK from central may legitimately carry a central-authored code,
 * so the read model needs the union while the report path stays restricted to
 * [InboxDeviceErrorCode]. Splitting the two is what keeps "what may I say" and
 * "what may I be told" from collapsing into one permissive set.
 */
sealed interface InboxTaskErrorCode {

    val wire: String

    @JvmInline
    value class Device(val code: InboxDeviceErrorCode) : InboxTaskErrorCode {
        override val wire: String get() = code.wire
    }

    @JvmInline
    value class Central(val code: InboxCentralErrorCode) : InboxTaskErrorCode {
        override val wire: String get() = code.wire
    }

    /** True when nothing has gone wrong yet. */
    val isNone: Boolean get() = this == Device(InboxDeviceErrorCode.NONE)

    companion object {
        fun fromWire(value: String): InboxTaskErrorCode? {
            InboxDeviceErrorCode.fromWire(value)?.let { return Device(it) }
            InboxCentralErrorCode.fromWire(value)?.let { return Central(it) }
            return null
        }
    }
}

/**
 * The machine-readable `error` tokens central returns on a rejection.
 *
 * Only the ones a client must BRANCH on are named. Anything else is carried as
 * its raw string by the caller and reported by status, so an unrecognised token
 * can never be mistaken for one of these.
 */
enum class InboxRejection(val wire: String) {
    UNSUPPORTED_PROTOCOL_VERSION("unsupported_protocol_version"),
    UNSUPPORTED_CAPABILITY("unsupported_capability"),
    UNSUPPORTED_AUTO_ACCEPT_CAPABILITY("unsupported_auto_accept_capability"),
    UNSUPPORTED_KEY_ALGORITHM("unsupported_key_algorithm"),
    DEVICE_INBOX_NOT_REGISTERED("device_inbox_not_registered"),
    DEVICE_INBOX_REVOKED("device_inbox_revoked"),
    STALE_KEY_ROTATION("stale_key_rotation"),
    DEVICE_KEY_REUSED("device_key_reused"),
    UNUSABLE_PUBLIC_KEY("unusable_public_key"),
    MALFORMED_PUBLIC_KEY("malformed_public_key"),
    STALE_CLAIM("stale_claim"),
    TASK_TERMINAL("task_terminal"),
    INVALID_TRANSITION("invalid_transition"),
    STORED_OBJECT_UNAVAILABLE("stored_object_unavailable"),
    AUTO_RECEIVE_DISABLED("auto_receive_disabled"),
    DEVICE_CANNOT_RECEIVE("device_cannot_receive"),

    // The four a SENDER's create can be refused with. Named rather than left as
    // raw strings because the branches are not interchangeable: one is
    // recoverable by resealing, one means somebody else's task owns these bytes,
    // and the remaining two are dead ends.

    /**
     * The target rotated its key between the read and the create. Recoverable
     * exactly once, by re-reading the device and resealing the same content key.
     */
    STALE_TARGET_KEY("stale_target_key"),

    /**
     * This idempotency key already names a task describing a DIFFERENT send.
     * Never a convergence — central refuses rather than silently returning the
     * first task, so a caller cannot mistake one delivery for another.
     */
    IDEMPOTENCY_KEY_CONFLICT("idempotency_key_conflict"),

    /** The stored object is already bound to some other task. */
    STORED_OBJECT_ALREADY_BOUND("stored_object_already_bound"),

    /** The target already has as many pending tasks as central will hold. */
    INBOX_QUEUE_FULL("inbox_queue_full"),
    ;

    companion object {
        fun fromWire(value: String): InboxRejection? = entries.firstOrNull { it.wire == value }
    }
}
