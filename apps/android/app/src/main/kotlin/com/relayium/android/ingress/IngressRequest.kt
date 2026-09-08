package com.relayium.android.ingress

import com.relayium.android.cloud.StoredLink
import com.relayium.protocol.JoinInput
import com.relayium.protocol.PairCode

/**
 * What something OUTSIDE this app asked it to do — as a REQUEST, never as an
 * action already taken.
 *
 * Every entry point that is not the user typing into this app's own fields —
 * a tapped link, a pasted link, a scanned code, a share sheet — produces one of
 * these and nothing else. That is the whole point of the type: a link is an
 * invitation, and the device it landed on may not be the one the user meant,
 * so the app that receives it prefills a field and shows a screen. Joining,
 * downloading and sending stay taps.
 *
 * The names say so structurally. There is no `Join`, no `Download` and no
 * `Send` case, because a case with that name would eventually be given that
 * meaning: `PrefillCode` cannot be misread as "join this code", and a reviewer
 * looking for a connect on this path finds a vocabulary that cannot express
 * one. The existing behaviour this replaces did exactly that —
 * `MainActivity.joinFromIntent` calls `viewModel.join(url)` on any ACTION_VIEW,
 * which tears down whatever transfer is running with no confirmation.
 *
 * ## Why none of these is a `data class`
 *
 * A synthesised `toString` would print the payload, and the payloads here are
 * the two values this product must not spill: `PairCode.toString()` IS the
 * six digits, a stored link's fragment IS the decryption key, and shared text
 * is the user's message. These reach coroutine failure text, `IllegalState`
 * messages and test output — none of which is a place a key belongs. Each case
 * therefore names its kind and redacts its content, and callers that need the
 * value read the property deliberately.
 */
sealed interface IngressRequest {

    /** Which surface the request is about. Navigation is the shell's to make. */
    val surface: IngressSurface

    /**
     * Put this code in the join field, with the lane the link named if it named
     * one. **Does not join.**
     *
     * Prefilling is still a write that can destroy work — it overwrites the
     * code a live session is running on — which is why it goes through
     * [IngressCoordinator] rather than straight into a model.
     *
     * [modeHint] is carried rather than dropped because a link from a shipped
     * Apple client really does name a lane, and this app now speaks those
     * lanes: `TransferController.Wire.LEGACY_FILES` and `LEGACY_TEXT` are
     * distinct connections, one of which cannot carry what the other does. It
     * is a HINT and not authority — see [IngressTransferMode] — so a request
     * carrying one is otherwise identical to a request without.
     */
    class PrefillCode(
        val code: PairCode,
        val modeHint: IngressTransferMode? = null,
    ) : IngressRequest {
        override val surface get() = IngressSurface.JOIN
        override fun toString() = "IngressRequest.PrefillCode(code=<redacted>, mode=$modeHint)"
    }

    /**
     * Show the stored-transfer surface addressed by this link.
     *
     * Resolving it to its ENCRYPTED metadata is a reversible read that shows
     * the user what they opened; writing any plaintext to disk stays a tap.
     */
    class OpenStoredLink(val link: StoredLink) : IngressRequest {
        override val surface get() = IngressSurface.STORED
        override fun toString() = "IngressRequest.OpenStoredLink(link=<redacted>)"
    }

    /**
     * A `/cross-network` link with no code: show the join surface, write
     * nothing.
     *
     * It is deliberately its own case rather than `PrefillCode(null)`. It
     * cannot destroy anything — clearing a code the user has already typed is
     * the one thing it must not do — so [IngressCoordinator] never gates it,
     * and a `null` code would have put that reasoning at every call site.
     */
    data object ShowJoinSurface : IngressRequest {
        override val surface get() = IngressSurface.JOIN
    }

    /**
     * Text another app shared into this one, held for a destination the user
     * has not chosen yet.
     */
    class StageText(val text: String) : IngressRequest {
        override val surface get() = IngressSurface.SHARE
        override fun toString() = "IngressRequest.StageText(chars=${text.length})"
    }

    /**
     * Content another app shared into this one, as permission-bearing
     * references. Nothing has been opened, copied or read at this point.
     */
    class StageFiles(val share: AdmittedShare) : IngressRequest {
        override val surface get() = IngressSurface.SHARE
        override fun toString() = "IngressRequest.StageFiles(items=${share.items.size})"
    }
}

/**
 * Which lane a link said it was for, when it said so.
 *
 * **A hint, never authority.** What a session actually speaks is decided on
 * the wire: `LegacyLane.mode` picks the lane from what the peer ANNOUNCED and
 * from whether a batch is already armed, and a `link/1` session carries both
 * lanes regardless. A link is written by whoever wrote it, so a value here can
 * be wrong, stale, or chosen by an attacker — it may select a control the user
 * can immediately change, and it may arm the surface a shared file needs. It
 * may not decide what this device announces or accepts.
 *
 * **Nothing consumes it yet, and that is recorded rather than hidden.** As of
 * the accepted session work, a legacy lane is negotiated: `LegacyLane.mode`
 * reads the peer's announcement and whether a batch is armed, and no surface
 * takes a lane from a link. So the honest status of this field today is
 * "validated and carried, not yet presented" — the integration that adds a
 * presentation for it decides what to do with it, and until then it must not
 * be wired into anything that selects a transport. Carrying it costs one
 * nullable field and keeps the information the link actually contained;
 * dropping it now would mean re-deriving the parse later, at the point where
 * the parser is hardest to test.
 *
 * Kept in this module's own vocabulary rather than as
 * `TransferController.Wire` or `LegacyProtocol.Lane`: those belong to the
 * session layer, and a parser that imported them could not be tested without
 * it. The wiring maps two values.
 */
enum class IngressTransferMode { FILE, TEXT }

/**
 * The screen a request is about.
 *
 * Deliberately NOT the app's own navigation type: the shell owns its
 * destinations, this module owns the policy, and a module that named the
 * shell's enum could not be tested without it. The wiring maps three values.
 */
enum class IngressSurface { JOIN, STORED, SHARE }

/**
 * Why an incoming request was refused, as a stable identity rather than text.
 *
 * Enum, not a message, for the reason [com.relayium.android.TransferController]
 * publishes an `errorKey`: this module has no resources — it cannot be
 * localised, and copy assembled here would be English in a Chinese UI. It also
 * cannot accidentally quote the input, which is how a rejected link's key ends
 * up in a toast.
 *
 * Several values mirror [JoinInput.Result.Reason] one-for-one so the join
 * surface can keep showing the copy it already has for a pasted link;
 * [fromJoinInput] is the single mapping.
 */
enum class IngressRefusal {
    /** Nothing to read: no data, no text, no items. */
    EMPTY,
    /** Not a URL this app can parse at all, or longer than any real link. */
    MALFORMED_LINK,
    /** `https://user:pass@relayium.com/…` — right host, credential-bearing. */
    CREDENTIALS_IN_LINK,
    /** A link on a host this app does not act on. */
    FOREIGN_ORIGIN,
    /** The right host, a route this app has no entry point for. */
    UNSUPPORTED_PATH,
    /** A join link whose fragment is not a code. */
    NO_CODE_IN_LINK,
    /** Six ASCII digits, or it is not a pairing code. */
    CODE_NOT_SIX_DIGITS,
    /** A `/d/` link whose id, key or shape does not hold up. */
    STORED_LINK_INVALID,
    /** A share that carried nothing this app can read. */
    NOTHING_SHAREABLE,
    /** The intent's own extras could not be read — see `IngressIntents`. */
    MALFORMED_INTENT,
    /**
     * More entries than one transfer can carry.
     *
     * Counted on what the sender NAMED, not on what survived admission: an
     * entry this app refused still had to be looked at, and a share whose
     * entries were only partly examined is not one it can honestly send part
     * of.
     */
    TOO_MANY_ITEMS,
    /** Shared text past the one-message ceiling. */
    TEXT_TOO_LONG;

    companion object {
        /** The pasted-input parser's refusals, in this module's vocabulary. */
        fun fromJoinInput(reason: JoinInput.Result.Reason): IngressRefusal = when (reason) {
            JoinInput.Result.Reason.EMPTY -> EMPTY
            JoinInput.Result.Reason.NOT_SIX_DIGITS -> CODE_NOT_SIX_DIGITS
            JoinInput.Result.Reason.FOREIGN_ORIGIN -> FOREIGN_ORIGIN
            // A `#k=` fragment on the JOIN route. It is not a stored link this
            // app could open — a stored link lives at `/d/<id>` — so it is a
            // malformed join link rather than "a surface we do not implement",
            // which is what that reason means to the pasted-input parser.
            JoinInput.Result.Reason.STORED_LINK -> NO_CODE_IN_LINK
            JoinInput.Result.Reason.NO_CODE_IN_LINK -> NO_CODE_IN_LINK
        }
    }
}

/** A parsed entry point: something to ask for, or a reason it was refused. */
sealed interface IngressOutcome {
    class Accepted(val request: IngressRequest) : IngressOutcome {
        override fun toString() = "IngressOutcome.Accepted($request)"
    }

    class Refused(val reason: IngressRefusal) : IngressOutcome {
        override fun toString() = "IngressOutcome.Refused($reason)"
    }
}
