package com.relayium.protocol

/**
 * The wire vocabulary of `link/1`: one encrypted connection carrying an ordered
 * file lane and an ordered text lane to one peer.
 *
 * Authoritative prose: `docs/protocol/relayium-link-v1.md`. Golden bytes: the
 * `link` and `capability` blocks of
 * `apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json`.
 *
 * This file deliberately contains no I/O and no policy. Which peer may be
 * offered a link, what a UI shows and how a transport is built all live above
 * it, so a reader of the transport does not have to convince themselves the
 * vocabulary shares any state.
 */
object LinkProtocol {

    // ── identity ────────────────────────────────────────────────────────────

    /** Matched with byte equality. `link/2` and `LINK/1` are not this protocol. */
    const val CAPABILITY = "link/1"

    /** The shipped single-generation message wire. Named here because it is
     *  part of what this client ANNOUNCES; its vocabulary lives in
     *  `com.relayium.protocol.legacy.LegacyProtocol`. */
    const val TEXT_CAPABILITY = "text/1"

    /**
     * What this client announces, and the whole of it: the fixture's
     * `capability.hello.native`, which is what both Apple clients say.
     *
     * `text/1` is here because this client now IMPLEMENTS the shipped
     * single-generation message connection — see
     * `com.relayium.protocol.legacy.LegacyTextLane` — in both roles. It was
     * absent while that handler did not exist, and the two must move together:
     * announcing it without the handler invites a peer onto a connection that
     * cannot open, and implementing it without announcing it is worse than
     * useless, because `RealtimeConnectionFactory.connectInRoom` REFUSES to
     * send a text offer until it has heard this exact string back. A message
     * connection with an Apple peer is unreachable in either direction without
     * it.
     *
     * Still not `preupload/1`: frame kind 12 rides the file lane with its own
     * derived key, and an unannounced kind is a hard error, so claiming it
     * without implementing it kills whole transfers.
     *
     * An untruthful capability is worse than a missing one; it is the one input
     * a peer is entitled to act on.
     */
    val ADVERTISED_CAPS: List<String> = listOf(TEXT_CAPABILITY, CAPABILITY)

    /** The file lane's SCTP label. */
    const val FILE_CHANNEL = "relayium"
    /** The text lane's SCTP label. */
    const val TEXT_CHANNEL = "relayium-text"

    /**
     * The exact lanes a link carries, in primary-first order.
     *
     * A TUPLE, not a set. The empty list, the one-element `["relayium"]` (the
     * retired single-lane transport), a reversed pair and an extra lane are each
     * a connection this build must refuse to construct. A link whose text lane
     * never opened is not a degraded link — it is a link that cannot honour
     * `link/1`.
     */
    val CHANNEL_LABELS: List<String> = listOf(FILE_CHANNEL, TEXT_CHANNEL)

    // ── bounds ──────────────────────────────────────────────────────────────

    /** Pre-attachment frames, COMBINED across both lanes. Overflow fails closed. */
    const val CAPTURE_MAX_BYTES = 256 * 1024

    /** A 32-byte HMAC in standard padded base64. Checked before any decode. */
    const val AUTH_TAG_LENGTH = 44

    /** HMACs ever spent on inbound leave signals, per authenticated link. */
    const val LEAVE_MAX_ATTEMPTS = 8

    /** Chase frames held for one pending offer, before it is abandoned. */
    const val HELD_SIGNAL_MAX = 64

    /** Accepted remote candidates that may extend the no-progress deadline. */
    const val MAX_CANDIDATE_PROGRESS = 6

    // Establishment and recovery deadlines, in milliseconds.
    const val NO_PROGRESS_TIMEOUT_MS = 30_000L
    const val SETUP_HARD_CAP_MS = 90_000L
    const val KEY_REVEAL_TIMEOUT_MS = 30_000L
    const val LINK_AUTH_TIMEOUT_MS = 30_000L
    const val LINK_REQUEST_TIMEOUT_MS = 30_000L
    const val LINK_REQUEST_RETRY_MS = 3_000L

    /** Roster hello cadence. Three attempts spaced 1.5 s land inside the peer's
     *  five-second settle window with room left to be acted on. */
    const val CAPS_ANNOUNCE_ATTEMPTS = 3
    const val CAPS_RETRY_INTERVAL_MS = 1_500L
    const val CAPS_SETTLE_MS = 5_000L

    // ── deterministic role ──────────────────────────────────────────────────

    enum class Role { INITIATOR, RESPONDER }

    /**
     * Which side offers, computed identically by both peers from their room ids.
     *
     * The SMALLER id offers; the larger asks and waits. Without this, two users
     * pressing at the same moment produce two SDP offers into one pair of lanes.
     *
     * `compareTo` on a Kotlin `String` is a UTF-16 code-unit comparison, which
     * is what JavaScript's `<` does and what the hub's ASCII-hex ids need. It is
     * deliberately NOT a locale-aware or canonical-equivalence collation, which
     * is where Swift's `String` ordering differs and where a port could disagree
     * with the browser about who offers.
     *
     * Total: a self-collision — impossible in a real room — resolves to
     * RESPONDER rather than trapping.
     */
    fun linkRole(selfId: String, peerId: String): Role =
        if (selfId < peerId) Role.INITIATOR else Role.RESPONDER

    // ── the two hand-rolled tag payloads ────────────────────────────────────

    /**
     * The exact bytes a resume/ICE tag covers: an EXPLICIT field list, in this
     * order, rendered with `JSON.stringify` semantics.
     *
     * The list is explicit rather than "the whole signal" so that adding a field
     * to a signal cannot silently change what an existing tag covers. `caps` in
     * particular is deliberately OUTSIDE it — it is a hint, and a hint must not
     * be able to alter an authentication. Implementations must not extend it.
     */
    fun authPayload(signal: Signal): String = Json.stringify(
        Json.obj(
            "sdpType" to (signal.sdpType?.let { Json.of(it) } ?: Json.Null),
            "sdp" to (signal.sdp?.let { Json.of(it) } ?: Json.Null),
            "candidate" to (signal.candidate?.let { Json.of(it) } ?: Json.Null),
            "sdpMid" to (signal.sdpMid?.let { Json.of(it) } ?: Json.Null),
            // Index 0 is a real m-line, not a missing one: it must render as 0.
            "sdpMLineIndex" to (signal.sdpMLineIndex?.let { Json.of(it.toLong()) } ?: Json.Null),
            "usernameFragment" to (signal.usernameFragment?.let { Json.of(it) } ?: Json.Null),
        ),
    )

    /**
     * The exact bytes a link-leave tag covers.
     *
     * Deliberately NOT [authPayload]. A leave carries no SDP and no ICE, so that
     * payload would render one constant string for the whole life of a link — a
     * tag with no direction, replayable in either direction once observed. The
     * `kind` field additionally makes this string unreachable from
     * [authPayload], whose output always begins with `sdpType`.
     *
     * `from`/`to` are the room peer ids as each side knows them, so a relay that
     * reflects a leave back at its sender verifies the REVERSED tuple and fails.
     */
    fun linkLeavePayload(from: String, to: String): String = Json.stringify(
        Json.obj("kind" to Json.of("link-leave"), "from" to Json.of(from), "to" to Json.of(to)),
    )

    // ── leave shape ─────────────────────────────────────────────────────────

    private val LEAVE_KEYS = setOf("link", "leave", "auth")

    /**
     * Recognise a leave by EXACT shape and hand back its tag, before anything
     * cryptographic runs.
     *
     * The allow-list is the point, not a formality. A leave rides the `link`
     * generation, which means an establishment in flight for the same peer sees
     * it too — that filter is by generation, not by message kind. A smuggled
     * `commit` would be recorded by the handshake, a `caps` array would reach
     * the capability registry, a `busy` would fail a connecting link, and
     * `sdp`/`ice` would be handled outright. Requiring exactly
     * `{link, leave, auth}` makes the signal inert everywhere except the leave
     * handler.
     */
    fun parseLeaveAuth(raw: Json?): String? {
        val obj = raw as? Json.Obj ?: return null
        if ((obj["link"] as? Json.Bool)?.value != true) return null
        if ((obj["leave"] as? Json.Bool)?.value != true) return null
        val auth = (obj["auth"] as? Json.Str)?.value ?: return null
        if (auth.length != AUTH_TAG_LENGTH) return null
        if (obj.keys.size != LEAVE_KEYS.size || obj.keys != LEAVE_KEYS) return null
        return auth
    }

    // ── the file lane's total frame partition ───────────────────────────────

    enum class FileControl { ACCEPT, REJECT, COMPLETE, BUSY, BATCH_ABORT }

    /**
     * A lifecycle control is EXACTLY one byte.
     *
     * A longer frame that merely starts with one of these values is a protected
     * frame or a malformed one, and reading it as consent is how a peer would
     * get a batch accepted without a user ever answering. The length check is
     * the whole control, not a formality.
     */
    fun fileLifecycleKind(frame: ByteArray, barrier: Boolean = true): FileControl? {
        if (frame.size != 1) return null
        return when (frame[0].toInt() and 0xff) {
            RealtimeFrame.CTRL_ACCEPT -> FileControl.ACCEPT
            RealtimeFrame.CTRL_REJECT -> FileControl.REJECT
            RealtimeFrame.CTRL_COMPLETE -> FileControl.COMPLETE
            // `link/1` additions. On the shipped legacy wire the control set is
            // exactly the three above (fixture `controlHex`), so recognising
            // these there would be inventing a dialect: an Apple peer's
            // `RealtimeControl(rawValue:)` has three cases and would feed the
            // byte to its AEAD receiver. Unrecognised, a one-byte frame is
            // shorter than a header and lands in `Unroutable`, which fails the
            // lane — the same answer the peer would reach.
            RealtimeFrame.CTRL_BUSY -> if (barrier) FileControl.BUSY else null
            RealtimeFrame.CTRL_BATCH_ABORT -> if (barrier) FileControl.BATCH_ABORT else null
            else -> null
        }
    }

    /**
     * What one frame arriving on the file lane IS, exactly.
     *
     * The classes PARTITION the space: every byte string lands in exactly one,
     * so no frame can be both counted as flow control and fed to the AEAD
     * receiver, and none can be silently dropped.
     */
    sealed interface FileFrameClass {
        data class Lifecycle(val control: FileControl) : FileFrameClass
        /** A well-formed ACK HEADER. Its VALUE is a separate decision. */
        data object Ack : FileFrameClass
        /** Kind 5, INCLUDING a payload that does not parse — a malformed resume
         *  request is control the lane must fail closed on, never bytes for the
         *  protected stream. */
        data object ResumeRequest : FileFrameClass
        data object ResumeStart : FileFrameClass
        /** Carries a nonce; must reach the receiver in wire order. */
        data object Protected : FileFrameClass
        /** Nothing this lane can route. The owner FAILS rather than guessing. */
        data object Unroutable : FileFrameClass
    }

    /**
     * Route one file-channel frame, by kind and by exact shape. Total, and
     * allocation-free: it runs on every inbound message, before consent, on
     * bytes a peer chose.
     *
     * `Unroutable` fails the lane. On an ordered channel it is either corruption
     * or a peer speaking a protocol this build does not have, and skipping one
     * frame the peer counted strands the receiver's sequence permanently.
     */
    fun fileFrameClass(frame: ByteArray, barrier: Boolean = true): FileFrameClass {
        fileLifecycleKind(frame, barrier)?.let { return FileFrameClass.Lifecycle(it) }
        // Below the header there is no kind to dispatch on at all.
        if (frame.size < RealtimeFrame.HEADER_BYTES) return FileFrameClass.Unroutable
        return when (frame[0].toInt() and 0xff) {
            // 13 bytes is part of what an ACK IS. A kind-6 frame of another
            // length is not one, and must not fall through into the protected
            // stream either.
            RealtimeFrame.KIND_ACK ->
                if (frame.size == RealtimeFrame.ACK_FRAME_BYTES) FileFrameClass.Ack
                else FileFrameClass.Unroutable
            RealtimeFrame.KIND_RESUME_REQ -> FileFrameClass.ResumeRequest
            RealtimeFrame.KIND_RESUME_START -> FileFrameClass.ResumeStart
            // The two legacy kinds are Protected DELIBERATELY: the receiver is
            // the single place that turns them into a loud "older version"
            // error, and a demux that swallowed them here would downgrade a
            // version mismatch into silence.
            RealtimeFrame.KIND_CHUNK,
            RealtimeFrame.KIND_CHUNK_PART,
            RealtimeFrame.KIND_BATCH_ENC,
            RealtimeFrame.KIND_BATCH_PART,
            RealtimeFrame.KIND_DONE_ENC,
            RealtimeFrame.KIND_BATCH_LEGACY,
            RealtimeFrame.KIND_DONE_LEGACY,
            -> FileFrameClass.Protected
            // Kind 12 included: this client does not announce `preupload/1`, so
            // a handoff frame is something it may never legally be sent, and
            // classifying it Unroutable matches the Apple clients exactly.
            else -> FileFrameClass.Unroutable
        }
    }
}
