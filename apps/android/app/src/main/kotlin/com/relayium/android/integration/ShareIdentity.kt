package com.relayium.android.integration

/**
 * Who a staged share belongs to, and who a dispatch of it is being made by.
 *
 * These are two different questions and conflating them is the bug this file
 * exists to prevent.
 *
 * **A share is account-independent input.** Another app hands this one a photo;
 * nothing about that says who is signed in, and the user may well sign in
 * AFTERWARDS precisely because they want to send it somewhere that needs an
 * account. A share released the moment a restored credential arrives is a
 * share the user watched disappear for no reason they could see.
 *
 * **A delivery is account-bound.** The same photo dispatched to cloud storage,
 * or to a device in an account's Inbox, is uploaded under one specific
 * credential — and if the account changed between the tap and the upload, it is
 * one person's file arriving in somebody else's storage.
 *
 * So the staging identity ([ShareEpoch]) survives a sign-in, and the delivery
 * identity ([DispatchAuthority]) is captured at the explicit destination choice
 * and re-checked before every side effect that follows it.
 */

/**
 * The generation a staged share is held under.
 *
 * `ShareStaging` releases a share whose generation no longer matches — which is
 * the right rule and the wrong counter if the counter is the account's. This is
 * the counter it should be given instead.
 *
 * ## The one rule
 *
 * It advances when a signed-in identity is **replaced**, and at no other time:
 *
 *  | before | after | epoch |
 *  | --- | --- | --- |
 *  | nobody | A | unchanged — this is the cold restore, and the share survives it |
 *  | A | A | unchanged — a refresh is not a new person |
 *  | A | B | advances — B may not dispatch A's staged file |
 *  | A | nobody | advances — the credential the share might have been sent under is gone |
 *
 * The first row is the whole point. At a cold launch the account arrives
 * asynchronously: `Restoring` first, `Ready` some hundreds of milliseconds
 * later. A share delivered by an intent in between is staged while nobody is
 * signed in, and an epoch that counted "nobody → A" as a change would release
 * it exactly when the restore completed — every single cold-start share, on
 * every launch, silently.
 *
 * Main thread only, like the account state flow it is driven from.
 */
class ShareEpoch {

    /**
     * The last account id actually observed as SIGNED IN, or null.
     *
     * Only `Ready` moves this. `Restoring`, `SigningIn` and the various failure
     * states are not an identity — treating them as "nobody" would make an
     * ordinary sign-in look like two changes (A → nobody → A) and advance the
     * epoch twice for one refresh.
     */
    private var last: String? = null

    var current: Long = 0
        private set

    /**
     * Report who is signed in now, and get the epoch a share must be staged
     * under.
     *
     * @param accountId the live account's id, or null when there is no live
     *   session. A state that is neither — a restore in flight, a sign-in being
     *   attempted — must not be reported here at all; see [last].
     */
    fun observe(accountId: String?): Long {
        val previous = last
        if (previous != null && previous != accountId) current += 1
        last = accountId
        return current
    }
}

/**
 * The identity a dispatch was authorised under, captured at the tap.
 *
 * Everything that happens after the user chooses a destination is
 * asynchronous — describing the items, opening descriptors, staging an
 * outgoing job, uploading — and the account can be switched or signed out
 * inside any of those gaps. This value is what a late callback compares itself
 * against before it acts, so that a delivery authorised as A never completes as
 * B.
 *
 * Not a `data class`: a synthesised `toString` would print the account id into
 * coroutine failure text.
 */
class DispatchAuthority(
    /** `StagedShare.id` — the exact share the user was LOOKING at when they
     *  tapped. A newer share arriving between the render and the tap is a
     *  different thing to send. */
    val shareId: Long,
    /** The staging epoch, from [ShareEpoch]. */
    val epoch: Long,
    /**
     * The credential this delivery needs, or null for a destination that needs
     * none.
     *
     * Null is not "we did not bother": cross-network and Nearby transfers are
     * genuinely anonymous — no bearer is presented and no account pays for
     * them — so requiring one would be a fence with nothing behind it. Cloud
     * and Inbox are the account-bound ones and always carry this.
     */
    val account: AccountBinding?,
    /**
     * What was chosen INSIDE the destination, when the destination has such a
     * thing: an Inbox device id, for instance.
     *
     * Carried so a late callback cannot deliver to a target that was picked
     * for a different account's device list.
     */
    val target: String? = null,
) {
    override fun toString(): String =
        "DispatchAuthority(share=$shareId, epoch=$epoch, accountBound=${account != null})"

    /**
     * May this dispatch still act?
     *
     * All three parts, because each catches something the others do not: the
     * epoch catches an identity replacement under the staging, the account
     * binding catches a sign-out or a switch between the tap and the side
     * effect, and a caller that needs the target compares it separately at the
     * point it uses it.
     */
    fun isCurrent(epochNow: Long, accountNow: AccountBinding?): Boolean {
        if (epochNow != epoch) return false
        val required = account ?: return true
        return accountNow == required
    }
}

/**
 * A live credential, as much of it as an authority check needs.
 *
 * The generation is what makes this a fence rather than a comparison: signing
 * out of an account and back into the same one is a NEW session, and a result
 * from the first must not land in the second just because the id matches. It
 * mirrors `AccountSession.Authority` deliberately — same three-part reasoning —
 * without carrying the token, which has no business travelling this far into
 * the UI layer.
 */
data class AccountBinding(val accountId: String, val generation: Int)
