package com.relayium.protocol

/**
 * The `relay-renew/1` vocabulary: the server round exchange, the five signed
 * link messages, and the bounds every implementation shares.
 *
 * Authoritative prose: `docs/protocol/relay-renew-v1.md`. Golden bytes:
 * `apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json`, read by
 * `RelayRenewVectorTest`. Neither file is written from here — this is the third
 * port of a frozen wire, and a value retyped rather than asserted is the drift
 * the fixture exists to catch.
 *
 * Like [LinkProtocol], this file has no I/O and no policy. What a client may
 * renew, when it may ask and what it does with a grant lives above it.
 *
 * ## Why the integers are `Long`
 *
 * Every number on this wire is an exact `uint32`. Kotlin's `Int` is signed, so
 * a round of 4 294 967 295 would arrive negative and a lenient decoder would
 * either wrap it or reject a legitimate value; `Long` holds the whole range and
 * [isUint32] is the single gate every parse runs through. A value that is not
 * an exact `uint32` is a REJECT, never a coercion — the native ports carry a
 * real `UInt32`, so anything tolerated here is a divergence.
 */
object RelayRenewWire {

    // ── identity ────────────────────────────────────────────────────────────

    /**
     * Announced ONLY by a build with the whole path wired on this platform.
     *
     * It is an unsigned hint (`relayium-link-v1.md` section 1.6) and confers no
     * proof: only an authenticated message does. Announcing it without the
     * handler invites a peer to spend its epochs preparing into silence.
     */
    const val CAPABILITY = "relay-renew/1"

    // ── bounds (spec section 9) ─────────────────────────────────────────────

    /** Migration attempts per server round. A fourth is a reject. */
    const val MAX_EPOCHS_PER_ROUND = 3

    /** HMACs ever spent verifying inbound probes, per epoch. */
    const val MAX_PROBE_VERIFICATIONS = 8

    /** Inbound candidates held per epoch, before the description they belong
     *  to has been applied. */
    const val MAX_HELD_CANDIDATES = 64

    /** Retransmits of one probe nonce. */
    const val PROBE_MAX_SENDS = 5

    const val PROBE_RETRY_MS = 2_000L
    const val PREPARE_TO_READY_MS = 15_000L
    const val READY_TO_ANSWER_MS = 15_000L
    const val ICE_PROBE_MS = 30_000L

    /** The whole epoch. Never re-armed, whatever progress it makes. */
    const val EPOCH_HARD_CAP_MS = 60_000L

    /**
     * How long a COMMITTED epoch keeps answering probes and emitting its own
     * trickle candidates.
     *
     * The two peers do not commit together: this side commits when the peer's
     * ack for its nonce arrives, and the peer commits when this side's ack
     * reaches it. Between those instants the peer is still retransmitting, and
     * an implementation that tore its epoch down on its own commit would drop
     * those retransmits — leaving the peer to time out and keep an expiring
     * deadline while this side believed the migration was shared. Equal to
     * [ICE_PROBE_MS], because the peer's own window cannot outlive it.
     */
    const val POST_COMMIT_ACK_MS = ICE_PROBE_MS

    /** Silence after a `prepare` before one retry is spent. Two with no reply
     *  at all means the peer does not implement renewal. */
    const val PREPARE_SILENCE_MS = 10_000L

    /**
     * How long one round request waits.
     *
     * Deliberately SHORTER than the server's 30 s collection window: both peers
     * exchange `prepare` before either asks, so in the normal case the two
     * requests land milliseconds apart. When they do not, this attempt times
     * out and the NEXT epoch's request for the same round is served from the
     * server's per-round cache — no reissuance, no rate charge.
     */
    const val ROUND_TIMEOUT_MS = 15_000L

    /** A 32-byte HMAC in standard padded base64. Checked before any decode. */
    const val AUTH_LENGTH = 44

    // ── uint32 ──────────────────────────────────────────────────────────────

    const val UINT32_MAX = 4_294_967_295L

    fun isUint32(value: Long): Boolean = value in 0..UINT32_MAX

    /**
     * One exact `uint32` out of a parsed JSON number, or null.
     *
     * `Json.Num` holds a double because JavaScript reads every JSON number as
     * one. `1.5`, `-1`, `4294967296` and a non-finite value are each a reject
     * here rather than a rounding.
     */
    fun uint32(value: Json?): Long? {
        val num = (value as? Json.Num)?.value ?: return null
        if (!num.isFinite()) return null
        val asLong = num.toLong()
        if (asLong.toDouble() != num) return null
        return if (isUint32(asLong)) asLong else null
    }

    private fun uintJson(value: Long): Json = Json.of(value)

    // ── the five inner messages ─────────────────────────────────────────────

    enum class AbortReason(val wire: String) {
        DENIED("denied"),
        UNAVAILABLE("unavailable"),
        TIMEOUT("timeout"),
        SDP("sdp"),
        CLOSED("closed"),
        ;

        companion object {
            fun of(wire: String?): AbortReason? = entries.firstOrNull { it.wire == wire }
        }
    }

    /**
     * One renewal message, already shape-checked.
     *
     * A sealed hierarchy rather than one wide record: the type table is closed,
     * each member has an EXACT key set, and a reader that has a [Sdp] in hand
     * cannot accidentally read a `candidate` that this type does not have.
     */
    sealed interface Message {
        val epoch: Long

        data class Prepare(override val epoch: Long) : Message

        data class Ready(override val epoch: Long, val round: Long) : Message

        data class Sdp(
            override val epoch: Long,
            val round: Long,
            /** `offer` or `answer`. Nothing else, including `pranswer`. */
            val sdpType: String,
            val sdp: String,
        ) : Message

        data class Ice(
            override val epoch: Long,
            val round: Long,
            val candidate: String,
            /** Nullable but never omittable — see [parseMessage]. */
            val sdpMid: String?,
            val sdpMLineIndex: Long?,
            /** Non-empty: a candidate whose generation cannot be named cannot
             *  be bound to an epoch. */
            val usernameFragment: String,
        ) : Message

        data class Abort(override val epoch: Long, val reason: AbortReason) : Message
    }

    // ── the signed payloads ─────────────────────────────────────────────────

    /**
     * The EXACT bytes a renewal tag covers, in the declared key order.
     *
     * `from` and `to` are the established peer ids as each side knows them and
     * are deliberately NOT carried in the envelope: they come from the
     * signalling context, so a relay that reflects a message back at its sender
     * verifies the reversed tuple and fails. Same reasoning, and same
     * `JSON.stringify` escaping, as [LinkProtocol.linkLeavePayload].
     */
    fun payload(from: String, to: String, message: Message): String {
        val map = LinkedHashMap<String, Json>()
        map["kind"] = Json.of(
            when (message) {
                is Message.Prepare -> "link-renew-prepare"
                is Message.Ready -> "link-renew-ready"
                is Message.Sdp -> "link-renew-sdp"
                is Message.Ice -> "link-renew-ice"
                is Message.Abort -> "link-renew-abort"
            },
        )
        map["from"] = Json.of(from)
        map["to"] = Json.of(to)
        map["epoch"] = uintJson(message.epoch)
        when (message) {
            is Message.Prepare -> Unit
            is Message.Ready -> map["round"] = uintJson(message.round)
            is Message.Sdp -> {
                map["round"] = uintJson(message.round)
                map["sdpType"] = Json.of(message.sdpType)
                map["sdp"] = Json.of(message.sdp)
            }
            is Message.Ice -> {
                map["round"] = uintJson(message.round)
                map["candidate"] = Json.of(message.candidate)
                map["sdpMid"] = message.sdpMid?.let { Json.of(it) } ?: Json.Null
                map["sdpMLineIndex"] = message.sdpMLineIndex?.let { uintJson(it) } ?: Json.Null
                map["usernameFragment"] = Json.of(message.usernameFragment)
            }
            is Message.Abort -> map["reason"] = Json.of(message.reason.wire)
        }
        return Json.stringify(Json.Obj(map))
    }

    // ── the envelope ────────────────────────────────────────────────────────

    private val ENVELOPE_KEYS = setOf("link", "renew", "auth")

    private val PREPARE_KEYS = setOf("type", "epoch")
    private val READY_KEYS = setOf("type", "epoch", "round")
    private val SDP_KEYS = setOf("type", "epoch", "round", "sdpType", "sdp")
    private val ICE_KEYS =
        setOf("type", "epoch", "round", "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment")
    private val ABORT_KEYS = setOf("type", "epoch", "reason")

    /** A renewal envelope's two halves, recognised by SHAPE alone. */
    data class Envelope(val message: Message, val auth: String)

    /**
     * Whether this signal payload is SHAPED like a renewal envelope.
     *
     * Cheap, allocation-light, and deliberately separate from [parseEnvelope]:
     * the router needs to know "this frame belongs to the renewal controller
     * and nowhere else" before it knows whether the controller can act on it.
     * A renewal envelope that fails the inner checks must still be consumed
     * here rather than falling through to establishment — otherwise a malformed
     * `renew` would reach the ordinary link handler, which is the whole reason
     * SDP and ICE are nested in the first place.
     */
    fun isRenewEnvelope(raw: Json?): Boolean {
        val obj = raw as? Json.Obj ?: return false
        if ((obj["link"] as? Json.Bool)?.value != true) return false
        if (obj["renew"] == null) return false
        return obj.keys.size == ENVELOPE_KEYS.size && obj.keys == ENVELOPE_KEYS
    }

    /**
     * Parse a renewal envelope, or null.
     *
     * Every cheap check runs before anything cryptographic: the outer shape is
     * EXACTLY `{link, renew, auth}`, the tag is exactly [AUTH_LENGTH]
     * characters before any decode, the inner type table is closed, and each
     * type's key set must match exactly. An extra or a missing key is a reject,
     * not a lenient read.
     *
     * `sdpMid` and `sdpMLineIndex` are nullable but NOT omittable. An encoder
     * that dropped an absent optional would render a payload the signer's tag
     * cannot cover, and the three ports would then disagree about exactly the
     * messages that carry a relay candidate.
     */
    fun parseEnvelope(raw: Json?): Envelope? {
        if (!isRenewEnvelope(raw)) return null
        val obj = raw as Json.Obj
        val auth = (obj["auth"] as? Json.Str)?.value ?: return null
        if (auth.length != AUTH_LENGTH) return null
        val message = parseMessage(obj["renew"]) ?: return null
        return Envelope(message, auth)
    }

    /** The inner object, by exact key set. Exposed for the fixture suite. */
    fun parseMessage(raw: Json?): Message? {
        val obj = raw as? Json.Obj ?: return null
        val type = (obj["type"] as? Json.Str)?.value ?: return null
        val epoch = uint32(obj["epoch"]) ?: return null
        fun keysAre(expected: Set<String>) = obj.keys.size == expected.size && obj.keys == expected
        return when (type) {
            "prepare" -> {
                if (!keysAre(PREPARE_KEYS)) return null
                Message.Prepare(epoch)
            }
            "ready" -> {
                if (!keysAre(READY_KEYS)) return null
                Message.Ready(epoch, uint32(obj["round"]) ?: return null)
            }
            "sdp" -> {
                if (!keysAre(SDP_KEYS)) return null
                val round = uint32(obj["round"]) ?: return null
                val sdpType = (obj["sdpType"] as? Json.Str)?.value ?: return null
                if (sdpType != "offer" && sdpType != "answer") return null
                val sdp = (obj["sdp"] as? Json.Str)?.value ?: return null
                if (sdp.isEmpty()) return null
                Message.Sdp(epoch, round, sdpType, sdp)
            }
            "ice" -> {
                if (!keysAre(ICE_KEYS)) return null
                val round = uint32(obj["round"]) ?: return null
                val candidate = (obj["candidate"] as? Json.Str)?.value ?: return null
                if (candidate.isEmpty()) return null
                // Present-with-an-explicit-null, or a value of the right type.
                val mid = when (val v = obj["sdpMid"]) {
                    is Json.Null -> null
                    is Json.Str -> v.value
                    else -> return null
                }
                val index = when (val v = obj["sdpMLineIndex"]) {
                    is Json.Null -> null
                    is Json.Num -> uint32(v) ?: return null
                    else -> return null
                }
                val ufrag = (obj["usernameFragment"] as? Json.Str)?.value ?: return null
                if (ufrag.isEmpty()) return null
                Message.Ice(epoch, round, candidate, mid, index, ufrag)
            }
            "abort" -> {
                if (!keysAre(ABORT_KEYS)) return null
                val reason = AbortReason.of((obj["reason"] as? Json.Str)?.value) ?: return null
                Message.Abort(epoch, reason)
            }
            // The type table is closed.
            else -> null
        }
    }

    /** Render one message as its inner object, in the fixture's key order. */
    fun messageJson(message: Message): Json.Obj {
        val map = LinkedHashMap<String, Json>()
        map["type"] = Json.of(
            when (message) {
                is Message.Prepare -> "prepare"
                is Message.Ready -> "ready"
                is Message.Sdp -> "sdp"
                is Message.Ice -> "ice"
                is Message.Abort -> "abort"
            },
        )
        map["epoch"] = uintJson(message.epoch)
        when (message) {
            is Message.Prepare -> Unit
            is Message.Ready -> map["round"] = uintJson(message.round)
            is Message.Sdp -> {
                map["round"] = uintJson(message.round)
                map["sdpType"] = Json.of(message.sdpType)
                map["sdp"] = Json.of(message.sdp)
            }
            is Message.Ice -> {
                map["round"] = uintJson(message.round)
                map["candidate"] = Json.of(message.candidate)
                map["sdpMid"] = message.sdpMid?.let { Json.of(it) } ?: Json.Null
                map["sdpMLineIndex"] = message.sdpMLineIndex?.let { uintJson(it) } ?: Json.Null
                map["usernameFragment"] = Json.of(message.usernameFragment)
            }
            is Message.Abort -> map["reason"] = Json.of(message.reason.wire)
        }
        return Json.Obj(map)
    }

    /** The whole outbound envelope: `{link, renew, auth}` and nothing else. */
    fun envelopeJson(message: Message, auth: String): Json.Obj = Json.obj(
        "link" to Json.of(true),
        "renew" to messageJson(message),
        "auth" to Json.of(auth),
    )

    // ── the server exchange ─────────────────────────────────────────────────

    /** `C -> S {"type":"ice-renew","data":{"round":…,"rid":…}}` — the `data`. */
    fun renewRequestData(round: Long, rid: Long): Json.Obj {
        require(isUint32(round) && isUint32(rid)) { "round and rid are uint32" }
        return Json.obj("round" to uintJson(round), "rid" to uintJson(rid))
    }

    enum class GrantStatus(val wire: String) {
        GRANTED("granted"),
        DENIED("denied"),
        UNAVAILABLE("unavailable"),
        STALE("stale"),
        ;

        companion object {
            fun of(wire: String?): GrantStatus? = entries.firstOrNull { it.wire == wire }
        }
    }

    /**
     * One `ice-grant`, correlated and shape-checked.
     *
     * [config] is the grant's own object, handed on WHOLE rather than reparsed
     * here: a `granted` reply carries `iceServers` and optional `relays` in
     * exactly the `/api/ice` shape, and the client's rule is that there is no
     * second credential parser. The app layer feeds this straight to the same
     * sanitiser that survives a hostile `/api/ice` body.
     */
    data class IceGrant(
        val status: GrantStatus,
        val round: Long,
        val rid: Long,
        val config: Json.Obj,
    ) {
        /** The server's machine-readable refusal, or "". Never shown as prose. */
        val relayDenied: String get() = (config["relayDenied"] as? Json.Str)?.value.orEmpty()

        /** An optional diagnostic enum. Never routed on, never user-facing. */
        val reason: String get() = (config["reason"] as? Json.Str)?.value.orEmpty()
    }

    /**
     * Read an `ice-grant` payload.
     *
     * A reply that cannot be correlated is not a reply: `rid` is required and,
     * like `round`, must be an exact `uint32`. The status enum is closed — an
     * unknown status is dropped rather than treated as a refusal, because
     * guessing which of "grant" and "deny" a future word meant is the one
     * mistake that could either strand a live link or mint a configuration.
     */
    fun parseGrant(raw: Json?): IceGrant? {
        val obj = raw as? Json.Obj ?: return null
        val status = GrantStatus.of((obj["status"] as? Json.Str)?.value) ?: return null
        val round = uint32(obj["round"]) ?: return null
        val rid = uint32(obj["rid"]) ?: return null
        return IceGrant(status, round, rid, obj)
    }
}
