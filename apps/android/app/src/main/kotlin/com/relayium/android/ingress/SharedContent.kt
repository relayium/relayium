package com.relayium.android.ingress

import com.relayium.protocol.ManifestCodec
import com.relayium.protocol.TextWire

/**
 * One URI another app handed over, reduced to the facts a policy can judge.
 *
 * ## Why this is not `android.net.Uri`
 *
 * Two reasons, and the second is the one that matters. The first is testing:
 * `Uri` is a framework class, host unit tests run against stubs, and a policy
 * that needed a real one could only be exercised on an emulator — which is
 * exactly where a hostile-intent case is most expensive to write and least
 * likely to be written. The second is that the policy has no business with the
 * target at all: what it decides is answered by the scheme, the authority and
 * whether two entries are the same entry.
 *
 * [key] is the URI in its exact original string form and exists ONLY as
 * identity — for the duplicate check, and as the lookup the Android adapter
 * uses to reach the `Uri` object it kept. It is never re-parsed back into a
 * `Uri` (a round trip through a second parser is a place for two spellings of
 * one address to become two addresses), never written to a `Bundle`, never
 * persisted, and never printed: a content URI can carry a document id that is
 * a filesystem path, and [toString] is what ends up in a crash report.
 */
class IncomingUri(
    val key: String,
    val scheme: String?,
    /** `Uri.getAuthority()` — percent-escapes resolved. */
    val authority: String?,
    /** `Uri.getEncodedAuthority()` — exactly as the sender wrote it. */
    val encodedAuthority: String?,
) {

    override fun equals(other: Any?): Boolean = other is IncomingUri && other.key == key

    override fun hashCode(): Int = key.hashCode()

    /**
     * Says nothing about the URI at all.
     *
     * Every field here is a string an attacker chose and can make any length:
     * an authority can carry a payload, and a scheme is only a scheme once
     * something has checked it. This value reaches exception text and crash
     * reports, so there is no version of "a little context for debugging" that
     * is worth a place a sender can write into a log. What went wrong is
     * carried by [ShareItemRefusal] and [ShareUnavailable], which are closed
     * sets this module wrote.
     */
    override fun toString(): String = "IncomingUri(<redacted>)"
}

/** Why one item of a share was dropped while others were kept. */
enum class ShareItemRefusal {
    /** The intent carried no read grant, so nothing in it can be opened. */
    NO_READ_GRANT,
    /** Not a `content://` URI — see [ShareAdmission]. */
    UNSUPPORTED_SCHEME,
    /** No authority at all: there is no provider to ask. */
    NO_AUTHORITY,
    /** A `user@authority` form this app does not send and will not resolve. */
    USER_QUALIFIED_AUTHORITY,
    /** A URI naming this app's OWN providers. */
    OWN_PROVIDER,
    /** The same URI listed more than once. */
    DUPLICATE,
}

/**
 * A share that survived admission: the references, and an honest count of what
 * did not.
 *
 * Nothing has been opened, read, copied or measured at this point. That is the
 * product rule stated as a type — an intent arriving is not consent to touch
 * the data behind it, and a hostile app that fires a thousand share intents
 * must not be able to make this app read a thousand files.
 *
 * [skipped] carries COUNTS BY REASON and no identities, because the honest UI
 * sentence is "3 items could not be read" and printing the names of the files
 * an attacker put in a share is the same disclosure as printing the URIs.
 */
class AdmittedShare internal constructor(
    val items: List<IncomingUri>,
    val skipped: Map<ShareItemRefusal, Int>,
) {
    override fun toString(): String = "AdmittedShare(items=${items.size}, skipped=$skipped)"
}

/**
 * Which of the shared items this app will keep a reference to.
 *
 * The rules are all refusals, and each one closes a way an intent from another
 * app could make this one act against its user:
 *
 *  - **A read grant is required.** `ACTION_SEND` from a well-behaved app sets
 *    `FLAG_GRANT_READ_URI_PERMISSION`, and that flag is the whole mechanism by
 *    which this app is allowed to read the sender's document. Without it, the
 *    only URIs that would still open are providers left readable to everyone —
 *    so accepting a grant-less share would mean the app's access came from a
 *    provider's misconfiguration rather than from the user's choice. The flag
 *    is necessary and NOT sufficient: nothing here proves the grant is live,
 *    which only opening can, and [StagedShare] is where that happens.
 *  - **`content://` only.** A `file://` URI carries no grant and no owner: it
 *    is a path, evaluated with THIS app's identity, so a sender can name any
 *    file this app can read — including its own `/data/data` — and have it
 *    sent somewhere. Android has refused to let apps emit `file://` across an
 *    intent since API 24 for this reason; refusing to consume one is the same
 *    rule from the receiving side. `android.resource://`, `http(s)://` and
 *    everything else are refused because they are not a document the sender
 *    granted, whatever else they might be.
 *  - **No `user@authority` form.** A content authority may be written
 *    `content://10@com.example.provider/…`. `ContentProvider.validateIncomingAuthority`
 *    resolves it through `getAuthorityWithoutUserId`, which strips everything
 *    up to and including the LAST `@` before the provider is looked up, and a
 *    URI qualified with the CURRENT user passes validation. So the string a
 *    naive comparison reads and the string the framework routes on are
 *    different strings: `0@…own.provider` is not equal to `…own.provider`, and
 *    resolves to exactly `…own.provider`.
 *
 *    Every such URI is refused outright rather than normalised. This app never
 *    emits one; reading another user's providers needs permissions it does not
 *    hold and could not use; and a normaliser here would be a second parser
 *    whose disagreement with the framework's is the whole bug again. Refusing
 *    on ANY `@` is strictly stronger than the last-`@` rule it defends
 *    against, and both the decoded and the raw spelling are checked, so a
 *    `%40` escape cannot make one of them look clean.
 *  - **An authority is required.** `content:///path` names no provider; there
 *    is nothing to ask and nothing to grant.
 *  - **Not this app's own providers.** A URI naming an authority this app owns
 *    is resolved under this app's own uid, where a grant is not consulted at
 *    all. That is the confused deputy in its exact form: a stranger's intent
 *    naming this app's private storage, opened with this app's rights, staged
 *    for upload to the stranger's link. The authorities compared are the ones
 *    the app DECLARES, read from the package manager by the adapter, rather
 *    than a guess that every authority of this app's begins with its package
 *    name — a declared authority is a fact, and the convention is a habit.
 *  - **Deduplicated**, first occurrence winning, because `ClipData` and
 *    `EXTRA_STREAM` describe the same items on many senders and sending a file
 *    twice is a bug the user pays for in bytes.
 *  - **Bounded** by the count a manifest can carry, refusing the whole share
 *    rather than truncating it. Silently sending 1000 of 1500 files is the
 *    failure that is discovered after the transfer, by the person who needed
 *    the other 500.
 */
object ShareAdmission {

    /**
     * One share cannot exceed one batch. [ManifestCodec.MAX_FILES] is the wire
     * limit every peer already enforces, so a larger share could not be sent
     * even if it were staged.
     */
    const val MAX_ITEMS = ManifestCodec.MAX_FILES

    /** The only scheme a granted document arrives on. */
    private const val CONTENT_SCHEME = "content"

    /**
     * @param uris the URIs the intent named, in the order it named them.
     * @param readGranted whether the intent carried a read-URI grant.
     * @param ownAuthorities the authorities this app answers to, lowercased:
     *   every `<provider>` the package declares, plus the package name itself
     *   as a namespace guard. Supplied by the caller — see
     *   `IngressIntents.ownAuthorities` — rather than hard-coded, because the
     *   debug build's id is `…android.debug` with its own authorities, and a
     *   constant here would stop refusing in exactly the build the acceptance
     *   harness runs.
     */
    fun admit(
        uris: List<IncomingUri>,
        readGranted: Boolean,
        ownAuthorities: Set<String>,
    ): IngressOutcome {
        if (uris.isEmpty()) return IngressOutcome.Refused(IngressRefusal.EMPTY)
        // Counted BEFORE any per-item work, on the raw list: a sender that
        // names a hundred thousand URIs must not get a hundred thousand string
        // comparisons out of this app first.
        if (uris.size > MAX_ITEMS) return IngressOutcome.Refused(IngressRefusal.TOO_MANY_ITEMS)

        val kept = ArrayList<IncomingUri>(uris.size)
        val seen = HashSet<String>(uris.size)
        val skipped = LinkedHashMap<ShareItemRefusal, Int>()
        fun drop(reason: ShareItemRefusal) {
            skipped[reason] = (skipped[reason] ?: 0) + 1
        }

        for (uri in uris) {
            val refusal = when {
                !readGranted -> ShareItemRefusal.NO_READ_GRANT
                !uri.scheme.equals(CONTENT_SCHEME, ignoreCase = true) ->
                    ShareItemRefusal.UNSUPPORTED_SCHEME
                uri.authority.isNullOrBlank() -> ShareItemRefusal.NO_AUTHORITY
                isUserQualified(uri) -> ShareItemRefusal.USER_QUALIFIED_AUTHORITY
                isOwn(uri, ownAuthorities) -> ShareItemRefusal.OWN_PROVIDER
                !seen.add(uri.key) -> ShareItemRefusal.DUPLICATE
                else -> null
            }
            if (refusal != null) drop(refusal) else kept.add(uri)
        }

        // Every item refused is not "a share with problems", it is a share this
        // app cannot honour — and saying so is more useful than staging an
        // empty list and letting the send button fail later.
        if (kept.isEmpty()) return IngressOutcome.Refused(IngressRefusal.NOTHING_SHAREABLE)
        return IngressOutcome.Accepted(IngressRequest.StageFiles(AdmittedShare(kept, skipped)))
    }

    /**
     * A `userId@authority`, in either spelling.
     *
     * Both are asked because the two are handled by different code in the
     * framework — the encoded form is what a `Uri` carries and the decoded form
     * is what most callers read — and this file deliberately does not have an
     * opinion about which one the resolver will route on. A `@` in either is
     * enough to refuse, so no opinion is needed.
     */
    private fun isUserQualified(uri: IncomingUri): Boolean =
        uri.authority?.contains('@') == true || uri.encodedAuthority?.contains('@') == true

    /**
     * This app's own provider, in either spelling and in any case.
     *
     * Two rules, and the second is a net under the first. The declared
     * authorities are the exact answer. The package-name namespace is a
     * superset guard for anything a future manifest adds and this set was not
     * rebuilt for: refusing `com.relayium.android.anything` costs nothing real
     * — an authority under this app's package name that this app does not own
     * would be another app squatting its namespace — while missing one is the
     * confused-deputy read. Matched on whole labels, so
     * `com.relayium.androidx.something` stays somebody else's.
     */
    private fun isOwn(uri: IncomingUri, owned: Set<String>): Boolean {
        for (candidate in listOfNotNull(uri.authority, uri.encodedAuthority)) {
            val value = candidate.lowercase()
            if (owned.any { value == it || value.startsWith("$it.") }) return true
        }
        return false
    }
}

/**
 * Text another app shared, and the two questions worth asking about it.
 *
 * **A link first.** Sharing a page from a browser is how a person moves a
 * pairing link between devices, and the browser shares it as TEXT. So a shared
 * string that is a Relayium link is treated as that link — through
 * [IngressLinkPolicy], the same fences an `ACTION_VIEW` crosses, with no
 * second parser and no relaxation. Anything the link policy does not accept —
 * including a link to another site, which is an ordinary thing to want to send
 * — falls through to being text.
 *
 * **Bounded by what a message can be.** [TextWire.MAX_BYTES] is the product
 * cap for one message, measured in UTF-8 bytes and not characters, so a
 * Chinese or emoji message is refused by the same rule that would refuse it at
 * the composer rather than after the user has been told it fit.
 */
object SharedTextPolicy {

    /** One message, in UTF-8 bytes. */
    const val MAX_TEXT_BYTES = TextWire.MAX_BYTES

    fun read(text: String, trustedOrigin: String): IngressOutcome {
        if (text.isBlank()) return IngressOutcome.Refused(IngressRefusal.EMPTY)
        // Only when it could be one. `read` is cheap, but the length test in
        // front of it means a megabyte of shared prose is not run through a URL
        // parser to learn what its first character already said.
        if (text.length <= IngressLinkPolicy.MAX_LINK_CHARS) {
            val asLink = IngressLinkPolicy.read(text, trustedOrigin)
            if (asLink is IngressOutcome.Accepted) return asLink
        }
        // A char is at least one UTF-8 byte, so this refuses the oversized
        // cases without encoding a copy of the whole string first.
        if (text.length > MAX_TEXT_BYTES) return IngressOutcome.Refused(IngressRefusal.TEXT_TOO_LONG)
        if (text.toByteArray(Charsets.UTF_8).size > MAX_TEXT_BYTES) {
            return IngressOutcome.Refused(IngressRefusal.TEXT_TOO_LONG)
        }
        return IngressOutcome.Accepted(IngressRequest.StageText(text))
    }
}
