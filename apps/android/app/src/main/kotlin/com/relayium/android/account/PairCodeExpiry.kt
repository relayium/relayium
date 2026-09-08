package com.relayium.android.account

/**
 * What a minted pairing code's deadline means ON SCREEN.
 *
 * A type rather than a line in a composable, because the interesting part is not
 * the formatting — it is the ANSWER about usability that the surface must obey.
 * A code carries a real expiry: `/api/pair` returns `expiresAt` and the server
 * refuses the code from that second onward. Rendered as one static sentence
 * ("expires at 14:05") it is true and useless for what a person is actually
 * doing with it, which is reading six digits to somebody on the phone: there is
 * no way to tell from the screen whether the digits still being dictated are
 * worth anything. The failure is silent on both ends — this phone keeps drawing
 * them, the other device is told the code is invalid — and the only visible
 * symptom is a correct code being typed twice.
 *
 * The boundary is `<=`, deliberately: a code whose `expiresAt` is the current
 * second is already refused by the server, so a countdown reading `0:01` beside
 * it would be offering something that cannot work. [Presentation.usable] and a
 * countdown of nothing arrive in the same instant.
 */
object PairCodeExpiry {

    data class Presentation(
        /** Whole seconds left; zero exactly when the code has expired. */
        val remainingSeconds: Long,
        /**
         * Whether the code can still be used by anybody. The surface reads THIS
         * rather than recomputing `remaining > 0`, so the countdown, the share
         * controls and the expired notice cannot disagree about one instant.
         */
        val usable: Boolean,
        /** `4:32` while it is usable, and null once it is not: there is no
         *  countdown to a moment that has passed, and `0:00` beside "expired"
         *  says the same thing twice in two registers. */
        val countdown: String?,
    )

    /**
     * @param expiresAt the epoch second the MINT returned. Never a locally
     *   invented deadline: the server owns when a code dies, and a client
     *   running its own timer from a guessed lifetime would disagree with it
     *   about which code is still alive. This does not make the reading
     *   clock-independent — the comparison still uses this device's [now] — it
     *   only makes both sides talk about the same instant.
     * @param now this device's epoch second.
     */
    fun presentation(expiresAt: Long, now: Long): Presentation {
        // A mint that answered no deadline at all. Usable and uncounted rather
        // than expired: refusing a code over a missing field would break a
        // working transfer, and the server still refuses it at the real moment.
        if (expiresAt <= 0L) return Presentation(0L, usable = true, countdown = null)
        val left = expiresAt - now
        if (left <= 0L) return Presentation(0L, usable = false, countdown = null)
        return Presentation(left, usable = true, countdown = clock(left))
    }

    /** `m:ss`, or `h:mm:ss` when it is long enough to need it. Digits and
     *  separators only — it is a clock reading placed inside localised copy by
     *  the caller, not prose of its own. */
    private fun clock(seconds: Long): String {
        val hours = seconds / 3_600
        val minutes = (seconds % 3_600) / 60
        val secs = seconds % 60
        return if (hours > 0) {
            String.format(java.util.Locale.US, "%d:%02d:%02d", hours, minutes, secs)
        } else {
            String.format(java.util.Locale.US, "%d:%02d", minutes, secs)
        }
    }
}
