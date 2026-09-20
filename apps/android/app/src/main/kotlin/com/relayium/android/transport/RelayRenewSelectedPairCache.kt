package com.relayium.android.transport

/**
 * The last selected pair one `PeerConnection` actually reported, and the
 * subscriber that wants it.
 *
 * ## Why this exists at all
 *
 * The ICE agent picks a pair as soon as connectivity checks succeed. That is
 * routinely BEFORE DTLS finishes, before either data channel opens, and before
 * the commit-reveal handshake completes — and the owner only subscribes once
 * the link is ready, because until then there is no session to bound. So the
 * FIRST selection, the one that says whether this link is relayed at all, lands
 * with nothing listening.
 *
 * Dropping it is not a missed optimisation. A relayed link whose first
 * selection was lost is never bounded: no expiry timer, no warning, and no
 * renewal trigger, until some LATER pair change that a healthy connection has
 * no reason to produce. The link then runs past its credential's authority with
 * nothing on either side accounting for it.
 *
 * ## What it deliberately is not
 *
 * A single slot holding the latest REAL event. Not a history, not a guess
 * derived from whatever SDP is current, and not a substitute for the checks the
 * observation has to pass: a replayed pair is evaluated by exactly the same
 * ufrag rule as a live one, so a pair cached from an earlier ICE generation
 * proves nothing and is refused. That is what makes retaining it safe rather
 * than merely convenient.
 *
 * Its identity fence is the object itself: one cache belongs to one transport,
 * [clear] empties it on teardown, and a new link gets a new one. Not
 * thread-safe by design — its owner serialises every call onto one executor
 * thread, exactly as it does for the rest of the transport's state.
 */
internal class RelayRenewSelectedPairCache {

    private var last: RenewTransport.SelectedPair? = null
    private var subscriber: ((RenewTransport.SelectedPair) -> Unit)? = null

    /** The pair this connection is currently known to be using, or null. */
    val lastObserved: RenewTransport.SelectedPair? get() = last

    /**
     * One real observation from the platform.
     *
     * Cached BEFORE it is forwarded, so an event that arrives with no
     * subscriber is retained rather than lost, and so a subscriber that throws
     * cannot leave the cache disagreeing with what the agent reported.
     */
    fun record(pair: RenewTransport.SelectedPair) {
        last = pair
        subscriber?.invoke(pair)
    }

    /**
     * Attach, replace or detach the one subscriber.
     *
     * Attaching REPLAYS the last real observation, if there is one. That replay
     * is the whole point: it is the only way a subscriber that could not exist
     * until the handshake finished ever learns what the agent decided before
     * it.
     */
    fun subscribe(cb: ((RenewTransport.SelectedPair) -> Unit)?) {
        subscriber = cb
        if (cb != null) last?.let(cb)
    }

    /** Teardown. A configuration observed by a connection that is going away is
     *  not evidence about the next one. */
    fun clear() {
        subscriber = null
        last = null
    }
}
