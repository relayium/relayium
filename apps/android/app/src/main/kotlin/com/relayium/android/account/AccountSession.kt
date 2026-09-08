package com.relayium.android.account

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Who is signed in, and every way that can change.
 *
 * ## Ownership
 *
 * Every field below is read and written on ONE dispatcher — [owner], a
 * single-threaded serialising dispatcher supplied by the caller (the main
 * thread in the app, a test dispatcher under `:app:testDebugUnitTest`). Nothing
 * here is thread-safe by itself and nothing needs to be: the only concurrency
 * is the SUSPENSION points, which is precisely the concurrency that matters.
 *
 * Being serialised makes each STEP atomic, not each operation. A sign-out lands
 * between a sign-in's awaits routinely — a user who taps Sign out while a
 * refresh is waiting out a 30-second timeout, a browser approval that arrives
 * after the sheet was closed. Without identity, that late completion writes
 * `Ready` over a signed-out screen and hands back a credential the user just
 * discarded. So:
 *
 *  * every entry point claims the next [generation];
 *  * every write that happens AFTER an `await` is guarded on still holding it;
 *  * every TOKEN-STORE mutation re-checks it *inside* [storeLock], so a
 *    superseded sign-out's `clear` cannot delete the credential a newer sign-in
 *    has already written. That last one is the case a plain generation check
 *    after the fact cannot fix, because by then the file is gone.
 *
 * ## Credentials
 *
 * [sessionToken] is the source of truth for a live session; the store is
 * persistence only, so a failed `save` cannot sign a working session out from
 * under itself on the next read. It is deliberately not part of any published
 * state: a credential has no business in the value a UI re-renders from.
 *
 * A bearer that arrives for a generation that has already been superseded is
 * never stored and never rendered — and it is not simply dropped either. The
 * server minted it and it is live, so it is handed to a best-effort revoke (see
 * [revokeStranded]) and forgotten. Nothing in this file logs.
 */
class AccountSession(
    private val scope: CoroutineScope,
    private val owner: CoroutineDispatcher,
    /** Where blocking keystore and disk work runs; never [owner]. */
    private val io: CoroutineDispatcher,
    private val client: AccountClient,
    private val tokenStore: TokenStore,
    private val deviceName: String,
) {

    // ── published state ─────────────────────────────────────────────────────

    private val _state = MutableStateFlow<AccountState>(AccountState.Restoring)
    val state: StateFlow<AccountState> = _state.asStateFlow()

    /** The last refresh failed, but the account on screen is the last known
     *  good. Distinct from [AccountState.Unavailable], which has nothing to
     *  show. */
    private val _stale = MutableStateFlow(false)
    val stale: StateFlow<Boolean> = _stale.asStateFlow()

    private val _resend = MutableStateFlow<RequestState>(RequestState.Idle)
    val resend: StateFlow<RequestState> = _resend.asStateFlow()

    private val _recovery = MutableStateFlow<RequestState>(RequestState.Idle)
    val recovery: StateFlow<RequestState> = _recovery.asStateFlow()

    private val _devices = MutableStateFlow<DevicesState>(DevicesState.Idle)
    val devices: StateFlow<DevicesState> = _devices.asStateFlow()

    /**
     * A sign-out that revoked the credential on the server but could not remove
     * it from this device.
     *
     * Surfaced rather than swallowed. The remaining blob is inert — the server
     * no longer honours the token inside it — but "inert" is a claim the user is
     * entitled to have checked rather than assumed, and the same disk failure
     * will bite the next sign-in.
     */
    private val _signOutNote = MutableStateFlow(false)
    val signOutNote: StateFlow<Boolean> = _signOutNote.asStateFlow()

    // ── owner-confined fields ───────────────────────────────────────────────

    private var sessionToken: String? = null

    /**
     * Whether a credential is held at all — and deliberately NOT which one.
     *
     * The on-device acceptance needs to assert that a sign-out left nothing
     * behind, and the honest way to give it that is a boolean. Exporting the
     * bearer so a harness could present it to the server would put a live
     * credential in a report file, which is exactly the thing the rest of this
     * package refuses to do. That the REVOCATION happened is already carried by
     * the state machine: [AccountState.SignedOut] is only reachable when the
     * server answered, and a failure lands on [AccountState.SignOutFailed]
     * instead.
     *
     * `@Volatile` because it is the one field here read from outside [owner].
     */
    @Volatile
    var holdsCredential: Boolean = false
        private set

    /**
     * Whether [sessionToken] is actually on this device's disk.
     *
     * It belongs to the CREDENTIAL, not to the screen, and that is the whole
     * reason it is a field. Deriving it per load — "carry forward whatever the
     * last `Ready` said, and default to true otherwise" — is wrong on the exact
     * path that matters: a sign-in whose `save` failed and whose first
     * `/api/me` then failed too lands on `Unavailable`, which carries no
     * `persisted` to carry forward, so the next successful refresh reports a
     * durable sign-in that was never written. The token and this flag are set
     * together and cleared together, so no failure or retry in between can
     * separate them.
     */
    private var tokenPersisted = false

    /**
     * The ACCOUNT generation: bumped only by an operation that moves who is
     * signed in. Screen-local requests below have their own counters and must
     * NOT bump this one — a resend that superseded an in-flight sign-in, or a
     * device list that superseded itself, is a bug rather than a fence.
     */
    private var generation = 0

    /**
     * One counter per screen-local concern, so "a newer request of THIS kind
     * has started" is asked separately from "the account moved".
     *
     * Splitting them is what makes the device list work at all: the list
     * request pins an [Authority] whose `generation` is the account's, and a
     * shared counter meant claiming a request number ALSO invalidated the
     * authority the same call had just captured — every response then failed
     * its own currency check and the list never left `Loading`.
     */
    private var resendEpoch = 0
    private var recoveryEpoch = 0
    private var devicesEpoch = 0

    private val storeLock = Mutex()

    /**
     * The credential and the identity a dependent operation — minting a pairing
     * code — must pin, so that a mint started under one account cannot commit
     * under another. Read on [owner]; see [isCurrent].
     */
    data class Authority(val accountId: String, val token: String, val generation: Int)

    /**
     * A snapshot of the live session, or null when there is not one. MUST be
     * called from a coroutine already running on [owner].
     *
     * It answers only from [AccountState.Ready], which is what makes
     * [AccountState.SigningOut] a real fence rather than a label: while a
     * revocation is in flight there is no authority to mint or join anything
     * with, even though the token is still physically held for the retry.
     */
    fun authority(): Authority? {
        val ready = _state.value as? AccountState.Ready ?: return null
        val token = sessionToken?.takeIf { it.isNotEmpty() } ?: return null
        return Authority(ready.user.id, token, generation)
    }

    /**
     * Is [authority] still the live session? All three parts, because each
     * catches something the others do not: the generation catches a sign-out or
     * a second sign-in, the account id catches a switch that landed on a
     * different account, and the token catches a credential replaced under the
     * same account (a browser approval adopted while a mint was in flight).
     */
    fun isCurrent(authority: Authority): Boolean =
        generation == authority.generation &&
            sessionToken == authority.token &&
            (_state.value as? AccountState.Ready)?.user?.id == authority.accountId

    // ── entry points ────────────────────────────────────────────────────────

    /**
     * Load whatever credential this device holds.
     *
     * Not a blind "reset to a spinner and refetch": several states hold
     * something a cold start would silently discard, and the account tab is
     * entered and left constantly. The check-email screen owns an address the
     * keystore cannot reproduce; a rejection owns the reason the form is showing
     * it; a failed sign-out owns a live credential the user still has to deal
     * with. Each returns rather than restarting.
     */
    fun restore() = launchOwned {
        when (_state.value) {
            is AccountState.Ready,
            is AccountState.SigningIn,
            is AccountState.Registering,
            is AccountState.SigningOut,
            is AccountState.SignedOut,
            is AccountState.Rejected,
            is AccountState.CheckEmail,
            is AccountState.PendingDeletion,
            is AccountState.SignOutFailed,
            is AccountState.CredentialUnreadable,
            -> return@launchOwned
            is AccountState.Restoring, is AccountState.Unavailable -> Unit
        }
        // A token already in hand with no account on screen is a refresh, not a
        // cold start: keep the current screen while it runs.
        if (sessionToken != null) {
            refreshNow()
            return@launchOwned
        }
        val g = beginSessionOperation()
        _state.value = AccountState.Restoring
        when (val loaded = readStore(g)) {
            is StoreRead.Superseded -> return@launchOwned
            is StoreRead.Failed -> {
                // Something IS stored and this build cannot open it. Never
                // reported as "no account": that would let the next sign-in
                // write over it, and it hides a real failure the user can act on.
                _state.value = AccountState.CredentialUnreadable
                _stale.value = false
            }
            is StoreRead.Value -> {
                val token = loaded.token
                if (token.isNullOrEmpty()) {
                    _state.value = AccountState.SignedOut
                    _stale.value = false
                } else if (!Bearer.isValid(token)) {
                    // Stored, and unusable. Reported as unreadable rather than
                    // as absence, for the same reason a failed decrypt is:
                    // something IS here, and silently signing in over it would
                    // hide a real failure the user can act on.
                    _state.value = AccountState.CredentialUnreadable
                    _stale.value = false
                } else {
                    // It came OUT of the store, so it is by definition in it.
                    sessionToken = token
                    holdsCredential = true
                    tokenPersisted = true
                    loadAccount(token, g)
                }
            }
        }
    }

    fun signIn(email: String, password: String) = launchOwned {
        if (revocationInFlight()) return@launchOwned
        // The same claim a browser approval makes, so whichever route the user
        // takes second is the one that owns the outcome.
        val g = beginAccountAccess()
        _state.value = AccountState.SigningIn
        val outcome = client.login(email, password, deviceName)
        val landed = outcome.getOrNull()
        if (superseded(g)) {
            // A sign-out (or a second sign-in) that landed while this was in
            // flight wins — AND this attempt's bearer, if the server did mint
            // one, must not be left live on the account.
            (landed as? LoginOutcome.Session)?.let { revokeStranded(it.token) }
            return@launchOwned
        }
        when (landed) {
            is LoginOutcome.Session -> adopt(landed.token, g)
            is LoginOutcome.EmailUnverified -> _state.value = AccountState.CheckEmail(landed.email)
            // No token is held and none is written: the account is frozen, and
            // the reactivation token beside this answer is deliberately neither
            // carried nor shown (see LoginOutcome.PendingDeletion).
            is LoginOutcome.PendingDeletion ->
                _state.value = AccountState.PendingDeletion(landed.purgeAfter)
            null -> _state.value = AccountState.Rejected(outcome.failure())
        }
    }

    /**
     * Create an account.
     *
     * Three things it deliberately does not do, each of which would be a claim
     * the server never made: it never touches [sessionToken] or the store
     * (registration issues no credential), it never reaches
     * [AccountState.Ready], and its only success is the check-email screen.
     */
    fun register(email: String, password: String, displayName: String) = launchOwned {
        if (revocationInFlight()) return@launchOwned
        val g = beginAccountAccess()
        _state.value = AccountState.Registering
        val outcome = client.register(email, password, displayName)
        if (superseded(g)) return@launchOwned
        outcome.fold(
            onSuccess = { _state.value = AccountState.CheckEmail(it.email) },
            onFailure = { _state.value = AccountState.Rejected(outcome.failure()) },
        )
    }

    /**
     * Adopt a bearer obtained outside this type — the browser approval hands one
     * back after the human approves in a browser.
     *
     * Deliberately the same tail as a successful sign-in: persist, then fetch.
     * The token alone carries no plan and no usage, so a session rendered from
     * it would be half an account screen.
     */
    /**
     * Claim the right to become the signed-in account, returning the ATTEMPT
     * that claim is identified by.
     *
     * This is what makes "one account-access attempt at a time" a rule rather
     * than a hope. An attempt that produces a credential later — the browser
     * approval, which can be waiting for a human for minutes — hands its number
     * back at [adoptBearerOnOwner], and everything that moves the account in the
     * meantime (a password sign-in, a registration, a sign-out, going back to
     * the form) claims a NEWER one. So the concrete sequence this exists for —
     * start a browser approval, sign in with a password instead, sign out, and
     * only then have the browser approval complete — ends signed out, with the
     * abandoned bearer revoked, instead of silently signing the user back in.
     *
     * MUST be called from a coroutine already running on [owner].
     */
    fun beginAccountAccess(): Int {
        // A rejection belongs to the attempt that produced it. Starting a new
        // one clears it, so the form is not showing a reason for something the
        // user has already moved on from.
        if (_state.value is AccountState.Rejected) _state.value = AccountState.SignedOut
        return beginSessionOperation()
    }

    /**
     * Adopt a bearer produced by [attempt], WITHOUT a queue hop — the caller is
     * already running on [owner] and is handing over a credential it has just
     * been given.
     *
     * Both halves matter. The ATTEMPT check is the admission decision: only the
     * newest claim may become the session, and a bearer from a superseded one is
     * revoked rather than dropped, because the server minted a live, long-lived
     * credential and abandoning it would leave a working token on the account
     * that this device can no longer revoke.
     *
     * Being a suspend call rather than a posted callback is the other half.
     * `launch(owner)` on a serialising dispatcher does not run the body now, it
     * ENQUEUES it — so a sign-out tapped in the same instant could run to
     * completion first and the queued adoption would then undo it. Running in
     * the caller's own continuation makes the check and the claim one
     * uninterrupted step.
     */
    suspend fun adoptBearerOnOwner(token: String, attempt: Int) {
        if (attempt != generation || revocationInFlight()) {
            revokeStranded(token)
            return
        }
        if (!Bearer.isValid(token)) {
            beginSessionOperation()
            _state.value = AccountState.Rejected(
                AccountFailure(AccountFailure.Kind.CREDENTIAL_UNUSABLE),
            )
            return
        }
        val g = beginSessionOperation()
        _state.value = AccountState.SigningIn
        adopt(token, g)
    }

    /** Refresh the account on screen. Explicit — nothing here polls. */
    fun refresh() = launchOwned {
        if (revocationInFlight()) return@launchOwned
        refreshNow()
    }

    /**
     * True while a revocation is in flight, in which case no other entry point
     * may claim the generation.
     *
     * Superseding a sign-out is not a harmless race: its `logout` response is
     * then dropped, the token is replaced or forgotten, and a credential the
     * user explicitly asked to destroy stays live on the account with nothing
     * on this device able to revoke it. So the sign-out finishes — succeeding
     * or landing on [AccountState.SignOutFailed], which the user can retry —
     * before anything else moves.
     */
    private fun revocationInFlight(): Boolean = _state.value is AccountState.SigningOut

    /**
     * Ask for another verification email.
     *
     * Writes only [resend]: the address on screen, and the state that carries
     * it, are untouched by a request about them. It claims the shared generation
     * so a sign-out or a sign-in landing mid-request supersedes it, but does not
     * clear the notices, since the notice is the value it exists to write.
     */
    fun resendVerification() = launchOwned {
        val screen = _state.value as? AccountState.CheckEmail ?: return@launchOwned
        if (_resend.value is RequestState.Sending) return@launchOwned
        resendEpoch += 1
        val mine = resendEpoch
        val account = generation
        _resend.value = RequestState.Sending
        val outcome = client.resendVerification(screen.email)
        if (mine != resendEpoch || superseded(account)) return@launchOwned
        _resend.value = outcome.fold(
            onSuccess = { RequestState.Requested },
            onFailure = { RequestState.Failed(outcome.failure()) },
        )
    }

    /**
     * Ask the server to email a password-reset link to [email].
     *
     * The reset itself is completed in the mailbox and then in a browser: the
     * emailed link opens the website's reset page, which owns that flow. This
     * app only asks, so no browser is needed to get un-stuck, and nothing here
     * can claim an email was actually sent — the endpoint answers 200 whether it
     * mailed anything or swallowed the request under its per-address throttle.
     */
    fun requestPasswordReset(email: String) = launchOwned {
        if (_recovery.value is RequestState.Sending) return@launchOwned
        recoveryEpoch += 1
        val mine = recoveryEpoch
        val account = generation
        _recovery.value = RequestState.Sending
        val outcome = client.requestPasswordReset(email)
        if (mine != recoveryEpoch || superseded(account)) return@launchOwned
        _recovery.value = outcome.fold(
            onSuccess = { RequestState.Requested },
            onFailure = { RequestState.Failed(outcome.failure()) },
        )
    }

    /**
     * Sign out, which means REVOKE — not merely forget.
     *
     * `POST /api/auth/logout` answers 200 or 401, and both are terminal
     * success: 401 means the credential is already gone server-side, which is
     * the state a sign-out is trying to reach. Anything else — offline, a 500,
     * a timeout — means the token **may still be live**, so it is kept for an
     * explicit retry and the failure is shown. Deleting local state there would
     * leave a working server credential that this device can no longer revoke,
     * which is the opposite of what the user asked for; every dependent action
     * is disabled meanwhile, because the account they belong to is in an
     * unresolved state.
     *
     * On success the store is cleared. A `clear` that fails does NOT undo the
     * revocation — the server already dropped the token, so what is left on disk
     * is inert — but it is reported through [signOutNote] rather than swallowed.
     */
    fun signOut() = launchOwned {
        if (revocationInFlight()) return@launchOwned
        val g = beginSessionOperation()
        val token = sessionToken
        if (token != null) {
            // BEFORE the await, and this ordering is the fence: while the
            // request is in flight the account is no longer `Ready`, so
            // `authority()` answers null and nothing dependent on the session —
            // minting a pairing code, joining the room it names, listing
            // devices — can start on a credential that is being destroyed.
            _state.value = AccountState.SigningOut
            val revoked = client.logout(token)
            if (superseded(g)) return@launchOwned
            if (revoked.isFailure) {
                _state.value = AccountState.SignOutFailed(revoked.failure())
                return@launchOwned
            }
        }
        finishSignOut(g)
    }

    /** Try the revocation again after [AccountState.SignOutFailed]. */
    fun retrySignOut() = launchOwned {
        if (_state.value !is AccountState.SignOutFailed) return@launchOwned
        val g = beginSessionOperation()
        val token = sessionToken
        if (token == null) {
            finishSignOut(g)
            return@launchOwned
        }
        _state.value = AccountState.SigningOut
        val revoked = client.logout(token)
        if (superseded(g)) return@launchOwned
        if (revoked.isFailure) {
            _state.value = AccountState.SignOutFailed(revoked.failure())
            return@launchOwned
        }
        finishSignOut(g)
    }

    /** Load this account's device list. */
    fun loadDevices() = launchOwned {
        val authority = authority() ?: run {
            _devices.value = DevicesState.Idle
            return@launchOwned
        }
        if (_devices.value is DevicesState.Loading) return@launchOwned
        // Its OWN epoch. Claiming the account generation here would invalidate
        // the authority captured one line above, and every answer would then
        // fail its own currency check — the list would never leave `Loading`.
        devicesEpoch += 1
        val mine = devicesEpoch
        _devices.value = DevicesState.Loading
        val outcome = client.listDevices(authority.token)
        if (mine != devicesEpoch || !isCurrent(authority)) return@launchOwned
        _devices.value = outcome.fold(
            onSuccess = { DevicesState.Loaded(it) },
            onFailure = { DevicesState.Failed(outcome.failure()) },
        )
    }

    /**
     * Revoke one device credential.
     *
     * Revoking the row this app's own bearer is bound to cascades that token
     * server-side, so it ends THIS session — the local state has to follow, or
     * the app would keep rendering an account it can no longer read. That is
     * done without another `logout` call: the credential is already gone, and a
     * revocation request carrying it would only earn a 401.
     */
    fun revokeDevice(id: String) = launchOwned {
        val authority = authority() ?: return@launchOwned
        val known = (_devices.value as? DevicesState.Loaded)?.devices?.firstOrNull { it.id == id }
            ?: return@launchOwned
        devicesEpoch += 1
        val mine = devicesEpoch
        _devices.value = DevicesState.Loading
        val outcome = client.deleteDevice(id, authority.token)
        if (mine != devicesEpoch || !isCurrent(authority)) return@launchOwned
        if (outcome.isFailure) {
            _devices.value = DevicesState.Failed(outcome.failure())
            return@launchOwned
        }
        if (known.current) {
            // This app's OWN credential: the server cascades the bearer when
            // its device row goes, so this session is already over. The local
            // state follows without another `logout` — that request could only
            // present the token the server just destroyed and earn a 401.
            val out = beginSessionOperation()
            finishSignOut(out)
            return@launchOwned
        }
        _devices.value = DevicesState.Loaded(
            (_devices.value as? DevicesState.Loaded)?.devices.orEmpty().filterNot { it.id == id },
        )
        loadDevices()
    }

    /** Leave a rejection, a check-email screen or a frozen-account notice and
     *  go back to the form. Holds nothing, so it writes nothing. */
    fun backToSignIn() = launchOwned {
        when (_state.value) {
            is AccountState.Rejected,
            is AccountState.CheckEmail,
            is AccountState.PendingDeletion,
            -> {
                beginSessionOperation()
                _state.value = AccountState.SignedOut
            }
            else -> Unit
        }
    }

    /**
     * Give up on a credential this device cannot read.
     *
     * The only way out of [AccountState.CredentialUnreadable], and it is
     * explicit: the blob is removed and the user signs in again. If the removal
     * itself fails the screen stays, because pretending otherwise would put the
     * user back in the same state on the next launch with no explanation.
     */
    fun discardUnreadableCredential() = launchOwned {
        if (_state.value !is AccountState.CredentialUnreadable) return@launchOwned
        val g = beginSessionOperation()
        when (clearStore(g)) {
            is StoreWrite.Superseded -> Unit
            is StoreWrite.Failed -> _state.value = AccountState.CredentialUnreadable
            is StoreWrite.Done -> _state.value = AccountState.SignedOut
        }
    }

    fun dismissSignOutNote() = launchOwned { _signOutNote.value = false }

    // ── internals ───────────────────────────────────────────────────────────

    private fun launchOwned(block: suspend () -> Unit) {
        scope.launch(owner) { block() }
    }

    private fun beginOperation(): Int {
        generation += 1
        return generation
    }

    /**
     * [beginOperation] plus the one thing every SESSION-moving operation owes
     * the screen-local notices: each belongs to one address or one account in
     * one state, so signing in, out, restoring or registering clears them. A
     * "sent" line surviving into the next screen is a claim about an email
     * nobody there asked for.
     */
    private fun beginSessionOperation(): Int {
        _resend.value = RequestState.Idle
        _recovery.value = RequestState.Idle
        _devices.value = DevicesState.Idle
        return beginOperation()
    }

    private fun superseded(g: Int): Boolean = generation != g

    /** The tail every successful credential acquisition shares. */
    private suspend fun adopt(token: String, g: Int) {
        sessionToken = token
        holdsCredential = true
        tokenPersisted = when (writeStore(g, token)) {
            is StoreWrite.Superseded -> return
            is StoreWrite.Done -> true
            // NOT a failed sign-in: the account is genuinely open in this
            // process. What is false is only that it will still be open after a
            // restart, and [AccountState.Ready.persisted] says exactly that —
            // for as long as this credential is held, however many failed loads
            // and retries happen in between.
            is StoreWrite.Failed -> false
        }
        loadAccount(token, g)
    }

    private suspend fun refreshNow() {
        val g = beginSessionOperation()
        val token = sessionToken ?: when (val loaded = readStore(g)) {
            is StoreRead.Superseded -> return
            is StoreRead.Failed -> {
                _state.value = AccountState.CredentialUnreadable
                _stale.value = false
                return
            }
            is StoreRead.Value -> loaded.token?.also { tokenPersisted = true }
        }
        if (superseded(g)) return
        if (token.isNullOrEmpty()) {
            _state.value = AccountState.SignedOut
            _stale.value = false
            return
        }
        if (!Bearer.isValid(token)) {
            _state.value = AccountState.CredentialUnreadable
            _stale.value = false
            return
        }
        sessionToken = token
        holdsCredential = true
        loadAccount(token, g)
    }

    /**
     * A token is always already in hand by the time this runs, so a non-401
     * failure here is never a rejected sign-in — it is "we hold a credential and
     * could not load the account", which is a retry, not a form.
     */
    private suspend fun loadAccount(token: String, g: Int) {
        val user = client.fetchMe(token)
        if (superseded(g)) return
        if (user.isFailure) {
            handleLoadFailure(user.failure(), g)
            return
        }
        val usage = client.fetchUsage(token)
        if (superseded(g)) return
        if (usage.isFailure) {
            handleLoadFailure(usage.failure(), g)
            return
        }
        _state.value = AccountState.Ready(user.getOrThrow(), usage.getOrThrow(), tokenPersisted)
        _stale.value = false
    }

    private suspend fun handleLoadFailure(failure: AccountFailure, g: Int) {
        if (failure.kind == AccountFailure.Kind.INVALID_CREDENTIALS ||
            failure.kind == AccountFailure.Kind.CREDENTIAL_UNUSABLE
        ) {
            // The one and only signal that a stored token has gone bad. There is
            // nothing to revoke — the server has already refused it — so the
            // local copy is dropped and a failed removal is a note, not a state.
            sessionToken = null
            holdsCredential = false
            tokenPersisted = false
            if (clearStore(g) is StoreWrite.Failed) _signOutNote.value = true
            if (superseded(g)) return
            _stale.value = false
            _state.value = AccountState.SignedOut
            return
        }
        if (_state.value is AccountState.Ready) {
            // Keep the last known good on screen and say it is not fresh.
            _stale.value = true
        } else {
            _state.value = AccountState.Unavailable(failure)
        }
    }

    private suspend fun finishSignOut(g: Int) {
        sessionToken = null
        holdsCredential = false
        tokenPersisted = false
        val cleared = clearStore(g)
        if (superseded(g)) return
        _signOutNote.value = cleared is StoreWrite.Failed
        _stale.value = false
        _state.value = AccountState.SignedOut
    }

    /**
     * A bearer this session may not keep, handed back for revocation.
     *
     * It exists because "drop it on the floor" is not neutral: the server minted
     * a live, long-lived credential and registered a device row for it. A
     * sign-in the user abandoned would otherwise leave a working token behind
     * with nothing able to revoke it but the account's device list.
     *
     * Best-effort and unobserved on purpose — it must not resurrect any state,
     * touch the store, or produce a UI answer — and, like everything here, it
     * logs nothing.
     */
    private fun revokeStranded(token: String) {
        scope.launch(owner) { client.logout(token) }
    }

    // ── the token store, fenced ─────────────────────────────────────────────

    private sealed interface StoreRead {
        data class Value(val token: String?) : StoreRead
        data object Failed : StoreRead
        data object Superseded : StoreRead
    }

    private sealed interface StoreWrite {
        data object Done : StoreWrite
        data object Failed : StoreWrite
        data object Superseded : StoreWrite
    }

    /**
     * Every store access goes through one lock, and the generation is re-checked
     * INSIDE it.
     *
     * A check made only before the lock is not enough for the case this exists
     * for: a superseded sign-out and a fresh sign-in can both be waiting, and if
     * the sign-out wins the lock after the sign-in has written, a plain
     * after-the-fact check would notice the supersession only once the new
     * account's credential had already been deleted. Checking under the lock
     * makes "is this operation still the live one" and "mutate the store" a
     * single indivisible step.
     */
    private suspend fun <T> underStoreLock(g: Int, block: () -> T): Result<T>? =
        storeLock.withLock {
            if (withContext(owner) { superseded(g) }) return null
            withContext(io) { runCatching(block) }
        }

    private suspend fun readStore(g: Int): StoreRead {
        val result = underStoreLock(g) { tokenStore.load() } ?: return StoreRead.Superseded
        return result.fold(
            onSuccess = { StoreRead.Value(it) },
            onFailure = { StoreRead.Failed },
        )
    }

    private suspend fun writeStore(g: Int, token: String): StoreWrite {
        val result = underStoreLock(g) { tokenStore.save(token) } ?: return StoreWrite.Superseded
        return if (result.isSuccess) StoreWrite.Done else StoreWrite.Failed
    }

    private suspend fun clearStore(g: Int): StoreWrite {
        val result = underStoreLock(g) { tokenStore.clear() } ?: return StoreWrite.Superseded
        return if (result.isSuccess) StoreWrite.Done else StoreWrite.Failed
    }

    private companion object {
        /** The classification behind a failed call. A `Result` from
         *  [AccountClient] always carries an [AccountException]; anything else
         *  would be a programming error, and reporting it as a network failure
         *  would hide it. */
        fun Result<*>.failure(): AccountFailure =
            (exceptionOrNull() as? AccountException)?.failure
                ?: AccountFailure(AccountFailure.Kind.MALFORMED)
    }
}
