package com.relayium.android.integration

/**
 * Whether this app is, honestly, in front of the user — as ONE answer that
 * every foreground-only feature reads.
 *
 * ## Why it is one answer and not two
 *
 * Two features make a presence claim to somebody else. Nearby advertises this
 * device on the local link and holds sockets open; the Device Inbox tells
 * central it is listening, which is what makes a sender's delivery arrive
 * rather than wait out a presence TTL. Neither has a foreground service or a
 * background permission, so both claims stop being true at the same moment —
 * and if the two features computed that moment separately they would
 * eventually disagree, which means one of them would be lying about this
 * device while the other was not.
 *
 * ## `ON_STOP` is not "the user left"
 *
 * Three different things produce it and only one of them is abandonment:
 *
 *  * **this app's own system picker came to the front.** `DocumentsUI` is a
 *    separate Activity, so choosing a file to send — or a folder to receive
 *    into — stops this one every time. Treating that as leaving would make the
 *    file flows impossible to complete. Bounded by [PickerLease]; see below.
 *  * **a configuration this Activity does not handle changed.** A locale
 *    switch is the ordinary one. The Activity is coming straight back, with the
 *    same ViewModel and the same live session, and announcing `offline` to
 *    central on every locale change would be presence churn describing nothing.
 *  * **the user really did leave.** That one, and only that one, ends the
 *    claims.
 *
 * ## Why the Inbox follows the same rule as Nearby, deliberately
 *
 * iOS ties Inbox receiving to the scene phase — `inbox.foreground(phase !=
 * .background)` — and Android has no scene phase, only this Activity's
 * lifecycle. Mapping "background" onto a bare `ON_STOP` would stop receiving
 * every time the user opened a picker inside an Inbox flow, and would announce
 * offline/online on every rotation. So the mapping is to THIS predicate:
 * covered by our own picker, or being recreated, is still the app being used.
 *
 * It is not a background delivery channel and does not become one. The covered
 * state is bounded by the picker lease, ends by itself, and is entered only on
 * a round trip the user started inside this app.
 *
 * ## What it deliberately does not do
 *
 * It does not look at which destination is selected. Switching from the Inbox
 * tab to Account is not leaving the app, and an Inbox that stopped receiving
 * because the user looked at their account would drop deliveries for a reason
 * no one could see. Foreground is app-wide, never tab-owned.
 *
 * Main thread only, like the lifecycle callbacks that drive it.
 */
class HostPresence {

    /** Between `ON_START` and `ON_STOP`: the Activity is genuinely on screen. */
    private var started = false

    /**
     * Stopped, but for a reason that is not leaving — an owned picker in front,
     * or a recreation in flight.
     *
     * Kept apart from [started] rather than folded into one boolean because
     * only this one has a deadline: [PickerLease] can end it without any
     * lifecycle event arriving, which is the whole Home-from-`DocumentsUI`
     * case.
     */
    private var covered = false

    /** The one answer. */
    val isForeground: Boolean get() = started || covered

    /** The Activity is on screen. Ends any covered state: whatever we were
     *  waiting behind, we are in front of it now. */
    fun onStart(): Boolean {
        started = true
        covered = false
        return isForeground
    }

    /**
     * The Activity stopped.
     *
     * @param changingConfigurations the Activity is being recreated and is
     *   coming straight back.
     * @param ownedPickerOutstanding one of this app's own pickers is in front
     *   of it — see [PickerLease.outstandingCount].
     */
    fun onStop(changingConfigurations: Boolean, ownedPickerOutstanding: Boolean): Boolean {
        started = false
        covered = changingConfigurations || ownedPickerOutstanding
        return isForeground
    }

    /**
     * The picker lease ran out.
     *
     * Only meaningful while the app is actually away: a lease that expires
     * while the Activity is back on screen means a pick was lost, not that the
     * user left. Ending the presence claims there would be a session destroyed
     * by navigation, which is exactly what the covered state exists to prevent
     * — the user is demonstrably present, and the app may honestly say so. The
     * stale pick is retired either way; that is [PickerLease]'s half.
     */
    fun onPickerLeaseExpired(): Boolean {
        if (!started) covered = false
        return isForeground
    }

    /** The host is going away for good — the ViewModel is being cleared. */
    fun onDestroyed(): Boolean {
        started = false
        covered = false
        return isForeground
    }
}
