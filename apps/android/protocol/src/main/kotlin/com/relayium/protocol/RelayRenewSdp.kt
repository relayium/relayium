package com.relayium.protocol

/**
 * SDP pinning and ICE-generation binding — `relay-renew-v1.md` section 5.
 *
 * Pure string work, deliberately: `org.webrtc` types appear nowhere in this
 * module, so every rule here is a plain JVM test against the shared fixture
 * rather than something only an emulator can exercise.
 *
 * ## Why binding is done by the candidate's OWN ufrag
 *
 * A candidate belongs to whichever ICE generation the candidate itself names,
 * never to whatever epoch happens to be current when the callback fires.
 * `onIceCandidate` is asynchronous and a restart can land between gathering and
 * delivery, so labelling by a mutable "current epoch" variable attributes
 * candidates to the wrong generation — which is precisely how an old-generation
 * candidate gets mistaken for proof that a migration succeeded.
 *
 * Android's `org.webrtc.IceCandidate` exposes `sdpMid`, `sdpMLineIndex` and
 * `sdp` and NO `usernameFragment` property (verified against the
 * `io.github.webrtc-sdk:android:150.7871.01` classes). The string extension is
 * therefore the only source this platform has, which is exactly what the frozen
 * wire says the native ports use.
 */
object RelayRenewSdp {

    // ── the pin ─────────────────────────────────────────────────────────────

    /**
     * The identity a renewal must not change: the DTLS fingerprint set, the
     * m-line/mid sequence, and the answer's chosen `setup` role.
     *
     * Pinning keeps the existing DTLS peer in place. It is NOT the root of
     * trust — that remains the E2E key the SAS anchored.
     */
    data class Pin(
        /** Normalised `<hash-lower> <HEX-UPPER>`, sorted and deduplicated. */
        val fingerprints: List<String>,
        /** The `a=mid:` sequence, in order. Its SIZE is the m-line count. */
        val mids: List<String>,
        /** The `a=setup:` role, lower-cased, or "" when the description states
         *  none. */
        val setup: String,
    )

    /**
     * Read the pin out of a description.
     *
     * The fingerprint hash is lower-cased and the hex upper-cased before
     * comparison because the two ends may list the same set in a different
     * order and RFC 8122 leaves the hex case open — a strict byte comparison
     * would reject a legitimate peer for restating its own fingerprint in the
     * other case. The set is sorted and deduplicated for the same reason.
     *
     * The LAST `a=setup:` wins, matching how a media-level attribute overrides a
     * session-level one. A bundled `link/1` description states one.
     */
    fun pin(sdp: String): Pin {
        val fingerprints = LinkedHashSet<String>()
        val mids = ArrayList<String>()
        var setup = ""
        for (rawLine in sdp.split("\r\n", "\n", "\r")) {
            val line = rawLine.trim()
            when {
                line.startsWith(FINGERPRINT_PREFIX) -> {
                    val value = line.removePrefix(FINGERPRINT_PREFIX).trim()
                    val space = value.indexOf(' ')
                    if (space <= 0) continue
                    val hash = value.substring(0, space).lowercase()
                    val hex = value.substring(space + 1).trim().uppercase()
                    if (hash.isEmpty() || hex.isEmpty()) continue
                    fingerprints.add("$hash $hex")
                }
                line.startsWith(MID_PREFIX) -> mids.add(line.removePrefix(MID_PREFIX).trim())
                line.startsWith(SETUP_PREFIX) ->
                    setup = line.removePrefix(SETUP_PREFIX).trim().lowercase()
            }
        }
        return Pin(fingerprints.sorted(), mids, setup)
    }

    /**
     * Whether a renewal description may be applied against the epoch-0
     * baseline.
     *
     * `setup` is compared ONLY for an answer: an offer legitimately restates
     * `actpass`, so the role is compared where it is actually chosen. A
     * baseline that stated no role at all constrains nothing rather than
     * demanding the peer also state none.
     */
    fun pinMatches(baseline: Pin, next: Pin, isAnswer: Boolean): Boolean {
        if (baseline.fingerprints != next.fingerprints) return false
        if (baseline.mids != next.mids) return false
        if (isAnswer && baseline.setup.isNotEmpty() && baseline.setup != next.setup) return false
        return true
    }

    // ── ufrag binding ───────────────────────────────────────────────────────

    /**
     * The `a=ice-ufrag:` of a description, or "".
     *
     * A bundled `link/1` description has one. If a future description ever
     * carried two different ones this returns the FIRST, which is the
     * conservative answer: a candidate whose ufrag does not match it is
     * dropped, and dropping a usable candidate costs a failed migration that
     * keeps the old deadline — while accepting one from the wrong generation is
     * what the binding exists to stop.
     */
    fun iceUfrag(sdp: String): String {
        for (rawLine in sdp.split("\r\n", "\n", "\r")) {
            val line = rawLine.trim()
            if (line.startsWith(UFRAG_PREFIX)) return line.removePrefix(UFRAG_PREFIX).trim()
        }
        return ""
    }

    /**
     * The ufrag a CANDIDATE STRING states, or "".
     *
     * Read from the candidate's own `ufrag <x>` extension. Extensions are
     * `name value` pairs, so the scan is pairwise: a literal `ufrag` appearing
     * as a VALUE cannot be read as the key.
     */
    fun candidateUfrag(candidate: String): String {
        val parts = candidate.trim().split(WHITESPACE)
        var i = 0
        while (i + 1 < parts.size) {
            if (parts[i] == "ufrag") return parts[i + 1]
            i++
        }
        return ""
    }

    /**
     * The ufrag of an INBOUND candidate, requiring the two sources to agree.
     *
     * A candidate carries its generation twice: in the signal's
     * `usernameFragment` field, and in its own string extension. A native peer
     * may populate only the second. Requiring agreement where both exist, and
     * accepting a single source where only one does, is what makes the binding
     * work across the three clients without letting a relay relabel a candidate
     * by editing whichever copy the receiver happens to read.
     *
     * Returns "" when they contradict each other or when neither states one —
     * both of which mean the candidate cannot be attributed and must be
     * dropped.
     */
    fun inboundCandidateUfrag(candidate: String, usernameFragment: String): String {
        val embedded = candidateUfrag(candidate)
        if (embedded.isNotEmpty() && usernameFragment.isNotEmpty() && embedded != usernameFragment) {
            return ""
        }
        return if (usernameFragment.isNotEmpty()) usernameFragment else embedded
    }

    /**
     * The `typ` a candidate states — `host`, `srflx`, `prflx`, `relay` — or "".
     *
     * Used for two separate decisions, and it is worth keeping them apart:
     * whether the selected pair is RELAYED (and therefore bounded by a
     * credential at all), and whether a selected local candidate can be
     * attributed to a generation.
     */
    fun candidateType(candidate: String): String {
        val parts = candidate.trim().split(WHITESPACE)
        for (i in parts.indices) {
            if (parts[i] == "typ" && i + 1 < parts.size) return parts[i + 1]
        }
        return ""
    }

    /**
     * Whether a SELECTED LOCAL candidate demonstrably belongs to [epochUfrag].
     *
     * The candidate's own ufrag must equal this epoch's local ufrag. A selected
     * peer-reflexive candidate can carry that proof too: the SDK derives it
     * from the local port's generation. Its type alone is not a reason to
     * reject it. Missing or stale ufrags still fail closed; neither a changed
     * port nor the currently installed description substitutes for this proof.
     *
     * An empty [epochUfrag] — no local description applied yet — is never a
     * match, so observation cannot hold before there is a generation to hold
     * it against.
     */
    fun localCandidateBelongsTo(candidate: String, epochUfrag: String): Boolean {
        if (epochUfrag.isEmpty()) return false
        return candidateUfrag(candidate) == epochUfrag
    }

    /**
     * How the existing rule classifies one selected pair.
     *
     * Relay on EITHER side means the path is bounded by a TURN credential;
     * host-to-host is a LAN direct hop; anything else is a NAT-traversed direct
     * path. Identical to `classifyPath` in `web/src/lib/webrtc-core.ts`, but
     * read from the candidates the platform hands to
     * `onSelectedCandidatePairChanged` rather than scanned out of a stats
     * report — which is also why this port cannot make the mistake of picking
     * a stale nominated pair out of an unordered report.
     */
    enum class Path { RELAY, LAN, P2P }

    fun classifyPath(localCandidate: String, remoteCandidate: String): Path {
        val local = candidateType(localCandidate)
        val remote = candidateType(remoteCandidate)
        if (local == "relay" || remote == "relay") return Path.RELAY
        if (local == "host" && remote == "host") return Path.LAN
        return Path.P2P
    }

    private const val FINGERPRINT_PREFIX = "a=fingerprint:"
    private const val MID_PREFIX = "a=mid:"
    private const val SETUP_PREFIX = "a=setup:"
    private const val UFRAG_PREFIX = "a=ice-ufrag:"
    private val WHITESPACE = Regex("\\s+")
}
