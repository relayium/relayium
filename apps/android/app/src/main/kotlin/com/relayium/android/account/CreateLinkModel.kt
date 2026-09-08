package com.relayium.android.account

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * **Minting the six digits a second device joins, and nothing else.**
 *
 * It reserves a room whose traffic is METERED against an account's monthly
 * allowance, and it holds an expiry. It
 * opens no socket, derives no key and speaks no protocol: what the code is FOR
 * — one verified `link/1` carrying files and messages — belongs to
 * [com.relayium.android.TransferController], which this model asks to join the
 * room the digits name and never drives further.
 *
 * ## Three separate fences, because there are three separate races
 *
 * A mint is a network round trip, and by the time it lands any of these may
 * have happened:
 *
 *  1. **The user cancelled, or minted again.** [generation] catches it; a
 *     superseded answer writes nothing.
 *  2. **The account changed.** The [AccountSession.Authority] captured before
 *     the request is re-checked after it, so a code minted for one account —
 *     and metered against it — can never be shown or joined under another, and a
 *     mint that outlived a sign-out cannot create a room at all.
 *  3. **A session already exists.** [commit] is the caller's own check that
 *     the transfer controller is genuinely idle. A late mint must never tear
 *     down a live transfer to join its own room, so the commit refuses and the
 *     answer is reported as a code that arrived too late rather than joined.
 *
 * The expiry is checked at the same instant as the commit, not only at parse
 * time: a code that expired while the user was reading it must not be joined.
 */
class CreateLinkModel(
    private val scope: CoroutineScope,
    /** The same single-threaded dispatcher [AccountSession] runs on: the
     *  authority checks below read its owner-confined state directly. */
    private val owner: CoroutineDispatcher,
    private val client: AccountClient,
    private val session: AccountSession,
    /**
     * The origin every join link is composed against: this app's OWN resolved
     * backend, which in a shipped build can only ever be production (see
     * [com.relayium.android.Backend]). It is a constructor value rather than
     * something read out of the mint response — a link is what the user hands
     * to another person, and one assembled from a server-supplied string is a
     * redirect waiting to happen.
     */
    private val origin: String,
    /** Epoch seconds. Injected so the expiry boundary is a test, not a wait. */
    private val now: () -> Long,
) {

    sealed interface State {
        data object Idle : State
        data object Minting : State

        /**
         * A live code, joined into its room and waiting for the other device.
         *
         * [link] is the full official address for the same room, composed from
         * the app's own resolved origin — never from anything the server said —
         * so it is the one a browser or another Relayium opens.
         */
        data class Showing(val code: String, val expiresAt: Long, val link: String) : State

        data class Failed(val failure: AccountFailure) : State

        /**
         * Minted, but by the time it could be used the session had moved on.
         *
         * Reported rather than silently discarded, because the user asked for a
         * code and did not get one: digits that never appear read as a broken
         * button. Nothing is charged for a mint — it reserves a room and
         * passes a quota check, not a payment — so the copy says only that the
         * code could not be used, and offers another.
         */
        data object Superseded : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private var generation = 0

    /**
     * Mint a code and join its room.
     *
     * [commit] is called on [owner] with the validated code, and answers whether
     * the join really happened — it is where the caller checks that no transfer
     * is already in progress. `false` leaves the code unshown: it names a room
     * nothing on this device is listening in.
     */
    fun create(commit: (MintedCode) -> Boolean) {
        scope.launch(owner) {
            generation += 1
            val mine = generation
            val authority = session.authority()
            if (authority == null) {
                _state.value = State.Failed(AccountFailure(AccountFailure.Kind.NOT_SIGNED_IN))
                return@launch
            }
            _state.value = State.Minting
            val minted = client.mintPairCode(authority.token, now())
            if (mine != generation) {
                // Cancelled or re-minted while this was in flight. The code is
                // left unused; it expires on its own and joins nothing.
                return@launch
            }
            val code = minted.getOrElse {
                _state.value = State.Failed(
                    (it as? AccountException)?.failure
                        ?: AccountFailure(AccountFailure.Kind.MALFORMED),
                )
                return@launch
            }
            // Re-checked HERE, after the await and immediately before the only
            // action that has an effect. All three fences, in one place.
            if (!session.isCurrent(authority) ||
                !PairCodeExpiry.presentation(code.expiresAt, now()).usable ||
                !commit(code)
            ) {
                _state.value = State.Superseded
                return@launch
            }
            _state.value = State.Showing(code.code, code.expiresAt, link(code.code))
        }
    }

    /** Discard whatever is held and make an in-flight mint's answer arrive too
     *  late to be written. */
    fun cancel() {
        scope.launch(owner) {
            generation += 1
            _state.value = State.Idle
        }
    }

    /** The full join address for [code] — the same string the website's own
     *  create screen produces, so a peer opens one link whichever side minted. */
    private fun link(code: String): String = "$origin$CROSS_PATH#c=$code"

    private companion object {
        const val CROSS_PATH = com.relayium.protocol.JoinInput.CROSS_PATH
    }
}
