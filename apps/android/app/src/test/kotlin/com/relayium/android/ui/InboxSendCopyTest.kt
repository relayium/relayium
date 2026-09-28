package com.relayium.android.ui

import com.relayium.android.R
import com.relayium.android.inbox.InboxSendStatus
import com.relayium.protocol.inbox.InboxManifestKind
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
}
