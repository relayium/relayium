package com.relayium.protocol

/**
 * Reading what the user pasted into the one join field: a six-digit pairing
 * code, or a full join link that carries one.
 *
 * The pairing code and the SAS are BOTH six digits and are unrelated values
 * (`relayium-handshake-v1.md`). They are deliberately different types here —
 * [PairCode] against the plain `String` [Crypto.sas] returns — so a UI cannot
 * render one where it meant the other without the compiler noticing.
 */
@JvmInline
value class PairCode(val digits: String) {
    override fun toString() = digits
}

object JoinInput {

    /** Exactly six, per `signal.CodeLen`. */
    const val CODE_LENGTH = 6

    /** The production origin a join link must be on. */
    const val DEFAULT_ORIGIN = "https://relayium.com"

    /** The page a join link points at. */
    const val CROSS_PATH = "/cross-network"

    sealed interface Result {
        data class Code(val code: PairCode) : Result
        data class Rejected(val reason: Reason) : Result

        enum class Reason {
            EMPTY,
            /** Not six digits, or contains something that is not a digit. */
            NOT_SIX_DIGITS,
            /** A link on an origin this app will not join. */
            FOREIGN_ORIGIN,
            /** A stored-transfer link (`#k=`), which is a different product
             *  surface this client does not implement. */
            STORED_LINK,
            /** A link with no `#c=` fragment, or one whose code is malformed. */
            NO_CODE_IN_LINK,
        }
    }

    /**
     * Parse a pairing code out of raw user input.
     *
     * Accepts a bare code or a full join link, because the field is labelled for
     * both and a user who copied the whole link should not have to edit it.
     *
     * ## Leading zeros are significant
     *
     * `004291` and `000000` are valid codes and are NOT the integers 4291 and 0.
     * Nothing here ever converts to a number: parsing a code as an integer
     * destroys a tenth of the code space and produces a "code not found" that
     * looks like a server problem. The value stays six ASCII characters from
     * first keystroke to WebSocket query string.
     *
     * ## What is refused rather than tidied
     *
     * A stored-transfer link (`#k=`) is refused BY NAME rather than falling into
     * "no code here": it is a real Relayium link for a product surface this
     * client does not implement, and telling the user that is more useful than a
     * generic parse failure. A link on another origin is refused too — this app
     * does not join arbitrary hosts, and self-hosted server configuration is a
     * separately deferred decision, not something to infer from a pasted URL.
     */
    fun parse(raw: String, allowedOrigins: List<String> = listOf(DEFAULT_ORIGIN)): Result {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return Result.Rejected(Result.Reason.EMPTY)

        if (trimmed.contains("://")) return parseLink(trimmed, allowedOrigins)

        // A bare entry. Strip the separators a human might type between groups,
        // and nothing else: a letter is not a typo to discard, it is input this
        // format does not have, and silently dropping it would turn `4o291x` into
        // a plausible-looking five-digit failure.
        val compact = trimmed.filterNot { it == ' ' || it == '-' }
        return asCode(compact)
    }

    private fun parseLink(raw: String, allowedOrigins: List<String>): Result {
        val uri = try {
            java.net.URI(raw)
        } catch (_: java.net.URISyntaxException) {
            return Result.Rejected(Result.Reason.NO_CODE_IN_LINK)
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        if (scheme == null || host == null) return Result.Rejected(Result.Reason.NO_CODE_IN_LINK)
        val origin = buildString {
            append(scheme).append("://").append(host)
            if (uri.port != -1) append(':').append(uri.port)
        }
        val allowed = allowedOrigins.any { it.equals(origin, ignoreCase = true) }
        if (!allowed) return Result.Rejected(Result.Reason.FOREIGN_ORIGIN)

        val fragment = uri.rawFragment ?: return Result.Rejected(Result.Reason.NO_CODE_IN_LINK)
        // Checked BEFORE the `#c=` match, so a stored link gets its own honest
        // message rather than "no code in this link".
        if (fragment.startsWith("k=")) return Result.Rejected(Result.Reason.STORED_LINK)
        if (!fragment.startsWith("c=")) return Result.Rejected(Result.Reason.NO_CODE_IN_LINK)
        val candidate = fragment.substring(2)
        return when (val result = asCode(candidate)) {
            is Result.Code -> result
            is Result.Rejected -> Result.Rejected(Result.Reason.NO_CODE_IN_LINK)
        }
    }

    private fun asCode(value: String): Result {
        if (value.isEmpty()) return Result.Rejected(Result.Reason.EMPTY)
        if (value.length != CODE_LENGTH) return Result.Rejected(Result.Reason.NOT_SIX_DIGITS)
        // ASCII digits ONLY. `Char.isDigit()` is true for Arabic-Indic and other
        // decimal digits, which the server's alphabet does not accept and which
        // would produce a confusing server-side refusal instead of a local one.
        if (value.any { it !in '0'..'9' }) return Result.Rejected(Result.Reason.NOT_SIX_DIGITS)
        return Result.Code(PairCode(value))
    }

    /** The rendezvous socket for a code room. */
    fun webSocketUrl(origin: String, code: PairCode): String {
        val base = origin.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        return "$base/ws?code=${code.digits}"
    }

    /** The ICE credential endpoint. Anonymous; the code is the capability. */
    fun iceUrl(origin: String, code: PairCode): String = "$origin/api/ice?code=${code.digits}"
}
