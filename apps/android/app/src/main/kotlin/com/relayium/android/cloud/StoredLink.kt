package com.relayium.android.cloud

import com.relayium.protocol.stored.STORE_KEY_BYTES
import com.relayium.protocol.stored.STORE_KEY_TEXT_LENGTH
import com.relayium.protocol.stored.StoredWireException
import com.relayium.protocol.stored.decodeStoreKey
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The one rule for a stored-object identifier, whoever produced it.
 *
 * Three places compose an id into something where a stray character changes the
 * MEANING rather than the value: the `api/files/<id>/meta` and
 * `api/files/<id>/blob` paths, and the `origin/d/<id>#k=<key>` link the user is
 * shown as the address of what they just uploaded. All three need it to stay one
 * inert token, so separators, dot segments, query and fragment delimiters,
 * whitespace and non-ASCII are refused.
 *
 * **Refused, never sanitised, never percent-encoded.** Escaping would let two
 * distinct ids collapse onto one, and percent-encoding cannot help a `.` or `..`
 * that a server or proxy resolves for its own reasons. Refusing is the only
 * defence that does not depend on who normalises the path.
 *
 * Two populations arrive here and only one is trusted. An id the server minted
 * for this account's own upload is 32 hex characters, so the check is a tripwire
 * on a broken or substituted response. An id that arrives inside a link — from a
 * sender, a page, a chat message — was produced by whoever wrote the link, and
 * here the check is the defence.
 */
object StoredObjectId {

    private const val MAX_LENGTH = 128

    /** The id, or null if it is not one. */
    fun accepted(id: String): String? {
        if (id.isEmpty() || id.length > MAX_LENGTH) return null
        for (c in id) {
            val ok = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'
            if (!ok) return null
        }
        return id
    }
}

/**
 * A stored object and the key that opens it — VALIDATED, by construction.
 *
 * The constructor is private and [of] is the only way in, so an id that reached
 * here has already passed [StoredObjectId.accepted] and a key is already 32
 * bytes. That matters because the id is interpolated into request paths: a type
 * that could hold an unchecked id would put the check on every call site, and
 * the one that forgot would be the one that mattered.
 *
 * [toString] is overridden and the key is deliberately unreachable through it. A
 * `data class` would synthesise one that prints the key bytes, and this value
 * reaches UI state, coroutine failure text and test output — the key IS the
 * file, so the default would be a disclosure with no attacker required. The full
 * link is shown, copied and shared by explicit user action through
 * [buildDownloadLink]; that is the intended path and the only one.
 */
class StoredLink private constructor(val id: String, val key: ByteArray) {

    override fun toString(): String = "StoredLink(id=$id, key=<redacted>)"

    companion object {
        /** The object and its key, or null if either is not what it claims. */
        fun of(id: String, key: ByteArray): StoredLink? {
            val safe = StoredObjectId.accepted(id) ?: return null
            if (key.size != STORE_KEY_BYTES) return null
            return StoredLink(safe, key)
        }
    }
}

/** The `#k=` fragment, extracted and validated; null if it is not one. */
fun parseDownloadFragment(fragment: String?): String? {
    val raw = fragment?.removePrefix("#") ?: return null
    if (!raw.startsWith("k=")) return null
    val key = raw.removePrefix("k=")
    if (key.length != STORE_KEY_TEXT_LENGTH) return null
    for (c in key) {
        val ok = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'
        if (!ok) return null
    }
    return key
}

/**
 * The shareable address of an upload.
 *
 * [id] is interpolated verbatim, and this neither checks nor escapes it: the id
 * must be REFUSED before a link is built from it, not repaired on the way into a
 * string. Every caller passes one [StoredObjectId.accepted] has already taken.
 */
fun buildDownloadLink(origin: String, id: String, keyB64url: String): String =
    "$origin/d/$id#k=$keyB64url"

/**
 * Read a `…/d/<id>#k=<key>` link a recipient supplied.
 *
 * **Own origin only.** This app talks to exactly one Relayium (see
 * [com.relayium.android.Backend]), and a link naming a different host is not a
 * link it can open: the id would be fetched from the configured backend
 * regardless, so accepting a foreign origin would silently retarget someone
 * else's link at this server — and, worse, teach the user that a link from any
 * host works here. Refused with [CloudFailure.Kind.LINK_INVALID], which is the
 * same answer a malformed link gets, because to the reader they are the same
 * event: this is not a link this app can open.
 *
 * The key is decoded HERE, strictly, so a link that cannot possibly decrypt
 * fails before a request is made and before a key is held.
 */
fun parseStoredLink(raw: String, trustedOrigin: String): StoredLink? {
    // Bounded BEFORE parsing. This string arrives from a clipboard, a share
    // intent or a text field, and a real stored link is an origin plus about
    // 180 characters; anything near this ceiling is not one, and refusing by
    // length costs a comparison rather than a parse of arbitrary input.
    if (raw.length > MAX_LINK_LENGTH) return null
    val trusted = trustedOrigin.toHttpUrlOrNull() ?: return null
    val url = raw.trim().toHttpUrlOrNull() ?: return null
    // Userinfo in the link itself, refused for the same reason a redirect
    // carrying it is: `https://user:pass@relayium.com/d/x` matches the trusted
    // host and is still a credential-bearing URL this app will not act on.
    if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
    if (!sameOrigin(url, trusted)) return null
    // Exactly `/d/<id>`: two segments and nothing else. `pathSegments` on
    // `/d/x/` yields ["d","x",""], so a trailing slash is a different path and
    // is refused rather than trimmed.
    val segments = url.pathSegments
    if (segments.size != 2 || segments[0] != "d") return null
    val id = StoredObjectId.accepted(segments[1]) ?: return null
    if (url.querySize != 0) return null
    val encoded = parseDownloadFragment(url.fragment) ?: return null
    val key = try {
        decodeStoreKey(encoded)
    } catch (_: StoredWireException) {
        return null
    }
    return StoredLink.of(id, key)
}

/** Generous for any real link, bounded against pasted rubbish. */
private const val MAX_LINK_LENGTH = 2048

/** Scheme, host and port — the whole origin, never a prefix match. */
private fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean =
    a.scheme == b.scheme && a.host == b.host && a.port == b.port
