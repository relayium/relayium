package com.relayium.android.account

/**
 * What this app will accept as a bearer token, checked BEFORE the value is
 * adopted, persisted or sent.
 *
 * ## Why a token needs validating at all
 *
 * It is attacker-influenced input. The app gets it from a response body — a
 * native login or a device-code poll — so "the server would never send that" is
 * an assumption about a value that arrives over the network, and this client
 * already refuses to assume things about that. The concrete failure it prevents
 * was reproduced rather than imagined: a token containing a newline is accepted
 * by a lenient reader, stored, and then thrown out of OkHttp as an
 * `IllegalArgumentException` when it is put into an `Authorization` header —
 * an uncaught exception raised by a remote value, on whatever dispatcher the
 * next request happened to run on, with the credential quoted in its message.
 *
 * Refusing at adoption keeps a value that can never work from ever reaching the
 * keystore, where it would fail on every launch until the user cleared the app's
 * data. [OkHttpAccountTransport] additionally classifies the throw, so the two
 * together are belt and braces: nothing gets in, and nothing crashes if it does.
 *
 * ## The rule
 *
 * Non-empty, bounded, and every character a printable, non-space ASCII one
 * (`0x21`–`0x7E`) — the subset of an HTTP field value with no framing
 * significance at all, so it needs no quoting and cannot introduce a header.
 * The server's own tokens are `rlm_cli_` followed by hex, comfortably inside it.
 */
object Bearer {

    /**
     * Generous against what the server mints (`"rlm_cli_"` + 64 hex characters)
     * and far below anything that could bloat a keystore blob or a header.
     */
    const val MAX_LENGTH: Int = 512

    fun isValid(token: String): Boolean {
        if (token.isEmpty() || token.length > MAX_LENGTH) return false
        return token.all { it.code in 0x21..0x7E }
    }
}
