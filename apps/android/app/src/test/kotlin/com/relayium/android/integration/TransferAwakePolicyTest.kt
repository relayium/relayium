package com.relayium.android.integration

import com.relayium.android.TransferController
import com.relayium.android.cloud.CloudDownloadModel
import com.relayium.android.cloud.CloudFailure
import com.relayium.android.cloud.CloudUploadModel
import com.relayium.android.inbox.InboxModel
import com.relayium.android.inbox.InboxReceiving
import com.relayium.android.inbox.InboxSendStatus
import com.relayium.protocol.inbox.InboxManifestKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The keep-awake rule, as a rule.
 *
 * Two failures are possible here and they are opposite, so both are pinned
 * rather than only the one the feature was written for:
 *
 *  * **Too little** — a transfer that is genuinely running does not hold the
 *    screen, the device times out, `ON_STOP` arrives, and Nearby or the Inbox
 *    is torn down mid-transfer. That is the defect this exists to fix.
 *  * **Too much** — an idle, finished, staged or failed state holds the screen
 *    anyway, which is an app keeping somebody's device awake for work that is
 *    not happening. A window flag makes that visible rather than silent, but it
 *    is still wrong, and a boolean that is true too often is the easiest way to
 *    get there.
 *
 * Every terminal and pre-work state below is asserted false for that reason.
 */
class TransferAwakePolicyTest {

    private val idleSession = TransferController.State()
    private val idleDownload = CloudDownloadModel.State.Idle
    private val idleUpload = CloudUploadModel.State.Idle
    private val idleInbox = InboxModel.State()

    private fun awake(
        session: TransferController.State = idleSession,
        download: CloudDownloadModel.State = idleDownload,
        upload: CloudUploadModel.State = idleUpload,
        inbox: InboxModel.State = idleInbox,
    ) = TransferAwakePolicy.keepAwake(session, download, upload, inbox)

    private fun progress() = TransferController.Progress("f.bin", 10, 100)

    private fun send(phase: InboxSendStatus.Phase) = InboxSendStatus(
        jobId = "job-1",
        targetDeviceId = "device-1",
        kind = InboxManifestKind.FILE,
        names = listOf("f.bin"),
        totalBytes = 100,
        phase = phase,
    )

    // ── nothing is happening ────────────────────────────────────────────────

    @Test
    fun `an app doing nothing holds no claim on the screen`() {
        assertFalse(awake())
    }

    @Test
    fun `a connected session with no batch does not hold the screen`() {
        // The deliberate boundary. A session can sit connected indefinitely, and
        // holding the screen for one would be a battery cost with no transfer to
        // protect. Recorded as a known limit rather than left implicit: a screen
        // timeout during an idle connected session still ends it.
        assertFalse(
            awake(session = TransferController.State(phase = TransferController.Phase.CONNECTED)),
        )
    }

    // ── a live session ──────────────────────────────────────────────────────

    @Test
    fun `a session receiving a batch holds the screen`() {
        assertTrue(awake(session = TransferController.State(receiveProgress = progress())))
    }

    @Test
    fun `a session sending a batch holds the screen`() {
        assertTrue(awake(session = TransferController.State(sendProgress = progress())))
    }

    @Test
    fun `a finished batch releases it`() {
        // `savedBatch` with no progress is the shape a completed receive leaves
        // behind, and it must not keep the screen on afterwards.
        assertTrue(awake(session = TransferController.State(receiveProgress = progress())))
        assertFalse(awake(session = TransferController.State(savedBatch = true, savedBatchCount = 1)))
    }

    @Test
    fun `an ended session releases it`() {
        assertFalse(awake(session = TransferController.State(phase = TransferController.Phase.ENDED)))
    }

    // ── a stored download ───────────────────────────────────────────────────

    @Test
    fun `a saving download holds the screen`() {
        assertTrue(awake(download = CloudDownloadModel.State.Saving(10, 100)))
    }

    @Test
    fun `a reconnecting download still holds the screen`() {
        // The recovery window is part of the same operation. Releasing here
        // would let the device sleep during exactly the moment the transfer is
        // most fragile.
        assertTrue(awake(download = CloudDownloadModel.State.Saving(10, 100, reconnecting = true)))
    }

    @Test
    fun `a resolved but unsaved link does not hold the screen`() {
        // `Ready` is waiting for the user to choose a folder, which is precisely
        // when a screen timeout is the correct behaviour.
        assertFalse(
            awake(
                download = CloudDownloadModel.State.Ready(
                    names = listOf("a.txt"),
                    totalBytes = 10,
                    burnAfterRead = false,
                    expiresAt = 0,
                ),
            ),
        )
    }

    @Test
    fun `a finished or failed download releases it`() {
        assertFalse(awake(download = CloudDownloadModel.State.Done(2)))
        assertFalse(
            awake(download = CloudDownloadModel.State.Failed(CloudFailure(CloudFailure.Kind.NETWORK))),
        )
    }

    // ── a stored upload ─────────────────────────────────────────────────────

    @Test
    fun `an upload holds the screen while it stages, sends and settles`() {
        assertTrue(awake(upload = CloudUploadModel.State.Staging(1, 100)))
        assertTrue(awake(upload = CloudUploadModel.State.Uploading(1, 100)))
        assertTrue(awake(upload = CloudUploadModel.State.Verifying))
        assertTrue(awake(upload = CloudUploadModel.State.Completing(1, 100)))
    }

    @Test
    fun `an upload the user has not started does not hold the screen`() {
        assertFalse(awake(upload = CloudUploadModel.State.Selected(emptyList(), 0)))
    }

    @Test
    fun `an interrupted upload waiting to be resumed does not hold the screen`() {
        // Recovery is an OFFER on that surface — nothing runs until the user
        // taps — so there is no work to protect.
        assertFalse(awake(upload = CloudUploadModel.State.Interrupted(1, 100, true, null)))
    }

    // ── the Device Inbox ────────────────────────────────────────────────────

    @Test
    fun `a delivery being worked holds the screen`() {
        // The Inbox loop is foreground-only, exactly like Nearby, so a screen
        // timeout mid-delivery stops a download that was working.
        assertTrue(awake(inbox = InboxModel.State(receiving = InboxReceiving.RECEIVING)))
    }

    @Test
    fun `an idle Inbox loop does not hold the screen`() {
        // LISTENING is a poll with nothing to deliver. Holding the screen for it
        // would keep a device awake for as long as the tab was open.
        for (state in listOf(
            InboxReceiving.OFF,
            InboxReceiving.STOPPED,
            InboxReceiving.LISTENING,
            InboxReceiving.UNAVAILABLE,
        )) {
            assertFalse(state.name, awake(inbox = InboxModel.State(receiving = state)))
        }
    }

    @Test
    fun `an outgoing job holds the screen only while an attempt is running`() {
        assertTrue(awake(inbox = InboxModel.State(sends = listOf(send(InboxSendStatus.Phase.SENDING)))))
        for (phase in listOf(
            InboxSendStatus.Phase.STAGED,
            InboxSendStatus.Phase.DELIVERED,
            InboxSendStatus.Phase.STOPPED,
        )) {
            assertFalse(
                phase.name,
                awake(inbox = InboxModel.State(sends = listOf(send(phase)))),
            )
        }
    }

    @Test
    fun `one running job among finished ones still holds the screen`() {
        val sends = listOf(
            send(InboxSendStatus.Phase.DELIVERED),
            send(InboxSendStatus.Phase.SENDING),
            send(InboxSendStatus.Phase.STOPPED),
        )
        assertTrue(awake(inbox = InboxModel.State(sends = sends)))
    }

    // ── the answer is one answer ────────────────────────────────────────────

    @Test
    fun `any one live surface is enough, and all four quiet releases it`() {
        assertTrue(awake(session = TransferController.State(sendProgress = progress())))
        assertTrue(awake(download = CloudDownloadModel.State.Saving(1, 2)))
        assertTrue(awake(upload = CloudUploadModel.State.Uploading(1, 2)))
        assertTrue(awake(inbox = InboxModel.State(receiving = InboxReceiving.RECEIVING)))
        assertFalse(awake())
    }

    // The creator's wait — read six digits out, wait for someone to type them —
    // used to let the screen time out, which dropped the socket and ended the
    // session. Held now, but only while the CODE is alive, so it is bounded.
    @Test
    fun `a minted code that is still alive holds the screen while waiting for the peer`() {
        val waiting = TransferController.State(phase = TransferController.Phase.WAITING_PEER)
        assertTrue(TransferAwakePolicy.waitingOnMintedCode(waiting, mintedCodeAlive = true))
        assertFalse("an expired code releases it", TransferAwakePolicy.waitingOnMintedCode(waiting, mintedCodeAlive = false))
        assertFalse(
            "connected and idle is still not work",
            TransferAwakePolicy.waitingOnMintedCode(
                TransferController.State(phase = TransferController.Phase.CONNECTED), mintedCodeAlive = true,
            ),
        )
        assertFalse(
            "Nearby has no expiry to bound the claim, so it never qualifies",
            TransferAwakePolicy.waitingOnMintedCode(
                waiting.copy(nearby = TransferController.Nearby(active = true)), mintedCodeAlive = true,
            ),
        )
    }
}
