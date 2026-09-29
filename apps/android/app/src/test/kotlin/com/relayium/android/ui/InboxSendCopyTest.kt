package com.relayium.android.ui

import com.relayium.android.R
import com.relayium.android.inbox.InboxSendStatus
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxTaskErrorCode
import com.relayium.protocol.inbox.InboxTaskState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which uncertainty the Outgoing row and its discard confirmation describe.
 *
 * An unsettled UPLOAD (publish attempted, no object id) never sent a create, so
 * it must not borrow the "may have reached the other device" copy that is true
 * only of an unresolved create.
 */
class InboxSendCopyTest {

    private fun send(
        phase: InboxSendStatus.Phase = InboxSendStatus.Phase.STOPPED,
        ambiguous: Boolean = false,
        uploadUnknown: Boolean = false,
        uploadUnsettled: Boolean = false,
    ) = InboxSendStatus(
        jobId = "job-1",
        targetDeviceId = "device-1",
        kind = InboxManifestKind.FILE,
        names = listOf("f.bin"),
        totalBytes = 100,
        phase = phase,
        ambiguous = ambiguous,
        uploadUnknown = uploadUnknown,
        uploadUnsettled = uploadUnsettled,
    )

    @Test
    fun `an unsettled finalize says nothing was delivered`() {
        val s = send(ambiguous = true, uploadUnsettled = true)
        assertEquals(R.string.inbox_sending_upload_unsettled, sendUncertaintyNoteRes(s))
        assertEquals(R.string.inbox_sending_discard_unsettled_body, sendDiscardBodyRes(s))
    }

    @Test
    fun `an unresolved create keeps the may-still-arrive copy`() {
        val s = send(ambiguous = true)
        assertEquals(R.string.inbox_sending_ambiguous, sendUncertaintyNoteRes(s))
        assertEquals(R.string.inbox_sending_discard_unknown_body, sendDiscardBodyRes(s))
    }

    @Test
    fun `an unresolved single-shot publish keeps its row note but not the may-arrive discard`() {
        val s = send(ambiguous = true, uploadUnknown = true, uploadUnsettled = true)
        assertEquals(R.string.inbox_sending_upload_unknown, sendUncertaintyNoteRes(s))
        assertEquals(R.string.inbox_sending_discard_unsettled_body, sendDiscardBodyRes(s))
    }

    @Test
    fun `settled rows keep their existing copy`() {
        assertNull(sendUncertaintyNoteRes(send()))
        assertEquals(R.string.inbox_sending_discard_body, sendDiscardBodyRes(send()))
        assertEquals(
            R.string.inbox_sending_cancel_delivery_body,
            sendDiscardBodyRes(send(phase = InboxSendStatus.Phase.DELIVERED)),
        )
    }

    @Test
    fun `server states use the closed native delivery vocabulary`() {
        assertEquals(R.string.inbox_sending_unknown, deliveryStateText(null))
        assertEquals(R.string.inbox_sending_queued, deliveryStateText(InboxTaskState.QUEUED))
        assertEquals(R.string.inbox_sending_notified, deliveryStateText(InboxTaskState.NOTIFIED))
        assertEquals(
            R.string.inbox_sending_awaiting_approval,
            deliveryStateText(InboxTaskState.ATTENTION_REQUIRED),
        )
        assertEquals(R.string.inbox_sending_receiving, deliveryStateText(InboxTaskState.DOWNLOADING))
        assertEquals(R.string.inbox_sending_verifying, deliveryStateText(InboxTaskState.VERIFYING))
        assertEquals(R.string.inbox_sending_saved, deliveryStateText(InboxTaskState.SAVED))
        assertEquals(R.string.inbox_sending_declined, deliveryStateText(InboxTaskState.REVOKED))
        assertEquals(
            R.string.inbox_sending_failed_retryable,
            deliveryStateText(InboxTaskState.FAILED_RETRYABLE),
        )
        assertEquals(
            R.string.inbox_sending_failed_terminal,
            deliveryStateText(InboxTaskState.FAILED_TERMINAL),
        )
        assertEquals(
            R.string.inbox_sending_declined,
            deliveryStateText(
                InboxTaskState.FAILED_TERMINAL,
                InboxTaskErrorCode.Device(InboxDeviceErrorCode.USER_DECLINED),
            ),
        )
    }

    @Test
    fun `cancel disappears once the receiver owns a claim`() {
        fun delivered(state: InboxTaskState?) = send(phase = InboxSendStatus.Phase.DELIVERED)
            .copy(taskId = "task-1", taskState = state)

        assertEquals(false, delivered(null).offersCancelDelivery)
        assertEquals(true, delivered(InboxTaskState.QUEUED).offersCancelDelivery)
        assertEquals(true, delivered(InboxTaskState.ATTENTION_REQUIRED).offersCancelDelivery)
        assertEquals(false, delivered(InboxTaskState.DOWNLOADING).offersCancelDelivery)
        assertEquals(false, delivered(InboxTaskState.VERIFYING).offersCancelDelivery)
        assertEquals(false, delivered(InboxTaskState.SAVED).offersCancelDelivery)
    }
}
