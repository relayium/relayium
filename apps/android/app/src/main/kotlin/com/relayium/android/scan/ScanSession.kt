package com.relayium.android.scan

import com.relayium.android.ingress.IngressRequest
import com.relayium.android.ingress.ScanPolicy

/**
 * One run of the scanner: open, decode frames until one of them is a pairing
 * code, close.
 *
 * ## Why this is not just a callback
 *
 * Analysis frames arrive on a camera executor, and closing a scanner does not
 * stop the frames that are already in flight. Between the user dismissing the
 * sheet and the pipeline actually unbinding there are frames being decoded, on
 * another thread, whose results arrive afterwards. Without a fence they land on
 * a screen the user has moved on from — prefilling a code into a session they
 * started in the meantime, or reopening a sheet they closed.
 *
 * So every result carries the generation it was produced under, and a
 * generation is spent by its first success:
 *
 *  - **One result per run.** A viewfinder decodes the same code many times a
 *    second. The second success is not a second thing the user did.
 *  - **Late frames are dropped, not applied.** A result from a closed or
 *    superseded run returns null however good the decode was.
 *  - **Reopening is a new generation**, so the fence survives close/reopen
 *    rather than being reset by it.
 *
 * The same shape [com.relayium.android.ingress.IngressCoordinator] uses for
 * late deep links, for the same reason.
 *
 * Thread-safe: [offer] is called from the camera executor while [open] and
 * [close] are called from the main thread.
 */
class ScanSession {

    private val lock = Any()
    private var generation = 0L
    private var open = false
    private var consumed = false

    /**
     * Begin a run and return its generation. Whatever was running is
     * superseded, so a stale frame from it can no longer land.
     */
    fun open(): Long = synchronized(lock) {
        generation += 1
        open = true
        consumed = false
        generation
    }

    /** End the current run. Idempotent; results offered afterwards are late. */
    fun close() = synchronized(lock) {
        open = false
    }

    /** Whether a run is accepting results right now. */
    val isOpen: Boolean get() = synchronized(lock) { open && !consumed }

    /**
     * Whether [generation] is still the run the user is looking at.
     *
     * Asked AGAIN at delivery, on the main thread, after [offer] has already
     * accepted a result. Consuming a run authorises one result; it does not
     * authorise delivering it at some later moment. Between the decode on the
     * camera executor and the callback reaching the UI there is a real gap, and
     * a dismissal that lands inside it has to win — otherwise a code prefills
     * into whatever the user opened after closing the scanner.
     *
     * Deliberately does not consult `consumed`: the run that produced this
     * result is exactly the run that spent itself producing it.
     */
    fun isCurrent(generation: Long): Boolean = synchronized(lock) {
        open && generation == this.generation
    }

    /**
     * Offer one decoded payload, and get back the ONE result this run will
     * produce — or null.
     *
     * Null covers every uninteresting case together, and deliberately: a
     * payload that is not a Relayium pairing link, a duplicate of one already
     * accepted, a frame from a superseded run, and a frame that arrived after
     * the sheet closed are all "nothing happens on screen".
     *
     * The payload is never returned, stored or logged — only the code it
     * yielded, and only through [ScanPolicy], which is the same policy an
     * OS-delivered link crosses. It cannot join: the return type has no case
     * that could.
     */
    fun offer(generation: Long, payload: String, trustedOrigin: String): IngressRequest.PrefillCode? {
        synchronized(lock) {
            if (!open || consumed || generation != this.generation) return null
        }
        // Decided OUTSIDE the lock: policy work must not hold a lock the main
        // thread takes to close the sheet.
        val request = ScanPolicy.result(payload, trustedOrigin) ?: return null
        synchronized(lock) {
            // Re-checked, because the sheet can close while the policy runs.
            // This is the window where a scan and a dismissal race, and the
            // dismissal has to win — the user has already looked away.
            if (!open || consumed || generation != this.generation) return null
            consumed = true
        }
        return request
    }
}
