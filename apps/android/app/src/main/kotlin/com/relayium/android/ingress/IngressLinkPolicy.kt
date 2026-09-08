package com.relayium.android.ingress

import com.relayium.android.cloud.parseStoredLink
import com.relayium.protocol.JoinInput
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The one rule for a link this app did not produce.
 *
 * A link that arrives from OUTSIDE — an `ACTION_VIEW` from the browser, a
 * share sheet, a QR code on a poster — is a trust boundary, and it is a wider
 * one than the join field. The field is a person typing into this app; an
 * intent is any installed app, and a printed QR is anybody who can print.
 *
 * ## It adds fences, it does not replace parsers
 *
 * The two existing parsers stay authoritative for what they already own, and
 * this file deliberately re-derives neither:
 *
 *  - [JoinInput.parse] owns the pairing code — six ASCII digits, leading zeros
 *    significant, no integer round trip — and the allowed origin for a join
 *    link. A second code reader here would be the rule that drifts.
 *  - [parseStoredLink] owns `/d/<id>#k=<key>` — exact two-segment path, no
 *    query, no userinfo, strict id alphabet and a key that must decode before
 *    a request is made or a key is held.
 *
 * What this adds is what neither can know: that the string arrived from
 * another app, so the ROUTE must be one of exactly two, spelled exactly, and
 * carrying no credentials.
 *
 * ### Why the route check is not redundant
 *
 * `AndroidManifest.xml` filters `/cross-network` with `android:pathPrefix`,
 * which matches `/cross-network-evil` and `/cross-networkX` as well, and
 * [JoinInput.parse] does not look at the path at all: it reads the origin and
 * the `#c=` fragment. So on the pasted path those two facts never meet, and on
 * this path they do — `https://relayium.com/cross-networkX#c=123456` is
 * delivered by the OS and would otherwise be accepted as an ordinary join
 * link. It is refused here, before anything acts on it.
 *
 * ### Two parsers, one direction of disagreement
 *
 * The join branch requires BOTH okhttp (structure) and [JoinInput] (origin and
 * code) to accept the same string. They are different parsers and will not
 * agree on every hostile input — but because acceptance needs both, a
 * disagreement can only REFUSE a link, never widen what is accepted. That
 * ordering is the reason the structural pass is not simply trusted.
 *
 * ## Not a second origin policy
 *
 * [trustedOrigin] is supplied by the caller — [com.relayium.android.Backend]
 * resolves it once per process — rather than read from a constant here. A
 * fixed `relayium.com` in this file would be a second origin list to drift
 * from the one the app actually talks to, and would refuse every link the
 * acceptance harness produces against its local server.
 */
object IngressLinkPolicy {

    /**
     * Bounded BEFORE parsing, for the reason [parseStoredLink] states: a real
     * link is an origin plus about 180 characters, and refusing by length
     * costs one comparison instead of a parse of arbitrary input. The value
     * matches that parser's own internal ceiling; it is restated rather than
     * shared because that one is private, and a link this side accepted and
     * that side refused would be a confusing dead end.
     */
    const val MAX_LINK_CHARS = 2048

    /** The join route, spelled exactly. */
    private const val JOIN_SEGMENT = "cross-network"

    /** The stored-transfer route's first segment. */
    private const val STORED_SEGMENT = "d"

    /**
     * The one query parameter a first-party link carries, and the two values it
     * can have.
     *
     * iOS builds pairing links through `pairingJoinURL(baseURL:code:mode:)` and
     * `DirectView` passes a mode, so an iOS-generated QR or copied link really
     * does read `…/cross-network?mode=file#c=123456`. The web emits no query at
     * all (`CodePairing.svelte` builds `origin + CROSS_PATH + "#c=" + code`).
     *
     * It is READ, and it is not authority — see [IngressTransferMode]. This app
     * now speaks the shipped Apple file and message generations as separate
     * connections, so which one a link names is real information about what the
     * sender is offering, and dropping it here would throw away the only thing
     * the link says beyond the code.
     */
    private const val MODE_PARAM = "mode"
    private const val MODE_FILE = "file"
    private const val MODE_TEXT = "text"

    /**
     * Read a link that arrived from outside.
     *
     * Refusals are ordered so the reason is the most specific true one: a
     * credential-bearing link on the right host says so rather than reporting a
     * bad route, because those are different mistakes and only one of them is
     * an attack.
     */
    fun read(raw: String, trustedOrigin: String): IngressOutcome {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return IngressOutcome.Refused(IngressRefusal.EMPTY)
        if (trimmed.length > MAX_LINK_CHARS) {
            return IngressOutcome.Refused(IngressRefusal.MALFORMED_LINK)
        }
        val trusted = trustedOrigin.toHttpUrlOrNull()
            ?: return IngressOutcome.Refused(IngressRefusal.FOREIGN_ORIGIN)
        val url = trimmed.toHttpUrlOrNull()
            ?: return IngressOutcome.Refused(IngressRefusal.MALFORMED_LINK)

        // Before the origin check, because a credential-bearing URL on the
        // TRUSTED host is the interesting case: it passes every host
        // comparison and is still a URL this app will not act on.
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) {
            return IngressOutcome.Refused(IngressRefusal.CREDENTIALS_IN_LINK)
        }
        if (!sameOrigin(url, trusted)) {
            return IngressOutcome.Refused(IngressRefusal.FOREIGN_ORIGIN)
        }

        val segments = url.pathSegments
        return when {
            segments.size == 2 && segments[0] == STORED_SEGMENT -> readStored(trimmed, trustedOrigin)
            segments.size == 1 && segments[0] == JOIN_SEGMENT -> readJoin(trimmed, url, trustedOrigin)
            else -> IngressOutcome.Refused(IngressRefusal.UNSUPPORTED_PATH)
        }
    }

    /**
     * The stored parser decides, and it re-reads the whole string.
     *
     * Handing it the raw link rather than the pieces already parsed here keeps
     * it the single authority on its own route: it checks the origin, the
     * userinfo, the two path segments, the absence of a query and the key,
     * and none of those becomes this file's opinion.
     */
    private fun readStored(trimmed: String, trustedOrigin: String): IngressOutcome {
        val link = parseStoredLink(trimmed, trustedOrigin)
            ?: return IngressOutcome.Refused(IngressRefusal.STORED_LINK_INVALID)
        return IngressOutcome.Accepted(IngressRequest.OpenStoredLink(link))
    }

    private fun readJoin(trimmed: String, url: HttpUrl, trustedOrigin: String): IngressOutcome {
        // No fragment at all is a request to LOOK at the join surface. It is
        // valid and it writes nothing — see [IngressRequest.ShowJoinSurface].
        val fragment = url.fragment
        if (fragment.isNullOrEmpty()) return IngressOutcome.Accepted(IngressRequest.ShowJoinSurface)

        return when (val parsed = JoinInput.parse(trimmed, listOf(trustedOrigin))) {
            is JoinInput.Result.Code ->
                IngressOutcome.Accepted(IngressRequest.PrefillCode(parsed.code, modeHint(url)))
            is JoinInput.Result.Rejected ->
                IngressOutcome.Refused(IngressRefusal.fromJoinInput(parsed.reason))
        }
    }

    /**
     * The lane a link named, or null when it did not name one this app knows.
     *
     * **The unreadable cases drop the HINT and keep the CODE**, which is what
     * `parseAppDeepLink` does with the same inputs: it reads `mode` only when
     * exactly one is present with a known value, and otherwise returns the
     * plain `.realtime(code:)` arm rather than refusing the URL. Matching it is
     * a deliberate parity decision rather than leniency:
     *
     *  - the code is what the link is FOR, and refusing a working code because
     *    a hint was misspelled, duplicated, or accompanied by a tracking
     *    parameter somebody's messenger appended would break links that work on
     *    every other client;
     *  - the hint decides nothing on its own. `LegacyLane.mode` picks the lane
     *    from the peer's announcement and from whether a batch is armed, so a
     *    dropped or hostile hint costs at most a preselected control the user
     *    can change, while an accepted-but-wrong one cannot make this device
     *    speak a generation the peer did not offer.
     *
     * Ambiguity is resolved by dropping, never by picking: `?mode=file&mode=text`
     * yields null rather than a first-one-wins guess about which of two
     * conflicting statements the sender meant.
     */
    private fun modeHint(url: HttpUrl): IngressTransferMode? {
        val values = url.queryParameterValues(MODE_PARAM)
        if (values.size != 1) return null
        return when (values[0]) {
            MODE_FILE -> IngressTransferMode.FILE
            MODE_TEXT -> IngressTransferMode.TEXT
            else -> null
        }
    }

    /**
     * Scheme, host and port — the whole origin, never a prefix match.
     *
     * `HttpUrl` fills in the default port, so `https://relayium.com` and
     * `https://relayium.com:443` are the one origin they actually are here.
     * [JoinInput.parse] builds an origin STRING and compares it, so it treats
     * an explicit `:443` as a different origin and refuses it — the join
     * branch needs both to accept, so the stricter answer wins there. No
     * first-party producer writes the port, and refusing a link nobody emits
     * is not a compatibility cost worth widening a trust boundary for.
     */
    private fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean =
        a.scheme == b.scheme && a.host == b.host && a.port == b.port
}
