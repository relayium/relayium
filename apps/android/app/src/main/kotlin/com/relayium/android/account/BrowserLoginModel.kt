package com.relayium.android.account

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * **Signing in by approving this device in a browser.**
 *
 * The reason it exists is not convenience. Plenty of Relayium accounts have no
 * password at all — they were created through Sign in with Apple or Google — and
 * this app ships no Google SDK and no Play Services by design. Without a
 * browser-delegated route those accounts simply cannot sign in on Android. The
 * flow is the server's existing device-authorisation pair
 * (`/api/cli/device/start` and `/poll`, RFC 8628-shaped), which the CLI already
 * uses: this device asks for a short code, the human approves it in a browser
 * where they are already signed in by whatever means, and the bearer comes back
 * here.
 *
 * It publishes the URL to open rather than opening it, which is what leaves
 * every decision in this file testable with no browser and no server.
 *
 * ## What the polling loop must get right
 *
 *  * **The interval is the SERVER's.** Polling faster earns a 429 that reads to
 *    the user as a failed login. [AccountClient.startBrowserLogin] refuses a
 *    response whose interval this build will not honour rather than clamping it.
 *  * **A cancelled run must not resurrect.** The loop is usually parked in a
 *    sleep or a request; [generation] is re-checked after every suspension, and
 *    a run that has been superseded writes nothing.
 *  * **A bearer that arrives after a cancel is REVOKED, not dropped.** The
 *    server hands the token out exactly once and it is live and long-lived from
 *    that moment. Silently discarding it would leave a working credential on the
 *    account that the user never sees and this device can no longer revoke. It
 *    is never stored, never rendered and — like everything here — never logged.
 */
class BrowserLoginModel(
    private val scope: CoroutineScope,
    private val owner: CoroutineDispatcher,
    private val client: AccountClient,
    /**
     * The account this attempt is trying to become.
     *
     * Held directly rather than driven by a callback the caller supplies,
     * because the ADMISSION rule has to be one rule: this model claims an
     * attempt from the session before it asks the server for anything, and
     * hands that same attempt back at the end. A caller wiring the two together
     * with a lambda is a caller who can wire them together wrongly, and the way
     * it goes wrong is invisible — a browser approval that completes minutes
     * after the user signed in another way, and signs them into the wrong
     * account or back out of a sign-out.
     */
    private val session: AccountSession,
    private val deviceName: String,
    /** This app's own resolved origin. The server's `verification_uri` must be
     *  on it or the flow is refused; see
     *  [AccountFailure.Kind.UNTRUSTED_VERIFICATION_URL]. */
    private val trustedOrigin: String,
    /** Epoch seconds, injected so the expiry boundary is a test. */
    private val now: () -> Long,
    /** Injected so a test does not wait out a real poll interval. */
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {

    sealed interface State {
        data object Idle : State
        data object Starting : State

        /**
         * Waiting for the human. [userCode] is what they read and type;
         * [approvalUrl] is the same page with the code already filled in, and
         * has been checked against [trustedOrigin] before it got here.
         */
        data class Waiting(val userCode: String, val approvalUrl: String) : State

        data class Failed(val failure: AccountFailure) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private var generation = 0

    /**
     * Run the approval to a terminal state, adopting the bearer if one arrives
     * and this attempt is still the one the account is waiting on.
     *
     * Two independent identities are carried, and they answer different
     * questions. [generation] is THIS model's — "has the user left this screen
     * or started another approval?" — and guards what is drawn. The [attempt]
     * claimed from the session is the account's — "is this still the route the
     * user is signing in by?" — and guards what is ADOPTED. A run can fail the
     * second while passing the first, which is exactly the case that used to
     * sign someone back in after they had signed out.
     */
    fun begin() {
        scope.launch(owner) {
            generation += 1
            val mine = generation
            val attempt = session.beginAccountAccess()
            _state.value = State.Starting

            val started = client.startBrowserLogin(deviceName, trustedOrigin)
            if (mine != generation) return@launch
            val request = started.getOrElse {
                _state.value = State.Failed(failureOf(it))
                return@launch
            }
            _state.value = State.Waiting(request.userCode, request.approvalUrl)

            val deadline = now() + request.expiresInSeconds
            while (now() < deadline) {
                val answer = client.pollBrowserLogin(request.deviceCode)
                // Re-checked AFTER the request: a sheet closed mid-poll bumps
                // the generation, and the token that arrives belongs to nobody.
                if (mine != generation) {
                    (answer.getOrNull() as? DevicePollOutcome.Approved)
                        ?.let { revokeStranded(it.token) }
                    return@launch
                }
                when (val outcome = answer.getOrElse {
                    _state.value = State.Failed(failureOf(it))
                    return@launch
                }) {
                    is DevicePollOutcome.Pending -> {
                        sleep(request.intervalSeconds * 1_000L)
                        if (mine != generation) return@launch
                    }
                    is DevicePollOutcome.Denied -> {
                        _state.value = State.Failed(AccountFailure(AccountFailure.Kind.DEVICE_DENIED))
                        return@launch
                    }
                    is DevicePollOutcome.Expired -> {
                        _state.value = State.Failed(AccountFailure(AccountFailure.Kind.DEVICE_EXPIRED))
                        return@launch
                    }
                    is DevicePollOutcome.Approved -> {
                        // Handed out exactly once by the server; never poll
                        // again. The session decides whether this attempt may
                        // still become the account, and revokes the bearer
                        // itself if it may not.
                        _state.value = State.Idle
                        session.adoptBearerOnOwner(outcome.token, attempt)
                        return@launch
                    }
                }
            }
            if (mine != generation) return@launch
            _state.value = State.Failed(AccountFailure(AccountFailure.Kind.DEVICE_EXPIRED))
        }
    }

    /**
     * Leaving the screen. Bumping the generation is the load-bearing half: the
     * loop is normally parked in a sleep or a request and must not resume into a
     * surface the user has left.
     */
    fun cancel() {
        scope.launch(owner) {
            generation += 1
            _state.value = State.Idle
        }
    }

    /** See the class comment: a live bearer this run may not keep is handed
     *  back rather than abandoned. Unobserved, and never logged. */
    private fun revokeStranded(token: String) {
        scope.launch(owner) { client.logout(token) }
    }

    private companion object {
        fun failureOf(error: Throwable): AccountFailure =
            (error as? AccountException)?.failure
                ?: AccountFailure(AccountFailure.Kind.MALFORMED)
    }
}
