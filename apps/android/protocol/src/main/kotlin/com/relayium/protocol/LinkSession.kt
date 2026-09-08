package com.relayium.protocol

/**
 * The link's own lifecycle: who this client has greeted, who may be offered a
 * link, the commit-reveal handshake's ordering rules, and the leave budget.
 *
 * Pure and clock-injected. Every deadline here is a real bound the transport
 * must honour, and every one of them is testable by advancing a `now` the caller
 * supplies rather than by sleeping.
 */
class LinkSession(private val selfId: String) {

    // ── the capability registry ─────────────────────────────────────────────

    private val announced = HashMap<String, List<String>>()

    /**
     * Record a peer's roster hello.
     *
     * Returns true when the frame WAS a hello, so a caller can tell it from the
     * other piggybacks that share this envelope.
     *
     * Peer-authored input on an untrusted channel:
     *
     * - a missing `caps`, or one that is not an array, is NOT a hello — it is a
     *   frame we do not understand, and it must leave any earlier announcement
     *   standing rather than clearing it;
     * - a well-formed array is a SNAPSHOT, not an additive grant, so
     *   `["link/1"]` followed by `[]` revokes;
     * - non-string entries inside a well-formed array are dropped.
     */
    fun recordPeerCaps(peerId: String, raw: Json?): Boolean {
        val obj = raw as? Json.Obj ?: return false
        val caps = obj["caps"]
        if (caps !is Json.Arr) return false
        announced[peerId] = caps.items.mapNotNull { (it as? Json.Str)?.value }
        return true
    }

    /**
     * A `link`-generation frame is itself proof its sender speaks `link/1` —
     * nothing else composes one.
     *
     * It may stand in for a hello that never arrived, but ONLY for a peer that
     * has said nothing at all. It must never overrule a peer that has already
     * stated an incompatible wire.
     */
    fun recordProvenLink(peerId: String) {
        if (!announced.containsKey(peerId)) announced[peerId] = listOf(LinkProtocol.CAPABILITY)
    }

    /** Whether this peer has announced AT ALL — the third state the predicate
     *  below deliberately does not have. */
    fun peerCapsKnown(peerId: String): Boolean = announced.containsKey(peerId)

    /**
     * EXACT match, and the only admission decision this client makes.
     *
     * There is no second transport to fall through to, so a false answer here is
     * not a downgrade — it is a connection that cannot work. `link/2`, a
     * capitalised variant, `text/1` and a peer that never announced are all
     * equally not this protocol and all equally unreachable.
     */
    fun peerSupportsLink(peerId: String): Boolean =
        announced[peerId]?.contains(LinkProtocol.CAPABILITY) == true

    /**
     * Whether this peer positively named the shipped message wire.
     *
     * Read ONLY once `peerSupportsLink` has already answered false: a peer that
     * speaks `link/1` carries messages on it and must never be routed onto the
     * older single-generation connection instead. Exact match, for the reason
     * the link predicate gives — `text/2` is a different wire.
     *
     * Not itself an admission decision: which generation a legacy peer gets is
     * `LegacyLane.mode`, and this is one of its two inputs.
     */
    fun peerSupportsText(peerId: String): Boolean =
        announced[peerId]?.contains(LinkProtocol.TEXT_CAPABILITY) == true

    /** Drop announcements for peers no longer in the roster. A reconnecting peer
     *  gets a fresh id from the hub, so nothing stale is inherited. */
    fun retainPeers(ids: Collection<String>) {
        val keep = ids.toSet()
        announced.keys.retainAll(keep)
    }

    // ── the roster hello, and its bounded retries ───────────────────────────

    private val owed = HashMap<String, Int>()
    private val greeted = HashSet<String>()

    /**
     * The roster changed: greet whoever is new, forget whoever left.
     *
     * Announcing is driven ONLY by a roster gaining a peer this client has not
     * greeted and by the bounded retry tick. Hearing from a peer RETIRES what is
     * owed and never produces an announcement — answering a hello with a hello
     * is an unbounded ping-pong, and the one-way rule is structural rather than
     * something a reader has to remember.
     */
    fun rosterChanged(peerIds: List<String>): List<String> {
        val present = peerIds.toSet()
        owed.keys.retainAll(present)
        greeted.retainAll(present)
        val toGreet = ArrayList<String>()
        for (id in peerIds.sorted()) {
            if (!greeted.add(id)) continue
            // The first attempt goes out immediately, which is what the Web
            // does; the remaining two are ticks. All three land inside the
            // peer's five-second settle window.
            owed[id] = LinkProtocol.CAPS_ANNOUNCE_ATTEMPTS - 1
            toGreet.add(id)
        }
        return toGreet
    }

    /** One retry tick. Sorted, so a run's frame order is something a test can
     *  pin. */
    fun helloRetryTick(): List<String> {
        val due = owed.keys.sorted()
        val out = ArrayList<String>(due.size)
        for (id in due) {
            val remaining = owed.getValue(id)
            if (remaining <= 0) { owed.remove(id); continue }
            owed[id] = remaining - 1
            out.add(id)
        }
        return out
    }

    /** This peer has told us what it speaks. It does not need telling again. */
    fun didHearFrom(peerId: String) {
        owed.remove(peerId)
    }

    /** Test seam and liveness check: how many announcements this peer is owed. */
    fun helloOwed(peerId: String): Int = owed[peerId] ?: 0

    /** The hello frame itself. A fresh list each call, so a caller cannot mutate
     *  what is advertised to the next peer. */
    fun capsSignal(): Json.Obj =
        Json.obj("caps" to Json.arr(LinkProtocol.ADVERTISED_CAPS.map(Json::of)))

    // ── the handshake ───────────────────────────────────────────────────────

    /**
     * The commit-reveal handshake, with the ordering that makes the SAS worth
     * comparing.
     *
     * One instance per ESTABLISHMENT. A second link derives a second set of
     * keys, and this object holds the keypair that must not outlive them.
     */
    class Handshake(val role: LinkProtocol.Role) {

        private val self = Crypto.generateKeyPair()
        private val nonce = Crypto.randomCommitNonce()

        /** This side's commitment, base64, attached to every SDP we send. */
        val commit: String = Bytes.base64(Crypto.commitKey(self.publicKey, nonce))

        private var peerCommit: ByteArray? = null
        private var revealSent = false
        private var peerPublic: ByteArray? = null

        var keys: Crypto.SessionKeys? = null
            private set
        var sas: String? = null
            private set

        val complete: Boolean get() = keys != null

        /**
         * Record the peer's commitment.
         *
         * MUST run before any reveal is handled: answering an offer sends this
         * side's commitment, and the peer's must already be recorded or a reveal
         * arriving in the same burst has nothing to verify against.
         *
         * A SECOND, DIFFERENT commitment is refused. Accepting a replacement
         * would let a relay that saw the real public key commit again afterwards,
         * which is exactly the adaptive choice commit-reveal removes.
         */
        fun recordPeerCommit(base64: String): Boolean {
            val decoded = Bytes.unbase64OrNull(base64) ?: return false
            if (decoded.size != Crypto.COMMIT_BYTES) return false
            val existing = peerCommit
            if (existing != null) return Bytes.constantTimeEquals(existing, decoded)
            peerCommit = decoded
            return true
        }

        /** Whether the peer's commitment has been recorded. The transport uses
         *  this to fail an answer that arrived carrying none. */
        val hasPeerCommit: Boolean get() = peerCommit != null

        /**
         * The initiator reveals once it holds the responder's commitment, which
         * is when the answer arrives.
         *
         * The commitment check is a PRECONDITION here, not only in the caller.
         * An answer whose `commit` was stripped by the relay still triggers the
         * transport's on-answer path, and revealing then would hand the peer a
         * public key it can commit to AFTER seeing it — the exact adaptive
         * choice commit-reveal exists to remove. No commitment recorded means no
         * reveal, unconditionally; the caller decides whether that is a fatal
         * admission failure or a wait.
         */
        fun revealOnAnswer(): Reveal? {
            if (role != LinkProtocol.Role.INITIATOR) return null
            if (peerCommit == null) return null
            return reveal()
        }

        private fun reveal(): Reveal? {
            if (revealSent) return null
            revealSent = true
            return Reveal(Bytes.base64(self.publicKey), Bytes.base64(nonce))
        }

        data class Reveal(val key: String, val nonce: String)

        sealed interface RevealResult {
            /** Verified. `reveal` is this side's own, for a responder that owes
             *  one; null for an initiator that already sent it. */
            data class Accepted(val reveal: Reveal?) : RevealResult
            /** A duplicate — an ICE restart re-delivering one — ignored. */
            data object Duplicate : RevealResult
            /** Mismatch, or no commitment was ever recorded. HARD failure: the
             *  channel must never open. */
            data object Mismatch : RevealResult
        }

        /**
         * Verify a peer reveal against its earlier commitment.
         *
         * A mismatch, a malformed value, or NO recorded commitment at all are
         * one answer: [RevealResult.Mismatch]. "No commitment" is not a lenient
         * case — a reveal with nothing to check it against is precisely the
         * unconstrained key choice the commitment exists to prevent.
         */
        fun acceptReveal(keyBase64: String, nonceBase64: String): RevealResult {
            if (peerPublic != null) return RevealResult.Duplicate
            val commitment = peerCommit ?: return RevealResult.Mismatch
            val key = Bytes.unbase64OrNull(keyBase64) ?: return RevealResult.Mismatch
            val n = Bytes.unbase64OrNull(nonceBase64) ?: return RevealResult.Mismatch
            if (key.size != Crypto.PUBLIC_KEY_BYTES || n.size != Crypto.COMMIT_NONCE_BYTES) {
                return RevealResult.Mismatch
            }
            if (!Bytes.constantTimeEquals(commitment, Crypto.commitKey(key, n))) {
                return RevealResult.Mismatch
            }
            val derived = try {
                Crypto.deriveSession(
                    if (role == LinkProtocol.Role.INITIATOR) Crypto.Role.INITIATOR else Crypto.Role.RESPONDER,
                    self,
                    key,
                )
            } catch (e: Crypto.LowOrderKeyException) {
                // A peer whose key drives the agreement to zero is refused at
                // the same strength as a bad commitment: both mean the shared
                // secret is not this pair's.
                return RevealResult.Mismatch
            }
            peerPublic = key
            keys = derived
            sas = Crypto.sas(self.publicKey, key)
            // The responder learns the peer key from the reveal and only NOW
            // discloses its own.
            val own = if (role == LinkProtocol.Role.RESPONDER) reveal() else null
            return RevealResult.Accepted(own)
        }

        fun destroy() {
            self.destroy()
            keys?.destroy()
        }
    }

    // ── the leave budget ────────────────────────────────────────────────────

    private var leaveAttempts = 0
    private var verifyingLeave = false

    /**
     * Consume an inbound authenticated leave.
     *
     * Every cheap check runs BEFORE the HMAC — exact shape, the current link's
     * peer, the budget — so a forged or replayed signal cannot buy verification
     * work. One verification at a time; the rest of a burst is dropped WITHOUT
     * spending budget, so a flood costs one HMAC rather than one per message.
     *
     * A signal that does not verify is dropped IN SILENCE. Answering would tell
     * a signalling relay which peer holds a live link, and losing a genuine
     * leave is safe by construction: it degrades to exactly the behaviour of a
     * peer that dropped off the network.
     */
    fun acceptLeave(from: String, raw: Json?, keys: Crypto.SessionKeys): Boolean {
        if (verifyingLeave) return false
        val auth = LinkProtocol.parseLeaveAuth(raw) ?: return false
        if (leaveAttempts >= LinkProtocol.LEAVE_MAX_ATTEMPTS) return false
        leaveAttempts++
        verifyingLeave = true
        try {
            // Direction matters: `from` is the SENDER and `to` is this client, so
            // a relay reflecting a leave back at its sender verifies the reversed
            // tuple and fails.
            return Crypto.verifyAuth(keys, LinkProtocol.linkLeavePayload(from, selfId), auth)
        } finally {
            verifyingLeave = false
        }
    }

    /** Spent HMACs, for a test that must prove the budget is real. */
    val leaveAttemptsSpent: Int get() = leaveAttempts

    /**
     * A NEW authentication step begins. The budget starts over with it.
     *
     * Deliberately tied to the keys rather than to a transport: a rebuilt
     * transport under the same keys is the SAME authenticated link and must not
     * refill the budget.
     */
    fun newAuthentication() {
        leaveAttempts = 0
    }

    /** Announce this side's own departure. Best effort; a leave that never
     *  arrives degrades to the peer's ordinary drop handling. */
    fun leaveSignal(peerId: String, keys: Crypto.SessionKeys): Signal =
        Signal.leave(Crypto.signAuth(keys, LinkProtocol.linkLeavePayload(selfId, peerId)))

    // ── who offers ──────────────────────────────────────────────────────────

    fun roleFor(peerId: String): LinkProtocol.Role = LinkProtocol.linkRole(selfId, peerId)
}
