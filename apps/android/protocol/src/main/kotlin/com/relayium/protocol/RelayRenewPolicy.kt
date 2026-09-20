package com.relayium.protocol

/**
 * When a relayed link ends, when it may ask for a new credential, and what
 * counts as a reason to ask — `relay-renew-v1.md` section 7.
 *
 * Pure and clock-injected, like [LinkSession]: every instant here is a real
 * bound a caller arms a timer off, and every one of them is testable by handing
 * in a `now` rather than by sleeping.
 */
object RelayRenewPolicy {

    // ── the credential boundary ─────────────────────────────────────────────

    /**
     * How much local-clock error the boundary absorbs.
     *
     * `expiry` is stamped by the server's clock; every timer runs on this
     * device's. If the device is AHEAD the remaining lifetime is
     * underestimated and the link ends early — safe. If it is BEHIND the
     * lifetime is overestimated, which is the direction that would present dead
     * credentials as live, so the margin is subtracted to cover it. A minute
     * covers ordinary NTP drift and phone clock slop; nothing client-side can
     * cover a clock that is hours out, and pretending otherwise would just move
     * the lie.
     */
    const val CLOCK_SKEW_MS = 60_000L

    /** How long before the boundary a live link must say so. */
    const val WARN_MS = 5 * 60_000L

    /**
     * The furthest ahead of the boundary a renewal is ever attempted.
     *
     * Ten minutes on the normal one-hour grant.
     */
    const val MAX_MARGIN_MS = 10 * 60_000L

    /**
     * How long a failed epoch waits before another is spent.
     *
     * Without it the trigger's own poll cadence would burn all three of a
     * round's epochs inside fifteen seconds — a peer that is briefly idle, or a
     * server still collecting the second request, would cost the link every
     * attempt it had before the renewal window had really begun. A minute
     * spreads three attempts across a ten-minute margin, which is what that
     * margin is for.
     */
    const val RETRY_BACKOFF_MS = 60_000L

    /**
     * How recently real user data must have moved for a renewal to be asked
     * for.
     *
     * The same ten minutes as the existing idle policy, and deliberately the
     * same number: a link nobody is using still dies on schedule, and renewal
     * does not become the reason an idle link lives forever.
     */
    const val USER_DATA_WINDOW_MS = 10 * 60_000L

    /**
     * How often the trigger re-asks once the margin has opened.
     *
     * The margin is not a single moment. The two peers' initial expiries may
     * legitimately differ, the user may start typing at minute 55 of a
     * one-hour grant, and a failed epoch's backoff has to expire into
     * something. Fifteen seconds over a ten-minute margin is forty wake-ups at
     * the very most, and the tick does nothing at all outside the margin.
     */
    const val TICK_MS = 15_000L

    /** One TURN entry, as much of it as the boundary depends on. */
    data class Credential(val urls: List<String>, val username: String?)

    /**
     * The bounded lifetime of a RELAYED link, derived from the credential the
     * server actually issued.
     *
     * Held as ABSOLUTE instants on the local clock, derived once against the
     * clock that was current when the configuration arrived. Re-deriving later
     * against a clock that has since been stepped would silently move the
     * boundary under a live link, which is exactly what this exists to prevent.
     *
     * ## What this bound is, and what it is not
     *
     * It bounds THIS CLIENT'S willingness to keep using a credential, and
     * nothing else. It is not a statement about when a TURN allocation stops
     * carrying bytes: an allocation that already exists may outlive the
     * credential that created it. Nothing here establishes any provider's real
     * allocation lifetime, an upper bound on one, automatic revocation, or
     * immediate quota enforcement. The server's GRANT authority expires on its
     * own schedule regardless, which is the thing renewal actually renews.
     */
    data class Deadline(
        /** The earliest server-stated expiry, as local-clock ms. Reported so a
         *  caller — and a test — can see what the margin was applied to. */
        val expiresAt: Long,
        /** When this configuration was turned into a boundary. The margin is
         *  anchored HERE, not to "now": see [renewAt]. */
        val armedAt: Long,
        /** When the relayed link must be terminal. */
        val deadlineAt: Long,
        /** When a live link must warn. Never after [deadlineAt]. */
        val warnAt: Long,
        /** The first instant a renewal may be attempted. */
        val renewAt: Long,
    ) {
        /**
         * A credential that was already dead when it was armed.
         *
         * A real state — a badly-set clock, or a configuration held far too
         * long — and the truthful answer is an immediate terminal one. It is
         * NOT a reason to renew: a grant that bounds nothing cannot be
         * extended, and asking would spend a round on a link that must end.
         */
        val expired: Boolean get() = deadlineAt <= armedAt
    }

    /**
     * The unix-second expiry a TURN REST username states, or null.
     *
     * Strict on purpose, and for the same reason the browser's parser is: a
     * lenient numeric conversion accepts `""`, `" 12 "` and `"0x10"`, so it
     * would read an expiry out of a credential that never carried one — and an
     * expiry read out of noise is a deadline imposed on a link for no reason.
     * Only ASCII digits before the first colon count, and only a positive
     * value.
     */
    fun restExpirySeconds(username: String?): Long? {
        if (username == null) return null
        val colon = username.indexOf(':')
        if (colon <= 0) return null
        val head = username.substring(0, colon)
        if (head.any { it !in '0'..'9' }) return null
        val seconds = head.toLongOrNull() ?: return null
        return if (seconds > 0) seconds else null
    }

    /** Whether this entry can hold a TURN allocation at all. */
    fun isRelayEntry(credential: Credential): Boolean =
        credential.urls.any { it.startsWith("turn:") || it.startsWith("turns:") }

    /**
     * The earliest expiry stated by any TURN credential, in unix seconds.
     *
     * EARLIEST, not first or longest: the pool hands out one credential per
     * relay and ICE decides which one carries the link, so the only honest
     * bound is the one that dies first. An entry with no `turn:`/`turns:` URL
     * is ignored — a STUN entry has no allocation to lose, and reading one
     * would let a hostile configuration impose a deadline on a link that never
     * relays. Malformed entries are skipped rather than failing the list:
     * dropping a valid sibling because of a broken neighbour would remove the
     * bound entirely, which is the one outcome worth avoiding.
     */
    fun earliestTurnExpiry(credentials: List<Credential>): Long? {
        var earliest: Long? = null
        for (credential in credentials) {
            if (!isRelayEntry(credential)) continue
            val seconds = restExpirySeconds(credential.username) ?: continue
            if (earliest == null || seconds < earliest) earliest = seconds
        }
        return earliest
    }

    /**
     * The boundary for one configuration, or null when nothing in it relays.
     *
     * Null is the LAN answer and the answer for a STUN-only room: there is no
     * allocation to lose, so there is nothing to bound and nothing to renew.
     */
    fun deadline(credentials: List<Credential>, now: Long): Deadline? {
        val earliest = earliestTurnExpiry(credentials) ?: return null
        val expiresAt = earliest * 1000L
        val deadlineAt = maxOf(now, expiresAt - CLOCK_SKEW_MS)
        return Deadline(
            expiresAt = expiresAt,
            armedAt = now,
            deadlineAt = deadlineAt,
            warnAt = maxOf(now, deadlineAt - WARN_MS),
            renewAt = maxOf(now, deadlineAt - marginMs(deadlineAt - now)),
        )
    }

    /**
     * How far ahead of the boundary a renewal is attempted, for a grant of
     * [lifetimeMs].
     *
     * Ten minutes on the normal one-hour grant, scaled for a short credential
     * so an accelerated test TTL does not produce a negative delay or a margin
     * larger than the whole lifetime. A third of the lifetime is the ceiling
     * for a short grant, so a 60-second test credential renews 20 seconds
     * before its boundary — 40 seconds into its life.
     *
     * ## The anchor is the LIFETIME, not the time remaining
     *
     * This takes the grant's whole lifetime and the caller applies it to the
     * boundary ONCE, at arming time. Recomputing the margin from the time
     * remaining at every tick is a trap that reads as correct and is not: with
     * `margin = remaining / 3`, `remaining > remaining / 3` holds for every
     * positive remaining, so "are we inside the margin yet" answers no right up
     * to the deadline and the renewal never fires at all.
     */
    fun marginMs(lifetimeMs: Long): Long {
        if (lifetimeMs <= 0) return 0
        return minOf(MAX_MARGIN_MS, lifetimeMs / 3)
    }

    // ── what counts as activity ─────────────────────────────────────────────

    /**
     * The independent real-user-data clock.
     *
     * Deliberately NOT the controller's existing text-lane activity stamp. That
     * one is refreshed by lifecycle bytes and by UI state, which is exactly
     * what section 7.1 forbids as a consent signal: a UI "active" flag, a
     * pending-consent flag, queued but unsent work, keepalives, and renewal's
     * own probes and acks are each NOT activity.
     *
     * What IS activity is authenticated user-lane data: actual file plaintext
     * written, ACK progress that proves the peer received bytes, and user text
     * that was sealed or authenticated. There is deliberately NO minimum speed
     * or volume — a fixed floor would exclude a sparse legitimate conversation
     * and a slow or stalled-but-recovering file, while a hostile pair can pad
     * arbitrary bytes past any floor, because the meter cannot distinguish E2E
     * content from padding by design.
     */
    class Activity(private val windowMs: Long = USER_DATA_WINDOW_MS) {

        private var lastAt: Long? = null

        /** Real user data moved, at [at]. Monotonic: a stale caller cannot
         *  rewind the clock. */
        fun note(at: Long) {
            val current = lastAt
            if (current == null || at > current) lastAt = at
        }

        /** The last instant real user data moved, or null. */
        val lastUserDataAt: Long? get() = lastAt

        /** Whether the link has carried real user data recently enough to treat
         *  its user as consenting to a renewal. */
        fun active(now: Long): Boolean {
            val at = lastAt ?: return false
            return now - at <= windowMs
        }
    }
}
