package com.relayium.android.integration

import java.security.SecureRandom

/**
 * How long this app may keep claiming the local link while one of its OWN
 * system pickers is in front of it — and what happens to the pick when that
 * time runs out.
 *
 * ## The platform hole this exists to close
 *
 * Choosing a file to send, or a folder to receive into, launches `DocumentsUI`
 * — a separate Activity in a separate process. That STOPS this one, every
 * single time. The Nearby surface treats an ordinary `ON_STOP` as "the user
 * left" and tears discovery down, because a device that goes on advertising
 * itself while the app is gone is offering a delivery it cannot make. So an
 * owned picker round trip is exempted, or a Nearby file transfer could never
 * be completed at all: the user taps Send and the session dies before they
 * have chosen anything.
 *
 * The exemption has a hole in it, and it is not fixable from lifecycle events
 * alone. If the user presses **Home while still inside `DocumentsUI`**, this
 * app receives NO second `ON_STOP` — it was already stopped — and there is no
 * callback that says "the picker is no longer on screen either". Left alone,
 * the exemption becomes an indefinite advertisement lease: a device announcing
 * itself, holding sockets, with its owner two apps away.
 *
 * So the exemption is BOUNDED. A picker gets [DEFAULT_TIMEOUT_MILLIS] from the
 * moment it was launched, and then the claim ends whether or not anything came
 * back.
 *
 * ## The clock is elapsed real time, and it is the host's to pass in
 *
 * Wall-clock time is not a duration: an NTP correction or a user changing the
 * date moves it, and a lease measured against it can expire an hour early or
 * never. The host passes `SystemClock.elapsedRealtime()`, which is monotonic
 * and — deliberately — INCLUDES deep sleep: a device that slept for ten
 * minutes with `DocumentsUI` on screen was away for ten minutes, and the
 * presence claim was false for all of them.
 *
 * ## Why the deadline is anchored to the original launch
 *
 * A recreation must not renew it. Rotating the device, or switching to dark
 * mode, recreates the Activity behind the picker and re-runs the composition —
 * and if the deadline were re-derived there, a user who left through Home
 * during a rotation would get a fresh two minutes for a picker nobody is
 * looking at. That is why this object lives in the **ViewModel**, which
 * survives recreation, and why the composition holds nothing but the opaque
 * token: there is no path that could restart the clock, because there is no
 * second place the clock is kept.
 *
 * ## Why the token is opaque and not a counter
 *
 * `ActivityResultRegistry` restores pending results **across process death**
 * and dispatches them to the launcher when it is re-registered. So a token
 * written into saved instance state really can come back to a lease that is
 * not the one that issued it — and a plain counter restarting at 1 in the new
 * process would ALIAS: the restored token names the picker from the previous
 * runtime, the fresh lease has just issued the same integer for a completely
 * different operation, and the old result is applied to the new one. The
 * consequence is the exact failure this class exists to prevent, arrived at
 * from the other direction: a file chosen for a session that no longer exists,
 * sent under a target chosen since.
 *
 * A token is therefore `<runtime>:<counter>`, where the runtime half is random
 * and minted once per lease instance. It cannot collide across a restart, and
 * it carries nothing: no URI, no grant, no code, no name — which matters
 * because saved instance state is written outside this process's memory.
 *
 * ## This is a platform accommodation, not a background service
 *
 * Nothing here keeps working while the app is away. It buys exactly the
 * interval a person needs to pick a file and come back, and it is the reason
 * the product may honestly say Nearby is foreground-only: the one case where
 * the app is not visible is one it entered on the user's behalf, is bounded,
 * and ends by itself.
 *
 * ## Threading
 *
 * Main thread only. Activity-result callbacks, lifecycle events and the
 * ViewModel's own `Dispatchers.Main.immediate` coroutines are all it is
 * touched from; there are no locks here because there is no second thread, and
 * adding some would suggest otherwise.
 */
class PickerLease(
    /** Injected so tests drive expiry without waiting, and so the product's
     *  own value is stated in exactly one place. */
    val timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
    /** Injected so a test can mint two leases that cannot be confused, and so
     *  the aliasing case below is exercised rather than argued about. */
    runtimeId: String = randomRuntimeId(),
) {

    /**
     * What the app loses when this picker's lease runs out.
     *
     * The distinction exists because "the app was away for two minutes" means
     * two different things to two different kinds of round trip, and applying
     * the strict answer to both would discard work for no safety gain.
     */
    enum class Claim {
        /**
         * The round trip is holding a PRESENCE claim open — a Nearby or
         * cross-network session picker. Expiry withdraws the claim and retires
         * this exact operation; a late result may not revive the room, the
         * session or the peer it was chosen for.
         */
        PRESENCE,

        /**
         * The round trip claims nothing to anybody else — a cloud upload
         * choice, an Inbox send choice, an export destination.
         *
         * Expiry still ends the covered state, because `DocumentsUI` stopped
         * this Activity either way. It does NOT discard the answer: the user
         * really did choose those files, no third party was told anything, and
         * the model receiving them has its own request fence that decides
         * whether the choice is still the one it asked for. Throwing the pick
         * away here would be a second, blunter fence overruling a correct one.
         */
        DATA,
    }

    /** What a returning result is allowed to do. */
    enum class Verdict {
        /** The lease is still good. */
        LIVE,

        /**
         * The deadline passed while the picker was away, and this call is the
         * one that noticed.
         *
         * For a [Claim.PRESENCE] round trip the operation has been retired and
         * the result may not be applied. For [Claim.DATA] it is a statement
         * about the lease, not a veto on the answer — see the enum.
         */
        EXPIRED,

        /**
         * No such outstanding picker.
         *
         * A token from a previous process, a second delivery of a result
         * already consumed, a token retired by [sweep], or one this lease never
         * issued. Kept distinct from [EXPIRED] because only [EXPIRED] means
         * "we ended it, just now".
         */
        UNKNOWN,
    }

    /** One picker that is in front of the app. */
    private class Outstanding(val claim: Claim, val deadline: Long)

    /**
     * How a DATA round trip stays recognisable after its lease has run out.
     *
     * The presence claim and the OPERATION are two different lifetimes, and
     * collapsing them was a real defect: removing a DATA token at the sweep
     * meant that after the timer fired, the user's perfectly valid folder or
     * file choice came back as [Verdict.UNKNOWN] and was thrown away — the exact
     * opposite of what [Claim.DATA] says should happen.
     *
     * So a swept DATA token is RETIRED FROM THE COVERAGE but retained as an
     * identity: it no longer counts towards [outstandingCount] or
     * [nextDeadline], so it cannot hold the app "present", and it still answers
     * [Verdict.EXPIRED] once when its result arrives. It stops being recognised
     * when it is consumed, when [retire] drops it, or when the account it was
     * chosen under is invalidated.
     *
     * A swept PRESENCE token is not retained. Its operation was ended — the
     * room left, the advertisement withdrawn — so there is nothing for a late
     * result to be about.
     */
    private val retainedData = LinkedHashSet<String>()

    /** A picker whose deadline passed, as [sweep] reports it. */
    class Expiry internal constructor(val token: String, val claim: Claim) {
        override fun toString(): String = "Expiry($token, $claim)"
    }

    /**
     * The outstanding pickers, in launch order.
     *
     * A map rather than a counter because the session, cloud and Inbox surfaces
     * each own launchers, and each round trip needs its own deadline: the first
     * one to return must not declare the app abandoned, and the first one to
     * EXPIRE must retire only its own operation.
     *
     * Whether the platform ever delivers two of this app's pickers at once is
     * not asserted here and is not relied on. What IS relied on is that using a
     * launcher again [retire]s the token it replaces, so a result for a
     * superseded launch is refused rather than applied to the newer one.
     */
    private val outstanding = LinkedHashMap<String, Outstanding>()

    private val runtime = runtimeId
    private var nextToken = 0L

    /**
     * A picker is going to the front. The returned token is what the result
     * must come back with.
     */
    fun launch(nowMillis: Long, claim: Claim): String {
        val token = "$runtime:${++nextToken}"
        outstanding[token] = Outstanding(claim, nowMillis + timeoutMillis)
        return token
    }

    /**
     * The picker came back. Consumes the token either way: a result is
     * accounted for once or not at all.
     *
     * Expiry is `>=` rather than `>`. At exactly the deadline the lease is
     * over — a host that slept until its own [nextDeadline] and then asked
     * would otherwise be told the picker is still live, with a remaining delay
     * of zero, and would sweep in a tight loop for as long as the clock stood
     * still.
     */
    fun consume(token: String, nowMillis: Long): Verdict {
        val held = outstanding.remove(token)
        if (held != null) {
            return if (nowMillis >= held.deadline) Verdict.EXPIRED else Verdict.LIVE
        }
        // A DATA round trip whose lease ran out while it was away. Its choice
        // is still the user's; what expired is the app's claim to be present,
        // not the answer they gave. Recognised exactly once.
        if (retainedData.remove(token)) return Verdict.EXPIRED
        return Verdict.UNKNOWN
    }

    /**
     * Drop a token without expiring it.
     *
     * Called when a launcher is used again: the previous operation for that
     * launcher is replaced, and a result that arrives for the replaced one must
     * not be applied to what the newer launch is doing. That is what binds a
     * callback to the launch it belongs to, without this class having to claim
     * anything about whether the platform delivers two at once.
     */
    fun retire(token: String) {
        outstanding.remove(token)
        retainedData.remove(token)
    }

    /**
     * Forget every retained DATA identity.
     *
     * For the account change: a file chosen under one session is not a file
     * the next one may deliver, and the choice stops being recognisable at that
     * moment rather than waiting for a callback that may never come.
     */
    fun invalidateRetained() {
        retainedData.clear()
    }

    /**
     * Every picker whose deadline has passed, retired in the same call.
     *
     * Returned rather than acted on, because what retirement MEANS belongs to
     * the host: it withdraws the presence claim and drops the pending
     * operation, and this object knows about neither. Retiring inside the sweep
     * is what makes a later [consume] for the same token answer
     * [Verdict.UNKNOWN] rather than [Verdict.EXPIRED] — the second statement is
     * only true once.
     */
    fun sweep(nowMillis: Long): List<Expiry> {
        val due = outstanding.entries
            .filter { (_, held) -> nowMillis >= held.deadline }
            .map { Expiry(it.key, it.value.claim) }
        for (expiry in due) {
            outstanding.remove(expiry.token)
            // The coverage ends for both; the IDENTITY survives only for the
            // claim whose answer is still worth having.
            if (expiry.claim == Claim.DATA) retainedData.add(expiry.token)
        }
        return due
    }

    /** How many owned pickers are in front of the app right now. */
    fun outstandingCount(): Int = outstanding.size

    /** The soonest deadline, so a host can sleep until it rather than poll. */
    fun nextDeadline(): Long? = outstanding.values.minOfOrNull { it.deadline }

    /**
     * Drop every outstanding picker without expiring it.
     *
     * For the one caller that legitimately ends them all at once — the host
     * going away for good — where reporting each as expired would announce a
     * timeout that did not happen.
     */
    fun retireAll() {
        outstanding.clear()
        retainedData.clear()
    }

    companion object {
        /**
         * Two minutes from the launch of the picker.
         *
         * Long enough to browse into a folder, scroll, and choose; short enough
         * that a device whose owner walked away mid-pick stops advertising
         * itself while they are still in the same room as the person they were
         * sending to. It is a product choice, not a protocol constant — nothing
         * on the wire depends on it.
         */
        const val DEFAULT_TIMEOUT_MILLIS = 120_000L

        /**
         * 16 hex characters of randomness, minted once per lease.
         *
         * Not a secret and not an identifier for anything: it exists only so
         * two runtimes cannot issue the same token. `SecureRandom` rather than
         * a time seed because a token minted twice within the same clock tick
         * across a fast restart is precisely the collision being excluded.
         */
        fun randomRuntimeId(): String {
            val bytes = ByteArray(8)
            SecureRandom().nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
