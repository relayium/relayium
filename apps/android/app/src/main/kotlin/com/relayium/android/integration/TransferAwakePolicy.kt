package com.relayium.android.integration

import com.relayium.android.TransferController
import com.relayium.android.cloud.CloudDownloadModel
import com.relayium.android.cloud.CloudUploadModel
import com.relayium.android.inbox.InboxModel
import com.relayium.android.inbox.InboxReceiving
import com.relayium.android.inbox.InboxSendStatus

/**
 * Whether the screen must stay on because this app is actually MOVING BYTES.
 *
 * ## The problem this exists for
 *
 * A device screen times out after 15–30 seconds. Screen-off delivers a bare
 * `ON_STOP` with `isChangingConfigurations == false` and no owned picker, which
 * [HostPresence] correctly reads as "the user really did leave" — so
 * `nearbyLeftForeground()` stops Nearby and the Inbox announces offline. For a
 * Nearby file transfer that takes longer than the timeout, the transfer dies
 * untouched while the user is watching it.
 *
 * ## Why this does NOT change [HostPresence]
 *
 * The obvious-looking fix — teach the presence rule that screen-off is not
 * leaving — is the wrong one, and it is wrong in the direction that matters.
 * The presence claim is made TO ANOTHER DEVICE: Nearby advertises this device on
 * the local link and the Inbox tells central it is listening. A sleeping phone
 * is not in front of anybody, so a build that kept advertising through screen-off
 * would be asserting something false to a peer that then waits out a presence
 * TTL for a device that is never going to answer.
 *
 * So the fix is the other direction: keep the screen from going off in the first
 * place, for exactly as long as there is real work, and let the presence rule go
 * on meaning precisely what it already means. When the work ends, the screen
 * times out normally, `ON_STOP` arrives, and every existing teardown runs
 * unchanged. Manual screen-off and Home still withdraw the claim immediately,
 * because this holds no wake lock and cannot keep a window the user has left.
 *
 * ## Why a window flag and not a wake lock
 *
 * `FLAG_KEEP_SCREEN_ON` needs no permission, is scoped to one window, and is
 * released by the system when that window stops being visible — so the worst
 * case of a bug here is a screen that stays on while the user is looking at it,
 * never a background process holding the device awake. `WAKE_LOCK` is the
 * opposite on all three counts and is deliberately not used.
 *
 * ## What counts as work
 *
 * Bytes, or the finalisation of bytes — never merely being connected. An idle
 * connected session holds no claim here: it could sit for an hour, and burning
 * the screen for it would be a battery cost with no transfer to protect. That is
 * a deliberate boundary and a known limit, not an oversight — see
 * `docs/android-development.md`.
 *
 * Pure, and free of Android types, so the rule is tested as a rule rather than
 * through an Activity.
 */
object TransferAwakePolicy {

    /**
     * Whether a live session is pushing or pulling a batch right now.
     *
     * `sendProgress`/`receiveProgress` are non-null only while a batch is
     * actually moving: they are cleared on completion, on cancellation and when
     * the link ends, so the release conditions are the same fields' own
     * semantics rather than a second lifecycle this file would have to keep in
     * step. `phase` is deliberately not read — a CONNECTED session with no batch
     * is not work, and an ENDED one cannot have progress.
     */
    fun sessionWorking(state: TransferController.State): Boolean =
        state.sendProgress != null || state.receiveProgress != null

    /**
     * Whether a stored download is writing.
     *
     * `Saving` only. `Loading` is one metadata round trip — short, and losing it
     * costs a retry of nothing — and `Ready` is a resolved link the user has not
     * acted on, which is precisely when the screen SHOULD be allowed to time out.
     * A reconnecting attempt is still `Saving`, so a recovery window holds the
     * screen exactly as the read it is recovering did.
     */
    fun downloadWorking(state: CloudDownloadModel.State): Boolean =
        state is CloudDownloadModel.State.Saving

    /**
     * Whether a stored upload is staging, sending or settling.
     *
     * `Verifying` and `Completing` are included with the two obvious ones
     * because they are the round trips that decide whether bytes already sent
     * become an object at all: an upload interrupted there is the case that
     * strands ciphertext the user then has to resume or discard by hand.
     * `Interrupted`, `Uncertain`, `Ready` and `Failed` are outcomes the user
     * reads, not work.
     */
    fun uploadWorking(state: CloudUploadModel.State): Boolean = when (state) {
        is CloudUploadModel.State.Staging,
        is CloudUploadModel.State.Uploading,
        is CloudUploadModel.State.Verifying,
        is CloudUploadModel.State.Completing,
        -> true

        else -> false
    }

    /**
     * Whether the Device Inbox is moving a delivery.
     *
     * The Inbox has the SAME exposure as Nearby and for the same reason: its
     * loop runs only in the foreground, so a screen timeout mid-delivery stops
     * a download that was working. [InboxReceiving] already draws the line this
     * needs — `RECEIVING` is "a delivery is being worked right now", while
     * `LISTENING` is an idle poll, and `OFF`/`STOPPED`/`UNAVAILABLE` are not
     * work at all — so this reads that answer rather than inventing a second
     * one.
     *
     * Outgoing is `SENDING` only: `STAGED` is durable and has sent nothing,
     * `DELIVERED` is finished, and `STOPPED` is an outcome the user reads. A
     * staged or stopped job holding the screen on would be this app keeping a
     * device awake for work that is not happening.
     */
    fun inboxWorking(state: InboxModel.State): Boolean =
        state.receiving == InboxReceiving.RECEIVING ||
            state.sends.any { it.phase == InboxSendStatus.Phase.SENDING }

    /** The one answer the window flag is driven from. */
    fun keepAwake(
        session: TransferController.State,
        download: CloudDownloadModel.State,
        upload: CloudUploadModel.State,
        inbox: InboxModel.State,
    ): Boolean = sessionWorking(session) ||
        downloadWorking(download) ||
        uploadWorking(upload) ||
        inboxWorking(inbox)
}
