package com.relayium.android.account

/**
 * Where this device keeps the one bearer it holds.
 *
 * **Every method reports failure by throwing.** That is the whole point of the
 * interface: a store that swallowed a failed write would let the app claim a
 * persistent sign-in it does not have, and a store that swallowed a failed
 * `clear` would let it claim a revocation it did not perform. Both are lies the
 * user cannot detect and cannot act on, so neither is available here.
 *
 * The only thing stored is the bearer. Never the password, never the
 * pending-deletion reactivation token, never a session snapshot.
 */
interface TokenStore {

    /** Persist [token], replacing whatever was there. Throws
     *  [TokenStoreException] if the credential is NOT durably stored. */
    fun save(token: String)

    /**
     * The stored bearer, or null when there is none.
     *
     * Null means **there is nothing here**. It never means "there is something
     * here that could not be read": an unreadable blob throws, because the two
     * are different facts and the honest recoveries differ. Signing the user
     * out on an unreadable store would silently discard a live credential
     * during a transient failure; treating it as absent would then let the next
     * sign-in write over it as if nothing had been there.
     */
    fun load(): String?

    /** Remove the stored bearer. Throws unless nothing is left behind. */
    fun clear()
}

/** A store operation that did not do what it was asked. The message names the
 *  operation and the reason and NEVER the value: a token in an exception
 *  message travels into every log and crash report that catches it. */
class TokenStoreException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

/** Process-lifetime only. The seam every state-machine test uses, and the
 *  honest fallback for a device whose keystore this app cannot use. */
class InMemoryTokenStore(initial: String? = null) : TokenStore {
    private var token: String? = initial
    override fun save(token: String) { this.token = token }
    override fun load(): String? = token
    override fun clear() { token = null }
}
