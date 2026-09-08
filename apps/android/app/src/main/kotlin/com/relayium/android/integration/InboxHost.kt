package com.relayium.android.integration

import com.relayium.android.inbox.InboxAccountId
import com.relayium.android.inbox.InboxRuntime
import com.relayium.android.inbox.InboxWireException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * The Device Inbox's place in the app: ONE runtime for the life of the process,
 * adopted into each account in turn, live for exactly as long as the app is in
 * front of the user.
 *
 * ## One runtime, adopted — never replaced
 *
 * The per-account object is `InboxServices`: an immutable bundle of stores and
 * transports built from one account and one bearer. `InboxRuntime.adopt` swaps
 * that bundle behind a serialised gate that cancels and JOINS everything the
 * previous account owned before the new authority exists.
 *
 * Building a second runtime on an account change would throw that away. The old
 * one would still be holding a receive loop, an in-flight upload carrying the
 * previous bearer, and a half-finished durable write — with nothing left
 * pointing at it to cancel or join. The failure is not theoretical: the account
 * that "signed out" would go on claiming deliveries, and the writes it was
 * inside would land under an identity the user had already left.
 *
 * So this class holds one [InboxReceiving] and calls [InboxReceiving.adopt] on
 * it. There is deliberately no code path here that constructs a runtime.
 *
 * ## Every credential generation is an adoption, including a re-login
 *
 * A sign-out and a sign-in as the SAME account is a new session with a new
 * bearer. Comparing account ids alone would skip the adoption, and the first
 * account's cancelled-but-unjoined work would then be reachable from the second
 * session. [Credential] therefore carries the generation, and any change in the
 * whole value is an adoption — the same three-part fence `AccountSession` uses
 * for its own authority.
 *
 * ## The newest credential cancels the adoption it supersedes
 *
 * A plain sequential collector is not enough, and getting this wrong is a real
 * bug rather than a theoretical one. `adopt` SUSPENDS in the middle — it cancels
 * and joins everything the previous account owned — so a collector that awaited
 * it before reading the next value would hold account B behind account A's
 * teardown, and when A's adoption finally returned it would install and publish
 * a session the user had already left. The surface would show A's Inbox, and
 * A's receive loop would be started, after B signed in.
 *
 * So the orchestration is latest-cancelling: a new credential cancels the
 * adoption in flight for the old one. That is safe precisely because the runtime
 * was designed for it — `InboxModel.adopt` releases ownership when a job
 * COMPLETES rather than when an adoption begins, so a cancelled adoption leaves
 * the registry intact and the NEXT adoption still cancels and joins the old
 * work before its own authority exists. Cancelling the host's adoption removes
 * the obsolete PUBLICATION; it does not skip the teardown.
 *
 * Ordering is preserved for the same reason: only one adoption body runs at a
 * time, and the one that survives is always the newest.
 *
 * Identical credentials are filtered BEFORE the cancellation point. Without
 * that, an account-state re-emission carrying no identity change — a usage
 * refresh, a device list — would cancel a legitimate adoption in flight and
 * then decide there was nothing to do, leaving no session adopted at all.
 *
 * ## Foreground is app-wide and never tab-owned
 *
 * [foreground] is driven by [HostPresence], which answers for the whole
 * Activity — not by the Inbox destination being selected. Switching to Account
 * or Nearby must not silently stop receiving: the user would see deliveries
 * stop for a reason nothing on screen explains, and a sender would be told this
 * device is offline because its owner looked at another tab. This mirrors the
 * iOS scene root, which calls `inbox.foreground(phase != .background)` from the
 * app root rather than from the Inbox screen.
 *
 * A cold launch needs no away-and-back cycle: `adopt` starts the loop itself
 * when the host is already live, and [foreground] starts it when the adoption
 * came first. Whichever arrives second completes the pair.
 */
class InboxHost(
    private val receiving: InboxReceiving,
    /** Where a credential this build cannot use as a store identity is
     *  reported. See [Credential.inboxAccount]. */
    private val onUnusableAccount: (Credential) -> Unit = {},
) {

    private val adoption = InboxAdoption()

    /**
     * Apply credentials as they arrive, newest always winning, for as long as
     * [scope] lives.
     *
     * `distinctUntilChanged` first, so only a real identity change reaches the
     * cancellation point; `collectLatest` second, so a change that DOES arrive
     * cancels the adoption it supersedes before that adoption can publish.
     * Nothing else in this class launches an adoption.
     */
    fun run(scope: CoroutineScope, credentials: Flow<Credential?>): Job = scope.launch {
        credentials.distinctUntilChanged().collectLatest { credential ->
            val decision = adoption.next(credential) ?: return@collectLatest
            val account = decision.credential?.inboxAccount()
            if (decision.credential != null && account == null) {
                // A credential whose account id cannot name a store directory
                // and a keystore label. Adopting nothing is the honest outcome —
                // the surface says signed out rather than showing an Inbox that
                // silently belongs to no account — and it is reported so the
                // condition is visible rather than looking like a sign-out the
                // user did not perform.
                onUnusableAccount(decision.credential)
                receiving.adopt(null, null)
                return@collectLatest
            }
            receiving.adopt(account, decision.credential?.bearer)
        }
    }

    /** The whole app became visible, or stopped being visible. */
    fun foreground(live: Boolean) {
        if (live) receiving.start() else receiving.stop()
    }
}

/**
 * A live credential, as the Inbox needs it.
 *
 * Not a `data class`: a synthesised `toString` would print the bearer, and this
 * value travels through coroutine failure text and adoption decisions.
 * [equals] is still needed — it is what "the same session" means here — so it
 * is written out with the generation and the id, and the bearer is compared
 * too because a replaced token under one generation would otherwise be missed.
 */
class Credential(
    val accountId: String,
    val generation: Int,
    val bearer: String,
) {
    /**
     * This account as a store identity, or null when it cannot be one.
     *
     * `InboxAccountId` becomes a directory name and part of a keystore AAD
     * label, so it refuses anything that is not `[A-Za-z0-9_-]{1,64}`. That is
     * a fence worth keeping: a server that one day issued an id with a slash in
     * it must not be able to name a path outside the store's own directory.
     *
     * The refusal is returned rather than thrown, because the caller's honest
     * response is to adopt nothing — not to crash the app of a user whose
     * account id this build cannot represent.
     */
    fun inboxAccount(): InboxAccountId? = try {
        InboxAccountId(accountId)
    } catch (_: InboxWireException) {
        null
    }

    override fun equals(other: Any?): Boolean =
        other is Credential &&
            other.accountId == accountId &&
            other.generation == generation &&
            other.bearer == bearer

    override fun hashCode(): Int =
        (accountId.hashCode() * 31 + generation) * 31 + bearer.hashCode()

    /** No bearer. This reaches failure text and adoption logs. */
    override fun toString(): String = "Credential(account=$accountId, generation=$generation)"
}

/**
 * When to adopt, as a pure decision over the credential sequence.
 *
 * Separated from the collector so the rule — every generation, including a
 * same-account re-login; nothing when nothing changed — is testable without a
 * runtime, a scope or a clock.
 */
class InboxAdoption {

    /** What has actually been handed to the runtime, not what was last seen. */
    private var adopted: Credential? = null

    /** Whether anything has been adopted at all, so the very first `null` —
     *  the ordinary "no account yet" at launch — is not reported as a change. */
    private var started = false

    /** An adoption to perform. A null [credential] releases the account. */
    class Decision(val credential: Credential?)

    /**
     * The adoption this credential requires, or null when nothing changed.
     *
     * The record moves when the decision is MADE rather than when the adoption
     * finishes, and that is correct under cancellation: a body cancelled by a
     * newer credential is followed by a decision for that newer credential,
     * whose adoption cancels and joins everything the abandoned one would
     * have. Recording only on completion would instead let a credential that
     * was superseded mid-adoption be adopted again later for no reason.
     */
    fun next(credential: Credential?): Decision? {
        if (started && adopted == credential) return null
        started = true
        adopted = credential
        return Decision(credential)
    }
}

/**
 * The half of `InboxRuntime` a host drives.
 *
 * A seam rather than the concrete class, so the adoption and foreground rules
 * above are tested against a recording double on the JVM — the composed runtime
 * has its own suite, and a composition tested through a second copy of its
 * dependencies tests neither.
 */
interface InboxReceiving {
    suspend fun adopt(account: InboxAccountId?, bearer: String?)
    fun start(): Job?
    fun stop(): Job?
}

/** The production binding. Nothing but a forward. */
class RuntimeReceiving(private val runtime: InboxRuntime) : InboxReceiving {
    override suspend fun adopt(account: InboxAccountId?, bearer: String?) =
        runtime.adopt(account, bearer)

    override fun start(): Job? = runtime.start()

    override fun stop(): Job? = runtime.stop()
}
