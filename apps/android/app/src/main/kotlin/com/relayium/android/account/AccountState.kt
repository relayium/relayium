package com.relayium.android.account

/**
 * Everything the account surface can be, as ONE value.
 *
 * Routing IS state here: the screen is chosen by this type rather than by a
 * separate flag the two could disagree about. The cases that look similar are
 * deliberately distinct, because the honest recovery differs in each:
 *
 *  * [Rejected] holds nothing and belongs back on the form — the fields that
 *    produced it are still there;
 *  * [Unavailable] HOLDS A CREDENTIAL and belongs on a retry — a sign-in form
 *    cannot fix a server that is down;
 *  * [SignOutFailed] holds a credential that may still be LIVE on the server,
 *    which is neither of the above and must not offer account actions at all;
 *  * [CredentialUnreadable] holds something this device cannot open, which is
 *    not the same as holding nothing.
 */
sealed interface AccountState {

    /** Reading whatever this device stored. The state at first composition. */
    data object Restoring : AccountState

    /** No credential. The sign-in / create-account form. */
    data object SignedOut : AccountState

    data object SigningIn : AccountState

    /**
     * A registration is in flight.
     *
     * Distinct from [SigningIn] because it is a different operation with a
     * different destination: it can never produce a session, only [CheckEmail],
     * so a screen reporting "Signing in…" here would name an outcome that
     * cannot happen.
     */
    data object Registering : AccountState

    /**
     * A revocation is in flight.
     *
     * Its own state rather than a flag beside [Ready], and that is load-bearing
     * twice over. It is what stops [AccountSession.authority] from answering
     * while the credential is being revoked — otherwise a pairing code could be
     * minted, and a room joined, on a token that is in the middle of being
     * destroyed. And it is what the entry points refuse to move off, so a tap
     * elsewhere cannot supersede the sign-out and leave a live credential
     * behind with nothing tracking it.
     */
    data object SigningOut : AccountState

    /** Registered or signed in against an address that has never been
     *  confirmed. No session exists and none can until the emailed link is
     *  opened. */
    data class CheckEmail(val email: String) : AccountState

    /**
     * Correct credentials, but the account is inside its deletion grace period.
     * [purgeAfter] is the epoch second the server named.
     *
     * The way out is the reactivation link emailed when the deletion was
     * requested — this app deliberately holds no token that could do it. See
     * [LoginOutcome.PendingDeletion].
     */
    data class PendingDeletion(val purgeAfter: Long) : AccountState

    /**
     * An account, as the server describes it.
     *
     * [persisted] is false when the credential is live in this process but could
     * NOT be written to this device. The session is real; what is not true is
     * that it will survive a restart, and the screen says exactly that rather
     * than letting the user discover it later.
     */
    data class Ready(
        val user: AccountUser,
        val usage: AccountUsage,
        val persisted: Boolean,
    ) : AccountState

    /** A sign-in or registration was refused. Nothing is held. */
    data class Rejected(val failure: AccountFailure) : AccountState

    /** A credential is held but the account could not be loaded. */
    data class Unavailable(val failure: AccountFailure) : AccountState

    /** The revocation request failed, so the credential may still be live. It
     *  is KEPT, for an explicit retry. */
    data class SignOutFailed(val failure: AccountFailure) : AccountState

    /** Something is stored that this device cannot decrypt — an invalidated
     *  keystore key, an altered file. Never reported as "no account". */
    data object CredentialUnreadable : AccountState
}

/** A one-shot request whose only product is a notice: another verification
 *  email, a password-reset email. Never a session. */
sealed interface RequestState {
    data object Idle : RequestState
    data object Sending : RequestState

    /**
     * The server ACCEPTED the request. Deliberately not "sent": both endpoints
     * answer 200 whether they mailed anything or swallowed the request under a
     * per-address throttle, and the copy may only say what is true.
     */
    data object Requested : RequestState

    data class Failed(val failure: AccountFailure) : RequestState
}

/** The account's device list. */
sealed interface DevicesState {
    /** Not asked for, or not applicable — no account is loaded. */
    data object Idle : DevicesState
    data object Loading : DevicesState
    data class Loaded(val devices: List<AccountDevice>) : DevicesState
    data class Failed(val failure: AccountFailure) : DevicesState
}
