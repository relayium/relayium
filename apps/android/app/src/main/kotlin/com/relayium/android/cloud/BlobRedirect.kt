package com.relayium.android.cloud

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Whether a stored-ciphertext download may follow a redirect, and to where.
 *
 * ## Why this exists instead of the account transport's rule
 *
 * [com.relayium.android.account.OkHttpAccountTransport] refuses every 3xx
 * outright, and is right to: its requests carry a BEARER, so following a
 * redirect would hand the credential to whatever host answered. Reusing that
 * refusal here would break real downloads. A blob request is answered by
 * `server/account/files.go`, and its fleet-direct branch **302s unconditionally
 * whenever the file is eligible** — the `X-Relayium-Direct-Download` header
 * gates only the BYO own-node case. A client that refused redirects would fail
 * every download of a file that happens to live on a fleet node.
 *
 * So the answer is a different policy, not a different threshold:
 *
 * * **The request is anonymous.** No bearer, no cookie, no key — the key never
 *   leaves this device, and the ciphertext needs no identity to fetch. There is
 *   therefore no credential a redirect could leak, which is what makes following
 *   one acceptable at all.
 * * **The target must be `https`**, unless the configured origin is ITSELF
 *   plaintext and the target is the same host — the local/dev case, where
 *   demanding TLS would mean the policy could never be executed against a real
 *   redirect. In a shipped build the origin is `https`, so every plaintext
 *   target is refused.
 * * **No userinfo.** `https://user:pass@node.example/…` is a shape no node ever
 *   sends and a credential-carrying URL this client will not construct.
 * * **No fragment.** The fragment is where a KEY lives in this product. A
 *   redirect target carrying one is refused rather than dropped, because a
 *   client that quietly strips it is a client that could one day forward it.
 * * **Bounded hops**, so a redirect loop is a refusal rather than a hang.
 *
 * A refusal is reported, never retried differently: the user is told the server
 * pointed somewhere this app would not follow, which is a truthful and
 * actionable statement.
 */
object BlobRedirect {

    /** Central → node is one hop. Three leaves room for a deployment that adds
     *  a rewrite without letting a loop run. */
    const val MAX_HOPS = 3

    sealed interface Verdict {
        data class Follow(val url: HttpUrl) : Verdict
        data class Refuse(val reason: Reason) : Verdict
    }

    enum class Reason { NO_LOCATION, UNPARSEABLE, INSECURE_SCHEME, USERINFO, FRAGMENT, TOO_MANY_HOPS }

    /**
     * @param current the URL that produced this redirect, for resolving a
     *   relative `Location`
     * @param origin this app's own configured backend, which decides whether a
     *   plaintext target is admissible at all
     * @param hop how many redirects have already been followed
     */
    fun next(current: HttpUrl, location: String?, origin: HttpUrl, hop: Int): Verdict {
        if (hop >= MAX_HOPS) return Verdict.Refuse(Reason.TOO_MANY_HOPS)
        val raw = location?.trim()
        if (raw.isNullOrEmpty()) return Verdict.Refuse(Reason.NO_LOCATION)
        // Resolved against the current URL, which is how a relative Location is
        // defined — and `resolve` returns null for a scheme OkHttp does not
        // speak, so `intent://`, `file://` and `content://` never reach the
        // checks below as something that could be followed.
        val target = current.resolve(raw) ?: return Verdict.Refuse(Reason.UNPARSEABLE)
        if (target.username.isNotEmpty() || target.password.isNotEmpty()) {
            return Verdict.Refuse(Reason.USERINFO)
        }
        if (target.fragment != null) return Verdict.Refuse(Reason.FRAGMENT)
        val secure = target.scheme == "https" ||
            (origin.scheme == "http" && target.scheme == "http" && target.host == origin.host)
        if (!secure) return Verdict.Refuse(Reason.INSECURE_SCHEME)
        return Verdict.Follow(target)
    }

    /** Convenience for callers holding origins as strings. */
    fun origin(text: String): HttpUrl? = text.toHttpUrlOrNull()
}
