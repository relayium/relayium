package com.relayium.android.ingress

/**
 * Everything that happens after this app is handed something from outside, in
 * one object outside the view layer and outside the ViewModel.
 *
 * It answers two deliberately separate questions, in the shape
 * `AppDeepLinkCoordinator` settled on for iOS and macOS — the same product
 * decision, so the same structure, so a reviewer can compare them line for
 * line:
 *
 *  1. **Where to go.** One [navigate] call, made the moment the request
 *     arrives and never again. Navigation is the user's own tap on a link, so
 *     it is not held back — and it must not be REPLAYED later, which is the
 *     whole reason application is split out from it.
 *  2. **What to write.** Prefilling a code overwrites the code a live session
 *     is running on, and resolving a stored link restarts a download. Those
 *     are refused while the work they would interrupt is in flight, retained,
 *     and applied once, later, when it is safe.
 *
 * **Deferred application never navigates.** That is what keeps "the later
 * event wins" true: a link that arrives during a live transfer selects its
 * screen once, and if the user has moved somewhere else during the wait, the
 * field write that lands afterwards leaves them there. A second selection
 * would be the app yanking the screen away minutes after anybody asked it to.
 *
 * **It cannot join, download or send.** Not by convention — structurally. It
 * holds two function seams, [navigate] and [apply], and the values it can pass
 * to [apply] are [IngressRequest]s, none of which names a transfer action. The
 * behaviour this replaces is `MainActivity.joinFromIntent`, which calls
 * `viewModel.join(url)` for any `ACTION_VIEW` and so replaces a running
 * transfer with no confirmation.
 *
 * ## Seams, not models
 *
 * [isBusy] is a function of a request, supplied by the wiring, and this file
 * references no ViewModel, controller or model type. Three reasons, in
 * increasing order of importance: the ViewModel is another writer's file; a
 * dependency on it would make every test here need Android; and the busy
 * question genuinely differs per request — a stored link waits on the download
 * model, a pairing code waits on the session — so it belongs where those
 * models are.
 *
 * The wiring's expected answers, from the current source:
 *
 *  - [IngressRequest.PrefillCode] is busy exactly when a session is running,
 *    which `TransferViewModel.createCrossNetworkLink` already defines as
 *    `phase != IDLE && phase != ENDED`. Reusing that predicate rather than a
 *    new one keeps a link and a minted code from disagreeing about whether
 *    this device is free.
 *  - [IngressRequest.OpenStoredLink] is busy while `CloudDownloadModel.State`
 *    is `Loading` or `Saving` — resolving or writing. `Ready` is a resolved
 *    link the user has not saved yet and is not busy, matching iOS
 *    `CloudDownloadModel.isBusy`.
 *
 * ## Threading, and the thing that is not threading
 *
 * Main thread only, like the models it writes into. Intents arrive on the main
 * thread and busy edges are collected there; there are no locks here because
 * there is no second thread, and adding some would suggest otherwise.
 *
 * One thread is NOT one call at a time, though, and that is the trap this
 * class has to survive. [navigate], [isBusy] and [apply] are the wiring's own
 * code: a navigation can drop a screen that delivers a second request on its
 * way out, an apply can sign an account out, and either can call back into
 * [deliver] or [discardPending] BEFORE the outer call has finished deciding
 * anything. Re-entrancy on one thread reorders the two decisions exactly the
 * way two threads would — the outer call resumes holding a request the app has
 * already moved past, and writes it over the newer one.
 *
 * So every entry point stamps a generation, and every step that could have
 * re-entered re-checks it. A stale call returns without touching [pending] and
 * without applying: the nested call is the newer statement of what the user
 * wants, and the older one loses. That is the same "the later event wins" rule
 * the retention slot already implements, extended to the window inside a
 * single delivery.
 */
class IngressCoordinator(
    private val navigate: (IngressSurface) -> Unit,
    private val apply: (IngressRequest) -> Unit,
    private val isBusy: (IngressRequest) -> Boolean,
) {

    /**
     * A valid request whose write could not be made when it arrived, kept until
     * the work it must not interrupt has stopped.
     *
     * At most one, and always the newest: a second request arriving during the
     * wait REPLACES it rather than queueing behind it. Two links are two things
     * the user asked for, and the older one is the one they have already moved
     * on from.
     *
     * It is also the only request this object ever holds, and it is cleared the
     * moment it is written. Nothing keeps a history of what has been applied,
     * and that is privacy rather than tidiness: a stored link IS the decryption
     * key, so a list of everything this app has opened would be a list of file
     * keys living for the life of the process, for no purpose the user asked
     * for.
     *
     * Private, and nothing exposes its CONTENT — [pendingSurface] answers the
     * only question a UI has ("is something waiting, and for where") without
     * being a second way to learn a key or a code.
     */
    private var pending: IngressRequest? = null

    /**
     * Bumped by every public entry point, so a call that re-entered through one
     * of this object's callbacks can be recognised by the call it re-entered.
     *
     * A counter rather than a boolean "in progress" flag: what the outer call
     * needs to know is not that SOMETHING happened underneath it, but that
     * something happened that has already decided this question — and after two
     * nested deliveries a flag has no way to say which. `Long`, so it does not
     * wrap in any lifetime of a process.
     */
    private var generation: Long = 0

    /** Which surface has a request waiting, if any. Never its content. */
    val pendingSurface: IngressSurface? get() = pending?.surface

    /**
     * One thing from outside: navigate now, write now or later.
     *
     * Returns the refusal to show, or null when the request was accepted —
     * whether it was applied or retained, which is deliberately not something
     * the caller can act on differently. A refused input is reported and
     * **changes nothing**: in particular it does not clear a valid request
     * that is already waiting. A malformed link arriving during a transfer is
     * the likeliest way to lose the good one that came before it, and losing it
     * would be silent.
     */
    fun deliver(outcome: IngressOutcome): IngressRefusal? {
        when (outcome) {
            // A refusal is reported and returns before the generation moves:
            // nothing about a rejected link should be able to invalidate a
            // delivery that is legitimately in flight underneath it.
            is IngressOutcome.Refused -> return outcome.reason
            is IngressOutcome.Accepted -> {
                val request = outcome.request
                val mine = ++generation
                // Unconditional. It is not a write that can lose anything, and
                // refusing it during a transfer would leave the user staring at
                // the screen they were on with no sign the link they tapped had
                // been received at all.
                navigate(request.surface)
                // The navigation may have delivered something newer, or reset
                // the app. Either way this call is now describing the past.
                if (generation != mine) return null
                if (needsIdle(request) && isBusy(request)) {
                    // Asking is also the wiring's code, so the same question
                    // again — an `isBusy` that signed the account out must not
                    // then have this request retained under the new one.
                    if (generation != mine) return null
                    // Replacing an unapplied request drops no resource: an
                    // admitted share owns no open stream and no lease until it
                    // is staged, which is exactly why admission and staging are
                    // separate objects.
                    pending = request
                    return null
                }
                if (generation != mine) return null
                // A newer request that CAN be applied supersedes an older one
                // still waiting: the user has asked for this one instead.
                pending = null
                apply(request)
                return null
            }
        }
    }

    /**
     * Write a retained request if the work it was waiting on has stopped.
     * **No navigation** — see the class note.
     *
     * Re-reads [pending] rather than taking a request, which is what makes a
     * late call harmless when a newer one arrived in the meantime: it applies
     * whatever is waiting NOW, never the value some earlier turn saw. Calling
     * it when nothing is waiting, or while still busy, is a no-op — so the
     * wiring can call it on every busy edge without deciding anything.
     */
    fun applyIfIdle() {
        val mine = ++generation
        val request = pending ?: return
        if (isBusy(request)) return
        // `isBusy` can deliver, discard, or apply something newer. Without this
        // the busy edge of an ENDING transfer could write a request the nested
        // call had already superseded — and it would write it with no
        // navigation, so nothing on screen would show what had happened.
        if (generation != mine) return
        // Cleared BEFORE the write, so a re-entrant edge raised by the write
        // itself finds nothing to apply. Exactly once is the property that
        // matters here: applying twice would prefill over a code the user had
        // begun correcting.
        pending = null
        apply(request)
    }

    /**
     * Drop whatever is waiting.
     *
     * For the wiring to call when the retained request can no longer be honest
     * — the account it was staged under signed out, or the user dismissed the
     * notice that something was waiting. Not called from anywhere in this file;
     * silently expiring a request the user asked for would be worse than
     * applying it late.
     */
    fun discardPending() {
        // The generation moves as well, which is the half that matters when
        // this is called from inside a callback: an account reset raised while
        // a delivery is mid-flight must not be undone by that delivery
        // resuming and retaining or applying its request afterwards.
        generation++
        pending = null
    }

    /**
     * Whether this request has to wait for anything at all.
     *
     * [IngressRequest.ShowJoinSurface] never does: it writes nothing, so there
     * is nothing it could destroy, and asking the seam about it would let a
     * wiring bug turn "look at this screen" into something that queues behind
     * a transfer and then arrives minutes later.
     */
    private fun needsIdle(request: IngressRequest): Boolean =
        request !is IngressRequest.ShowJoinSurface
}
